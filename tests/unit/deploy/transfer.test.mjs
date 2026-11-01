import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { ReleaseTransfer, transferConfiguration } from '../../../scripts/deploy/transfer-release.mjs';
import { TransferProcesses, errorCategory } from '../../../scripts/deploy/transfer-process.mjs';
import { manifestFor, RELEASE_FILES, quoteShell } from '../../../scripts/deploy/transfer-files.mjs';

const env = { DEPLOY_HOST: 'fixture.example', DEPLOY_USER: 'fixture', DEPLOY_PATH: '/tmp/fixture',
  REVISION: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' };
const values = { 'key-file': '/tmp/synthetic-key', 'known-hosts-file': '/tmp/synthetic-known-hosts', 'release-root': '/tmp/bundle' };

test('stage identity contains revision, run and attempt; malformed inputs fail closed', () => {
  const normal = transferConfiguration(values, env);
  assert.equal(normal.stage, `/tmp/fixture/.runtime/releases/${env.REVISION}-123-2`);
  const diagnostic = transferConfiguration({ ...values, 'release-root': undefined, diagnostic: true }, env);
  assert.equal(diagnostic.stage, `/tmp/fixture/.runtime/releases/diagnostic-${env.REVISION}-123-2`);
  for (const patch of [{ DEPLOY_HOST: 'x;echo secret' }, { DEPLOY_USER: '-oProxyCommand=x' },
    { DEPLOY_PATH: '/tmp/../production' }, { DEPLOY_PATH: '/' }, { GITHUB_RUN_ID: '0' },
    { GITHUB_RUN_ATTEMPT: '../x' }, { REVISION: 'main' }, { DEPLOY_PORT: '65536' },
    { DEPLOY_ENV_FILE: '../../secret' }]) {
    assert.throws(() => transferConfiguration(values, { ...env, ...patch }), { category: 'configuration' });
  }
  assert.throws(() => transferConfiguration({ ...values, diagnostic: true }, env), { category: 'configuration' });
  assert.notEqual(normal.stage, transferConfiguration(values, { ...env, GITHUB_RUN_ATTEMPT: '3' }).stage);
});

test('manifest uses fixed basenames, exact bytes and streaming SHA256; rejects links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'transfer-manifest-'));
  try {
    await writeFile(join(root, 'controller.tar'), 'abc');
    assert.deepEqual(await manifestFor(root, ['controller.tar']), [{ name: 'controller.tar', bytes: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }]);
    await symlink(join(root, 'controller.tar'), join(root, 'gateway.tar'));
    await assert.rejects(manifestFor(root, ['gateway.tar']), { category: 'local_file' });
    assert.equal(new Set(RELEASE_FILES).size, 10);
    assert.ok(RELEASE_FILES.every(name => !name.includes('/')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('error classification returns only fixed categories despite secret-bearing stderr', async () => {
  for (const [stderr, expected] of [
    ['Host key verification failed.', 'host_key'], ['Permission denied (publickey).', 'authentication'],
    ['Could not resolve hostname private-host', 'dns'], ['Connection refused', 'network_connect'],
    ['Connection reset by peer', 'network_closed'], ['No space left on device', 'remote_capacity'],
    ['unknown sensitive text', 'remote_command'],
  ]) assert.equal(errorCategory({ code: 1, stderr: `SYNTHETIC_SECRET ${stderr}` }), expected);
  const processes = new TransferProcesses();
  await assert.rejects(processes.checked(process.execPath, ['-e',
    'process.stderr.write("SYNTHETIC_SECRET Permission denied (publickey).");process.exit(1)']), error => {
    assert.equal(error.category, 'authentication');
    assert.ok(!error.stack.includes('SYNTHETIC_SECRET'));
    return true;
  });
  assert.equal(processes.children.size, 0);
});

test('cancel stops a real process group including a descendant that ignores SIGTERM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'transfer-process-'));
  const pidFile = join(root, 'child.pid');
  const abort = new AbortController(), processes = new TransferProcesses();
  const code = `const{spawn}=require('node:child_process');const fs=require('node:fs');
    process.on('SIGTERM',()=>{});
    const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
    fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`;
  const running = processes.run(process.execPath, ['-e', code], { signal: abort.signal });
  try {
    let pid;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { pid = Number(await readFile(pidFile, 'utf8')); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; await delay(20); }
    }
    assert.ok(pid);
    await delay(100);
    const start = Date.now();
    abort.abort();
    const result = await running;
    assert.equal(result.reason, 'cancelled');
    assert.notEqual(result.code, 0);
    assert.ok(Date.now() - start < 3_000);
    assert.equal(processes.children.size, 0);
    // A zombie has exited too; ps distinguishes it from a surviving process.
    const probe = await processes.run('ps', ['-o', 'stat=', '-p', String(pid)]);
    assert.ok(probe.code !== 0 || probe.stdout.trim().startsWith('Z'));
  } finally { abort.abort(); await running; await rm(root, { recursive: true, force: true }); }
});

test('timeouts and missing tools remain nonzero; subprocesses do not inherit credentials', async () => {
  const processes = new TransferProcesses();
  const timed = await processes.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 30 });
  assert.equal(timed.reason, 'timeout');
  assert.notEqual(timed.code, 0);
  await assert.rejects(processes.checked('/nonexistent/transfer-tool', []), { category: 'tool_missing' });
  const result = await processes.checked(process.execPath, ['-e', 'console.log(JSON.stringify(Object.keys(process.env)))']);
  assert.ok(!JSON.parse(result.stdout).some(key => /TOKEN|DEPLOY_|SSH_AUTH/.test(key)));
  assert.equal(processes.children.size, 0);
});

test('remote argument quoting keeps embedded quotes literal', () => {
  assert.equal(quoteShell("a'b"), "'a'\\''b'");
});

test('cleanup allows connection plus execution and shrinks to the diagnostic deadline', () => {
  const transfer = new ReleaseTransfer(transferConfiguration(values, env), { log: () => {} });
  assert.equal(transfer.timeout(true), 8000);
  assert.ok(transfer.sshArgs(8000).includes('ConnectTimeout=5'));
  assert.ok(transfer.sshArgs(4000).includes('ConnectTimeout=3'));
  transfer.deadline = Date.now() + 6500;
  assert.ok(transfer.timeout(true) <= 4500);
  transfer.deadline = Date.now() + 3500;
  assert.throws(() => transfer.timeout(true), { category: 'diagnostic_deadline' });
});
