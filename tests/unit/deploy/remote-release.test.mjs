import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { ACTIVATION_LOG, ACTIVATION_STATUS, REMOTE_FILES } from '../../../scripts/deploy/transfer-files.mjs';

const REVISION = 'a'.repeat(40);
const SCRIPT = fileURLToPath(new URL('../../../scripts/deploy/remote-release.sh', import.meta.url));
const RELEASE_ENV = `CONTROLLER_IMAGE=super-leader-controller:${REVISION}\n` +
  `GATEWAY_IMAGE=super-leader-gateway:${REVISION}\nGATEWAY_CONTEXT_WINDOW_MS=82800000\n`;
const PREVIOUS_ENV = RELEASE_ENV.replaceAll(REVISION, 'b'.repeat(40));
const OWNER = 'synthetic-owner';
const STATUS_WAIT_MS = 10_000;
const POLL_MS = 50;

function releaseFixture() {
  const root = mkdtempSync(join(tmpdir(), 'release-idempotency-'));
  const stage = join(root, 'stage');
  const bin = join(root, 'bin');
  mkdirSync(stage);
  mkdirSync(bin);
  mkdirSync(join(root, '.runtime'));
  writeFileSync(join(root, '.runtime/controller.env'), '', { mode: 0o600 });
  writeFileSync(join(root, '.runtime/release.env'), RELEASE_ENV);
  writeFileSync(join(root, '.runtime/release.env.previous'), PREVIOUS_ENV);
  const bundle = ['controller.tar', 'gateway.tar', 'compose.release.yaml', 'compose.yaml',
    'compose.production.yaml', 'compose.gateway.yaml', 'codex-seccomp.json'];
  for (const file of bundle) writeFileSync(join(stage, file), 'fixture\n');
  const digest = createHash('sha256').update('fixture\n').digest('hex');
  writeFileSync(join(stage, 'release.sha256'), bundle.map(file => `${digest}  ${file}\n`).join(''));
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.RELEASE_COMMAND_LOG, JSON.stringify(args) + '\\n');
const revision = process.env.TEST_RELEASE_REVISION;
if (args[0] === 'compose') {
  const ps = args.indexOf('ps');
  if (ps !== -1) console.log(args.at(-1));
  if (args.includes('--force-recreate') && process.env.TEST_RECREATE_MS) {
    // Block like a long stop_grace_period, then write to stderr as Compose does.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.TEST_RECREATE_MS));
    console.error('Container super-leader-gateway Recreated');
  }
} else if (args[0] === 'inspect' || (args[0] === 'image' && args[1] === 'inspect')) {
  const format = args[args.indexOf('--format') + 1];
  const service = args.at(-1);
  if (format.includes('.Os')) console.log('linux/amd64');
  else if (format === '{{.Image}}') console.log(process.env.TEST_IMAGE_ID || 'sha256:expected');
  else if (format === '{{.Id}}') console.log('sha256:expected');
  else if (format.includes('revision')) console.log(revision);
  else if (format.includes('.State.Status')) console.log('running');
  else if (format.includes('.State.Health')) console.log(process.env.TEST_HEALTH || 'healthy');
  else if (format.includes('.Config.Image')) console.log(process.env.TEST_IMAGE || 'super-leader-' + service + ':' + revision);
  else if (format.includes('.Config.Env')) console.log('GATEWAY_CONTEXT_WINDOW_MS=' + (process.env.TEST_WINDOW || '82800000'));
  else throw new Error('Unexpected inspect format ' + format);
}
`);
  chmodSync(join(bin, 'docker'), 0o755);
  const args = ['--release-dir', root, '--stage-dir', stage, '--revision', REVISION,
    '--controller-image', `super-leader-controller:${REVISION}`,
    '--gateway-image', `super-leader-gateway:${REVISION}`,
    '--controller-archive', join(stage, 'controller.tar'), '--gateway-archive', join(stage, 'gateway.tar'),
    '--checksums', join(stage, 'release.sha256'), '--compose-overlay', join(stage, 'compose.release.yaml'),
    '--compose-base', join(stage, 'compose.yaml'), '--compose-production', join(stage, 'compose.production.yaml'),
    '--compose-gateway', join(stage, 'compose.gateway.yaml'), '--seccomp-policy', join(stage, 'codex-seccomp.json')];
  return { root, stage, args: args.slice(), env: overrides => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`,
    TEST_RELEASE_REVISION: REVISION, RELEASE_COMMAND_LOG: join(root, 'commands.jsonl'), ...overrides }), run(overrides = {}) {
    const result = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_RELEASE_REVISION: REVISION,
        RELEASE_COMMAND_LOG: join(root, 'commands.jsonl'), ...overrides } });
    if (result.error) throw result.error;
    return { ...result, commands: readFileSync(join(root, 'commands.jsonl'), 'utf8') };
  }, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}

test('duplicate healthy release skips recreation and preserves previous rollback selection', () => {
  const fixture = releaseFixture();
  try {
    const result = fixture.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /deployment already healthy.*skipping recreation/);
    assert.doesNotMatch(result.commands, /force-recreate/);
    assert.equal(readFileSync(join(fixture.root, '.runtime/release.env.previous'), 'utf8'), PREVIOUS_ENV);
    assert.equal(readFileSync(join(fixture.root, '.runtime/release.env'), 'utf8'), RELEASE_ENV);
  } finally { fixture.cleanup(); }
});

