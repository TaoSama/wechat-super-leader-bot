import { readFile, readlink } from 'node:fs/promises';

const QUERY_MS = 1_500;
const PROC_LIMIT = 8 * 1024;
const OUTPUT_LIMIT = 64 * 1024;
const CHILD_LIMIT = 16;
const SOCKET_LIMIT = 128;
const NUMBER = '(?:[0-9]+(?:\\.[0-9]+)?)';
const TCP_FIELDS = ['rtt_ms', 'rtt_variance_ms', 'min_rtt_ms', 'cwnd_segments', 'ssthresh_segments',
  'mss_bytes', 'retransmits_current', 'retransmits_total', 'bytes_sent', 'bytes_acked', 'bytes_retrans',
  'snd_wnd_bytes', 'rwnd_limited_ms', 'rwnd_limited_percent', 'sndbuf_limited_ms', 'busy_ms'];

function numeric(value, integer = false) {
  if (!new RegExp(`^${NUMBER}$`).test(value ?? '')) return null;
  const number = Number(value);
  return Number.isFinite(number) && number <= Number.MAX_SAFE_INTEGER &&
    (!integer || Number.isSafeInteger(number)) ? number : null;
}

function token(text, name, pattern) {
  return new RegExp(`(?:^|\\s)${name}:(${pattern})(?=\\s|$)`).exec(text)?.[1];
}

function emptyTcp() { return Object.fromEntries(TCP_FIELDS.map(name => [name, null])); }

function tcpMetrics(text) {
  const metrics = emptyTcp();
  const rtt = token(text, 'rtt', `${NUMBER}/${NUMBER}`)?.split('/');
  metrics.rtt_ms = numeric(rtt?.[0]);
  metrics.rtt_variance_ms = numeric(rtt?.[1]);
  metrics.min_rtt_ms = numeric(token(text, 'minrtt', NUMBER));
  for (const [source, target] of [['cwnd', 'cwnd_segments'], ['ssthresh', 'ssthresh_segments'],
    ['mss', 'mss_bytes'], ['bytes_sent', 'bytes_sent'], ['bytes_acked', 'bytes_acked'],
    ['bytes_retrans', 'bytes_retrans'], ['snd_wnd', 'snd_wnd_bytes']]) {
    metrics[target] = numeric(token(text, source, '[0-9]+'), true);
  }
  const retrans = token(text, 'retrans', '[0-9]+/[0-9]+')?.split('/');
  metrics.retransmits_current = numeric(retrans?.[0], true);
  metrics.retransmits_total = numeric(retrans?.[1], true);
  for (const [source, target] of [['rwnd_limited', 'rwnd_limited_ms'],
    ['sndbuf_limited', 'sndbuf_limited_ms'], ['busy', 'busy_ms']]) {
    const value = token(text, source, `${NUMBER}ms(?:\\(${NUMBER}%\\))?`);
    metrics[target] = numeric(value?.split('ms')[0]);
    if (source === 'rwnd_limited') {
      const percent = numeric(/\(([0-9.]+)%\)/.exec(value ?? '')?.[1]);
      metrics.rwnd_limited_percent = percent !== null && percent <= 100 ? percent : null;
    }
  }
  return metrics;
}

// Only ownership integers and allowlisted counters survive parsing; addresses and raw text never do.
export function parseTcpSockets(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > OUTPUT_LIMIT) return null;
  const records = [];
  let current;
  for (const line of text.split('\n')) {
    const state = /^(\S+)\s+[0-9]+\s+[0-9]+\s+\S+\s+\S+(?:\s|$)/.exec(line);
    if (state) {
      if (records.length >= SOCKET_LIMIT) return null;
      current = { established: state[1] === 'ESTAB', text: line };
      records.push(current);
    } else if (current && /^\s+\S/.test(line)) current.text += ` ${line.trim()}`;
  }
  return records.filter(record => record.established).map(record => ({
    owners: [...record.text.matchAll(/\bpid=([1-9][0-9]*),fd=([0-9]+)\b/g)]
      .map(match => ({ pid: numeric(match[1], true), fd: numeric(match[2], true) }))
      .filter(owner => owner.pid !== null && owner.fd !== null),
    metrics: tcpMetrics(record.text),
  }));
}

