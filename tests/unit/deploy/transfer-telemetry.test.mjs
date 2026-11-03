import assert from 'node:assert/strict';
import test from 'node:test';
import { createSenderTelemetry, parseTcpSockets, parseProcessStat, parseProcessIo,
  parseIoPressure } from '../../../scripts/deploy/transfer-telemetry.mjs';

const GROUP = 101;
const SSH = 202;
const SECRET = 'SYNTHETIC_TOKEN_https://secret.invalid/credential';
const PROC_IO = 'rchar: 42000\nwchar: 123\nsyscr: 10\nsyscw: 1\nread_bytes: 8192\nwrite_bytes: 0\n';
const PRESSURE = 'some avg10=1.25 avg60=0.30 avg300=0.10 total=1234\nfull avg10=0.25 avg60=0.10 avg300=0.01 total=321\n';
const TCP_INFO = 'cubic rtt:101.25/4.5 minrtt:98.5 rcv_rtt:999 cwnd:12 mss:1448 ssthresh:10 ' +
  'bytes_sent:42000 bytes_acked:40000 bytes_retrans:1448 retrans:1/3 snd_wnd:65535 ' +
  'busy:234ms rwnd_limited:10ms(4.3%) sndbuf_limited:7ms(3.0%)';

function processStat(pid, name, group = GROUP, { start = 999, user = 30, system = 7, state = 'S' } = {}) {
  const fields = Array(50).fill('0');
  fields[0] = state;
  fields[2] = String(group);
  fields[11] = String(user);
  fields[12] = String(system);
  fields[19] = String(start);
  return `${pid} (${name}) ${fields.join(' ')}\n`;
}

function ssSocket(pid = SSH, fd = 3, info = TCP_INFO, state = 'ESTAB') {
  return `${state} 0 123 192.0.2.11:32123 198.51.100.22:22 users:(("ssh",pid=${pid},fd=${fd}))\n\t ${info}\n`;
}

function fixture({ stdout = ssSocket(), outcome, onRun, platform = 'linux' } = {}) {
  const files = new Map([
    [`/proc/${GROUP}/stat`, processStat(GROUP, 'scp')],
    [`/proc/${GROUP}/io`, PROC_IO],
    [`/proc/${GROUP}/task/${GROUP}/children`, `${SSH} `],
    [`/proc/${SSH}/stat`, processStat(SSH, 'ssh')],
    [`/proc/${SSH}/io`, PROC_IO],
    ['/proc/pressure/io', PRESSURE],
  ]);
  const links = new Map([[`/proc/${SSH}/fd/3`, 'socket:[123456]']]);
  const calls = [];
  const read = async (map, path) => {
    const value = map.get(path);
    if (value instanceof Error) throw value;
    if (value === undefined) throw Object.assign(new Error(SECRET), { code: 'ENOENT' });
    return typeof value === 'function' ? value() : value;
  };
  const fs = { readFile: async (path, encoding) => {
    assert.equal(encoding, 'utf8');
    return read(files, path);
  }, readlink: path => read(links, path) };
  const processes = { async run(command, args, options) {
    calls.push({ command, args, options });
    await onRun?.({ files, links });
    if (outcome instanceof Error) throw outcome;
    return outcome ?? { code: 0, stdout, stderr: SECRET };
  } };
  return { telemetry: createSenderTelemetry({ processes, fs, platform }), files, links, calls };
}

