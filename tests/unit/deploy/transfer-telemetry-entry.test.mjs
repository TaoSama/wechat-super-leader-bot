import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { runSenderTelemetry, verifySenderTelemetry } from '../../integration/deploy/transfer-telemetry.mjs';
import { verificationEnvironment } from '../../../scripts/verify.mjs';

const SECRET = 'SYNTHETIC_TOKEN https://credential.invalid/private /private/key';
const ENTRY = fileURLToPath(new URL('../../integration/deploy/transfer-telemetry.mjs', import.meta.url));
const EVIDENCE = { event: 'linux_sender_telemetry_verified', children_active: 0, sigterm_cancelled: true,
  elapsed_ms: 100, first: { tcp: { bytes_sent: 1 } }, second: { tcp: { bytes_sent: 2 } } };
const DIAGNOSTIC = { event: 'linux_sender_telemetry_failed', phase: 'sender_validation', category: 'rtt_missing' };
const unsafeError = fields => Object.assign(new Error(SECRET), fields);

async function fixture(t, { prepareError, runtimeError, cleanupError, closeError, output = JSON.stringify(EVIDENCE) } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sender-telemetry-entry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(console, 'log', () => {});
  await writeFile(join(root, 'known_hosts'), 'synthetic ssh-ed25519 AAAASYNTHETIC\n');
  const calls = [];
  return { root, calls, values: { 'key-file': join(root, 'client'), 'known-hosts-file': join(root, 'known_hosts') },
    copyToContainer() {},
    runInContainer(args, options) {
      calls.push(args[0]);
      if (args[0] === 'mkdir' && prepareError) throw prepareError;
      if (args[0] === 'node') {
        assert.deepEqual(options, { timeout: 20_000 });
        if (runtimeError) throw runtimeError;
        return output;
      }
      if (args[0] === 'rm' && cleanupError) throw cleanupError;
      return '';
    },
    async close() { calls.push('close'); if (closeError) throw closeError; },
  };
}

function safeFailure(error, phase, category, cleanupCategory) {
  assert.equal(error.phase, phase);
  assert.equal(error.category, category);
  assert.equal(error.message, category);
  assert.equal(error.cleanupCategory, cleanupCategory);
  assert.ok(!JSON.stringify(error).includes('SYNTHETIC'));
  assert.ok(!JSON.stringify(error).includes('credential.invalid'));
  return true;
}

test('copied sender entry includes its complete static import closure', async t => {
  const value = await fixture(t);
  await writeFile(value.values['key-file'], 'synthetic client fixture');
  const container = join(value.root, 'container');
  const localPath = path => join(container, relative('/fixture/sender-telemetry', path));
  value.copyToContainer = (source, destination) => copyFileSync(source, localPath(destination));
  let imported;
  value.runInContainer = args => {
    if (args[0] === 'mkdir') {
      for (const path of args.slice(2)) mkdirSync(localPath(path), { recursive: true });
    } else if (args[0] === 'node') {
      imported = spawnSync(process.execPath, ['--input-type=module', '--eval',
        `await import(${JSON.stringify(pathToFileURL(localPath(args[1])).href)})`],
      { encoding: 'utf8', timeout: 5_000 });
      if (imported.error) throw imported.error;
      assert.equal(imported.status, 0, imported.stderr);
      return JSON.stringify(EVIDENCE);
    } else if (args[0] === 'rm') rmSync(localPath(args.at(-1)), { recursive: true, force: true });
    else assert.fail(`Unexpected fixture operation: ${args[0]}`);
    return '';
  };
  assert.deepEqual(await verifySenderTelemetry(value), EVIDENCE);
  assert.equal(imported.status, 0);
  assert.equal(imported.stderr, '');
  assert.deepEqual((await readdir(value.root)).sort(), ['client', 'known_hosts']);
});

test('prepare and cleanup failures preserve primary and still remove the host temporary directory', async t => {
  const value = await fixture(t, { prepareError: unsafeError({}), cleanupError: unsafeError({ code: 'EACCES' }) });
  await assert.rejects(verifySenderTelemetry(value), error => safeFailure(error, 'sender_prepare', 'probe_failed', 'permission_denied'));
  assert.deepEqual(value.calls, ['mkdir', 'rm']);
  assert.deepEqual(await readdir(value.root), ['known_hosts']);
});

test('temporary directory creation is classified and container cleanup is attempted', async t => {
  const value = await fixture(t);
  value.root = join(value.root, 'missing');
  await assert.rejects(verifySenderTelemetry(value), error => safeFailure(error, 'sender_prepare', 'file_missing'));
  assert.deepEqual(value.calls, ['rm']);
});

