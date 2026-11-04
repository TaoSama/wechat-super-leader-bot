import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { TransferFailure, TransferProcesses, errorCategory } from './transfer-process.mjs';
import { createSenderTelemetry } from './transfer-telemetry.mjs';
import { DIAGNOSTIC_FILES, DIAGNOSTIC_PAYLOAD_LIMIT, REMOTE_FILES, manifestFor, quoteShell } from './transfer-files.mjs';
import { manifestArtifactName, manifestIdentity, readTransferManifest, verifyLocalManifest } from './transfer-manifest.mjs';

const PROGRESS_MS = 15_000;
const FIRST_TELEMETRY_MS = 1_000;
const PROGRESS_UNAVAILABLE_CATEGORIES = new Set(['dns', 'timeout', 'network_connect', 'network_closed']);
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
const ACTIVATION_POLL_MS = 5_000;
// Normally the 20-minute job timeout ends the wrapper first; either way completion is reported as unknown.
const ACTIVATION_WAIT_MS = 20 * 60_000;

export function transferConfiguration(values, env = process.env) {
  const config = { diagnostic: values.diagnostic === true, root: values['release-root'],
    key: values['key-file'], knownHosts: values['known-hosts-file'], host: env.DEPLOY_HOST,
    user: env.DEPLOY_USER, port: Number(env.DEPLOY_PORT || 22), path: env.DEPLOY_PATH,
    revision: env.REVISION, run: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT,
    manifestFile: values['manifest-file'], manifestArtifactId: Number(values['manifest-artifact-id']),
    envFile: env.DEPLOY_ENV_FILE || '.runtime/controller.env', repository: env.GITHUB_REPOSITORY, githubToken: env.GH_TOKEN };
  const validPath = value => typeof value === 'string' && /^\/[A-Za-z0-9._/-]+$/.test(value) &&
    value !== '/' && posix.normalize(value) === value && !value.split('/').includes('..');
  if (!/^[0-9a-f]{40}$/.test(config.revision ?? '') || !/^[1-9][0-9]*$/.test(config.run ?? '') ||
    !/^[1-9][0-9]*$/.test(config.attempt ?? '') || !/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(config.host ?? '') ||
    !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(config.user ?? '') || !Number.isInteger(config.port) ||
    config.port < 1 || config.port > 65535 || !validPath(config.path) ||
    !config.key || !config.knownHosts || (config.diagnostic ? config.root !== undefined : !config.root) ||
    (config.diagnostic ? values['manifest-file'] !== undefined || values['manifest-artifact-id'] !== undefined :
      !config.manifestFile || !/^[1-9][0-9]*$/.test(values['manifest-artifact-id'] ?? '') ||
      !Number.isSafeInteger(config.manifestArtifactId) || config.manifestArtifactId <= 0) ||
    !/^[A-Za-z0-9._/-]+$/.test(config.envFile) || config.envFile.split('/').includes('..')) {
    throw new TransferFailure('configuration');
  }
  try { manifestIdentity(config); }
  catch { throw new TransferFailure('configuration'); }
  config.stage = `${config.path}/.runtime/releases/${config.diagnostic ? 'diagnostic-' : ''}${config.revision}-${config.run}-${config.attempt}`;
  return config;
}