test('TCP rtt and variance match exact tokens independently from minrtt and receiver RTT', () => {
  const tcp = parseTcpSockets(ssSocket())[0].metrics;
  assert.equal(tcp.rtt_ms, 101.25);
  assert.equal(tcp.rtt_variance_ms, 4.5);
  assert.equal(tcp.min_rtt_ms, 98.5);
  assert.equal(tcp.cwnd_segments, 12);
  assert.equal(tcp.retransmits_current, 1);
  assert.equal(tcp.retransmits_total, 3);
  assert.equal(tcp.rwnd_limited_ms, 10);
  assert.equal(tcp.rwnd_limited_percent, 4.3);
  assert.equal(tcp.snd_wnd_bytes, 65535);
  assert.equal(tcp.bytes_sent, 42000);
  assert.equal(tcp.bytes_acked, 40000);
  assert.equal(tcp.bytes_retrans, 1448);
  for (const text of ['minrtt:27.5 rcv_rtt:100', 'minrtt:27.5/2', 'notrtt:1/2 rcv_rtt:2/3',
    'rtt:12/3secret minrtt:4x', 'rtt:-1/2', 'rtt:1e3/2', 'rtt:NaN/2']) {
    const metrics = parseTcpSockets(ssSocket(SSH, 3, text))[0].metrics;
    assert.equal(metrics.rtt_ms, null, text);
    assert.equal(metrics.rtt_variance_ms, null, text);
  }
  assert.equal(parseTcpSockets(ssSocket(SSH, 3, 'minrtt:27.5'))[0].metrics.min_rtt_ms, 27.5);
  assert.equal(parseTcpSockets(ssSocket(SSH, 3, 'bytes_sent:9007199254740992'))[0].metrics.bytes_sent, null);
});

test('TCP parser keeps per-socket ownership and counters apart and discards all raw fields', () => {
  const parsed = parseTcpSockets(ssSocket(SSH, 3, `rtt:100/10 bytes_sent:100 ${SECRET}`) +
    ssSocket(303, 9, 'rtt:1/0.1 bytes_sent:999999'));
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0].owners, [{ pid: SSH, fd: 3 }]);
  assert.equal(parsed[0].metrics.bytes_sent, 100);
  assert.equal(parsed[1].metrics.bytes_sent, 999999);
  assert.equal(parseTcpSockets(ssSocket(SSH, 3, TCP_INFO, 'CLOSE-WAIT')).length, 0);
  assert.ok(!JSON.stringify(parsed).includes(SECRET));
  assert.ok(!JSON.stringify(parsed).includes('192.0.2'));
  assert.equal(parseTcpSockets('x'.repeat(64 * 1024 + 1)), null);
  assert.equal(parseTcpSockets(Array(129).fill(ssSocket()).join('')), null);
});

test('proc parsers use Linux stat field positions without assuming a clock tick frequency', () => {
  assert.deepEqual(parseProcessStat(processStat(SSH, 'ssh', GROUP, { user: 4321, system: 876, start: 123 })),
    { pid: SSH, name: 'ssh', state: 'S', group: GROUP, userTicks: 4321, systemTicks: 876, startTicks: 123 });
  assert.equal(parseProcessStat(processStat(SSH, 'name ) with spaces')).name, 'name ) with spaces');
  assert.deepEqual(parseProcessIo(PROC_IO), { rchar: 42000, read_bytes: 8192 });
  assert.equal(parseProcessStat('not a stat'), null);
  assert.equal(parseProcessIo('rchar: 0\nread_bytes: unknown\n'), null);
  assert.equal(parseProcessIo('rchar: 9007199254740992\nread_bytes: 0\n'), null);
  assert.deepEqual(parseIoPressure(PRESSURE), { some_avg10_percent: 1.25, some_total_us: 1234,
    full_avg10_percent: 0.25, full_total_us: 321 });
  assert.equal(parseIoPressure('some avg10=101 total=1\nfull avg10=0 total=0\n'), null);
});

