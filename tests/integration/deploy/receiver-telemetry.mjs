import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, stat, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { TransferFailure, TransferProcesses } from '../../../scripts/deploy/transfer-process.mjs';
import { RELEASE_FILES, quoteShell } from '../../../scripts/deploy/transfer-files.mjs';

const ROOT = '/fixture/receiver-telemetry';
const TEST = `${ROOT}/tests/integration/deploy/receiver-telemetry.mjs`;
const RECEIVER = `${ROOT}/scripts/deploy/receiver-telemetry.py`;
const REVISION = 'c'.repeat(40), RUN = 424242, ATTEMPT = 1;
const RELEASE_PATH = `${ROOT}/remote`, STAGE = `${RELEASE_PATH}/.runtime/releases/${REVISION}-${RUN}-${ATTEMPT}`;
const PAYLOAD_BYTES = 512 * 1024, BANDWIDTH_KBIT = 128;
const CASE_MS = 30_000, TOTAL_MS = 60_000, POLL_MS = 100;
const MANIFEST = RELEASE_FILES.map(name => ({ name, bytes: name.endsWith('.tar') ? PAYLOAD_BYTES : 0 }));
const IDENTIFIERS = ['writer_pid', 'writer_start_ticks', 'file_fd', 'file_inode', 'stage_inode',
  'socket_inode', 'owner_pid', 'owner_start_ticks', 'socket_fd'];
const TCP = ['bytes_received', 'recv_queue_bytes', 'rcv_space_bytes', 'rcv_ssthresh_bytes',
  'receive_memory_bytes', 'receive_buffer_bytes', 'backlog_bytes', 'drops'];
const PROCESS = ['status', 'category', 'cpu_user_ticks', 'cpu_system_ticks', 'wchar',
  'write_bytes', 'cancelled_write_bytes', 'io_status', 'io_category'];
const PRESSURE = ['status', 'category', 'some_avg10_percent', 'some_total_us', 'full_avg10_percent', 'full_total_us'];
const PHASES = new Set(['arguments', 'fixture_create', 'receiver_prepare', 'receiver_runtime', 'host_validation',
  'runtime_setup', 'upload_start', 'status_start', 'writer_binding', 'optional_fields', 'writer_exit',
  'normal_stop', 'deadline_helper', 'escaped_helper', 'client_cleanup', 'cleanup']);
const OPERATIONS = new Set(['process_stat_read', 'escaped_kill', 'escaped_prepare', 'escaped_collector_start',
  'escaped_collector_wait', 'escaped_collector_finish', 'escaped_identity_read', 'escaped_alive_check',
  'escaped_helper_stop', 'escaped_ps_probe', 'escaped_budget_check']);
const ERRNOS = new Set(['ENOENT', 'ESRCH', 'EPERM', 'EACCES', 'EIO', 'ENOTDIR', 'EINVAL', 'EBADF', 'EINTR', 'ETIMEDOUT']);
const CATEGORIES = new Set(`probe_failed assertion_failed invalid_json file_missing permission_denied io_error
  command_missing command_timeout command_failed invalid_options unsafe_output collector_exit_timeout collector_exit_failed
  collector_output_invalid collector_cleanup_failed escaped_pid_reused escaped_helper_survived_cleanup status_session_misbound
  observer_session_misbound writer_owner_not_related writer_fd_not_writable archive_inode_mismatch socket_inode_mismatch
  linux_required inspection_capability_missing ssh_version_unavailable upload_not_started status_not_started
  receiver_binding_unavailable receive_bytes_not_increasing binding_changed payload_progress_invalid optional_fields_binding_unavailable
  missing_fields_not_null upload_cancel_failed writer_exit_not_observed status_session_used_after_writer_exit normal_case_deadline
  second_upload_not_started deadline_did_not_stop_collector helper_timeout_not_observed ss_helper_survived timeout_case_deadline
  escaped_collector_did_not_exit escaped_false_cleanup_confirmation escaped_not_alive_at_failure escaped_ps_still_running
  escaped_ps_probe_failed escaped_case_deadline test_children_survived total_deadline container_probe_failed invalid_evidence
  stage_missing stage_invalid stage_changed file_changed socket_changed proc_permission process_exited children_unavailable proc_io proc_invalid proc_limit
  process_changed owner_shared writer_ambiguous writer_unavailable socket_ambiguous socket_owner_missing ss_missing ss_start ss_timeout
  ss_output_limit ss_failed ss_invalid cleanup_unconfirmed cancelled platform_unsupported unexpected_error tool_missing process_start
  process_stop input_io output_limit timeout remote_command authentication host_key dns network_connect network_closed`.split(/\s+/));

