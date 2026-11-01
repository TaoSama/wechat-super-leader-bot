import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { TransferFailure, TransferProcesses, errorCategory } from './transfer-process.mjs';
import { RELEASE_FILES, DIAGNOSTIC_FILES, DIAGNOSTIC_PAYLOAD_LIMIT, REMOTE_FILES, manifestFor, quoteShell } from './transfer-files.mjs';

const PROGRESS_MS = 15_000;
const REMOTE_OPERATION_MS = 30_000;
const CLEANUP_MS = 8_000;
const SSH_CONNECT_SECONDS = 5;
const REMOTE_EXECUTION_RESERVE_MS = 1_000;
const MIN_OPERATION_MS = 2_000;
const DIAGNOSTIC_MS = 60_000;
const DIAGNOSTIC_RESERVE_MS = 10_000;
const DIAGNOSTIC_SUCCESS_BYTES = 1024 * 1024;
const DIAGNOSTIC_CANCEL_BYTES = 256 * 1024;
const DIAGNOSTIC_PARTIAL_WAIT_MS = 10_000;
const DIAGNOSTIC_POLL_MS = 500;

export function transferConfiguration(values, env = process.env) {
  const config = { diagnostic: values.diagnostic === true, root: values['release-root'],
    key: values['key-file'], knownHosts: values['known-hosts-file'], host: env.DEPLOY_HOST,
    user: env.DEPLOY_USER, port: Number(env.DEPLOY_PORT || 22), path: env.DEPLOY_PATH,
    revision: env.REVISION, run: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT,
    envFile: env.DEPLOY_ENV_FILE || '.runtime/controller.env', repository: env.GITHUB_REPOSITORY, githubToken: env.GH_TOKEN };
  const validPath = value => typeof value === 'string' && /^\/[A-Za-z0-9._/-]+$/.test(value) &&
    value !== '/' && posix.normalize(value) === value && !value.split('/').includes('..');
  if (!/^[0-9a-f]{40}$/.test(config.revision ?? '') || !/^[1-9][0-9]*$/.test(config.run ?? '') ||
    !/^[1-9][0-9]*$/.test(config.attempt ?? '') || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(config.host ?? '') ||
    !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(config.user ?? '') || !Number.isInteger(config.port) ||
    config.port < 1 || config.port > 65535 || !validPath(config.path) ||
    !config.key || !config.knownHosts || (config.diagnostic ? config.root !== undefined : !config.root) ||
    !/^[A-Za-z0-9._/-]+$/.test(config.envFile) || config.envFile.split('/').includes('..')) {
    throw new TransferFailure('configuration');
  }
  config.stage = `${config.path}/.runtime/releases/${config.diagnostic ? 'diagnostic-' : ''}${config.revision}-${config.run}-${config.attempt}`;
  return config;
}

export class ReleaseTransfer {
  constructor(config, { signal, log = console.log, processes = new TransferProcesses(), beforeActivate } = {}) {
    this.config = config;
    this.processes = processes;
    this.beforeActivate = beforeActivate ?? (() => this.processes.checked(process.execPath,
      [fileURLToPath(new URL('./resolve-revision.mjs', import.meta.url)), '--assert-current', config.revision], {
        signal: this.signal, timeoutMs: REMOTE_OPERATION_MS,
        environment: { GH_TOKEN: config.githubToken ?? '', GITHUB_REPOSITORY: config.repository ?? '' },
      }));
    this.started = Date.now();
    this.deadline = config.diagnostic ? this.started + DIAGNOSTIC_MS : Infinity;
    this.abort = new AbortController();
    this.signal = signal ? AbortSignal.any([signal, this.abort.signal]) : this.abort.signal;
    this.owner = randomBytes(32).toString('hex');
    this.log = (event, fields = {}) => log(JSON.stringify({ schema: 1, event,
      mode: config.diagnostic ? 'diagnostic-only' : 'production', revision: config.revision,
      run_id: config.run, attempt: config.attempt, elapsed_ms: Date.now() - this.started, ...fields }));
  }

