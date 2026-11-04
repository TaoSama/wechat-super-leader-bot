import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { RELEASE_FILES } from '../../../scripts/deploy/transfer-files.mjs';
import { TransferFailure } from '../../../scripts/deploy/transfer-process.mjs';
import { ReleaseTransfer, transferConfiguration } from '../../../scripts/deploy/transfer-release.mjs';
import { MANIFEST_MAX_BYTES, MANIFEST_FILENAME, manifestIdentity, validateTransferManifest,
  readTransferManifest, createTransferManifest, verifyLocalManifest,
  manifestArtifactName } from '../../../scripts/deploy/transfer-manifest.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PREPARE = join(ROOT, 'scripts/deploy/prepare-transfer-manifest.mjs');
const ENV = { DEPLOY_HOST: 'fixture.example', DEPLOY_USER: 'fixture', DEPLOY_PATH: '/tmp/fixture',
  REVISION: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' };
const IDENTITY = manifestIdentity({ revision: ENV.REVISION, run: ENV.GITHUB_RUN_ID, attempt: ENV.GITHUB_RUN_ATTEMPT });
const SHA_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const SECRET = 'SYNTHETIC_PRIVATE_MANIFEST_TOKEN';

function wire() {
  return { schema: 1, revision: ENV.REVISION, run_id: 123, attempt: 2,
    files: RELEASE_FILES.map(name => ({ name, bytes: 3, sha256: SHA_ABC })), total_bytes: 30 };
}

async function fixture(t, { frozen = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'frozen-transfer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'payload'), path = join(directory, MANIFEST_FILENAME);
  await mkdir(root);
  for (const name of RELEASE_FILES) await writeFile(join(root, name), 'abc');
  const manifest = await createTransferManifest(root, IDENTITY);
  if (frozen) await writeFile(path, JSON.stringify(manifest), { flag: 'wx' });
  return { directory, root, path, manifest,
    values: { 'release-root': root, 'manifest-file': path, 'manifest-artifact-id': '456',
      'key-file': '/tmp/synthetic-key', 'known-hosts-file': '/tmp/synthetic-known-hosts' } };
}

function prepare(f, extra = [], env = ENV) {
  return spawnSync(process.execPath, [PREPARE, '--release-root', f.root, '--output', f.path, ...extra], {
    cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 5000,
  });
}

test('manifest identity is numeric, immutable and names one revision/run/attempt artifact', () => {
  assert.deepEqual(IDENTITY, { revision: ENV.REVISION, run_id: 123, attempt: 2 });
  assert.ok(Object.isFrozen(IDENTITY));
  assert.equal(MANIFEST_MAX_BYTES, 16 * 1024);
  assert.equal(MANIFEST_FILENAME, 'transfer-manifest.json');
  assert.equal(manifestArtifactName(IDENTITY), `release-transfer-manifest-${ENV.REVISION}-123-2`);
  assert.notEqual(manifestArtifactName({ ...IDENTITY, attempt: 3 }), manifestArtifactName(IDENTITY));
});

for (const [name, value] of [['zero run', { run: '0' }], ['unsafe run', { run: '9007199254740992' }],
  ['fractional attempt', { attempt: '1.5' }], ['unsafe attempt', { attempt: Number.MAX_SAFE_INTEGER + 1 }],
  ['nonrevision', { revision: 'main' }], ['uppercase revision', { revision: 'A'.repeat(40) }]]) {
  test(`manifest identity rejects ${name}`, () => {
    assert.throws(() => manifestIdentity({ revision: ENV.REVISION, run: '123', attempt: '2', ...value }),
      { category: 'manifest_identity' });
  });
}

test('validation copies and freezes every field without sharing caller-owned data', () => {
  const original = wire(), validated = validateTransferManifest(original, IDENTITY);
  assert.deepEqual(validated, wire());
  assert.notEqual(validated, original);
  assert.notEqual(validated.files, original.files);
  assert.ok(Object.isFrozen(validated) && Object.isFrozen(validated.files));
  assert.ok(validated.files.every(Object.isFrozen));
  original.files[0].bytes = 99;
  assert.equal(validated.files[0].bytes, 3);
});

const invalidWires = [
  ['extra root key', value => { value.secret = SECRET; }],
  ['missing root key', value => { delete value.schema; }],
  ['wrong schema', value => { value.schema = 2; }],
  ['string schema', value => { value.schema = '1'; }],
  ['different revision', value => { value.revision = 'b'.repeat(40); }],
  ['different run', value => { value.run_id = 124; }],
  ['different attempt', value => { value.attempt = 3; }],
  ['string run', value => { value.run_id = '123'; }],
  ['unsafe run', value => { value.run_id = Number.MAX_SAFE_INTEGER + 1; }],
  ['zero attempt', value => { value.attempt = 0; }],
  ['missing file', value => { value.files.pop(); }],
  ['extra file', value => { value.files.push({ ...value.files[0] }); }],
  ['duplicate file', value => { value.files[1].name = value.files[0].name; }],
  ['path file', value => { value.files[0].name = '../controller.tar'; }],
  ['unknown file', value => { value.files[0].name = 'unapproved.tar'; }],
  ['extra file key', value => { value.files[0].path = SECRET; }],
  ['missing hash', value => { delete value.files[0].sha256; }],
  ['uppercase hash', value => { value.files[0].sha256 = SHA_ABC.toUpperCase(); }],
  ['short hash', value => { value.files[0].sha256 = 'a'.repeat(63); }],
  ['negative length', value => { value.files[0].bytes = -1; }],
  ['fractional length', value => { value.files[0].bytes = 1.5; }],
  ['string length', value => { value.files[0].bytes = '3'; }],
  ['boolean length', value => { value.files[0].bytes = true; }],
  ['null length', value => { value.files[0].bytes = null; }],
  ['nonfinite length', value => { value.files[0].bytes = Infinity; }],
  ['unsafe length', value => { value.files[0].bytes = Number.MAX_SAFE_INTEGER + 1; }],
  ['wrong total', value => { value.total_bytes = 29; }],
  ['string total', value => { value.total_bytes = '30'; }],
  ['nonarray files', value => { value.files = {}; }],
  ['unsafe sum', value => { value.files[0].bytes = Number.MAX_SAFE_INTEGER; value.total_bytes = Number.MAX_SAFE_INTEGER; }],
];
for (const [name, mutate] of invalidWires) {
  test(`manifest rejects ${name}`, () => {
    const value = wire();
    mutate(value);
    assert.throws(() => validateTransferManifest(value, IDENTITY), error => {
      assert.ok(['manifest_invalid', 'manifest_identity'].includes(error.category));
      assert.ok(!error.message.includes(SECRET));
      return true;
    });
  });
}

test('creation hashes the exact ten local files and reading preserves the frozen wire', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.manifest, wire());
  assert.deepEqual(await readTransferManifest(f.path, IDENTITY), wire());
  await verifyLocalManifest(f.root, f.manifest);
});