class ProbeFailure extends Error {
  constructor(category, phase) { super(category); this.category = category; this.phase = phase; }
}
function metadataFor(error, operation) {
  const op = OPERATIONS.has(error?.operation) ? error.operation : operation;
  const errno = ERRNOS.has(error?.errno) ? error.errno : error?.code;
  return { ...(OPERATIONS.has(op) ? { operation: op } : {}), ...(ERRNOS.has(errno) ? { errno } : {}) };
}
function preserveCleanup(failure, cleanup) {
  if (failure.cleanupCategory !== undefined) return;
  failure.cleanupCategory = cleanup.category;
  const metadata = metadataFor(cleanup);
  if (metadata.operation) failure.cleanupOperation = metadata.operation;
  if (metadata.errno) failure.cleanupErrno = metadata.errno;
}
export function failureFor(error, phase, operation) {
  if (error instanceof AggregateError && error.errors.length) {
    const hasPrimary = Object.hasOwn(error, 'cause');
    const failure = failureFor(hasPrimary ? error.cause : error.errors[0], phase, operation);
    const cleanup = hasPrimary && error.errors.find(item => item !== error.cause);
    if (cleanup) preserveCleanup(failure, failureFor(cleanup, 'cleanup'));
    return failure;
  }
  if (error instanceof ProbeFailure && PHASES.has(error.phase) && CATEGORIES.has(error.category)) {
    const { category, phase } = error, metadata = metadataFor(error, operation);
    const cleanupCategory = CATEGORIES.has(error.cleanupCategory) ? error.cleanupCategory : undefined;
    const cleanup = metadataFor({ operation: error.cleanupOperation, errno: error.cleanupErrno });
    for (const key of Object.keys(error)) delete error[key];
    return Object.assign(error, { category, phase, ...metadata, ...(cleanupCategory ? { cleanupCategory,
      ...(cleanup.operation ? { cleanupOperation: cleanup.operation } : {}),
      ...(cleanup.errno ? { cleanupErrno: cleanup.errno } : {}) } : {}) });
  }
  let category = 'probe_failed';
  if ((error instanceof ProbeFailure || error instanceof TransferFailure) && CATEGORIES.has(error.category)) category = error.category;
  else if (error?.code === 'ERR_ASSERTION') category = 'assertion_failed';
  else if (error instanceof SyntaxError) category = 'invalid_json';
  else if (typeof error?.code === 'string' && error.code.startsWith('ERR_PARSE_ARGS')) category = 'invalid_options';
  else if (error?.code === 'ENOENT') category = 'file_missing';
  else if (['EACCES', 'EPERM'].includes(error?.code)) category = 'permission_denied';
  else if (error?.code === 'ETIMEDOUT') category = 'command_timeout';
  else if (typeof error?.status === 'number') category = 'command_failed';
  else if (['EIO', 'ENOTDIR', 'EEXIST'].includes(error?.code)) category = 'io_error';
  return Object.assign(new ProbeFailure(category, PHASES.has(phase) ? phase : 'receiver_runtime'), metadataFor(error, operation));
}
export function failureEvent(error) {
  const failure = failureFor(error, 'receiver_runtime');
  const cleanup = metadataFor({ operation: failure.cleanupOperation, errno: failure.cleanupErrno });
  return { event: 'linux_receiver_telemetry_failed', phase: failure.phase, category: failure.category,
    ...metadataFor(failure), ...(CATEGORIES.has(failure.cleanupCategory) ? { cleanup_category: failure.cleanupCategory,
      ...(cleanup.operation ? { cleanup_operation: cleanup.operation } : {}),
      ...(cleanup.errno ? { cleanup_errno: cleanup.errno } : {}) } : {}) };
}
export function containerFailure(stderr) {
  try {
    const value = JSON.parse(String(stderr ?? '').trim());
    if (value?.event !== 'linux_receiver_telemetry_failed' || !PHASES.has(value.phase) || !CATEGORIES.has(value.category)) return;
    const failure = Object.assign(new ProbeFailure(value.category, value.phase),
      metadataFor({ operation: value.operation, errno: value.errno }));
    if (CATEGORIES.has(value.cleanup_category)) preserveCleanup(failure,
      Object.assign(new ProbeFailure(value.cleanup_category, 'cleanup'),
        metadataFor({ operation: value.cleanup_operation, errno: value.cleanup_errno })));
    return failure;
  } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
}
async function cleanupActions(actions, primary) {
  let failure;
  for (const action of actions) {
    try { await action(); }
    catch (error) { failure ??= failureFor(error, 'cleanup'); }
  }
  if (failure) {
    if (primary) preserveCleanup(primary, failure);
    else throw failure;
  }
}
function requireProbe(condition, category) { if (!condition) throw new ProbeFailure(category); }
function keys(value, allowed) { assert.deepEqual(Object.keys(value).sort(), [...allowed].sort()); }
function numbers(value) { assert.ok(Object.values(value).every(item => item === null || typeof item === 'number' && Number.isFinite(item))); }
function safeText(text) {
  requireProbe(!/https?:\/\/|(?:[0-9]{1,3}\.){3}[0-9]{1,3}|SYNTHETIC_|PRIVATE KEY|\/fixture\/|\/proc\//.test(text), 'unsafe_output');
}
function safeEvent(event) {
  const common = ['schema', 'event', 'revision', 'run_id', 'attempt', 'elapsed_ms', 'utc'];
  if (event.event === 'receiver_complete') {
    keys(event, [...common, 'reason', 'children_active', 'cleanup']);
    assert.ok(['confirmed', 'unconfirmed'].includes(event.cleanup));
    assert.ok(['signal', 'deadline', 'unavailable', 'output_limit', 'unexpected_error'].includes(event.reason));
    assert.ok(Number.isSafeInteger(event.children_active) && event.children_active >= 0);
  } else {
    keys(event, [...common, 'status', 'category', 'identifiers', 'tcp', 'processes', 'io_pressure',
      'files', 'total_bytes', 'received_bytes', 'remaining_bytes']);
    assert.equal(event.event, 'receiver_telemetry');
    assert.ok(['available', 'unavailable'].includes(event.status));
    assert.match(event.category, /^[a-z_]+$/);
    keys(event.identifiers, IDENTIFIERS); numbers(event.identifiers);
    keys(event.tcp, TCP); numbers(event.tcp);
    keys(event.processes, ['writer', 'connection']);
    for (const process of Object.values(event.processes)) {
      keys(process, PROCESS);
      for (const [key, value] of Object.entries(process)) {
        if (['status', 'io_status'].includes(key)) assert.ok(['available', 'unavailable'].includes(value));
        else if (['category', 'io_category'].includes(key)) assert.match(value, /^[a-z_]+$/);
        else assert.ok(value === null || Number.isSafeInteger(value) && value >= 0);
      }
    }
    keys(event.io_pressure, PRESSURE);
    for (const [key, value] of Object.entries(event.io_pressure)) {
      if (key === 'status') assert.ok(['available', 'unavailable'].includes(value));
      else if (key === 'category') assert.match(value, /^[a-z_]+$/);
      else assert.ok(value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0);
    }
    assert.equal(event.files.length, MANIFEST.length);
    for (const item of event.files) {
      keys(item, ['name', 'expected_bytes', 'received_bytes']);
      assert.ok(RELEASE_FILES.includes(item.name));
      assert.ok(item.received_bytes === null || item.received_bytes >= 0 && item.received_bytes <= item.expected_bytes);
    }
  }
  assert.equal(event.schema, 1); assert.equal(event.revision, REVISION);
  assert.equal(event.run_id, RUN); assert.equal(event.attempt, ATTEMPT);
  assert.ok(Number.isSafeInteger(event.elapsed_ms) && event.elapsed_ms >= 0);
  assert.match(event.utc, /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/);
  safeText(JSON.stringify(event));
}

async function until(predicate, milliseconds, category) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(POLL_MS);
  }
  throw new ProbeFailure(typeof category === 'function' ? category() : category);
}

