import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { PARALLEL_MIN_BYTES, PARALLEL_STREAMS, ReleaseTransfer, transferConfiguration } from '../../../scripts/deploy/transfer-release.mjs';
import { REMOTE_FILES, manifestFor } from '../../../scripts/deploy/transfer-files.mjs';
import { TransferFailure } from '../../../scripts/deploy/transfer-process.mjs';

const ENV = { DEPLOY_HOST: 'fixture.example', DEPLOY_USER: 'fixture', REVISION: 'b'.repeat(40),
  GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '1' };

// Runs the real remote helper locally against the synthetic stage.
function remoteHelper(stage, owner, op, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-', stage, owner, op, Buffer.from(JSON.stringify(payload)).toString('base64')]);
    let stdout = '';
    child.stdout.on('data', data => { stdout += data; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`helper ${op} exited ${code}`)));
    child.stdin.end(REMOTE_FILES);
  });
}

test('large archives travel as parallel parts and are reassembled byte-identically before verification', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'release-parallel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'bundle'), path = join(directory, 'deploy');
  await mkdir(root);
  const large = randomBytes(PARALLEL_MIN_BYTES + 12345);
  await writeFile(join(root, 'controller.tar'), large);
  await writeFile(join(root, 'manifest.env'), 'REVISION=fixture\n');
  const config = transferConfiguration({ 'key-file': '/tmp/k', 'known-hosts-file': '/tmp/h', 'release-root': root,
    'manifest-file': '/tmp/m.json', 'manifest-artifact-id': '1' }, { ...ENV, DEPLOY_PATH: path });
  const scpCalls = [];
  const processes = { children: new Set(), async run(command, args) {
    assert.equal(command, 'scp');
    const destination = args.at(-1).split(':').at(-1).replace(/\/$/, '');
    const sources = args.filter(arg => arg.includes('release-transfer-parts-') || arg.startsWith(root));
    scpCalls.push(sources.map(source => basename(source)));
    for (const source of sources) await copyFile(source, join(destination, basename(source)));
    return { code: 0 };
  } };
  const logs = [];
  const transfer = new ReleaseTransfer(config, { processes, log: value => logs.push(JSON.parse(value)), beforeActivate: async () => {} });
  transfer.remote = (op, payload = transfer.files) => remoteHelper(config.stage, transfer.owner, op, payload);
  transfer.files = await manifestFor(root, ['controller.tar', 'manifest.env']);
  assert.equal((await transfer.remote('create')).owned, true);
  await transfer.copyParallel([transfer.files[0]]);
  assert.equal(scpCalls.length, PARALLEL_STREAMS, 'one SCP stream per part index');
  assert.deepEqual(await readFile(join(config.stage, 'controller.tar')), large);
  assert.deepEqual((await readdir(config.stage)).sort(), ['.transfer-owner', 'controller.tar']);
  await transfer.copy([transfer.files[1]]);
  assert.equal((await transfer.remote('verify')).verified, true);
  assert.ok(logs.some(event => event.event === 'parallel_transfer_finished' && event.category === 'ok'));
  assert.equal((await transfer.remote('cleanup')).cleanup, 'confirmed');
});

test('a rejected parallel upload cancels and joins its siblings before removing local parts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'release-parallel-reject-'));
  const completions = Array.from({ length: PARALLEL_STREAMS }, () => Promise.withResolvers());
  const started = Promise.withResolvers(), aborted = Promise.withResolvers();
  const uploads = [], children = new Set(), failure = new TransferFailure('process_stop');
  let abortedCount = 0, settled = false, copying;
  t.after(async () => {
    for (const completion of completions) completion.resolve({ code: null, reason: 'cancelled' });
    await copying;
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(join(root, 'controller.tar'), 'archive contents for every stream');
  const config = transferConfiguration({ 'key-file': '/tmp/k', 'known-hosts-file': '/tmp/h', 'release-root': root,
    'manifest-file': '/tmp/m.json', 'manifest-artifact-id': '1' }, { ...ENV, DEPLOY_PATH: '/tmp/deploy' });
  const processes = { children, run(command, args, { signal }) {
    assert.equal(command, 'scp');
    const index = uploads.length, child = { index };
    const paths = args.filter(arg => arg.includes('release-transfer-parts-'));
    uploads.push({ paths, child });
    children.add(child);
    const onAbort = () => { if (++abortedCount === PARALLEL_STREAMS - 1) aborted.resolve(); };
    signal.addEventListener('abort', onAbort, { once: true });
    if (uploads.length === PARALLEL_STREAMS) started.resolve();
    return completions[index].promise.finally(() => {
      signal.removeEventListener('abort', onAbort);
      if (index !== 0) children.delete(child);
    });
  } };
  const transfer = new ReleaseTransfer(config, { processes, log: () => {} });
  transfer.remote = () => assert.fail('a rejected upload must never join or activate');
  copying = transfer.copyParallel(await manifestFor(root, ['controller.tar']))
    .then(() => ({ ok: true }), error => ({ error }))
    .finally(() => { settled = true; });
  await started.promise;
  completions[0].reject(failure);
  assert.equal(await Promise.race([aborted.promise.then(() => 'aborted'), copying.then(() => 'settled')]), 'aborted');
  assert.equal(settled, false, 'all sibling uploads must settle before copyParallel returns');
  for (const upload of uploads) for (const path of upload.paths) await access(path);
  for (const [index, completion] of completions.entries()) {
    if (index === 1) completion.reject(new TransferFailure('secondary_stop_failure'));
    else if (index !== 0) completion.resolve({ code: null, reason: 'cancelled' });
  }
  assert.equal((await copying).error, failure, 'sibling failures must not replace the first rejection');
  assert.deepEqual([...children], [uploads[0].child], 'the unresolved child must remain registered');
  for (const upload of uploads) for (const path of upload.paths) await assert.rejects(access(path), { code: 'ENOENT' });
});

test('cleanup removes leftover parts from an interrupted parallel upload', async t => {
  const stage = join(await mkdtemp(join(tmpdir(), 'release-parts-')), 'stage');
  t.after(() => rm(join(stage, '..'), { recursive: true, force: true }));
  const owner = 'o'.repeat(64);
  await remoteHelper(stage, owner, 'create', []);
  await writeFile(join(stage, 'controller.tar.part03'), 'partial');
  assert.equal((await remoteHelper(stage, owner, 'cleanup', [{ name: 'controller.tar' }])).cleanup, 'confirmed');
});

test('join refuses missing parts', async t => {
  const stage = join(await mkdtemp(join(tmpdir(), 'release-join-')), 'stage');
  t.after(() => rm(join(stage, '..'), { recursive: true, force: true }));
  const owner = 'p'.repeat(64);
  await remoteHelper(stage, owner, 'create', []);
  await writeFile(join(stage, 'gateway.tar.part00'), 'a');
  await assert.rejects(remoteHelper(stage, owner, 'join', [{ name: 'gateway.tar', parts: 2 }]), /exited 74/);
});