test('manifest reader closes once and preserves read failures when closing also fails', { concurrency: false }, async t => {
  const primary = new TransferFailure('manifest_file');
  const plainReadFailure = Object.assign(new Error(SECRET), { code: 'EIO' });
  const closeFailure = Object.assign(new Error(SECRET), { code: 'EBADF' });
  for (const { name, readFailure, closeFails, preserveIdentity } of [
    { name: 'successful read rejects a close failure', closeFails: true },
    { name: 'original read failure survives a successful close', readFailure: primary, preserveIdentity: true },
    { name: 'original read failure survives a failing close', readFailure: primary, closeFails: true, preserveIdentity: true },
    { name: 'ordinary read errors map to manifest_file', readFailure: plainReadFailure },
    { name: 'ordinary read errors map to manifest_file when close fails', readFailure: plainReadFailure, closeFails: true },
  ]) {
    await t.test(name, async t => {
      const contents = Buffer.from(JSON.stringify(wire()));
      let closeCalls = 0;
      const handle = {
        async stat() { return { isFile: () => true, size: contents.length, mtimeMs: 0, ctimeMs: 0 }; },
        async read(buffer, offset, length, position) {
          if (readFailure) throw readFailure;
          return { bytesRead: contents.copy(buffer, offset, position, Math.min(position + length, contents.length)) };
        },
        async close() { closeCalls++; if (closeFails) throw closeFailure; },
      };
      t.mock.method(fs, 'open', async () => handle);
      syncBuiltinESMExports();
      t.after(() => {
        t.mock.restoreAll(); syncBuiltinESMExports();
        assert.equal(closeCalls, 1, 'every opened manifest handle is closed exactly once');
      });
      await assert.rejects(readTransferManifest(join(tmpdir(), MANIFEST_FILENAME), IDENTITY), error => {
        if (preserveIdentity) assert.equal(error, readFailure);
        assert.ok(error instanceof TransferFailure);
        assert.equal(error.category, 'manifest_file');
        assert.ok(!error.stack.includes(SECRET));
        return true;
      });
    });
  }
});