test('different release environment activates the new revision and retains the old selection', () => {
  const fixture = releaseFixture();
  try {
    writeFileSync(join(fixture.root, '.runtime/release.env'), PREVIOUS_ENV);
    const result = fixture.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.commands, /force-recreate/);
    assert.match(result.stdout, /deployment verified for revision/);
    assert.equal(readFileSync(join(fixture.root, '.runtime/release.env.previous'), 'utf8'), PREVIOUS_ENV);
    assert.equal(readFileSync(join(fixture.root, '.runtime/release.env'), 'utf8'), RELEASE_ENV);
  } finally { fixture.cleanup(); }
});

for (const [name, overrides] of [
  ['unhealthy container', { TEST_HEALTH: 'unhealthy' }],
  ['wrong image selection', { TEST_IMAGE: 'unexpected-image' }],
  ['different image archive', { TEST_IMAGE_ID: 'sha256:old-archive' }],
  ['wrong reply window', { TEST_WINDOW: '86400000' }],
]) {
  test(`same revision with ${name} cannot skip activation or claim success`, () => {
    const fixture = releaseFixture();
    try {
      const result = fixture.run(overrides);
      assert.equal(result.status, 1, result.stderr);
      assert.doesNotMatch(result.stdout, /deployment already healthy/);
      assert.match(result.commands, /force-recreate/);
      assert.match(result.stderr, /deployment is not successful/);
      assert.equal(readFileSync(join(fixture.root, '.runtime/release.env'), 'utf8'), PREVIOUS_ENV);
    } finally { fixture.cleanup(); }
  });
}

function helper(fixture, op, payload, env) {
  return spawnSync('python3', ['-', fixture.stage, OWNER, op, Buffer.from(JSON.stringify(payload)).toString('base64')],
    { input: REMOTE_FILES, encoding: 'utf8', timeout: 10_000, env });
}

async function waitForStatus(stage) {
  const deadline = Date.now() + STATUS_WAIT_MS;
  while (!existsSync(join(stage, ACTIVATION_STATUS))) {
    assert.ok(Date.now() < deadline, 'detached activation publishes its exit status');
    await delay(POLL_MS);
  }
  return readFileSync(join(stage, ACTIVATION_STATUS), 'utf8');
}

test('detached activation finishes its rollback after the launching session is killed and its pipes close', async () => {
  const fixture = releaseFixture();
  try {
    copyFileSync(SCRIPT, join(fixture.stage, 'remote-release.sh'));
    writeFileSync(join(fixture.stage, '.transfer-owner'), OWNER);
    const env = fixture.env({ TEST_HEALTH: 'unhealthy', TEST_RECREATE_MS: '1500' });
    const launcher = spawn('python3', ['-', fixture.stage, OWNER, 'activate',
      Buffer.from(JSON.stringify(fixture.args)).toString('base64')], { detached: true, env, stdio: ['pipe', 'pipe', 'ignore'] });
    launcher.stdin.end(REMOTE_FILES);
    let stdout = '';
    for await (const chunk of launcher.stdout) {
      stdout += chunk;
      if (stdout.includes('"started"')) break;
    }
    assert.deepEqual(JSON.parse(stdout), { started: true });
    // Emulate a cancelled runner: kill the SSH-side process group and drop its output pipe.
    try { process.kill(-launcher.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    launcher.stdout.destroy();

    assert.equal(existsSync(join(fixture.stage, ACTIVATION_STATUS)), false, 'activation is still running');
    assert.equal(helper(fixture, 'cleanup', [], env).status, 77, 'cleanup refuses a stage in use');
    assert.equal(helper(fixture, 'activate', fixture.args, env).status, 77, 'a second launch is rejected');
    assert.deepEqual(JSON.parse(helper(fixture, 'activation', [], env).stdout), { exit_code: null });

    assert.equal(await waitForStatus(fixture.stage), '1');
    const log = readFileSync(join(fixture.stage, ACTIVATION_LOG), 'utf8');
    assert.match(log, /Container super-leader-gateway Recreated/);
    assert.match(log, /restoring the previous image selection/);
    assert.match(log, /deployment is not successful/);
    assert.equal(readFileSync(join(fixture.root, '.runtime/release.env'), 'utf8'), PREVIOUS_ENV);
    const finished = JSON.parse(helper(fixture, 'activation', [], env).stdout);
    assert.equal(finished.exit_code, 1);
    assert.match(finished.output, /restoring the previous image selection/);

    const cleaned = helper(fixture, 'cleanup', [], env);
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(existsSync(fixture.stage), false, 'completed stage and its activation evidence are removable');
  } finally { fixture.cleanup(); }
});

test('detached activation publishes a successful exit status with the runtime verification output', async () => {
  const fixture = releaseFixture();
  try {
    copyFileSync(SCRIPT, join(fixture.stage, 'remote-release.sh'));
    writeFileSync(join(fixture.stage, '.transfer-owner'), OWNER);
    writeFileSync(join(fixture.root, '.runtime/release.env'), PREVIOUS_ENV);
    const env = fixture.env();
    const launched = helper(fixture, 'activate', fixture.args, env);
    assert.equal(launched.status, 0, launched.stderr);
    assert.equal(await waitForStatus(fixture.stage), '0');
    const finished = JSON.parse(helper(fixture, 'activation', [], env).stdout);
    assert.equal(finished.exit_code, 0);
    assert.match(finished.output, /^gateway_context_window_ms=82800000$/m);
    assert.equal(readFileSync(join(fixture.root, '.runtime/release.env'), 'utf8'), RELEASE_ENV);
  } finally { fixture.cleanup(); }
});