function sshArguments() {
  return ['-F', '/dev/null', '-i', `${ROOT}/credentials/client`, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'IdentityAgent=none', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${ROOT}/credentials/known_hosts`, '-o', 'ConnectTimeout=2'];
}

async function collector(duration, path, throughSsh = false) {
  const processes = new TransferProcesses(), abort = new AbortController(), events = [];
  let command = 'python3';
  const args = ['--release-path', RELEASE_PATH, '--revision', REVISION, '--run-id', String(RUN),
    '--attempt', String(ATTEMPT), '--port', '2222', '--manifest-json', JSON.stringify(MANIFEST),
    '--job-started-at', new Date().toISOString(), '--duration-seconds', String(duration),
    '--sample-interval-seconds', '0.25', '--discovery-interval-seconds', '0.1'];
  let pending = '', parseFailure, done = false, input, commandArgs = [RECEIVER, ...args];
  const pidPath = `${ROOT}/observer.pid`;
  if (throughSsh) {
    command = 'ssh'; input = await readFile(RECEIVER, 'utf8');
    const remote = `printf '%s' "$$" > ${quoteShell(pidPath)}; exec ${['python3', '-', ...args].map(quoteShell).join(' ')}`;
    commandArgs = [...sshArguments(), '-p', '2222', 'root@127.0.0.1', remote];
  }
  const outcome = processes.run(command, commandArgs, { signal: abort.signal, timeoutMs: CASE_MS, input,
    environment: path ? { PATH: `${path}:${process.env.PATH}` } : {} })
    .then(value => { done = true; return { value }; }, error => { done = true; return { error }; });
  const child = [...processes.children][0];
  child.stdout.on('data', chunk => {
    pending += chunk.toString();
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      try { events.push(JSON.parse(line)); }
      catch { parseFailure = true; }
    }
  });
  return { events, processes, abort, outcome, get done() { return done; },
    async observerPid() { return throughSsh ? Number(await readFile(pidPath, 'utf8')) : child.pid; },
    async stop() {
      if (done) return;
      if (!throughSsh) { child.kill('SIGTERM'); return; }
      try { process.kill(Number(await readFile(pidPath, 'utf8')), 'SIGTERM'); }
      catch (error) { if (error.code !== 'ESRCH' && error.code !== 'ENOENT') throw error; }
    },
    async finish(reason, sendSignal = true, confirmed = true) {
      if (sendSignal) await this.stop();
      await until(() => done, 6_000, 'collector_exit_timeout');
      const result = await outcome;
      requireProbe(!result.error && (confirmed ? result.value.code === 0 : result.value.code !== 0) &&
        !result.value.reason, 'collector_exit_failed');
      requireProbe(!parseFailure && !pending && !result.value.stderr, 'collector_output_invalid');
      events.forEach(safeEvent);
      const final = events.at(-1);
      requireProbe(final?.event === 'receiver_complete' && final.reason === reason &&
        final.cleanup === (confirmed ? 'confirmed' : 'unconfirmed') &&
        (confirmed ? final.children_active === 0 : final.children_active > 0) &&
        processes.children.size === 0, 'collector_cleanup_failed');
      return final;
    } };
}

async function ancestors(pid) {
  const result = [];
  while (pid > 0 && result.length < 16) {
    result.push(pid);
    const text = await readFile(`/proc/${pid}/stat`, 'utf8');
    pid = Number(text.slice(text.lastIndexOf(')') + 2).split(/\s+/)[1]);
  }
  return result;
}

export async function processState(pid, { read = readFile } = {}) {
  try {
    const text = await read(`/proc/${pid}/stat`, 'utf8'), separator = text.lastIndexOf(') ');
    const fields = text.slice(separator + 2).trim().split(/\s+/), start = Number(fields[19]);
    requireProbe(separator > 0 && /^[RSDZTWtXxKPI]$/.test(fields[0]) && /^\d+$/.test(fields[19] ?? '') &&
      Number.isSafeInteger(start), 'proc_invalid');
    return { state: fields[0], start };
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return null;
    throw failureFor(error, 'escaped_helper', 'process_stat_read');
  }
}

export async function stopEscaped(identity, { state = processState, kill = process.kill } = {}) {
  const current = await state(identity.pid);
  if (!current) return;
  requireProbe(current.start === identity.start, 'escaped_pid_reused');
  if (current.state === 'Z') return;
  try { kill(identity.pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw failureFor(error, 'escaped_helper', 'escaped_kill'); }
  await until(async () => {
    const value = await state(identity.pid);
    if (value) requireProbe(value.start === identity.start, 'escaped_pid_reused');
    return !value || value.state === 'Z';
  },
    2_000, 'escaped_helper_survived_cleanup');
}

async function verifyBinding(sample, status, observerPid) {
  const ids = sample.identifiers;
  requireProbe(!status.ancestors.includes(ids.writer_pid) && !status.ancestors.includes(ids.owner_pid), 'status_session_misbound');
  const observerAncestors = await ancestors(observerPid);
  requireProbe(!observerAncestors.includes(ids.writer_pid) && !observerAncestors.includes(ids.owner_pid), 'observer_session_misbound');
  requireProbe((await ancestors(ids.writer_pid)).includes(ids.owner_pid), 'writer_owner_not_related');
  const file = await stat(`${STAGE}/controller.tar`), fd = await stat(`/proc/${ids.writer_pid}/fd/${ids.file_fd}`);
  const flags = /^flags:\s+([0-7]+)$/m.exec(await readFile(`/proc/${ids.writer_pid}/fdinfo/${ids.file_fd}`, 'utf8'));
  requireProbe(flags && [1, 2].includes(parseInt(flags[1], 8) & 3), 'writer_fd_not_writable');
  requireProbe(file.dev === fd.dev && file.ino === fd.ino && file.ino === ids.file_inode &&
    (await stat(STAGE)).ino === ids.stage_inode, 'archive_inode_mismatch');
  requireProbe(await readlink(`/proc/${ids.owner_pid}/fd/${ids.socket_fd}`) === `socket:[${ids.socket_inode}]`, 'socket_inode_mismatch');
}

async function linuxProbe() {
  const started = Date.now(), clients = new TransferProcesses(), abort = new AbortController(), collectors = [];
  const deadline = setTimeout(() => abort.abort(), TOTAL_MS - 5_000);
  const jobs = [], escapedPath = `${ROOT}/escaped.json`;
  let clientMajor, phase = 'runtime_setup', operation, failure;
  const key = `${ROOT}/credentials/client`, ssh = sshArguments();
  const start = (tool, args, signal = abort.signal) => {
    const result = clients.run(tool, args, { signal, timeoutMs: CASE_MS })
      .then(value => ({ value }), error => ({ error })); jobs.push(result); return result;
  };
  const upload = name => {
    const stop = new AbortController();
    const protocol = clientMajor < 9 ? ['-s'] : ['-X', 'nrequests=1', '-X', 'buffer=16384'];
    return { stop, outcome: start('scp', ['-B', '-l', String(BANDWIDTH_KBIT), ...protocol,
      ...ssh, '-P', '2222', `${ROOT}/payload/${name}`, `root@127.0.0.1:${STAGE}/`], AbortSignal.any([abort.signal, stop.signal])) };
  };
  try {
    requireProbe(process.platform === 'linux', 'linux_required');
    const capabilities = /^CapEff:\s+([0-9a-f]+)$/m.exec(await readFile('/proc/self/status', 'utf8'));
    requireProbe(capabilities && (BigInt(`0x${capabilities[1]}`) & (1n << 19n)) !== 0n, 'inspection_capability_missing');
    const sshVersion = /OpenSSH_([0-9.]+p[0-9]+)/.exec((await clients.checked('ssh', ['-V'], { timeoutMs: 2_000 })).stderr)?.[1];
    requireProbe(sshVersion, 'ssh_version_unavailable');
    clientMajor = Number(sshVersion.split('.')[0]);
    const pythonVersion = JSON.parse((await clients.checked('python3', ['-c',
      'import sys,json;print(json.dumps(list(sys.version_info[:3])))'], { timeoutMs: 2_000 })).stdout);
    await mkdir(`${ROOT}/payload`, { recursive: true }); await mkdir(STAGE, { recursive: true });
    await chmod(key, 0o600);
    for (const file of MANIFEST) await writeFile(`${ROOT}/payload/${file.name}`, Buffer.alloc(file.bytes, 't'));
    phase = 'upload_start';
    const firstUpload = upload('controller.tar');
    await until(async () => { try { return (await stat(`${STAGE}/controller.tar`)).size > 0; }
      catch (error) { if (error.code !== 'ENOENT') throw error; return false; } }, 6_000, 'upload_not_started');
    phase = 'status_start';
    const statusPath = `${ROOT}/status.json`;
    const statusCode = `import json,os,time\np=${JSON.stringify(`${STAGE}/controller.tar`)}\nf=os.open(p,os.O_RDONLY)\na=[];i=os.getpid()\nwhile i>0 and len(a)<16:\n a.append(i);s=open('/proc/%s/stat'%i).read();i=int(s[s.rfind(')')+2:].split()[1])\nwith open(${JSON.stringify(statusPath)},'w') as o:json.dump({'pid':os.getpid(),'ancestors':a,'fd':f},o)\nu=time.monotonic()+25\nwhile time.monotonic()<u:\n os.stat(p);os.fstat(f);time.sleep(.1)\n`;
    const statusStop = new AbortController();
    start('ssh', [...ssh, '-p', '2222', 'root@127.0.0.1', `exec python3 -c ${quoteShell(statusCode)}`], AbortSignal.any([abort.signal, statusStop.signal]));
    const status = await until(async () => { try { return JSON.parse(await readFile(statusPath, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; return false; } }, 4_000, 'status_not_started');
    phase = 'writer_binding';
    const normal = await collector(20, undefined, true); collectors.push(normal);
    const first = await until(() => normal.events.find(event => event.status === 'available'), 6_000,
      () => {
        const category = normal.events.filter(event => event.event === 'receiver_telemetry').at(-1)?.category;
        return CATEGORIES.has(category) ? category : 'receiver_binding_unavailable';
      });
    const second = await until(() => normal.events.find(event => event.status === 'available' && event.tcp.bytes_received > first.tcp.bytes_received), 5_000, 'receive_bytes_not_increasing');
    await verifyBinding(second, status, await normal.observerPid());
    requireProbe(first.identifiers.socket_inode === second.identifiers.socket_inode, 'binding_changed');
    requireProbe(second.received_bytes > 0 && second.remaining_bytes === second.total_bytes - second.received_bytes, 'payload_progress_invalid');
    phase = 'optional_fields';
    const realSs = (await clients.checked('sh', ['-c', 'command -v ss'], { timeoutMs: 2_000 })).stdout.trim();
    const missing = `${ROOT}/missing`, hanging = `${ROOT}/hanging`, helperPids = `${ROOT}/helper-pids.jsonl`;
    await mkdir(missing); await mkdir(hanging);
    await writeFile(`${missing}/ss`, `#!/usr/bin/python3\nimport argparse,re,subprocess,sys\n_,args=argparse.ArgumentParser(add_help=False).parse_known_args()\np=subprocess.run([${JSON.stringify(realSs)}]+args,stdout=subprocess.PIPE,stderr=subprocess.PIPE)\nsys.stdout.buffer.write(re.sub(rb'(?<!\\S)(?:rcv_space|rcv_ssthresh):[^\\s]+',b'',p.stdout));sys.stderr.buffer.write(p.stderr);sys.exit(p.returncode)\n`, { mode: 0o700 });
    const optional = await collector(10, missing); collectors.push(optional);
    const absent = await until(() => optional.events.find(event => event.status === 'available'), 4_000, 'optional_fields_binding_unavailable');
    requireProbe(absent.tcp.rcv_space_bytes === null && absent.tcp.rcv_ssthresh_bytes === null && absent.tcp.bytes_received > 0, 'missing_fields_not_null');
    await optional.finish('signal');
    phase = 'writer_exit';
    firstUpload.stop.abort(); const cancelled = await firstUpload.outcome;
    requireProbe(!cancelled.error && cancelled.value.reason === 'cancelled', 'upload_cancel_failed');
    const sampleCount = normal.events.length;
    const gap = await until(() => normal.events.slice(sampleCount).find(event => event.status === 'unavailable'), 4_000, 'writer_exit_not_observed');
    requireProbe(gap.identifiers.writer_pid === null && gap.tcp.bytes_received === null, 'status_session_used_after_writer_exit');
    await stat(`/proc/${status.pid}/fd/${status.fd}`);
    phase = 'normal_stop';
    const complete = await normal.finish('signal');
    statusStop.abort();
    requireProbe(Date.now() - started < CASE_MS, 'normal_case_deadline');
    phase = 'deadline_helper';
    await writeFile(`${hanging}/ss`, `#!/usr/bin/python3\nimport argparse,json,os,signal,time\nargparse.ArgumentParser(add_help=False).parse_known_args()\nsignal.signal(signal.SIGTERM,signal.SIG_IGN)\nwith open(${JSON.stringify(helperPids)},'a') as f:f.write(json.dumps({'pid':os.getpid()})+'\\n')\nprint('SYNTHETIC_RAW_SS_SECRET https://198.51.100.77/private',flush=True)\nwhile True:time.sleep(1)\n`, { mode: 0o700 });
    const secondUpload = upload('gateway.tar');
    await until(async () => { try { return (await stat(`${STAGE}/gateway.tar`)).size > 0; }
      catch (error) { if (error.code !== 'ENOENT') throw error; return false; } }, 6_000, 'second_upload_not_started');
    const timeoutStarted = Date.now(), timeout = await collector(6, hanging); collectors.push(timeout);
    await until(() => timeout.done, 10_000, 'deadline_did_not_stop_collector');
    const timeoutComplete = await timeout.finish('deadline', false);
    requireProbe(timeout.events.some(event => event.category === 'ss_timeout'), 'helper_timeout_not_observed');
    const helpers = (await readFile(helperPids, 'utf8')).trim().split('\n').map(line => JSON.parse(line).pid);
    for (const pid of helpers) {
      try { await stat(`/proc/${pid}`); throw new ProbeFailure('ss_helper_survived'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    requireProbe(Date.now() - timeoutStarted < CASE_MS, 'timeout_case_deadline');
    phase = 'escaped_helper';
    operation = 'escaped_prepare';
    const escaping = `${ROOT}/escaping`;
    await mkdir(escaping);
    await writeFile(`${escaping}/ss`, `#!/usr/bin/python3\nimport argparse,json,os,signal,time\nargparse.ArgumentParser(add_help=False).parse_known_args()\nif os.fork():os._exit(0)\nos.setsid();signal.signal(signal.SIGTERM,signal.SIG_IGN)\ns=open('/proc/self/stat').read();start=int(s[s.rfind(')')+2:].split()[19])\nwith open(${JSON.stringify(escapedPath)},'w') as f:json.dump({'pid':os.getpid(),'start':start},f)\nwhile True:time.sleep(1)\n`, { mode: 0o700 });
    operation = 'escaped_collector_start';
    const escapedStarted = Date.now(), escaped = await collector(10, escaping); collectors.push(escaped);
    operation = 'escaped_collector_wait';
    await until(() => escaped.done, 12_000, 'escaped_collector_did_not_exit');
    operation = 'escaped_collector_finish';
    const escapedComplete = await escaped.finish('unavailable', false, false);
    requireProbe(escaped.events.some(event => event.category === 'cleanup_unconfirmed'), 'escaped_false_cleanup_confirmation');
    operation = 'escaped_identity_read';
    const identity = JSON.parse(await readFile(escapedPath, 'utf8'));
    operation = 'escaped_alive_check';
    const escapedState = await processState(identity.pid);
    requireProbe(escapedState && escapedState.state !== 'Z' && escapedState.start === identity.start, 'escaped_not_alive_at_failure');
    operation = 'escaped_helper_stop';
    await stopEscaped(identity);
    operation = 'escaped_ps_probe';
    const ps = await clients.run('ps', ['-o', 'pid,stat'], { timeoutMs: 2_000 });
    if (ps.code === 0 && !ps.reason) {
      const row = ps.stdout.split('\n').map(line => line.trim().split(/\s+/)).find(([pid]) => Number(pid) === identity.pid);
      requireProbe(!row || row[1]?.startsWith('Z'), 'escaped_ps_still_running');
    } else requireProbe(ps.reason === 'tool_missing', 'escaped_ps_probe_failed');
    operation = 'escaped_budget_check';
    requireProbe(Date.now() - escapedStarted < CASE_MS, 'escaped_case_deadline');
    phase = 'client_cleanup';
    operation = undefined;
    secondUpload.stop.abort(); await secondUpload.outcome;
    abort.abort(); await Promise.all(jobs);
    requireProbe(clients.children.size === 0 && collectors.every(item => item.processes.children.size === 0), 'test_children_survived');
    requireProbe(Date.now() - started < TOTAL_MS, 'total_deadline');
    return { event: 'linux_receiver_telemetry_verified', payload_bytes: PAYLOAD_BYTES * 2, elapsed_ms: Date.now() - started,
      ssh_version: sshVersion, python_version: pythonVersion, cap_eff: capabilities[1],
      first, second, missing: absent.tcp, gap_category: gap.category, complete,
      timeout_complete: timeoutComplete, escaped_complete: escapedComplete,
      escaped_helper_stopped: true, escaped_cleanup_probe: ps.code === 0 ? 'ps' : 'proc_stat',
      helper_queries_killed: helpers.length, children_active: clients.children.size };
  } catch (error) {
    failure = failureFor(error, phase, operation); throw failure;
  } finally {
    clearTimeout(deadline); abort.abort();
    await cleanupActions([async () => {
      try { await stopEscaped(JSON.parse(await readFile(escapedPath, 'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }, ...collectors.map(item => () => item.stop()), () => {
      for (const item of collectors) item.abort.abort();
    }, () => Promise.all([...jobs, ...collectors.map(item => item.outcome)])], failure);
  }
}

export async function verifyReceiverTelemetry(fixture) {
  let temporary, phase = 'receiver_prepare', failure;
  try {
    temporary = await mkdtemp(join(fixture.root, 'receiver-telemetry-'));
    fixture.runInContainer(['mkdir', '-p', `${ROOT}/scripts/deploy`, `${ROOT}/tests/integration/deploy`, `${ROOT}/credentials`]);
    for (const name of ['transfer-files.mjs', 'transfer-process.mjs', 'receiver-telemetry.py']) {
      fixture.copyToContainer(fileURLToPath(new URL(`../../../scripts/deploy/${name}`, import.meta.url)), `${ROOT}/scripts/deploy/${name}`);
    }
    fixture.copyToContainer(fileURLToPath(import.meta.url), TEST);
    fixture.copyToContainer(fixture.values['key-file'], `${ROOT}/credentials/client`);
    const publicKey = (await readFile(fixture.values['known-hosts-file'], 'utf8')).trim().split(' ').slice(1).join(' ');
    const knownHosts = join(temporary, 'known_hosts');
    await writeFile(knownHosts, `[127.0.0.1]:2222 ${publicKey}\n`, { mode: 0o600 });
    fixture.copyToContainer(knownHosts, `${ROOT}/credentials/known_hosts`);
    let output; phase = 'receiver_runtime';
    try { output = fixture.runInContainer(['node', TEST, '--in-container'], { timeout: TOTAL_MS }); }
    catch (error) {
      throw containerFailure(error.stderr) ?? failureFor(error, phase);
    }
    phase = 'host_validation';
    safeText(output);
    const evidence = JSON.parse(output.trim());
    requireProbe(evidence.event === 'linux_receiver_telemetry_verified' && evidence.children_active === 0, 'invalid_evidence');
    console.log(`PASS real Linux receiver OpenSSH ${evidence.ssh_version}/Python ${evidence.python_version.join('.')}: SSH-stdin observer/status excluded; writable archive FD/inode -> upload socket; bytes_received ${evidence.first.tcp.bytes_received}->${evidence.second.tcp.bytes_received}; missing=null; writer-exit gap; SIGTERM/deadline clean; escaped helper correctly unconfirmed then stopped (${evidence.elapsed_ms}ms)`);
    return evidence;
  } catch (error) {
    failure = failureFor(error, phase); throw failure;
  } finally {
    await cleanupActions([() => fixture.runInContainer(['rm', '-rf', ROOT]),
      async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); }], failure);
  }
}

async function main() {
  let phase = 'arguments', fixture, failure;
  try {
    const { values } = parseArgs({ options: { run: { type: 'boolean' }, 'in-container': { type: 'boolean' },
      profile: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
    if (values.help || (!values.run && !values['in-container'])) {
      console.log('Usage: node tests/integration/deploy/receiver-telemetry.mjs --run [--profile alpine|ubuntu22]'); return;
    }
    requireProbe(!(values.run && values['in-container']) && ['alpine', 'ubuntu22'].includes(values.profile ?? 'alpine'), 'invalid_options');
    if (values['in-container']) { console.log(JSON.stringify(await linuxProbe())); return; }
    const { transferSshFixture } = await import('../../support/transfer-ssh-fixture.mjs');
    phase = 'fixture_create';
    fixture = await transferSshFixture({ profile: values.profile ?? 'alpine', inspectProcesses: true });
    phase = 'receiver_runtime';
    await verifyReceiverTelemetry(fixture);
  } catch (error) {
    failure = failureFor(error, phase); throw failure;
  } finally { if (fixture) await cleanupActions([() => fixture.close()], failure); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(JSON.stringify(failureEvent(error)));
    process.exitCode = 1;
  });
}
