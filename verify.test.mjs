import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verificationEnvironment, verificationPlan, localDockerEnvironment, runSteps } from './verify.mjs';

const cli = fileURLToPath(new URL('./verify.mjs', import.meta.url));

test('verification preserves required tools but drops live gates, credentials and process injection', () => {
  const env = verificationEnvironment({ PATH: '/tools', HOME: '/fixture', TMPDIR: '/temp', HTTPS_PROXY: 'http://proxy',
    LIVE_DESKTOP_SEND: 'fixture-only', LIVE_CODEX_SESSION: 'real', CODEX_APP_SERVER_SOCKET: '/real',
    SUPER_LEADER_JOURNAL_CRASH_TEST: '1', SUPER_LEADER_JOURNAL_TEST_DIR: '/real',
    CONTROLLER_TOKEN: 'secret', LEADER_MODEL_API_KEY: 'secret', WECHAT_CREDENTIALS_PATH: '/real',
    OPENAI_API_KEY: 'secret', OP_SERVICE_ACCOUNT_TOKEN: 'secret', NODE_OPTIONS: '--import injected',
    SUPER_LEADER_NO_DOTENV: '0', COMPOSE_ENV_FILES: '/real', DOTENV_CONFIG_PATH: '/real',
    GOFLAGS: '-modfile=unexpected', GOOS: 'windows', GOENV: '/private', RANDOM_FUTURE_LIVE_GATE: '1' });
  assert.equal(env.PATH, '/tools');
  assert.equal(env.HOME, '/fixture');
  assert.equal(env.HTTPS_PROXY, 'http://proxy');
  assert.equal(env.GOENV, 'off');
  assert.equal(env.SUPER_LEADER_NO_DOTENV, '1');
  assert.notEqual(env.GOOS, 'windows');
  for (const key of ['LIVE_DESKTOP_SEND', 'LIVE_CODEX_SESSION', 'CODEX_APP_SERVER_SOCKET',
    'SUPER_LEADER_JOURNAL_CRASH_TEST', 'SUPER_LEADER_JOURNAL_TEST_DIR', 'CONTROLLER_TOKEN', 'LEADER_MODEL_API_KEY',
    'WECHAT_CREDENTIALS_PATH', 'OPENAI_API_KEY', 'OP_SERVICE_ACCOUNT_TOKEN', 'NODE_OPTIONS', 'GOFLAGS', 'RANDOM_FUTURE_LIVE_GATE',
    'COMPOSE_ENV_FILES', 'DOTENV_CONFIG_PATH']) {
    assert.equal(env[key], undefined, key);
  }
});

test('plans build prerequisites once, include all components, and never invoke live entrypoints', () => {
  for (const suite of ['all', 'unit', 'integration']) {
    const plan = verificationPlan(suite);
    assert.equal(new Set(plan.map(step => step.id)).size, plan.length);
    assert(plan.every(step => Array.isArray(step.args) && !step.args.includes('--live')));
    assert(!plan.some(step => step.args.includes('test-live-session.mjs') || step.args.includes('test-wechat-model.mjs')));
    const integration = plan.findIndex(step => step.id === 'synthetic-integration');
    const consoleAuth = plan.find(step => step.id === 'console-auth-integration');
    if (suite === 'unit') {
      assert.equal(integration, -1);
      assert.equal(consoleAuth, undefined);
    } else {
      for (const id of ['controller-build', 'gateway-build', 'web-build']) assert(plan.findIndex(step => step.id === id) < integration);
      assert.deepEqual(consoleAuth.args, ['test-console-auth.mjs', '--run']);
    }
  }
  const unit = verificationPlan('unit');
  assert(unit.find(step => step.id === 'cli-and-tool-tests').args.includes('deploy/image-build.test.mjs'));
  assert(unit.some(step => step.id === 'daemon-race' && step.args.includes('-count=1')));
  assert.deepEqual(unit.find(step => step.id === 'terminal-delivery-sample'), {
    id: 'terminal-delivery-sample', command: 'go', args: ['run', '-race', './examples/terminal-delivery', '--run'], cwd: 'daemon', env: {},
  });
  assert.deepEqual(unit.find(step => step.id === 'daemon-linux-build').env, { GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0' });
  assert.throws(() => verificationPlan('production'), /Unknown suite/);
});

test('CLI help and list do not require external tools or read application state', () => {
  for (const args of [['--help'], ['-h'], ['--list'], ['--suite', 'unit', '--list']]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { PATH: '/nonexistent' } });
    assert.equal(result.status, 0, result.stderr);
  }
  for (const args of [['--live'], ['--suite', 'wrong'], ['unexpected']]) {
    assert.notEqual(spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { PATH: '/nonexistent' } }).status, 0);
  }
});

test('import does not execute CLI or inspect Docker', () => {
  const code = `await import(${JSON.stringify(new URL('./verify.mjs', import.meta.url).href)}); console.log('imported');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', code, '--', '--foreign'], {
    encoding: 'utf8', env: { PATH: '/nonexistent' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'imported');
});

test('Docker context is resolved readonly and pinned to its local Unix endpoint', () => {
  let probes = 0;
  const result = localDockerEnvironment({ PATH: '/tools', DOCKER_CONTEXT: 'colima', DOCKER_HOST: 'ssh://ignored' }, (command, args) => {
    probes++;
    assert.equal(command, 'docker');
    assert.deepEqual(args, ['context', 'inspect', 'colima', '--format', '{{json .Endpoints.docker.Host}}']);
    return { status: 0, stdout: '"unix:///tmp/fixture.sock"' };
  });
  assert.equal(probes, 1);
  assert.equal(result.DOCKER_HOST, 'unix:///tmp/fixture.sock');
  assert.equal(result.DOCKER_CONTEXT, undefined);
  assert.equal(localDockerEnvironment({ DOCKER_HOST: 'unix:///tmp/direct.sock' }, () => assert.fail('unexpected probe')).DOCKER_HOST,
    'unix:///tmp/direct.sock');
});

test('remote Docker endpoints, invalid inspection and unavailable tool fail before any container action', () => {
  for (const host of ['ssh://production', 'tcp://127.0.0.1:2375', 'https://remote', 'unix://relative', 'unix:///tmp/a?x', 'unix:///tmp/a\n']) {
    assert.throws(() => localDockerEnvironment({ DOCKER_HOST: host }, () => assert.fail('unexpected probe')), /local Unix Docker/);
  }
  for (const result of [{ error: new Error('missing') }, { status: 1, stdout: '' }, { status: 0, stdout: 'bad-json' }]) {
    assert.throws(() => localDockerEnvironment({}, () => result));
  }
});

test('step failure propagates and stops subsequent checks without invoking a shell', async () => {
  const calls = [];
  await assert.rejects(runSteps(verificationPlan('unit'), { env: {}, execute: async step => {
    calls.push(step.id);
    throw new Error('synthetic tool failure');
  } }), /synthetic tool failure/);
  assert.deepEqual(calls, ['controller-typecheck']);
});

test('interrupt waits for active step cleanup and prevents the next check', async () => {
  const controller = new AbortController(), calls = [];
  await assert.rejects(runSteps(verificationPlan('unit'), { env: {}, signal: controller.signal, execute: async step => {
    calls.push(step.id);
    controller.abort(new Error('stop requested'));
    await Promise.resolve();
    calls.push('cleaned');
  } }), /stop requested/);
  assert.deepEqual(calls, ['controller-typecheck', 'cleaned']);
});
