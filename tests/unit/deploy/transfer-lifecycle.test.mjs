import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { RELEASE_FILES } from '../../../scripts/deploy/transfer-files.mjs';
import { TransferProcesses } from '../../../scripts/deploy/transfer-process.mjs';
import { ReleaseTransfer, transferConfiguration } from '../../../scripts/deploy/transfer-release.mjs';
import { createSenderTelemetry } from '../../../scripts/deploy/transfer-telemetry.mjs';
import { createTransferManifest, MANIFEST_FILENAME } from '../../../scripts/deploy/transfer-manifest.mjs';
import { withTestCleanup } from '../../support/cleanup.mjs';

const WATCHDOG_MS = 12_000;
const POLL_MS = 20;
const POLL_ATTEMPTS = 100;
const PROBE_TIMEOUT_MS = 1_500;
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

async function processStopped(pid, probe) {
  const state = await probe.run('ps', ['-o', 'stat=', '-p', String(pid)], { timeoutMs: PROBE_TIMEOUT_MS });
  const message = `cleanup probe for synthetic process ${pid} must confirm its state`;
  assert.ok(!state.reason && !state.signal && (state.code === 0 || state.code === 1), message);
  assert.equal(state.stderr.trim(), '', message);
  const status = state.stdout.trim();
  if (state.code === 1) {
    assert.equal(status, '', message);
    return true;
  }
  assert.match(status, /^\S+$/, message);
  return /^Z[<NLsl+]*$/.test(status);
}