export function parseProcessStat(text) {
  if (typeof text !== 'string' || text.length > PROC_LIMIT) return null;
  const match = /^([1-9][0-9]*) \(([\s\S]*)\) ([\s\S]*)$/.exec(text.trim());
  if (!match) return null;
  const fields = match[3].split(/\s+/);
  const result = { pid: numeric(match[1], true), name: match[2], state: fields[0],
    group: numeric(fields[2], true), userTicks: numeric(fields[11], true),
    systemTicks: numeric(fields[12], true), startTicks: numeric(fields[19], true) };
  return Object.values(result).some(value => value === null || value === undefined) ? null : result;
}

export function parseProcessIo(text) {
  if (typeof text !== 'string' || text.length > PROC_LIMIT) return null;
  const values = Object.fromEntries(['rchar', 'read_bytes'].map(name => [name,
    numeric(new RegExp(`^${name}:\\s+([0-9]+)$`, 'm').exec(text)?.[1], true)]));
  return Object.values(values).some(value => value === null) ? null : values;
}

export function parseIoPressure(text) {
  if (typeof text !== 'string' || text.length > PROC_LIMIT) return null;
  const values = {};
  for (const name of ['some', 'full']) {
    const line = new RegExp(`^${name} ([^\\n]+)$`, 'm').exec(text)?.[1];
    values[`${name}_avg10_percent`] = numeric(new RegExp(`(?:^|\\s)avg10=(${NUMBER})(?=\\s|$)`).exec(line ?? '')?.[1]);
    values[`${name}_total_us`] = numeric(/(?:^|\s)total=([0-9]+)(?=\s|$)/.exec(line ?? '')?.[1], true);
    if (values[`${name}_avg10_percent`] > 100) return null;
  }
  return Object.values(values).some(value => value === null) ? null : values;
}

class ObservationFailure extends Error {
  constructor(category) { super(category); this.category = category; }
}

function procCategory(error) {
  if (['ENOENT', 'ESRCH'].includes(error?.code)) return 'process_exited';
  if (['EACCES', 'EPERM'].includes(error?.code)) return 'proc_permission';
  return 'proc_io';
}

function emptyProcess(category = 'not_sampled') {
  return { status: 'unavailable', category, cpu_user_ticks: null, cpu_system_ticks: null,
    rchar: null, read_bytes: null, io_status: 'unavailable', io_category: category };
}

function emptyPressure(category = 'not_sampled') {
  return { status: 'unavailable', category, some_avg10_percent: null, some_total_us: null,
    full_avg10_percent: null, full_total_us: null };
}

function toolCategory(result) {
  return new Map([['tool_missing', 'ss_missing'], ['timeout', 'ss_timeout'], ['cancelled', 'cancelled'],
    ['output_limit', 'ss_output_limit'], ['process_start', 'ss_start']]).get(result?.reason) ?? 'ss_failed';
}