test('sampler selects only the direct SSH child in the SCP process group', async () => {
  const f = fixture({ stdout: ssSocket(303, 3, 'rtt:1/1 bytes_sent:999999') + ssSocket() });
  f.files.set(`/proc/${GROUP}/task/${GROUP}/children`, `${SSH} 303 404`);
  f.files.set('/proc/303/stat', processStat(303, 'ssh', 909));
  f.files.set('/proc/404/stat', processStat(404, 'unrelated'));
  const output = await f.telemetry.sample({ processGroupPid: GROUP });
  assert.equal(output.status, 'available');
  assert.equal(output.category, 'ok');
  assert.equal(output.process_group_pid, GROUP);
  assert.equal(output.ssh_pid, SSH);
  assert.equal(output.socket_fd, 3);
  assert.equal(output.tcp.rtt_ms, 101.25);
  assert.equal(output.tcp.bytes_sent, 42000);
  assert.equal(output.processes.scp.cpu_user_ticks, 30);
  assert.equal(output.processes.ssh.cpu_system_ticks, 7);
  assert.equal(output.processes.scp.rchar, 42000);
  assert.equal(output.processes.scp.read_bytes, 8192);
  assert.equal(output.io_pressure.some_avg10_percent, 1.25);
  assert.deepEqual(f.calls.map(call => [call.command, call.args, call.options.timeoutMs]), [['ss', ['-Hntip'], 1500]]);
  assert.ok(!JSON.stringify(output).includes(SECRET));
  assert.ok(!JSON.stringify(output).includes('192.0.2'));
  assert.ok(!JSON.stringify(output).includes('198.51.100'));
});

test('multiple owned upload sockets are explicitly ambiguous and their values never mix', async () => {
  const f = fixture({ stdout: ssSocket() + ssSocket(SSH, 4, 'rtt:1/1 bytes_sent:999999') });
  f.links.set(`/proc/${SSH}/fd/4`, 'socket:[654321]');
  const output = await f.telemetry.sample({ processGroupPid: GROUP });
  assert.equal(output.category, 'socket_ambiguous');
  assert.equal(output.process_group_pid, GROUP);
  assert.equal(output.ssh_pid, null);
  assert.equal(output.socket_fd, null);
  assert.ok(Object.values(output.tcp).every(value => value === null));
});

test('SCP or SSH exit, PID reuse and FD changes produce explicit unavailability', async () => {
  for (const [name, mutate, expected] of [
    ['SCP exits', ({ files }) => files.delete(`/proc/${GROUP}/stat`), 'process_exited'],
    ['SSH exits', ({ files }) => files.delete(`/proc/${SSH}/stat`), 'process_exited'],
    ['SCP PID reused', ({ files }) => files.set(`/proc/${GROUP}/stat`, processStat(GROUP, 'scp', GROUP, { start: 1000 })), 'process_changed'],
    ['SSH PID reused', ({ files }) => files.set(`/proc/${SSH}/stat`, processStat(SSH, 'ssh', GROUP, { start: 1000 })), 'process_changed'],
    ['SSH moved group', ({ files }) => files.set(`/proc/${SSH}/stat`, processStat(SSH, 'ssh', 999)), 'process_changed'],
    ['FD closes', ({ links }) => links.delete(`/proc/${SSH}/fd/3`), 'process_exited'],
    ['FD is not socket', ({ links }) => links.set(`/proc/${SSH}/fd/3`, SECRET), 'socket_changed'],
  ]) {
    const f = fixture({ onRun: mutate });
    const output = await f.telemetry.sample({ processGroupPid: GROUP });
    assert.equal(output.category, expected, name);
    assert.equal(output.status, 'unavailable', name);
    assert.equal(output.ssh_pid, null, name);
    assert.equal(output.socket_fd, null, name);
    assert.ok(Object.values(output.tcp).every(value => value === null), name);
    assert.ok(!JSON.stringify(output).includes(SECRET), name);
  }
  const f = fixture();
  let links = 0;
  f.links.set(`/proc/${SSH}/fd/3`, () => ++links === 1 ? 'socket:[123]' : 'socket:[124]');
  assert.equal((await f.telemetry.sample({ processGroupPid: GROUP })).category, 'process_changed');
});