async function stopSyntheticProcesses(processes, probe = new TransferProcesses()) {
  let escaped;
  try { escaped = Number(await readFile(processes.escapedFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const pids = [...new Set([...processes.children].map(child => child.pid).concat(escaped ?? []))];
  for (const pid of pids) {
    assert.ok(Number.isSafeInteger(pid) && pid > 0);
    try { process.kill(-pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  for (const pid of pids) {
    let stopped = false;
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      if (await processStopped(pid, probe)) { stopped = true; break; }
      await delay(POLL_MS);
    }
    assert.ok(stopped, `synthetic process ${pid} must exit during test cleanup`);
  }
  for (let attempt = 0; processes.children.size > 0 && attempt < POLL_ATTEMPTS; attempt++) await delay(POLL_MS);
  assert.equal(processes.children.size, 0, 'the original registry clears after escaped stdio closes');
  assert.equal(probe.children.size, 0);
}

test('cleanup rejects real missing and timed-out probes while the target still exists', async () => {
  const processes = new TransferProcesses();
  for (const mode of ['missing', 'timeout']) {
    const probe = { run: (_command, args, options) => mode === 'missing'
      ? processes.run('ps', args, { ...options, environment: { PATH: '/synthetic/missing-tools' } })
      : processes.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { ...options, timeoutMs: 30 }) };
    await assert.rejects(processStopped(process.pid, probe), /cleanup probe/);
    assert.equal(process.kill(process.pid, 0), true, 'the target remains alive despite the probe failure');
    assert.equal(processes.children.size, 0, 'the failed probe leaves no helper process');
  }
});

test('cleanup accepts only completed empty absence or an explicit zombie state', async () => {
  const outcomes = [
    [{ code: 1, stdout: '', stderr: '' }, true],
    [{ code: 0, stdout: ' Zs+\n', stderr: '' }, true],
    [{ code: 0, stdout: 'Ss\n', stderr: '' }, false],
  ];
  for (const [outcome, expected] of outcomes) {
    assert.equal(await processStopped(process.pid, { run: async () => outcome }), expected);
  }
  for (const outcome of [
    { code: null, reason: 'output_limit' }, { code: null, reason: 'tool_missing' },
    { code: null, reason: 'timeout' }, { code: null, signal: 'SIGKILL' },
    { code: 2 }, { code: 1, stdout: 'S' }, { code: 1, stderr: 'ps: Operation not permitted' },
    { code: 0, stderr: 'ps: Permission denied' }, { code: 0, stdout: '' },
    { code: 0, stdout: 'Z\nS' }, { code: 0, stdout: 'Z', reason: 'output_limit' },
  ]) {
    const probe = { run: async () => ({ stdout: '', stderr: '', ...outcome }) };
    await assert.rejects(processStopped(process.pid, probe), /cleanup probe/);
  }
});

async function checkUnknownProbeCleanup(directory, { missingProbe = true, kill = process.kill, cleanupCalls = [] } = {}) {
  const processes = new TransferProcesses(), probe = new TransferProcesses();
  processes.escapedFile = join(directory, 'escaped.pid');
  const running = processes.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: WATCHDOG_MS });
  const [{ pid }] = processes.children;
  const unknown = { children: probe.children, run: (_command, args, options) => probe.run('ps', args,
    { ...options, environment: missingProbe ? { PATH: '/synthetic/missing-tools' } : {} }) };
  return withTestCleanup(() => assert.rejects(stopSyntheticProcesses(processes, unknown), /cleanup probe/), [
    { label: 'synthetic process group', cleanup() {
      cleanupCalls.push('kill');
      try { kill(-pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    } },
    { label: 'synthetic process completion', cleanup() { cleanupCalls.push('await'); return running; } },
    { label: 'synthetic process exit verification', async cleanup() {
      cleanupCalls.push('verify');
      assert.equal(await processStopped(pid, probe), true);
      assert.equal(processes.children.size, 0);
      assert.equal(probe.children.size, 0);
    } },
    { label: 'synthetic process directory', cleanup() {
      cleanupCalls.push('remove');
      return rm(directory, { recursive: true, force: true });
    } },
  ]);
}

test('an unknown probe result rejects the complete cleanup operation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'transfer-cleanup-probe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await checkUnknownProbeCleanup(directory);
});

for (const [missingProbe, killFails] of [[false, true], [false, false], [true, true]]) {
  test(`probe assertion failure=${!missingProbe}, kill failure=${killFails} preserves errors and completes cleanup`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'transfer-cleanup-errors-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const denied = Object.assign(new Error('synthetic kill permission failure'), { code: 'EPERM' });
    const cleanupCalls = [];
    let pid;
    const kill = (group, signal) => {
      pid = -group;
      if (killFails) throw denied;
      return process.kill(group, signal);
    };
    await assert.rejects(checkUnknownProbeCleanup(directory, { missingProbe, kill, cleanupCalls }), error => {
      if (!missingProbe && killFails) {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.equal(error.cause, error.errors[0]);
        assert.ok(error.errors[0] instanceof assert.AssertionError);
        assert.match(error.errors[0].message, /Missing expected rejection/);
        assert.equal(error.errors[1].cause, denied);
      } else if (missingProbe) {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 1);
        assert.equal(error.errors[0].cause, denied);
      } else {
        assert.ok(error instanceof assert.AssertionError);
        assert.match(error.message, /Missing expected rejection/);
      }
      return true;
    });
    assert.deepEqual(cleanupCalls, ['kill', 'await', 'verify', 'remove']);
    await assert.rejects(stat(directory), { code: 'ENOENT' }, 'directory cleanup still runs after a kill error');
    const probe = new TransferProcesses();
    assert.equal(await processStopped(pid, probe), true);
    assert.equal(probe.children.size, 0);
  });
}

async function lifecycle(mode) {
  const directory = await mkdtemp(join(tmpdir(), 'transfer-lifecycle-'));
  const root = join(directory, 'payload'), manifestFile = join(directory, MANIFEST_FILENAME);
  const processes = new LifecycleProcesses(mode, directory), abort = new AbortController();
  const logs = [], remoteOperations = [];
  let gateCalls = 0, watchdog, execution, watchdogFired = false;
  const config = transferConfiguration({ 'release-root': root, 'manifest-file': manifestFile, 'manifest-artifact-id': '456',
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
    await mkdir(root);
    for (const name of RELEASE_FILES) await writeFile(join(root, name), 'synthetic');
    const frozen = await createTransferManifest(root, { revision: ENV.REVISION,
      run: ENV.GITHUB_RUN_ID, attempt: ENV.GITHUB_RUN_ATTEMPT });
    await writeFile(manifestFile, JSON.stringify(frozen), { flag: 'wx' });
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
    finally { await rm(directory, { recursive: true, force: true }); }
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
