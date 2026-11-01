import { spawn } from 'node:child_process';

const OUTPUT_LIMIT = 64 * 1024;
const STOP_GRACE_MS = 1_000;
const CHILD_ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL'];

export class TransferFailure extends Error {
  constructor(category) { super(category); this.category = category; }
}

export function errorCategory(result) {
  if (result.reason) return result.reason;
  if (result.code === 73) return 'stage_ownership';
  if (result.code === 74) return 'integrity';
  if (result.code === 75) return 'unexpected_stage_files';
  const text = result.stderr ?? '';
  for (const [pattern, category] of [
    [/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i, 'host_key'],
    [/Permission denied \(publickey|Authentication failed/i, 'authentication'],
    [/Could not resolve hostname|Name or service not known/i, 'dns'],
    [/Connection timed out|Operation timed out/i, 'timeout'],
    [/Connection refused|No route to host|Network is unreachable/i, 'network_connect'],
    [/Connection reset|Broken pipe|Connection closed/i, 'network_closed'],
    [/No space left on device/i, 'remote_capacity'],
    [/Permission denied/i, 'remote_permission'],
  ]) if (pattern.test(text)) return category;
  return 'remote_command';
}

function groupSignal(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw new TransferFailure('process_stop'); }
}

async function boundedWait(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise.then(() => true), new Promise(resolve => {
    timer = setTimeout(() => resolve(false), milliseconds);
  })]); } finally { clearTimeout(timer); }
}

// Every SSH/SCP gets its own process group. No raw tool output reaches the logger.
export class TransferProcesses {
  children = new Set();

  async run(command, args, { input, signal, timeoutMs, environment = {} } = {}) {
    if (signal?.aborted) return { code: null, reason: 'cancelled', stdout: '', stderr: '' };
    const env = { ...Object.fromEntries(CHILD_ENV_KEYS.filter(key => process.env[key] !== undefined)
      .map(key => [key, process.env[key]])), ...environment };
    const child = spawn(command, args, { detached: true, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.children.add(child);
    let stdout = '', stderr = '', bytes = 0, reason, stopping, timer;
    let closeChild;
    const closed = new Promise(resolve => { closeChild = resolve; });
    const stop = category => {
      reason ??= category;
      stopping ??= (async () => {
        groupSignal(child, 'SIGTERM');
        await boundedWait(closed, STOP_GRACE_MS);
        // A parent may exit before its descendants; still signal the whole group.
        groupSignal(child, 'SIGKILL');
        if (!await boundedWait(closed, STOP_GRACE_MS)) throw new TransferFailure('process_stop');
      })();
    };
    const abort = () => stop('cancelled');
    const capture = stream => data => {
      bytes += data.length;
      if (bytes > OUTPUT_LIMIT) { stop('output_limit'); return; }
      if (stream === 'stdout') stdout += data.toString(); else stderr += data.toString();
    };
    child.stdout.on('data', capture('stdout'));
    child.stderr.on('data', capture('stderr'));
    child.stdin.on('error', () => { reason ??= 'input_io'; });
    child.once('error', error => { reason ??= error.code === 'ENOENT' ? 'tool_missing' : 'process_start'; });
    const result = new Promise(resolve => child.once('close', (code, childSignal) => {
      this.children.delete(child);
      closeChild();
      resolve({ code, signal: childSignal });
    }));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    if (timeoutMs !== undefined) timer = setTimeout(() => stop('timeout'), Math.max(1, timeoutMs));
    child.stdin.end(input);
    try {
      const outcome = await result;
      if (stopping) await stopping;
      return { ...outcome, stdout, stderr, reason };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async checked(command, args, options) {
    const result = await this.run(command, args, options);
    if (result.code !== 0 || result.reason) throw new TransferFailure(errorCategory(result));
    return result;
  }
}