// Sampling is passive: every helper subprocess is owned and stopped by TransferProcesses.
// SCP normally reads the archives and SSH spends CPU encrypting them. read_bytes excludes
// page-cache hits; rchar includes them. CPU counters are raw ticks, and missing values stay null.
export function createSenderTelemetry({ processes, platform = process.platform,
  fs = { readFile, readlink } } = {}) {
  async function stat(pid) {
    let text;
    try { text = await fs.readFile(`/proc/${pid}/stat`, 'utf8'); }
    catch (error) { throw new ObservationFailure(procCategory(error)); }
    const value = parseProcessStat(text);
    if (!value || value.pid !== pid) throw new ObservationFailure('proc_invalid');
    if (['Z', 'X', 'x'].includes(value.state)) throw new ObservationFailure('process_exited');
    return value;
  }

  async function metrics(value) {
    const output = { ...emptyProcess(), status: 'available', category: 'ok',
      cpu_user_ticks: value.userTicks, cpu_system_ticks: value.systemTicks };
    let io;
    try { io = parseProcessIo(await fs.readFile(`/proc/${value.pid}/io`, 'utf8')); }
    catch (error) { output.io_category = procCategory(error); return output; }
    if (!io) { output.io_category = 'proc_invalid'; return output; }
    return { ...output, ...io, io_status: 'available', io_category: 'ok' };
  }

  async function pressure() {
    let value;
    try { value = parseIoPressure(await fs.readFile('/proc/pressure/io', 'utf8')); }
    catch (error) {
      return emptyPressure(['EACCES', 'EPERM'].includes(error?.code) ? 'io_permission' :
        ['ENOENT', 'ENOTDIR'].includes(error?.code) ? 'io_missing' : 'io_error');
    }
    return value ? { status: 'available', category: 'ok', ...value } : emptyPressure('io_invalid');
  }

  async function socket(pid, fd) {
    let link;
    try { link = await fs.readlink(`/proc/${pid}/fd/${fd}`); }
    catch (error) { throw new ObservationFailure(procCategory(error)); }
    if (!/^socket:\[[0-9]+\]$/.test(link)) throw new ObservationFailure('socket_changed');
    return link;
  }

  return { async sample({ processGroupPid, signal } = {}) {
    const output = { status: 'unavailable', category: 'not_sampled', process_group_pid: null,
      ssh_pid: null, socket_fd: null, tcp: emptyTcp(),
      processes: { scp: emptyProcess(), ssh: emptyProcess() }, io_pressure: emptyPressure() };
    const unavailable = category => ({ ...output, status: 'unavailable', category });
    if (platform !== 'linux') return unavailable('platform_unsupported');
    if (signal?.aborted) return unavailable('cancelled');
    if (!Number.isSafeInteger(processGroupPid) || processGroupPid <= 0) return unavailable('process_group_missing');
    try {
      const root = await stat(processGroupPid);
      if (root.group !== processGroupPid || root.name !== 'scp') return unavailable('process_group_mismatch');
      output.process_group_pid = processGroupPid;
      output.processes.scp = await metrics(root);
      output.io_pressure = await pressure();
      let children;
      try { children = await fs.readFile(`/proc/${processGroupPid}/task/${processGroupPid}/children`, 'utf8'); }
      catch (error) {
        if (['ENOENT', 'ESRCH'].includes(error?.code)) {
          const current = await stat(processGroupPid);
          if (current.startTicks !== root.startTicks || current.name !== root.name || current.group !== root.group) {
            return unavailable('process_changed');
          }
          return unavailable('children_unavailable');
        }
        throw new ObservationFailure(procCategory(error));
      }
      if (children.length > PROC_LIMIT || !/^(?:[1-9][0-9]*(?:\s+|$))*$/.test(children)) return unavailable('proc_invalid');
      const childIds = children.trim() ? children.trim().split(/\s+/).map(Number) : [];
      if (childIds.length > CHILD_LIMIT || childIds.some(pid => !Number.isSafeInteger(pid))) return unavailable('proc_limit');
      const ssh = new Map();
      for (const pid of childIds) {
        let child;
        try { child = await stat(pid); }
        catch (error) { if (error instanceof ObservationFailure && error.category === 'process_exited') continue; throw error; }
        if (child.name === 'ssh' && child.group === processGroupPid) ssh.set(pid, child);
      }
      if (ssh.size === 0) return unavailable('ssh_unavailable');
      if (ssh.size === 1) output.processes.ssh = await metrics(ssh.values().next().value);
      if (signal?.aborted) return unavailable('cancelled');
      if (typeof processes?.run !== 'function') return unavailable('ss_unavailable');
      let result;
      try { result = await processes.run('ss', ['-Hntip'], { signal, timeoutMs: QUERY_MS }); }
      catch { return unavailable('ss_error'); }
      if (!result || result.reason || result.code !== 0) return unavailable(toolCategory(result));
      const records = parseTcpSockets(result.stdout);
      if (!records) return unavailable('ss_invalid');
      const candidates = [];
      for (const record of records) {
        const owners = record.owners.filter(owner => ssh.has(owner.pid));
        if (owners.length) candidates.push({ record, owner: owners[0] });
      }
      if (candidates.length !== 1) return unavailable(candidates.length ? 'socket_ambiguous' : 'socket_unavailable');
      const { record, owner } = candidates[0];
      const link = await socket(owner.pid, owner.fd);
      const current = await stat(owner.pid), currentRoot = await stat(processGroupPid);
      const previous = ssh.get(owner.pid);
      if (current.startTicks !== previous.startTicks || current.group !== root.group || current.name !== 'ssh' ||
        currentRoot.startTicks !== root.startTicks || currentRoot.group !== root.group || currentRoot.name !== 'scp' ||
        await socket(owner.pid, owner.fd) !== link) return unavailable('process_changed');
      output.ssh_pid = owner.pid;
      output.socket_fd = owner.fd;
      output.processes.ssh = await metrics(current);
      if (Object.values(record.metrics).every(value => value === null)) return unavailable('tcp_info_unavailable');
      output.tcp = record.metrics;
      return { ...output, status: 'available', category: 'ok' };
    } catch (error) {
      return unavailable(error instanceof ObservationFailure ? error.category : 'observation_error');
    }
  } };
}
