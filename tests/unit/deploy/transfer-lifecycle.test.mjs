import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { RELEASE_FILES } from '../../../scripts/deploy/transfer-files.mjs';
import { TransferProcesses } from '../../../scripts/deploy/transfer-process.mjs';
import { ReleaseTransfer, transferConfiguration } from '../../../scripts/deploy/transfer-release.mjs';
import { createSenderTelemetry } from '../../../scripts/deploy/transfer-telemetry.mjs';

const WATCHDOG_MS = 12_000;
const POLL_MS = 20;
const POLL_ATTEMPTS = 100;
const SSH_PID_OFFSET = 1_000_000;
const PROC_IO = 'rchar: 42\nread_bytes: 0\n';
const PRESSURE = 'some avg10=0 total=0\nfull avg10=0 total=0\n';
const ENV = { DEPLOY_HOST: 'fixture.example', DEPLOY_USER: 'fixture', DEPLOY_PATH: '/tmp/fixture',
  REVISION: 'a'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' };

function processStat(pid, name, group) {
  const fields = Array(50).fill('0');
  fields[0] = 'S';
  fields[2] = String(group);
  fields[19] = '123';
  return `${pid} (${name}) ${fields.join(' ')}\n`;
}

function telemetryFiles(processes) {
  return { async readFile(path) {
    const group = processes.scpPid, ssh = group + SSH_PID_OFFSET;
    const files = new Map([
      [`/proc/${group}/stat`, processStat(group, 'scp', group)],
      [`/proc/${ssh}/stat`, processStat(ssh, 'ssh', group)],
      [`/proc/${group}/io`, PROC_IO], [`/proc/${ssh}/io`, PROC_IO],
      [`/proc/${group}/task/${group}/children`, String(ssh)], ['/proc/pressure/io', PRESSURE],
    ]);
    assert.ok(files.has(path), `unexpected proc fixture access: ${path}`);
    return files.get(path);
  }, async readlink() { assert.fail('failed ss observations must not inspect socket descriptors'); } };
}

class LifecycleProcesses extends TransferProcesses {
  constructor(mode, root) {
    super();
    this.mode = mode;
    this.finishedFile = join(root, 'scp.finished');
    this.escapedFile = join(root, 'escaped.pid');
    this.commands = [];
  }

  run(command, args, options = {}) {
    this.commands.push(command === 'ssh' && args[0] === '-V' ? 'ssh-version' : command);
    if (command === 'ssh') return Promise.resolve({ code: 0, stdout: '', stderr: 'OpenSSH_9.6p1' });
    if (command === 'scp') {
      const code = `const fs=require('node:fs');setInterval(()=>{
        if(fs.existsSync(${JSON.stringify(this.finishedFile)}))process.exit(0);
      },10);`;
      const running = super.run(process.execPath, ['-e', code], options);
      const child = [...this.children].find(value => value.spawnfile === process.execPath);
      assert.ok(child?.pid, 'the synthetic SCP uses the real process registry');
      child.spawnfile = 'scp';
      this.scpPid = child.pid;
      return running;
    }
    assert.equal(command, 'ss', 'no transport command may contact an external host');
    if (this.mode === 'missing') return super.run('/nonexistent/lifecycle-ss', args, options);
    const code = this.mode === 'escaped' ? `const{spawn}=require('node:child_process');
      const fs=require('node:fs');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],
        {detached:true,stdio:['ignore',process.stdout,process.stderr]});
      fs.writeFileSync(${JSON.stringify(this.escapedFile)},String(child.pid));setInterval(()=>{},1000);`
      : 'setInterval(()=>{},1000)';
    return super.run(process.execPath, ['-e', code], options);
  }
}

async function stopSyntheticProcesses(processes) {
  let escaped;
  try { escaped = Number(await readFile(processes.escapedFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const pids = [...new Set([...processes.children].map(child => child.pid).concat(escaped ?? []))];
  for (const pid of pids) {
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    try { process.kill(-pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const probe = new TransferProcesses();
  for (const pid of pids) {
    let stopped = false;
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      const state = await probe.run('ps', ['-o', 'stat=', '-p', String(pid)]);
      if (state.code !== 0 || state.stdout.trim().startsWith('Z')) { stopped = true; break; }
      await delay(POLL_MS);
    }
    assert.ok(stopped, `synthetic process ${pid} must exit during test cleanup`);
  }
  for (let attempt = 0; processes.children.size > 0 && attempt < POLL_ATTEMPTS; attempt++) await delay(POLL_MS);
  assert.equal(processes.children.size, 0, 'the original registry clears after escaped stdio closes');
  assert.equal(probe.children.size, 0);
}

async function lifecycle(mode) {
  const root = await mkdtemp(join(tmpdir(), 'transfer-lifecycle-'));
  const processes = new LifecycleProcesses(mode, root), abort = new AbortController();
  const logs = [], remoteOperations = [];
  let gateCalls = 0, watchdog, execution, watchdogFired = false;
  const config = transferConfiguration({ 'release-root': root,
    'key-file': '/tmp/synthetic-key', 'known-hosts-file': '/tmp/synthetic-known-hosts' }, ENV);
  const transfer = new ReleaseTransfer(config, { processes, signal: abort.signal,
    log: value => logs.push(JSON.parse(value)), beforeActivate: async () => { gateCalls++; } });
  transfer.remote = async (operation, files = transfer.files) => {
    remoteOperations.push(operation);
    if (operation === 'create') return { owned: true };
    if (operation === 'status') return { bytes: files.map(file => file.bytes) };
    if (operation === 'verify') return { verified: true };
    assert.equal(operation, 'cleanup');
    return { cleanup: 'confirmed' };
  };
  const telemetry = createSenderTelemetry({ processes, platform: 'linux', fs: telemetryFiles(processes) });
  transfer.telemetry = { async sample(options) {
    const observation = await telemetry.sample(options);
    await writeFile(processes.finishedFile, 'done');
    return observation;
  } };
  try {
    for (const name of RELEASE_FILES) await writeFile(join(root, name), 'synthetic');
    watchdog = setTimeout(() => { watchdogFired = true; abort.abort(); }, WATCHDOG_MS);
    execution = transfer.execute().then(() => ({ passed: true }), error => ({ error }));
    const outcome = await execution;
    assert.equal(watchdogFired, false, 'the lifecycle completes without the test watchdog');
    return { ...outcome, logs, remoteOperations, gateCalls, activationStarted: transfer.activationStarted,
      childrenActive: processes.children.size, commands: processes.commands };
  } finally {
    clearTimeout(watchdog);
    abort.abort();
    if (execution) await execution;
    try { await stopSyntheticProcesses(processes); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}

test('an ss stop failure blocks verification, revision gating and activation after successful SCP', async () => {
  const result = await lifecycle('escaped');
  assert.equal(result.error?.category, 'process_stop');
  assert.equal(result.childrenActive, 1, 'the real ss stop failure retains its unresolved registry entry');
  assert.ok(result.commands.includes('ss'), 'the actual telemetry sampler invokes the helper');
  assert.ok(result.logs.some(event => event.event === 'sender_telemetry' && event.category === 'ss_error'));
  assert.ok(result.logs.some(event => event.event === 'scp_finished' && event.exit_code === 0 && event.category === 'ok'));
  assert.deepEqual(result.remoteOperations, ['create', 'status']);
  assert.equal(result.gateCalls, 0);
  assert.equal(result.activationStarted, undefined);
  assert.ok(result.logs.some(event => event.event === 'transfer_failed' && event.category === 'process_stop'));
  assert.ok(result.logs.some(event => event.event === 'cleanup_state' && event.cleanup === 'unconfirmed' &&
    event.category === 'children_still_active'));
  assert.ok(!result.logs.some(event => event.cleanup === 'confirmed'));
  assert.ok(!result.logs.some(event => ['transfer_verified', 'activation_start', 'deployment_verified',
    'release_complete'].includes(event.event)));
});

for (const [mode, category] of [['missing', 'ss_missing'], ['timeout', 'ss_timeout']]) {
  test(`an unavailable ${mode} helper permits deployment after its registry entry is cleared`, async () => {
    const result = await lifecycle(mode);
    assert.equal(result.passed, true);
    assert.equal(result.childrenActive, 0);
    assert.equal(result.gateCalls, 1);
    assert.equal(result.activationStarted, true);
    assert.deepEqual(result.remoteOperations, ['create', 'status', 'status', 'verify', 'cleanup']);
    assert.ok(result.logs.some(event => event.event === 'sender_telemetry' && event.category === category));
    assert.ok(result.logs.some(event => event.event === 'release_complete' && event.children_active === 0));
    assert.ok(result.logs.some(event => event.event === 'cleanup_state' && event.cleanup === 'confirmed'));
    assert.ok(!result.logs.some(event => event.event === 'transfer_failed'));
  });
}