test('validated container phases and cleanup category survive all outer cleanup layers', async t => {
  const diagnostic = { ...DIAGNOSTIC, cleanup_category: 'process_stop', ignored: SECRET };
  const value = await fixture(t, { runtimeError: unsafeError({ status: 1, stderr: JSON.stringify(diagnostic) }),
    cleanupError: unsafeError({ code: 'EACCES' }), closeError: unsafeError({ code: 'EIO' }) });
  await assert.rejects(runSenderTelemetry(async () => value),
    error => safeFailure(error, 'sender_validation', 'rtt_missing', 'process_stop'));
  assert.deepEqual(value.calls, ['mkdir', 'node', 'rm', 'close']);
  assert.deepEqual(await readdir(value.root), ['known_hosts']);
});

for (const [name, diagnostic] of [
  ['event', { ...DIAGNOSTIC, event: 'another_event' }],
  ['phase', { ...DIAGNOSTIC, phase: 'synthetic_private_phase' }],
  ['category', { ...DIAGNOSTIC, category: 'synthetic_private_category' }],
  ['cleanup category', { ...DIAGNOSTIC, cleanup_category: 'synthetic_private_category' }],
  ['null cleanup category', { ...DIAGNOSTIC, cleanup_category: null }],
  ['null diagnostic', null],
]) {
  test(`container diagnostics reject an untrusted ${name}`, async t => {
    const value = await fixture(t, { runtimeError: unsafeError({ status: 1, stderr: JSON.stringify(diagnostic) }) });
    await assert.rejects(verifySenderTelemetry(value), error => safeFailure(error, 'sender_runtime', 'command_failed'));
  });
}

test('native container timeouts retain a safe runtime category without stderr', async t => {
  const value = await fixture(t, { runtimeError: unsafeError({ code: 'ETIMEDOUT', stderr: SECRET }) });
  await assert.rejects(verifySenderTelemetry(value), error => safeFailure(error, 'sender_runtime', 'command_timeout'));
});

for (const [output, category] of [['{', 'invalid_json'], [JSON.stringify({ ...EVIDENCE, children_active: 1 }), 'assertion_failed']]) {
  test(`host validation retains ${category} and cleans both directories`, async t => {
    const value = await fixture(t, { output });
    await assert.rejects(verifySenderTelemetry(value), error => safeFailure(error, 'host_validation', category));
    assert.equal(value.calls.at(-1), 'rm');
    assert.deepEqual(await readdir(value.root), ['known_hosts']);
  });
}

test('cleanup-only failure is reported at cleanup and fixture close still runs', async t => {
  const value = await fixture(t, { cleanupError: unsafeError({ code: 'EACCES' }), closeError: unsafeError({ code: 'EIO' }) });
  await assert.rejects(runSenderTelemetry(async () => value),
    error => safeFailure(error, 'cleanup', 'permission_denied', 'io_error'));
  assert.deepEqual(value.calls, ['mkdir', 'node', 'rm', 'close']);
  assert.deepEqual(await readdir(value.root), ['known_hosts']);
});

test('fixture initialization aggregate retains primary and safe cleanup classification', async () => {
  const primary = unsafeError({ code: 'ETIMEDOUT' });
  const cleanup = new AggregateError([unsafeError({ code: 'EACCES' }), unsafeError({ status: 1 })], SECRET);
  await assert.rejects(runSenderTelemetry(async () => {
    throw new AggregateError([primary, cleanup], SECRET, { cause: primary });
  }), error => safeFailure(error, 'fixture_create', 'command_timeout', 'permission_denied'));
});

for (const [name, args, overrides, phase, category] of [
  ['arguments', ['--unknown', SECRET], {}, 'arguments', 'invalid_options'],
  ['conflicting modes', ['--run', '--in-container'], {}, 'arguments', 'conflicting_modes'],
  ['fixture creation', ['--run'], { DOCKER_CONTEXT: '', DOCKER_HOST: 'tcp://SYNTHETIC_PRIVATE_ENDPOINT' }, 'fixture_create', 'probe_failed'],
  ['container preparation', ['--in-container'], {}, 'sender_prepare', 'linux_node24_required'],
]) {
  test(`CLI ${name} failure prints only a fixed diagnostic`, t => {
    if (name === 'container preparation' && process.platform === 'linux' && process.versions.node.startsWith('24.')) {
      t.skip('The host already meets the container runtime precondition'); return;
    }
    const result = spawnSync(process.execPath, [ENTRY, ...args], { env: { ...verificationEnvironment(), ...overrides }, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), { event: 'linux_sender_telemetry_failed', phase, category });
    assert.ok(!result.stderr.includes('SYNTHETIC'));
  });
}