test('manifest reader rejects oversized, malformed and symbolic-link input', async t => {
  const f = await fixture(t);
  for (const content of ['x'.repeat(MANIFEST_MAX_BYTES + 1), '{broken', JSON.stringify({ secret: SECRET })]) {
    await writeFile(f.path, content);
    await assert.rejects(readTransferManifest(f.path, IDENTITY));
  }
  const linkedDirectory = join(f.directory, 'linked');
  await mkdir(linkedDirectory);
  const link = join(linkedDirectory, MANIFEST_FILENAME);
  await writeFile(f.path, JSON.stringify(wire()));
  await symlink(f.path, link);
  await assert.rejects(readTransferManifest(link, IDENTITY), { category: 'manifest_file' });
  const directory = join(f.directory, 'directory', MANIFEST_FILENAME);
  await mkdir(directory, { recursive: true });
  await assert.rejects(readTransferManifest(directory, IDENTITY), { category: 'manifest_file' });
});

test('reader accepts an exact-size valid document and rejects the next byte', async t => {
  const f = await fixture(t), serialized = JSON.stringify(wire());
  const bounded = serialized + ' '.repeat(MANIFEST_MAX_BYTES - Buffer.byteLength(serialized));
  await writeFile(f.path, bounded);
  assert.deepEqual(await readTransferManifest(f.path, IDENTITY), wire());
  await writeFile(f.path, bounded + ' ');
  await assert.rejects(readTransferManifest(f.path, IDENTITY));
});

test('frozen SHA rejects same-length payload changes instead of silently recomputing a new manifest', async t => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'controller.tar'), 'xyz');
  await assert.rejects(verifyLocalManifest(f.root, f.manifest), { category: 'manifest_local_mismatch' });
  assert.deepEqual(await readTransferManifest(f.path, IDENTITY), wire());
});

test('archive symlinks and missing payload cannot enter or pass the frozen manifest', async t => {
  const f = await fixture(t), archive = join(f.root, 'controller.tar');
  await rm(archive);
  await assert.rejects(createTransferManifest(f.root, IDENTITY));
  await symlink(join(f.root, 'gateway.tar'), archive);
  await assert.rejects(createTransferManifest(f.root, IDENTITY));
  await assert.rejects(verifyLocalManifest(f.root, f.manifest));
});

test('prepare CLI creates one exact manifest outside the payload and refuses overwrite', async t => {
  const f = await fixture(t, { frozen: false });
  const first = prepare(f);
  assert.equal(first.error, undefined);
  assert.equal(first.status, 0, first.stderr);
  const saved = await readFile(f.path, 'utf8');
  assert.deepEqual(JSON.parse(saved), wire());
  const second = prepare(f);
  assert.notEqual(second.status, 0);
  assert.equal(await readFile(f.path, 'utf8'), saved);
});

test('prepare CLI rejects an existing output symlink and unsafe output location', async t => {
  const f = await fixture(t, { frozen: false }), target = join(f.directory, 'sentinel');
  await writeFile(target, SECRET);
  await symlink(target, f.path);
  assert.notEqual(prepare(f).status, 0);
  assert.equal(await readFile(target, 'utf8'), SECRET);
  assert.notEqual(prepare(f, ['--output', join(f.root, MANIFEST_FILENAME)]).status, 0);
  assert.notEqual(prepare(f, ['--output', join(f.directory, 'arbitrary.json')]).status, 0);
});

async function rejectedBeforeTransport(t, patch, mutate) {
  const f = await fixture(t);
  await mutate?.(f);
  const calls = [], logs = [], processes = { children: new Set(),
    async run() { calls.push('run'); assert.fail('must reject before starting a child'); },
    async checked() { calls.push('checked'); assert.fail('must reject before ssh -V'); } };
  let transfer;
  await assert.rejects(async () => {
    const config = transferConfiguration({ ...f.values, ...patch }, ENV);
    transfer = new ReleaseTransfer(config, { processes, log: line => logs.push(JSON.parse(line)),
      beforeActivate: async () => { calls.push('activate'); assert.fail('must not activate'); } });
    transfer.remote = async () => { calls.push('remote'); assert.fail('must reject before remote I/O'); };
    await transfer.execute();
  });
  assert.deepEqual(calls, []);
  assert.equal(processes.children.size, 0);
  assert.equal(transfer?.activationStarted, undefined);
  assert.ok(!logs.some(value => ['activation_start', 'deployment_verified', 'release_complete'].includes(value.event)));
  assert.ok(!JSON.stringify(logs).includes(SECRET));
  return logs;
}

for (const [name, patch] of [['missing manifest', { 'manifest-file': undefined }],
  ['missing artifact ID', { 'manifest-artifact-id': undefined }], ['zero artifact ID', { 'manifest-artifact-id': '0' }],
  ['unsafe artifact ID', { 'manifest-artifact-id': '9007199254740992' }]]) {
  test(`sender rejects ${name} before any child or remote call`, async t => rejectedBeforeTransport(t, patch));
}