export class ReleaseTransfer {
  constructor(config, { signal, log = console.log, processes = new TransferProcesses(), beforeActivate } = {}) {
    this.config = config;
    this.processes = processes;
    this.telemetry = createSenderTelemetry({ processes });
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

  async remote(op, payload = this.files, cleanup = false) {
    const c = this.config;
    const manifest = Buffer.from(JSON.stringify(payload)).toString('base64');
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
    const observerSignal = AbortSignal.any([signal, sampling.signal]);
    const processGroupPid = [...(this.processes.children ?? [])].find(child => child.spawnfile === 'scp')?.pid;
    const telemetrySampler = (async () => {
      let interval = FIRST_TELEMETRY_MS;
      while (!observerSignal.aborted) {
        try { await delay(interval, undefined, { signal: observerSignal }); }
        catch (error) { if (observerSignal.aborted && error.name === 'AbortError') break; throw error; }
        const observation = await this.telemetry.sample({ processGroupPid, signal: observerSignal });
        if (!observerSignal.aborted) this.log('sender_telemetry', { transfer_elapsed_ms: Date.now() - this.copyStarted, ...observation });
        interval = PROGRESS_MS;
      }
    })().catch(() => {
      if (!observerSignal.aborted) this.log('sender_telemetry', { status: 'unavailable', category: 'observer_error' });
    });
    let samplingFailure;
    const sampler = (async () => {
      while (!sampling.signal.aborted) {
        try { await delay(PROGRESS_MS, undefined, { signal: sampling.signal }); }
        catch (error) { if (sampling.signal.aborted && error.name === 'AbortError') break; throw error; }
        if (!sampling.signal.aborted) {
          try { await this.progress(files); }
          catch (error) {
            if (this.config.diagnostic || this.signal.aborted || !(error instanceof TransferFailure) ||
              !PROGRESS_UNAVAILABLE_CATEGORIES.has(error.category)) throw error;
            this.log('transfer_progress_unavailable', { category: error.category });
          }
        }
      }
    })().catch(error => { samplingFailure = error; this.abort.abort(); });
    let result;
    try {
      result = await scp;
      this.log('scp_finished', { transfer_elapsed_ms: Date.now() - this.copyStarted,
        exit_code: Number.isInteger(result.code) ? result.code : null,
        category: result.code === 0 && !result.reason ? 'ok' : errorCategory(result) });
    } finally { sampling.abort(); await Promise.all([sampler, telemetrySampler]); }
    if (samplingFailure) throw samplingFailure;
    if (this.processes.children?.size > 0) throw new TransferFailure('process_stop');
    return result;
  }

  // An earlier run that outlived its cancelled job still holds the activation lock; wait for it to finish.
  async launchActivation(args, { pollMs = ACTIVATION_POLL_MS, waitMs = ACTIVATION_WAIT_MS } = this.activationTiming ?? {}) {
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        if ((await this.remote('activate', args)).started !== true) throw new TransferFailure('remote_response');
        return;
      } catch (error) {
        if (!(error instanceof TransferFailure) || error.category !== 'activation_busy' || this.signal.aborted) throw error;
        // Nothing was launched, so the stage stays safe to clean up.
        if (Date.now() >= deadline) { this.activationStarted = false; throw error; }
        this.log('activation_waiting', { category: error.category });
      }
      await delay(pollMs, undefined, { signal: this.signal });
    }
  }

  // The detached remote run outlives this SSH client; only its published exit status confirms completion.
  async awaitActivation({ pollMs = ACTIVATION_POLL_MS, waitMs = ACTIVATION_WAIT_MS } = this.activationTiming ?? {}) {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      try {
        const state = await this.remote('activation');
        if (state.exit_code !== null) {
          if (!Number.isSafeInteger(state.exit_code) || typeof state.output !== 'string') throw new TransferFailure('remote_response');
          return state;
        }
      } catch (error) {
        if (this.signal.aborted || !(error instanceof TransferFailure) || !PROGRESS_UNAVAILABLE_CATEGORIES.has(error.category)) throw error;
        this.log('activation_poll_unavailable', { category: error.category });
      }
      await delay(pollMs, undefined, { signal: this.signal });
    }
    throw new TransferFailure('activation_completion_unknown');
  }

  async deploy() {
    const result = await this.copy(this.files);
    if (result.code !== 0 || result.reason) throw new TransferFailure(errorCategory(result));
    await this.progress(this.files);
    const verificationStarted = Date.now();
    if ((await this.remote('verify')).verified !== true) throw new TransferFailure('integrity');
    this.log('transfer_verified', { verification_elapsed_ms: Date.now() - verificationStarted });
    try { await this.beforeActivate(); }
    catch { throw new TransferFailure(this.signal.aborted ? 'cancelled' : 'revision_gate'); }
    this.signal.throwIfAborted();
    const c = this.config, stage = c.stage;
    const args = ['--release-dir', c.path, '--stage-dir', stage, '--revision', c.revision,
      '--controller-image', `super-leader-controller:${c.revision}`, '--gateway-image', `super-leader-gateway:${c.revision}`,
      '--controller-archive', `${stage}/controller.tar`, '--gateway-archive', `${stage}/gateway.tar`,
      '--checksums', `${stage}/release.sha256`, '--compose-overlay', `${stage}/compose.release.yaml`,
      '--compose-base', `${stage}/compose.yaml`, '--compose-production', `${stage}/compose.production.yaml`,
      '--compose-gateway', `${stage}/compose.gateway.yaml`, '--seccomp-policy', `${stage}/codex-seccomp.json`, '--env-file', c.envFile];
    this.activationStarted = true;
    this.log('activation_start');
    await this.launchActivation(args);
    const activation = await this.awaitActivation();
    this.activationExitCode = activation.exit_code;
    this.log('activation_finished', { exit_code: activation.exit_code });
    if (activation.exit_code !== 0) throw new TransferFailure('remote_command');
    const window = /^gateway_context_window_ms=([0-9]+)$/m.exec(activation.output);
    if (window && Number.isSafeInteger(Number(window[1]))) this.log('runtime_verified', { gateway_context_window_ms: Number(window[1]) });
    this.log('deployment_verified');
  }

  async diagnostic() {
    const [success, cancel] = this.files;
    const result = await this.copy([success]);
    if (result.code !== 0 || result.reason) throw new TransferFailure(errorCategory(result));
    const verificationStarted = Date.now();
    if ((await this.remote('verify', [success])).verified !== true) throw new TransferFailure('integrity');
    this.log('diagnostic_success_case', { bytes: success.bytes, sha256: success.sha256,
      verification_elapsed_ms: Date.now() - verificationStarted });
    const cancelCase = new AbortController();
    let settled = false;
    const copying = this.copy([cancel], { signal: AbortSignal.any([this.signal, cancelCase.signal]), limited: true })
      .then(value => { settled = true; return { value }; }, error => { settled = true; return { error }; });
    const partialDeadline = Math.min(this.deadline - DIAGNOSTIC_RESERVE_MS, Date.now() + DIAGNOSTIC_PARTIAL_WAIT_MS);
    let partial = 0, pollingFailed = false, pollingError;
    try {
      while (!settled && Date.now() < partialDeadline) {
        await delay(DIAGNOSTIC_POLL_MS, undefined, { signal: this.signal });
        partial = await this.progress([cancel]);
        if (partial > 0 && partial < cancel.bytes) break;
      }
    } catch (error) { pollingFailed = true; pollingError = error; }
    cancelCase.abort();
    const outcome = await copying;
    if (pollingFailed) throw pollingError;
    if ('error' in outcome) throw outcome.error;
    const cancelled = outcome.value;
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
      let artifact = {};
      if (this.config.diagnostic) {
        this.files = await manifestFor(this.config.root, DIAGNOSTIC_FILES, this.signal);
      } else {
        if (!Number.isSafeInteger(this.config.manifestArtifactId) || this.config.manifestArtifactId <= 0) throw new TransferFailure('configuration');
        this.manifest = await readTransferManifest(this.config.manifestFile, this.config);
        await verifyLocalManifest(this.config.root, this.manifest, this.signal);
        this.files = this.manifest.files;
        artifact = { manifest_artifact_id: this.config.manifestArtifactId,
          manifest_artifact_name: manifestArtifactName(this.config) };
      }
      const total = this.files.reduce((sum, file) => sum + file.bytes, 0);
      if (!Number.isSafeInteger(total) || (this.config.diagnostic && total > DIAGNOSTIC_PAYLOAD_LIMIT)) throw new TransferFailure('payload_limit');
      this.log('transfer_manifest', { files: this.files, total_bytes: total, ...artifact });
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
      } else if (stageAttempted && this.activationStarted && this.activationExitCode !== 0) {
        // A failed run keeps its stage and activation log as evidence; an unfinished run may still be using it.
        const category = this.activationExitCode === undefined ? 'activation_completion_unknown' : 'activation_failed';
        this.log('cleanup_state', { cleanup: 'unconfirmed', category });
        failure ??= new TransferFailure(category);
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
    this.log(this.config.diagnostic ? 'diagnostic_passed' : 'release_complete', { children_active: this.processes.children.size,
      ...(this.config.diagnostic ? {} : { manifest_artifact_id: this.config.manifestArtifactId,
        manifest_artifact_name: manifestArtifactName(this.config) }) });
  }
}

