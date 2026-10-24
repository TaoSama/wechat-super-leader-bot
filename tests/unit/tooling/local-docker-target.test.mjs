import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scripts = fileURLToPath(new URL('../../../scripts/', import.meta.url));
const modes = ['up', 'down'];
const localHost = 'unix:///tmp/synthetic-docker.sock';
const remoteHost = 'ssh://synthetic-production';

function lifecycleFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'local-docker-target-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const log = join(root, 'calls.jsonl');
  mkdirSync(bin);
  mkdirSync(join(root, 'scripts/lib'), { recursive: true });
  mkdirSync(join(root, '.runtime'));
  for (const file of ['local.mjs', 'verify.mjs', 'lib/send-eligibility.mjs', 'lib/compose-command.mjs']) copyFileSync(join(scripts, file), join(root, 'scripts', file));
  writeFileSync(join(root, '.runtime/local.json'), JSON.stringify({
    nodeId: 'synthetic-node', postgresPassword: 'a'.repeat(64), controllerToken: 'b'.repeat(64),
    nodeToken: 'c'.repeat(64), allowedChatIds: [],
  }), { mode: 0o600 });
  const record = `import { appendFileSync } from 'node:fs';
    const args = process.argv.slice(2);
    const record = tool => appendFileSync(process.env.SYNTHETIC_CALL_LOG, JSON.stringify({
      tool, args, host: process.env.DOCKER_HOST, context: process.env.DOCKER_CONTEXT,
    }) + '\\n');`;
  writeFileSync(join(bin, 'docker'), `#!${process.execPath}\n${record}
    record('docker');
    process.stdout.write(process.env.SYNTHETIC_INSPECT_OUTPUT);
    process.exitCode = Number(process.env.SYNTHETIC_INSPECT_STATUS);`, { mode: 0o700 });
  const compose = join(bin, 'synthetic-compose');
  writeFileSync(compose, `#!${process.execPath}\n${record}\nrecord('compose');`, { mode: 0o700 });
  return (mode, dockerEnv = {}, { output = JSON.stringify(localHost), status = 0 } = {}, composePath = compose) => {
    writeFileSync(log, '');
    const args = [join(root, 'scripts/local.mjs'), `--${mode}`];
    if (composePath !== null) args.push('--compose', composePath);
    const result = spawnSync(process.execPath, args, {
      encoding: 'utf8', timeout: 30_000, env: {
        PATH: bin, HOME: root, SYNTHETIC_CALL_LOG: log,
        SYNTHETIC_INSPECT_OUTPUT: output, SYNTHETIC_INSPECT_STATUS: String(status), ...dockerEnv,
      },
    });
    assert.equal(result.error, undefined);
    return { ...result, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) };
  };
}

test('local lifecycle auto-detects the Docker Compose plugin when no override is supplied', t => {
  const run = lifecycleFixture(t);
  const result = run('down', {}, {}, null);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.map(call => [call.tool, call.args]), [
    ['docker', ['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']],
    ['docker', ['compose', 'version']],
    ['docker', ['compose', '-f', result.calls.at(-1).args[2], 'down']],
  ]);
});

test('local lifecycle rejects explicit remote Docker hosts before any Docker or Compose command', t => {
  const run = lifecycleFixture(t);
  for (const mode of modes) {
    for (const host of [remoteHost, 'tcp://127.0.0.1:2375', 'https://synthetic-production']) {
      const result = run(mode, { DOCKER_HOST: host });
      assert.equal(result.status, 1, `${mode}: ${host}`);
      assert.match(result.stderr, /local Unix Docker socket/);
      assert.deepEqual(result.calls, []);
    }
  }
});

test('local lifecycle rejects remote environment and current contexts before Compose', t => {
  const run = lifecycleFixture(t);
  for (const mode of modes) {
    for (const env of [{}, { DOCKER_CONTEXT: 'synthetic-production', DOCKER_HOST: localHost }]) {
      const result = run(mode, env, { output: JSON.stringify(remoteHost) });
      assert.equal(result.status, 1, mode);
      assert.match(result.stderr, /local Unix Docker socket/);
      assert.deepEqual(result.calls.map(call => [call.tool, call.args]), [['docker', [
        'context', 'inspect', ...(env.DOCKER_CONTEXT ? [env.DOCKER_CONTEXT] : []),
        '--format', '{{json .Endpoints.docker.Host}}',
      ]]]);
    }
  }
});

test('local lifecycle pins the effective local endpoint and clears the context before Compose', t => {
  const run = lifecycleFixture(t);
  for (const mode of modes) {
    for (const env of [
      {},
      { DOCKER_HOST: localHost },
      { DOCKER_CONTEXT: 'synthetic-local', DOCKER_HOST: remoteHost },
    ]) {
      const result = run(mode, env);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.calls.length, env.DOCKER_HOST && !env.DOCKER_CONTEXT ? 1 : 2);
      const compose = result.calls.at(-1);
      assert.equal(compose.tool, 'compose');
      assert.equal(compose.host, localHost);
      assert.equal(compose.context, undefined);
      assert.deepEqual(compose.args.slice(0, 1), ['-f']);
      assert(compose.args[1].endsWith('/compose.yaml'));
      assert.deepEqual(compose.args.slice(2), mode === 'up' ? ['up', '-d', '--build'] : ['down']);
    }
  }
});

test('local lifecycle fails closed when context inspection fails or returns an invalid endpoint', t => {
  const run = lifecycleFixture(t);
  for (const mode of modes) {
    for (const response of [
      { status: 1 },
      { output: 'invalid-json' },
      { output: 'null' },
      { output: JSON.stringify('unix://relative.sock') },
      { output: JSON.stringify('unix:///tmp/synthetic.sock\n') },
    ]) {
      const result = run(mode, { DOCKER_CONTEXT: 'synthetic-context' }, response);
      assert.equal(result.status, 1, mode);
      assert.equal(result.calls.length, 1);
      assert.equal(result.calls[0].tool, 'docker');
      assert.match(result.stderr, /Cannot resolve Docker context|invalid endpoint|local Unix Docker socket/);
    }
  }
});