test('tool errors and secret-bearing output return only fixed categories and never throw', async () => {
  for (const [outcome, expected] of [
    [{ code: null, reason: 'tool_missing', stdout: SECRET, stderr: SECRET }, 'ss_missing'],
    [{ code: null, reason: 'timeout', stdout: SECRET, stderr: SECRET }, 'ss_timeout'],
    [{ code: null, reason: 'cancelled', stdout: SECRET, stderr: SECRET }, 'cancelled'],
    [{ code: null, reason: 'output_limit', stdout: SECRET, stderr: SECRET }, 'ss_output_limit'],
    [{ code: 1, reason: SECRET, stdout: SECRET, stderr: SECRET }, 'ss_failed'],
    [{ code: 1, reason: '__proto__', stdout: SECRET, stderr: SECRET }, 'ss_failed'],
    [{ code: 1, reason: 'constructor', stdout: SECRET, stderr: SECRET }, 'ss_failed'],
    [new Error(SECRET), 'ss_error'],
    [{ code: 0, stdout: SECRET, stderr: SECRET }, 'socket_unavailable'],
    [{ code: 0, stdout: 'x'.repeat(64 * 1024 + 1) }, 'ss_invalid'],
  ]) {
    const f = fixture({ outcome });
    const output = await f.telemetry.sample({ processGroupPid: GROUP });
    assert.equal(output.category, expected);
    assert.equal(output.process_group_pid, GROUP);
    assert.equal(output.ssh_pid, null);
    assert.ok(!JSON.stringify(output).includes(SECRET));
    assert.equal(output.processes.scp.status, 'available', 'CPU/IO observations survive ss failures');
  }
});

test('missing fields, process metadata and permissions are observable without false zeroes', async () => {
  for (const [mutate, expected] of [
    [f => f.files.set(`/proc/${GROUP}/task/${GROUP}/children`, ''), 'ssh_unavailable'],
    [f => f.files.set(`/proc/${GROUP}/stat`, processStat(GROUP, 'scp', 999)), 'process_group_mismatch'],
    [f => f.files.set(`/proc/${GROUP}/stat`, processStat(GROUP, 'scp', GROUP, { state: 'Z' })), 'process_exited'],
    [f => f.files.set(`/proc/${GROUP}/stat`, Object.assign(new Error(SECRET), { code: 'EACCES' })), 'proc_permission'],
    [f => f.files.set(`/proc/${GROUP}/stat`, 'malformed'), 'proc_invalid'],
  ]) {
    const f = fixture(); mutate(f);
    const output = await f.telemetry.sample({ processGroupPid: GROUP });
    assert.equal(output.category, expected);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture({ stdout: ssSocket(SSH, 3, 'cwnd:0 bytes_retrans:0') });
  f.files.set(`/proc/${GROUP}/io`, Object.assign(new Error(SECRET), { code: 'EACCES' }));
  f.files.delete('/proc/pressure/io');
  const output = await f.telemetry.sample({ processGroupPid: GROUP });
  assert.equal(output.status, 'available');
  assert.equal(output.tcp.cwnd_segments, 0);
  assert.equal(output.tcp.bytes_retrans, 0);
  assert.equal(output.tcp.rtt_ms, null);
  assert.equal(output.processes.scp.io_status, 'unavailable');
  assert.equal(output.processes.scp.io_category, 'proc_permission');
  assert.equal(output.processes.scp.read_bytes, null);
  assert.equal(output.io_pressure.category, 'io_missing');
});

test('non-Linux, absent SCP PID and cancellation never start a helper process', async () => {
  for (const [options, args, expected] of [
    [{ platform: 'darwin' }, { processGroupPid: GROUP }, 'platform_unsupported'],
    [{}, {}, 'process_group_missing'],
    [{}, { processGroupPid: -1 }, 'process_group_missing'],
    [{}, { processGroupPid: GROUP, signal: AbortSignal.abort() }, 'cancelled'],
  ]) {
    const f = fixture(options);
    const output = await f.telemetry.sample(args);
    assert.equal(output.status, 'unavailable');
    assert.equal(output.category, expected);
    assert.equal(output.process_group_pid, null);
    assert.equal(output.ssh_pid, null);
    assert.equal(f.calls.length, 0);
  }
  const controller = new AbortController();
  const f = fixture();
  await f.telemetry.sample({ processGroupPid: GROUP, signal: controller.signal });
  assert.equal(f.calls[0].options.signal, controller.signal);
});
