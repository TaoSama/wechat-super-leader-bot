import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { rm, stat } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';
import test from 'node:test';
import { transferSshFixture } from '../../support/transfer-ssh-fixture.mjs';
import { TransferProcesses } from '../../../scripts/deploy/transfer-process.mjs';

const SECRET = 'SYNTHETIC_TOKEN https://private.invalid /private/key';

function commands(t, { initializationFails = false, containerCleanupFails = false, imageCleanupFails = false } = {}) {
  const calls = [];
  const primary = Object.assign(new Error(SECRET), { code: 'ETIMEDOUT' });
  const containerCleanup = Object.assign(new Error(SECRET), { code: 'EACCES' });
  const imageCleanup = Object.assign(new Error(SECRET), { status: 1 });
  let root;
  const originalHost = process.env.DOCKER_HOST, originalContext = process.env.DOCKER_CONTEXT;
  process.env.DOCKER_HOST = 'unix:///synthetic-fixture/docker.sock';
  delete process.env.DOCKER_CONTEXT;
  t.mock.method(childProcess, 'execFileSync', (tool, args, options) => {
    assert.equal(options.timeout, 120_000);
    assert.equal(options.env.DOCKER_HOST, process.env.DOCKER_HOST);
    if (tool === 'ssh-keygen') { root = dirname(args.at(-1)); return ''; }
    assert.equal(tool, 'docker');
    calls.push(args);
    if (args[0] === 'start' && initializationFails) throw primary;
    if (args[0] === 'rm' && containerCleanupFails) throw containerCleanup;
    if (args[0] === 'image' && imageCleanupFails) throw imageCleanup;
    if (args[0] === 'port') return '127.0.0.1:54321';
    if (args[0] === 'exec') return 'ssh-ed25519 AAAASYNTHETIC fixture\n';
    return '';
  });
  t.mock.method(TransferProcesses.prototype, 'run', async () => ({ code: 0 }));
  syncBuiltinESMExports();
  t.after(async () => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    if (originalHost === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = originalHost;
    if (originalContext === undefined) delete process.env.DOCKER_CONTEXT; else process.env.DOCKER_CONTEXT = originalContext;
    if (root) await rm(root, { recursive: true, force: true });
  });
  return { calls, primary, containerCleanup, imageCleanup, root: () => root };
}

test('fixture creation preserves primary while trying container, image and directory cleanup', async t => {
  const fake = commands(t, { initializationFails: true, containerCleanupFails: true, imageCleanupFails: true });
  await assert.rejects(transferSshFixture(), error => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, fake.primary);
    assert.equal(error.errors[0], fake.primary);
    assert.deepEqual(error.errors[1].errors, [fake.containerCleanup, fake.imageCleanup]);
    return true;
  });
  assert.deepEqual(fake.calls.map(args => args[0]), ['build', 'create', 'cp', 'start', 'rm', 'image']);
  await assert.rejects(stat(fake.root()), { code: 'ENOENT' });
});

test('fixture close collects every cleanup failure and still removes its directory', async t => {
  const fake = commands(t, { containerCleanupFails: true, imageCleanupFails: true });
  const fixture = await transferSshFixture();
  await assert.rejects(fixture.close(), error => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [fake.containerCleanup, fake.imageCleanup]);
    return true;
  });
  assert.deepEqual(fake.calls.slice(-2).map(args => args[0]), ['rm', 'image']);
  await assert.rejects(stat(fake.root()), { code: 'ENOENT' });
});

test('fixture creation failure is unchanged when all cleanup succeeds', async t => {
  const fake = commands(t, { initializationFails: true });
  await assert.rejects(transferSshFixture(), error => error === fake.primary);
  assert.deepEqual(fake.calls.slice(-2).map(args => args[0]), ['rm', 'image']);
  await assert.rejects(stat(fake.root()), { code: 'ENOENT' });
});
