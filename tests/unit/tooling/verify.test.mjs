import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { verificationEnvironment, verificationPlan, parallelVerificationPlan, formatVerificationError, runParallelGroups, runParallelPool,
  localDockerEnvironment, runSteps } from '../../../scripts/verify.mjs';

const cli = fileURLToPath(new URL('../../../scripts/verify.mjs', import.meta.url));

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
    assert(!plan.some(step => step.args.includes('tests/live/session.mjs') || step.args.includes('tests/live/wechat-model.mjs')));
    const integration = plan.findIndex(step => step.id === 'synthetic-integration');
    const consoleAuth = plan.find(step => step.id === 'console-auth-integration');
    const wechat = plan.find(step => step.id === 'wechat-interaction');
    if (suite === 'unit') {
      assert.equal(integration, -1);
      assert.equal(consoleAuth, undefined);
      assert.equal(wechat, undefined);
    } else {
      for (const id of ['controller-build', 'gateway-build', 'web-build']) assert(plan.findIndex(step => step.id === id) < integration);
      assert.deepEqual(consoleAuth.args, ['tests/integration/console-auth.mjs', '--run']);
      assert.deepEqual(wechat.args, ['tests/integration/leader/wechat-interaction.mjs', '--run']);
    }
  }
  const unit = verificationPlan('unit');
  assert(unit.find(step => step.id === 'cli-and-tool-tests').args.includes('tests/unit/deploy/image-build.test.mjs'));
  assert.deepEqual(unit.find(step => step.id === 'controller-tests').args.slice(-3), ['vitest', 'run', '--no-file-parallelism']);
  assert.deepEqual(unit.find(step => step.id === 'web-tests').args.slice(-3), ['vitest', 'run', '--no-file-parallelism']);
  assert(unit.some(step => step.id === 'daemon-race' && step.args.includes('-count=1')));
  assert.deepEqual(unit.find(step => step.id === 'terminal-delivery-sample'), {
    id: 'terminal-delivery-sample', command: 'go', args: ['run', '-race', './examples/terminal-delivery', '--run'], cwd: 'daemon', env: {},
  });
  assert.deepEqual(unit.find(step => step.id === 'daemon-linux-build').env, { GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0' });
  assert.throws(() => verificationPlan('production'), /Unknown suite/);
});

test('parallel plan preserves every serial check while sharing component builds', () => {
  const serial = verificationPlan('all', { skipNativeProgress: true });
  const parallel = parallelVerificationPlan('all', { skipNativeProgress: true });
  const parallelIds = [...parallel.builds, ...parallel.unit, ...parallel.integration].map(step => step.id);
  assert.deepEqual(new Set(parallelIds), new Set(serial.map(step => step.id)));
  assert.equal(parallel.builds.length, 3);
  assert.equal(parallel.unit.some(step => step.id === 'controller-build'), false);
  assert.equal(parallel.integration.some(step => step.id === 'native-progress-steering'), false);
  assert.deepEqual(parallelVerificationPlan('unit').integration, []);
  assert.deepEqual(parallelVerificationPlan('integration').unit, []);
});

test('parallel runner completes all builds before collecting every group failure', async () => {
  const events = [];
  const step = id => ({ id, command: 'synthetic', args: [], cwd: '.', env: {} });
  const execute = async current => {
    events.push(`start:${current.id}`);
    await delay(2);
    events.push(`done:${current.id}`);
    if (current.id.startsWith('fail-')) throw new Error(current.id);
  };
  await assert.rejects(runParallelGroups({
    builds: [step('build-a'), step('build-b')],
    unit: [step('fail-unit-a'), step('fail-unit-b'), step('unit-ok')],
    integration: [],
  }, { env: {}, signal: new AbortController().signal, execute }), error => {
    assert(error instanceof AggregateError);
    const formatted = formatVerificationError(error).join('\n');
    assert.match(formatted, /fail-unit-a/);
    assert.match(formatted, /fail-unit-b/);
    assert(events.indexOf('start:fail-unit-a') > events.indexOf('done:build-a'));
    assert(events.indexOf('start:fail-unit-a') > events.indexOf('done:build-b'));
    assert(events.includes('done:fail-unit-a'));
    assert(events.includes('done:fail-unit-b'));
    assert(events.includes('done:unit-ok'));
    return true;
  });
});

test('parallel runner serializes latency variants after other integration checks', async () => {
  const events = [], active = { count: 0, max: 0 };
  const step = id => ({ id, command: 'synthetic', args: [], cwd: '.', env: {} });
  const execute = async current => {
    active.count++;
    active.max = Math.max(active.max, active.count);
    events.push(`start:${current.id}`);
    await delay(2);
    events.push(`done:${current.id}`);
    active.count--;
  };
  await runParallelGroups({ builds: [], unit: [], integration: [step('other-integration'), step('message-latency'),
    step('direct-directory-latency'), step('direct-console-latency')] }, { env: {}, signal: new AbortController().signal, execute });
  assert(events.indexOf('start:message-latency') > events.indexOf('done:other-integration'));
  assert(events.indexOf('start:direct-directory-latency') > events.indexOf('done:message-latency'));
  assert(events.indexOf('start:direct-console-latency') > events.indexOf('done:direct-directory-latency'));
  assert.equal(active.max, 1);
});

