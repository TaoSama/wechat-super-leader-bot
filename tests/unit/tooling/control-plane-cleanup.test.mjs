import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { createPostgresFixture } from '../../support/control-plane-fixture.mjs';

const env = { DOCKER_HOST: 'unix:///fixture-only/docker.sock' };
const CONTAINER_ID = 'owned-container-id';
const OWNER_LABEL = 'super-leader.test.fixture-owner';

function dockerFixture(t, { runFails = true, exists = true, foreign = false, failCommand } = {}) {
  const calls = [];
  const timeout = Object.assign(new Error('Synthetic Docker run timeout'), { code: 'ETIMEDOUT' });
  const cleanupError = new Error('Synthetic Docker cleanup failure');
  let name, owner;
  t.mock.method(childProcess, 'execFileSync', (command, args, options) => {
    assert.equal(command, 'docker');
    assert.equal(options.timeout, 30_000, 'Preserve the existing Docker timeout');
    assert.equal(options.env.DOCKER_HOST, env.DOCKER_HOST);
    calls.push(args);
    if (args[0] === failCommand) throw cleanupError;
    if (args[0] === 'run') {
      name = args[args.indexOf('--name') + 1];
      const label = args[args.indexOf('--label') + 1];
      assert.ok(label.startsWith(`${OWNER_LABEL}=`));
      owner = label.slice(OWNER_LABEL.length + 1);
      assert.equal(name, `super-leader-test-${owner}`);
      if (runFails) throw timeout;
      return CONTAINER_ID;
    }
    if (args[0] === 'ps') {
      assert.deepEqual(args, ['ps', '--all', '--filter', `name=^/${name}$`, '--format', '{{.ID}}']);
      return exists ? CONTAINER_ID : '';
    }
    if (args[0] === 'inspect') {
      assert.equal(args.at(-1), CONTAINER_ID);
      return JSON.stringify({ id: CONTAINER_ID, name: `/${name}`, owner: foreign ? 'another-fixture' : owner });
    }
    if (args[0] === 'rm') {
      assert.deepEqual(args, ['rm', '--force', '--volumes', CONTAINER_ID]);
      exists = false;
      return CONTAINER_ID;
    }
    if (args[0] === 'port') return '127.0.0.1:54321';
    if (args[0] === 'exec') return 'accepting connections';
    assert.fail(`Unexpected Docker command: ${args[0]}`);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { postgres: createPostgresFixture({ env }), calls, timeout, cleanupError };
}

test('timed-out run still cleans its uniquely labelled container by immutable ID', async t => {
  const { postgres, calls, timeout } = dockerFixture(t);
  await assert.rejects(postgres.start(), error => error === timeout);
  postgres.stop();
  assert.deepEqual(calls.map(args => args[0]), ['run', 'ps', 'inspect', 'rm']);
  postgres.stop();
  assert.equal(calls.length, 4, 'Successful cleanup is idempotent');
});

test('run failure before creation does not remove a container', async t => {
  const { postgres, calls, timeout } = dockerFixture(t, { exists: false });
  await assert.rejects(postgres.start(), error => error === timeout);
  postgres.stop();
  assert.deepEqual(calls.map(args => args[0]), ['run', 'ps']);
});

test('matching name with another owner is protected from removal', async t => {
  const { postgres, calls } = dockerFixture(t, { foreign: true });
  await assert.rejects(postgres.start());
  assert.throws(() => postgres.stop(), /not owned by this fixture/);
  assert.ok(!calls.some(args => args[0] === 'rm'));
});

for (const failCommand of ['ps', 'inspect', 'rm']) {
  test(`cleanup ${failCommand} failure is propagated and remains retryable`, async t => {
    const { postgres, calls, cleanupError } = dockerFixture(t, { failCommand });
    await assert.rejects(postgres.start());
    assert.throws(() => postgres.stop(), error => error === cleanupError);
    assert.throws(() => postgres.stop(), error => error === cleanupError);
    assert.equal(calls.filter(args => args[0] === failCommand).length, 2);
  });
}

test('successful start retains connection behavior and cleans only its own container', async t => {
  const { postgres, calls } = dockerFixture(t, { runFails: false });
  const url = new URL(await postgres.start());
  assert.equal(url.port, '54321');
  assert.equal(url.password, postgres.password);
  postgres.stop();
  assert.deepEqual(calls.map(args => args[0]), ['run', 'port', 'exec', 'ps', 'inspect', 'rm']);
});