  timeout(cleanup = false) {
    const remaining = this.deadline - Date.now() - (cleanup ? 2_000 : DIAGNOSTIC_RESERVE_MS);
    if (remaining < MIN_OPERATION_MS) throw new TransferFailure('diagnostic_deadline');
    return Math.min(cleanup ? CLEANUP_MS : REMOTE_OPERATION_MS, remaining);
  }

  sshArgs(timeoutMs = REMOTE_OPERATION_MS) {
    const c = this.config;
    const connectSeconds = Math.max(1, Math.min(SSH_CONNECT_SECONDS,
      Math.floor((timeoutMs - REMOTE_EXECUTION_RESERVE_MS) / 1000)));
    return ['-F', '/dev/null', '-i', c.key, '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
      '-o', 'IdentityAgent=none', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${c.knownHosts}`,
      '-o', `ConnectTimeout=${connectSeconds}`, '-o', 'ConnectionAttempts=1', '-o', 'LogLevel=ERROR'];
  }

  async remote(op, files = this.files, cleanup = false) {
    const c = this.config;
    const manifest = Buffer.from(JSON.stringify(files)).toString('base64');
    const command = ['python3', '-', c.stage, this.owner, op, manifest].map(quoteShell).join(' ');
    const timeoutMs = this.timeout(cleanup);
    const result = await this.processes.checked('ssh', [...this.sshArgs(timeoutMs), '-p', String(c.port), `${c.user}@${c.host}`, command], {
      input: REMOTE_FILES, signal: cleanup ? undefined : this.signal, timeoutMs,
    });
    try { return JSON.parse(result.stdout); }
    catch { throw new TransferFailure('remote_response'); }
  }

  async progress(files, cleanup = false) {
    const state = await this.remote('status', files, cleanup);
    if (!Array.isArray(state.bytes) || state.bytes.length !== files.length ||
      state.bytes.some((bytes, i) => !Number.isSafeInteger(bytes) || bytes < 0 || bytes > files[i].bytes)) {
      throw new TransferFailure('remote_response');
    }
    const received = state.bytes.reduce((sum, bytes) => sum + bytes, 0);
    const transferElapsed = this.copyStarted ? Date.now() - this.copyStarted : 0;
    this.log('transfer_progress', { files: files.map((file, i) => ({ name: file.name, received_bytes: state.bytes[i] })),
      received_bytes: received, transfer_elapsed_ms: transferElapsed,
      average_bytes_per_second: Math.floor(received * 1000 / Math.max(1, transferElapsed)) });
    return received;
  }

  async copy(files, { signal = this.signal, limited = false } = {}) {
    const c = this.config;
    this.copyStarted = Date.now();
    this.log('transfer_start', { files: files.map(file => file.name) });
    const scp = this.processes.run('scp', ['-B', ...this.sshArgs(), '-P', String(c.port),
      ...(limited ? ['-l', '64', '-X', 'nrequests=1', '-X', 'buffer=16384'] : []),
      ...files.map(file => join(c.root, file.name)), `${c.user}@${c.host}:${c.stage}/`], { signal });
    const sampling = new AbortController();
    let samplingFailure;
    const sampler = (async () => {
      while (!sampling.signal.aborted) {
        try { await delay(PROGRESS_MS, undefined, { signal: sampling.signal }); }
        catch (error) { if (sampling.signal.aborted && error.name === 'AbortError') break; throw error; }
        if (!sampling.signal.aborted) await this.progress(files);
      }
    })().catch(error => { samplingFailure = error; this.abort.abort(); });
    let result;
    try { result = await scp; }
    finally { sampling.abort(); await sampler; }
    if (samplingFailure) throw samplingFailure;
    return result;
  }

  async deploy() {
    const result = await this.copy(this.files);
    if (result.code !== 0 || result.reason) throw new TransferFailure(errorCategory(result));
    await this.progress(this.files);
    if ((await this.remote('verify')).verified !== true) throw new TransferFailure('integrity');
    this.log('transfer_verified');
    try { await this.beforeActivate(); }
    catch { throw new TransferFailure(this.signal.aborted ? 'cancelled' : 'revision_gate'); }
    this.signal.throwIfAborted();
    const c = this.config, stage = c.stage;
    const args = [`${stage}/remote-release.sh`, '--release-dir', c.path, '--stage-dir', stage, '--revision', c.revision,
      '--controller-image', `super-leader-controller:${c.revision}`, '--gateway-image', `super-leader-gateway:${c.revision}`,
      '--controller-archive', `${stage}/controller.tar`, '--gateway-archive', `${stage}/gateway.tar`,
      '--checksums', `${stage}/release.sha256`, '--compose-overlay', `${stage}/compose.release.yaml`,
      '--compose-base', `${stage}/compose.yaml`, '--compose-production', `${stage}/compose.production.yaml`,
      '--compose-gateway', `${stage}/compose.gateway.yaml`, '--seccomp-policy', `${stage}/codex-seccomp.json`, '--env-file', c.envFile];
    const command = `chmod 700 ${quoteShell(`${stage}/remote-release.sh`)} && ${args.map(quoteShell).join(' ')}`;
    this.activationStarted = true;
    this.log('activation_start');
    const activation = await this.processes.checked('ssh', [...this.sshArgs(), '-p', String(c.port), `${c.user}@${c.host}`, command], { signal: this.signal });
    this.remoteCompleted = true;
    const window = /^gateway_context_window_ms=([0-9]+)$/m.exec(activation.stdout);
    if (window && Number.isSafeInteger(Number(window[1]))) this.log('runtime_verified', { gateway_context_window_ms: Number(window[1]) });
    this.log('deployment_verified');
  }

  async diagnostic() {
    const [success, cancel] = this.files;
    const result = await this.copy([success]);
    if (result.code !== 0 || result.reason) throw new TransferFailure(errorCategory(result));
    if ((await this.remote('verify', [success])).verified !== true) throw new TransferFailure('integrity');
    this.log('diagnostic_success_case', { bytes: success.bytes, sha256: success.sha256 });
    const cancelCase = new AbortController();
    let settled = false;
    const copying = this.copy([cancel], { signal: AbortSignal.any([this.signal, cancelCase.signal]), limited: true })
      .then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    const partialDeadline = Math.min(this.deadline - DIAGNOSTIC_RESERVE_MS, Date.now() + DIAGNOSTIC_PARTIAL_WAIT_MS);
    let partial = 0, cancelled;
    try {
      while (!settled && Date.now() < partialDeadline) {
        await delay(DIAGNOSTIC_POLL_MS, undefined, { signal: this.signal });
        partial = await this.progress([cancel]);
        if (partial > 0 && partial < cancel.bytes) break;
      }
    } finally {
      cancelCase.abort();
      const outcome = await copying;
      if (outcome.error) throw outcome.error;
      cancelled = outcome.value;
    }
    if (cancelled.reason !== 'cancelled' || cancelled.code === 0 || partial <= 0 || partial >= cancel.bytes || this.processes.children.size !== 0) {
      throw new TransferFailure('diagnostic_cancel');
    }
    const after = await this.progress([cancel]);
    await delay(DIAGNOSTIC_POLL_MS, undefined, { signal: this.signal });
    if (await this.progress([cancel]) !== after) throw new TransferFailure('diagnostic_cancel');
    this.log('diagnostic_cancel_case', { received_bytes: after, children_active: this.processes.children.size });
  }

  async execute() {
    let localRoot, stageAttempted = false, failure, timer;
    this.log('cleanup_state', { cleanup: 'unconfirmed' });
    try {
      if (this.config.diagnostic) {
        timer = setTimeout(() => this.abort.abort(), DIAGNOSTIC_MS - DIAGNOSTIC_RESERVE_MS);
        localRoot = await mkdtemp(join(tmpdir(), 'release-transfer-diagnostic-'));
        this.config.root = localRoot;
        await writeFile(join(localRoot, DIAGNOSTIC_FILES[0]), randomBytes(DIAGNOSTIC_SUCCESS_BYTES));
        await writeFile(join(localRoot, DIAGNOSTIC_FILES[1]), randomBytes(DIAGNOSTIC_CANCEL_BYTES));
      }
      this.files = await manifestFor(this.config.root, this.config.diagnostic ? DIAGNOSTIC_FILES : RELEASE_FILES, this.signal);
      const total = this.files.reduce((sum, file) => sum + file.bytes, 0);
      if (!Number.isSafeInteger(total) || (this.config.diagnostic && total > DIAGNOSTIC_PAYLOAD_LIMIT)) throw new TransferFailure('payload_limit');
      this.log('transfer_manifest', { files: this.files, total_bytes: total });
      const version = await this.processes.checked('ssh', ['-V'], { signal: this.signal, timeoutMs: this.timeout() });
      this.log('ssh_version', { version: /OpenSSH_[A-Za-z0-9_.]+/.exec(version.stderr)?.[0] ?? 'unknown' });
      stageAttempted = true;
      if ((await this.remote('create')).owned !== true) throw new TransferFailure('stage_ownership');
      this.log('stage_owned');
      await this.progress(this.files);
      if (this.config.diagnostic) await this.diagnostic(); else await this.deploy();
    } catch (error) {
      failure = error instanceof TransferFailure ? error : new TransferFailure(this.signal.aborted ? 'cancelled' : 'local_or_gate');
      this.log('transfer_failed', { category: failure.category });
    } finally {
      clearTimeout(timer);
      if (stageAttempted && this.processes.children.size > 0) {
        this.log('cleanup_state', { cleanup: 'unconfirmed', category: 'children_still_active' });
        failure ??= new TransferFailure('process_stop');
      } else if (stageAttempted && this.activationStarted && !this.remoteCompleted) {
        this.log('cleanup_state', { cleanup: 'unconfirmed', category: 'activation_completion_unknown' });
        failure ??= new TransferFailure('activation_completion_unknown');
      } else if (stageAttempted) {
        try {
          if ((await this.remote('cleanup', this.files, true)).cleanup !== 'confirmed') throw new TransferFailure('remote_response');
          this.log('cleanup_state', { cleanup: 'confirmed', children_active: this.processes.children.size });
        } catch (error) {
          this.log('cleanup_state', { cleanup: 'unconfirmed', category: error instanceof TransferFailure ? error.category : 'local_io' });
          failure ??= new TransferFailure('cleanup_unconfirmed');
        }
      }
      if (localRoot) await rm(localRoot, { recursive: true, force: true });
    }
    if (failure) throw failure;
    this.log(this.config.diagnostic ? 'diagnostic_passed' : 'release_complete', { children_active: this.processes.children.size });
  }
}

async function main() {
  const { values } = parseArgs({ options: { diagnostic: { type: 'boolean' }, 'release-root': { type: 'string' },
    'key-file': { type: 'string' }, 'known-hosts-file': { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.log('Usage: node scripts/deploy/transfer-release.mjs --key-file PATH --known-hosts-file PATH\n' +
      '  (--release-root PATH | --diagnostic)\nUses existing DEPLOY_*, REVISION and GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT inputs.');
    return;
  }
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try { await new ReleaseTransfer(transferConfiguration(values), { signal: abort.signal }).execute(); }
  finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(JSON.stringify({ schema: 1, event: 'command_failed', category: error instanceof TransferFailure ? error.category : 'configuration_or_local' }));
    process.exitCode = 1;
  });
}