test('sender rejects a cross-run frozen manifest before ssh version or remote calls', async t => {
  await rejectedBeforeTransport(t, {}, async f => {
    await writeFile(f.path, JSON.stringify({ ...wire(), run_id: 124 }));
  });
});

for (const [name, content] of [['malformed JSON', `{${SECRET}`],
  ['oversized document', ' '.repeat(MANIFEST_MAX_BYTES + 1)],
  ['extra secret field', JSON.stringify({ ...wire(), secret: SECRET })]]) {
  test(`sender rejects ${name} without child, remote or activation calls`, async t => {
    await rejectedBeforeTransport(t, {}, f => writeFile(f.path, content));
  });
}

test('sender rejects a linked frozen manifest before any transport call', async t => {
  await rejectedBeforeTransport(t, {}, async f => {
    const target = join(f.directory, 'actual-manifest.json');
    await writeFile(target, JSON.stringify(wire()));
    await rm(f.path);
    await symlink(target, f.path);
  });
});

test('sender detects same-length local replacement before creating any transport process', async t => {
  const logs = await rejectedBeforeTransport(t, {}, f => writeFile(join(f.root, 'controller.tar'), 'xyz'));
  assert.ok(logs.some(value => value.event === 'transfer_failed' && value.category === 'manifest_local_mismatch'));
});

test('sender consumes the frozen files and carries the immutable artifact identity through completion', async t => {
  const f = await fixture(t), commands = [], remote = [], logs = [];
  const processes = { children: new Set(), async checked(command, args) {
    commands.push([command, args]);
    return { code: 0, stdout: '', stderr: args[0] === '-V' ? 'OpenSSH_9.6p1' : '' };
  } };
  let gates = 0;
  const transfer = new ReleaseTransfer(transferConfiguration(f.values, ENV), { processes,
    log: line => logs.push(JSON.parse(line)), beforeActivate: async () => { gates++; } });
  transfer.copy = async files => {
    assert.deepEqual(files, wire().files);
    assert.ok(Object.isFrozen(files) && files.every(Object.isFrozen));
    return { code: 0 };
  };
  transfer.remote = async operation => {
    remote.push(operation);
    if (operation === 'create') return { owned: true };
    if (operation === 'status') return { bytes: wire().files.map(file => file.bytes) };
    if (operation === 'verify') return { verified: true };
    if (operation === 'activate') return { started: true };
    if (operation === 'activation') return { exit_code: 0, output: '' };
    assert.equal(operation, 'cleanup');
    return { cleanup: 'confirmed' };
  };
  await transfer.execute();
  assert.equal(gates, 1);
  assert.deepEqual(remote, ['create', 'status', 'status', 'verify', 'activate', 'activation', 'cleanup']);
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0], ['ssh', ['-V']]);
  for (const event of ['transfer_manifest', 'release_complete']) {
    const record = logs.find(value => value.event === event);
    assert.equal(record.manifest_artifact_id, 456);
    assert.equal(record.manifest_artifact_name, manifestArtifactName(IDENTITY));
  }
  assert.deepEqual(logs.find(value => value.event === 'transfer_manifest').files, wire().files);
});

test('activation waits while an earlier run holds the release lock, then launches once', async t => {
  const f = await fixture(t), remote = [], logs = [];
  const processes = { children: new Set(), async checked() { return { code: 0, stdout: '', stderr: 'OpenSSH_9.6p1' }; } };
  const transfer = new ReleaseTransfer(transferConfiguration(f.values, ENV), { processes,
    log: line => logs.push(JSON.parse(line)), beforeActivate: async () => {} });
  transfer.activationTiming = { pollMs: 1, waitMs: 60_000 };
  transfer.copy = async () => ({ code: 0 });
  let busy = 2;
  transfer.remote = async operation => {
    remote.push(operation);
    if (operation === 'create') return { owned: true };
    if (operation === 'status') return { bytes: wire().files.map(file => file.bytes) };
    if (operation === 'verify') return { verified: true };
    if (operation === 'activate') { if (busy-- > 0) throw new TransferFailure('activation_busy'); return { started: true }; }
    if (operation === 'activation') return { exit_code: 0, output: '' };
    assert.equal(operation, 'cleanup');
    return { cleanup: 'confirmed' };
  };
  await transfer.execute();
  assert.deepEqual(remote, ['create', 'status', 'status', 'verify', 'activate', 'activate', 'activate', 'activation', 'cleanup']);
  assert.equal(logs.filter(value => value.event === 'activation_waiting').length, 2);
  assert.ok(logs.some(value => value.event === 'deployment_verified'));
});