test('parallel runner keeps the long WeChat integration outside the PostgreSQL pool', async () => {
  const events = [];
  const step = id => ({ id, command: 'synthetic', args: [], cwd: '.', env: {} });
  const execute = async current => {
    events.push(`start:${current.id}`);
    await delay(current.id === 'wechat-interaction' ? 8 : 2);
    events.push(`done:${current.id}`);
  };
  await runParallelGroups({ builds: [], unit: [], integration: [
    step('wechat-interaction'), step('synthetic-integration'), step('console-auth-integration'),
    step('task-notifications-postgres'), step('scheduled-sessions-postgres'),
  ] }, { env: {}, signal: new AbortController().signal, execute });
  assert.equal(events.filter(event => event === 'start:wechat-interaction').length, 1);
  assert(events.indexOf('start:wechat-interaction') < events.indexOf('done:wechat-interaction'));
  assert(events.indexOf('start:wechat-interaction') < events.indexOf('done:synthetic-integration'));
  for (const id of ['synthetic-integration', 'console-auth-integration', 'task-notifications-postgres', 'scheduled-sessions-postgres']) {
    assert(events.indexOf(`start:${id}`) < events.indexOf('done:wechat-interaction'), id);
  }
});

test('parallel runner completes controller unit checks before starting the remainder pool', async () => {
  const events = [], active = { count: 0, max: 0, controllerMax: 0, remainderMax: 0 };
  const step = id => ({ id, command: 'synthetic', args: [], cwd: '.', env: {} });
  const execute = async current => {
    active.count++;
    active.max = Math.max(active.max, active.count);
    if (current.id.startsWith('controller-')) active.controllerMax = Math.max(active.controllerMax, active.count);
    else active.remainderMax = Math.max(active.remainderMax, active.count);
    events.push(`start:${current.id}`);
    await delay(2);
    events.push(`done:${current.id}`);
    active.count--;
  };
  await runParallelGroups({ builds: [], unit: [step('controller-typecheck'), step('controller-tests'), step('gateway-tests'), step('web-tests'), step('daemon-race')], integration: [] }, {
    env: {}, signal: new AbortController().signal, execute,
  });
  assert(events.indexOf('start:controller-tests') > events.indexOf('done:controller-typecheck'));
  const controllerDone = Math.max(events.indexOf('done:controller-typecheck'), events.indexOf('done:controller-tests'));
  for (const id of ['gateway-tests', 'web-tests', 'daemon-race']) {
    assert(events.indexOf(`start:${id}`) > controllerDone, id);
  }
  assert.equal(active.controllerMax, 1);
  assert.equal(active.remainderMax, 2);
});

test('parallel runner keeps controller unit checks serial and stops before the remainder on failure', async () => {
  const events = [], active = { count: 0, max: 0 };
  const step = id => ({ id, command: 'synthetic', args: [], cwd: '.', env: {} });
  const execute = async current => {
    active.count++;
    active.max = Math.max(active.max, active.count);
    events.push(`start:${current.id}`);
    await delay(2);
    active.count--;
    if (current.id === 'controller-typecheck') throw new Error('controller failed');
    events.push(`done:${current.id}`);
  };
  await assert.rejects(runParallelGroups({ builds: [], unit: [step('controller-typecheck'), step('controller-tests'), step('gateway-tests'), step('web-tests'), step('daemon-race')], integration: [] }, {
    env: {}, signal: new AbortController().signal, execute,
  }), error => {
    assert(error instanceof AggregateError);
    assert.match(formatVerificationError(error).join('\n'), /controller failed/);
    assert.equal(events.filter(event => event.startsWith('start:')).filter(event => !event.includes('controller')).length, 0);
    assert.equal(events.includes('start:controller-tests'), false);
    assert.equal(active.max, 1);
    return true;
  });
});

test('parallel runner escalates abort cleanup when a child ignores SIGTERM', async () => {
  const controller = new AbortController();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const running = runParallelPool([{
    id: 'term-ignoring', command: process.execPath,
    args: ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 10_000)"], cwd: '.', env: {},
  }], { env: {}, concurrency: 1, signal: controller.signal, onStep: started });
  await ready;
  await delay(100);
  controller.abort(new Error('synthetic stop'));
  await assert.rejects(running, error => {
    assert(error instanceof AggregateError);
    assert.match(formatVerificationError(error).join('\n'), /term-ignoring: failed \(SIGKILL\)/);
    return true;
  });
});

test('parallel runner terminates active child processes on abort and never reports success', async () => {
  const controller = new AbortController();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const running = runParallelPool([{
    id: 'long-running', command: process.execPath, args: ['-e', 'setInterval(() => {}, 10_000)'], cwd: '.', env: {},
  }], { env: {}, concurrency: 1, signal: controller.signal, onStep: started });
  await ready;
  await delay(100);
  controller.abort(new Error('synthetic stop'));
  await assert.rejects(running, error => {
    assert(error instanceof AggregateError);
    assert.match(error.errors[0].message, /failed \(SIGTERM\)|failed \(SIGKILL\)/);
    return true;
  });
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
  const code = `await import(${JSON.stringify(new URL('../../../scripts/verify.mjs', import.meta.url).href)}); console.log('imported');`;
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