async function main() {
  const { values } = parseArgs({ options: { diagnostic: { type: 'boolean' }, 'release-root': { type: 'string' },
    'key-file': { type: 'string' }, 'known-hosts-file': { type: 'string' }, 'credentials-root': { type: 'string' },
    'manifest-file': { type: 'string' }, 'manifest-artifact-id': { type: 'string' },
    help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    console.log('Usage: node scripts/deploy/transfer-release.mjs\n' +
      '  (--credentials-root PATH | --key-file PATH --known-hosts-file PATH)\n' +
      '  (--release-root PATH --manifest-file PATH --manifest-artifact-id ID | --diagnostic)\nUses existing DEPLOY_*, REVISION and GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT inputs.');
    return;
  }
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  let credentials;
  try {
    if (values['credentials-root'] !== undefined) {
      if (!values['credentials-root'] || values['key-file'] !== undefined || values['known-hosts-file'] !== undefined ||
        !process.env.DEPLOY_SSH_PRIVATE_KEY || !process.env.DEPLOY_KNOWN_HOSTS) throw new TransferFailure('configuration');
      credentials = await mkdtemp(join(values['credentials-root'], 'release-transfer-credentials-'));
      values['key-file'] = join(credentials, 'key');
      values['known-hosts-file'] = join(credentials, 'known_hosts');
      const privateKey = process.env.DEPLOY_SSH_PRIVATE_KEY;
      await writeFile(values['key-file'], privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`, { mode: 0o600, flag: 'wx' });
      await writeFile(values['known-hosts-file'], process.env.DEPLOY_KNOWN_HOSTS, { mode: 0o600, flag: 'wx' });
    }
    await new ReleaseTransfer(transferConfiguration(values), { signal: abort.signal }).execute();
  } finally {
    try {
      // SSH cleanup must finish before its authentication files disappear.
      if (credentials) {
        await rm(credentials, { recursive: true, force: true });
        console.log(JSON.stringify({ schema: 1, event: 'credential_cleanup_state', cleanup: 'confirmed' }));
      }
    } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(JSON.stringify({ schema: 1, event: 'command_failed', category: error instanceof TransferFailure ? error.category : 'configuration_or_local' }));
    process.exitCode = 1;
  });
}
