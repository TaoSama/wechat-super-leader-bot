import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay, setImmediate as flush } from 'node:timers/promises';
import test from 'node:test';
import { ReleaseTransfer, transferConfiguration } from '../../../scripts/deploy/transfer-release.mjs';
import { TransferFailure, TransferProcesses, errorCategory } from '../../../scripts/deploy/transfer-process.mjs';
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

test('escaped descendant holding stdio lets an independent CLI fail naturally without claiming cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'transfer-escaped-'));
  const pidFile = join(root, 'escaped.pid');
  const code = `const{spawn}=require('node:child_process');const fs=require('node:fs');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],
      {detached:true,stdio:['ignore',process.stdout,process.stderr]});
    fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);`;
  const moduleUrl = new URL('../../../scripts/deploy/transfer-release.mjs', import.meta.url).href;
  const cli = `import { ReleaseTransfer, transferConfiguration } from ${JSON.stringify(moduleUrl)};
    import { readFile } from 'node:fs/promises';
    import { setTimeout as delay } from 'node:timers/promises';
    const abort = new AbortController();
    class EscapedTransfer extends ReleaseTransfer {
      async remote(op) {
        if (op === 'cleanup') throw new Error('must not delete an unresolved stage');
        return op === 'create' ? { owned: true } : { bytes: this.files.map(() => 0) };
      }
      copy() { return this.processes.run(process.execPath, ['-e', ${JSON.stringify(code)}], { signal: this.signal }); }
    }
    const transfer = new EscapedTransfer(transferConfiguration(${JSON.stringify({ ...values, 'release-root': root })}, ${JSON.stringify(env)}), {signal: abort.signal});
    const running = transfer.execute().catch(error => {
      console.log(JSON.stringify({caught:error.category,children_active:transfer.processes.children.size}));
      process.exitCode=1;
    });
    for(let attempt=0;attempt<250;attempt++) {
      try { await readFile(${JSON.stringify(pidFile)}); break; }
      catch(error) { if(error.code!=='ENOENT') throw error; await delay(20); }
    }
    abort.abort(); await running;`;
  let escaped, child, timeout;
  try {
    for (const name of RELEASE_FILES) await writeFile(join(root, name), 'synthetic');
    const started = Date.now();
    child = spawn(process.execPath, ['--input-type=module', '-e', cli], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', forced = false;
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    timeout = setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 6000);
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timeout);
    escaped = Number(await readFile(pidFile, 'utf8'));
    assert.ok(escaped);
    assert.equal(forced, false, 'CLI exits before the test cleans up the escaped process');
    assert.equal(result.code, 1);
    assert.equal(result.signal, null);
    assert.equal(stderr, '');
    assert.ok(Date.now() - started < 6000);
    const logs = stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(logs.some(event => event.caught === 'process_stop' && event.children_active === 1));
    process.kill(escaped, 0);
    assert.ok(logs.some(event => event.event === 'transfer_failed' && event.category === 'process_stop'));
    assert.ok(logs.some(event => event.event === 'cleanup_state' && event.category === 'children_still_active'));
    assert.ok(!logs.some(event => event.cleanup === 'confirmed'));
  } finally {
    clearTimeout(timeout);
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (!escaped) {
      try { escaped = Number(await readFile(pidFile, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (escaped) {
      try { process.kill(-escaped, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      const probe = new TransferProcesses();
      let stopped = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        const state = await probe.run('ps', ['-o', 'stat=', '-p', String(escaped)]);
        if (state.code !== 0 || state.stdout.trim().startsWith('Z')) { stopped = true; break; }
        await delay(20);
      }
      assert.ok(stopped, 'the synthetic escaped descendant has exited');
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('periodic sampling tolerates only production transport failures', { concurrency: 18 }, async t => {
  const transient = ['dns', 'timeout', 'network_connect', 'network_closed'];
  const categories = [...transient, 'stage_ownership', 'integrity', 'authentication', 'host_key', 'remote_response'];
  await Promise.all([false, true].flatMap(diagnostic => categories.map(category =>
    t.test(`${diagnostic ? 'diagnostic' : 'production'} ${category}`, async t => {
      let complete, samples = 0, first, recovered;
      const sampled = new Promise(resolve => { first = resolve; });
      const sampledAgain = new Promise(resolve => { recovered = resolve; });
      const logs = [], processes = { run: (_command, _args, { signal }) => new Promise(resolve => {
        complete = () => resolve({ code: 0 });
        signal.addEventListener('abort', () => resolve({ code: null, reason: 'cancelled' }), { once: true });
      }) };
      const config = transferConfiguration(values, env);
      config.diagnostic = diagnostic;
      const transfer = new ReleaseTransfer(config, { processes, log: value => logs.push(JSON.parse(value)) });
      transfer.progress = async () => {
        if (++samples === 1) { first(); throw new TransferFailure(category); }
        recovered(); return 1;
      };
      const outcome = transfer.copy([{ name: 'controller.tar' }]).then(value => ({ value }), error => ({ error }));
      t.after(async () => { complete(); await outcome; });
      await sampled;
      await flush();
      if (!diagnostic && transient.includes(category)) {
        assert.equal(transfer.signal.aborted, false);
        assert.ok(logs.some(event => event.event === 'transfer_progress_unavailable' && event.category === category));
        await sampledAgain;
        assert.equal(samples, 2, 'a later sample still runs after a transport failure');
        complete();
        assert.equal((await outcome).value.code, 0);
      } else {
        assert.equal((await outcome).error?.category, category);
        assert.equal(transfer.signal.aborted, true);
        assert.ok(!logs.some(event => event.event === 'transfer_progress_unavailable'));
      }
    }))));
});

test('final production progress failure still blocks verification and activation', async () => {
  const transfer = new ReleaseTransfer(transferConfiguration(values, env), { log: () => {},
    beforeActivate: async () => assert.fail('must not activate') });
  transfer.copy = async () => ({ code: 0 });
  transfer.progress = async () => { throw new TransferFailure('network_closed'); };
  transfer.remote = async () => assert.fail('must not reach verify or activation');
  await assert.rejects(transfer.deploy(), { category: 'network_closed' });
  assert.equal(transfer.activationStarted, undefined);
});

for (const pollingError of [new TransferFailure('network_closed'), undefined, null, false]) {
  test(`diagnostic retains the first polling failure (${String(pollingError)}) and awaits cancellation`, async () => {
    const transfer = new ReleaseTransfer(transferConfiguration(values, env), { log: () => {} });
    transfer.files = [{ name: 'success.bin', bytes: 10 }, { name: 'cancel.bin', bytes: 10 }];
    let copies = 0, copyingStopped = false;
    transfer.remote = async () => ({ verified: true });
    transfer.copy = async (_files, { signal } = {}) => {
      if (++copies === 1) return { code: 0 };
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      await delay(10);
      copyingStopped = true;
      throw new TransferFailure('process_stop');
    };
    transfer.progress = async () => { throw pollingError; };
    const outcome = await transfer.diagnostic().then(() => ({ passed: true }), error => ({ error }));
    assert.equal(outcome.passed, undefined);
    assert.equal(outcome.error, pollingError);
    assert.equal(copyingStopped, true);
  });
}

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
