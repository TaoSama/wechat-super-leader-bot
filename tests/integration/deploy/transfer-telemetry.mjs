import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { ReleaseTransfer, transferConfiguration } from '../../../scripts/deploy/transfer-release.mjs';
import { TransferFailure, TransferProcesses } from '../../../scripts/deploy/transfer-process.mjs';

const CONTAINER_ROOT = '/fixture/sender-telemetry';
const CONTAINER_TEST = `${CONTAINER_ROOT}/tests/integration/deploy/transfer-telemetry.mjs`;
const PAYLOAD_BYTES = 512 * 1024;
const BANDWIDTH_KBIT = 128;
const PROBE_MS = 20_000;
const CANCEL_MS = 15_000;
const SAMPLE_MS = 250;
const SAMPLE_WAIT_MS = 8_000;
const DEPLOY_MODULES = ['transfer-release.mjs', 'transfer-process.mjs', 'transfer-telemetry.mjs',
  'transfer-files.mjs', 'transfer-manifest.mjs', 'resolve-revision.mjs', 'probe-release.mjs'];
const PHASES = new Set(['arguments', 'fixture_create', 'sender_prepare', 'sender_runtime', 'sender_validation', 'host_validation', 'cleanup']);
const CATEGORIES = new Set(`probe_failed assertion_failed invalid_json invalid_options file_missing permission_denied io_error
  command_timeout command_failed unsafe_logs linux_node24_required unexpected_activation scheduled_sample_unavailable
  pid_binding_missing pid_binding_invalid send_bytes_not_increasing socket_binding_changed rtt_missing min_rtt_missing
  send_bytes_missing partial_upload_missing sigterm_cancel_failed children_survived probe_deadline conflicting_modes
  container_probe_failed configuration tool_missing process_start process_stop input_io output_limit timeout remote_command
  authentication host_key dns network_connect network_closed cancelled`.split(/\s+/));

class ProbeFailure extends Error {
  constructor(category, phase) { super(category); this.category = category; this.phase = phase; }
}

function failureFor(error, phase) {
  if (error instanceof AggregateError && error.errors.length) {
    const hasPrimary = Object.hasOwn(error, 'cause');
    const failure = failureFor(hasPrimary ? error.cause : error.errors[0], phase);
    const cleanup = hasPrimary && error.errors.find(item => item !== error.cause);
    if (cleanup) failure.cleanupCategory ??= failureFor(cleanup, 'cleanup').category;
    return failure;
  }
  if (error instanceof ProbeFailure && PHASES.has(error.phase) && CATEGORIES.has(error.category)) return error;
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
  return new ProbeFailure(category, PHASES.has(phase) ? phase : 'sender_runtime');
}

async function cleanupActions(actions, primary) {
  let failure;
  for (const action of actions) {
    try { await action(); }
    catch (error) { failure ??= failureFor(error, 'cleanup'); }
  }
  if (failure) {
    if (primary) primary.cleanupCategory ??= failure.category;
    else throw failure;
  }
}

function containerFailure(error) {
  let diagnostic;
  try { diagnostic = JSON.parse(String(error.stderr ?? '').trim()); }
  catch (parseError) { if (!(parseError instanceof SyntaxError)) throw parseError; }
  if (diagnostic?.event === 'linux_sender_telemetry_failed' && PHASES.has(diagnostic.phase) &&
      CATEGORIES.has(diagnostic.category) &&
      (diagnostic.cleanup_category === undefined || CATEGORIES.has(diagnostic.cleanup_category))) {
    const failure = new ProbeFailure(diagnostic.category, diagnostic.phase);
    if (diagnostic.cleanup_category !== undefined) failure.cleanupCategory = diagnostic.cleanup_category;
    return failure;
  }
  return failureFor(error, 'sender_runtime');
}

function requireProbe(condition, category) {
  if (!condition) throw new ProbeFailure(category);
}

function assertSafeLogs(text) {
  requireProbe(!/https?:\/\/|(?:[0-9]{1,3}\.){3}[0-9]{1,3}|SYNTHETIC_.*(?:TOKEN|KEY)|PRIVATE KEY/.test(text), 'unsafe_logs');
}

async function linuxProbe() {
  const started = Date.now(), logs = [], samples = [], abort = new AbortController();
  let phase = 'sender_prepare', failure, timer, copying, stop;
  try {
    requireProbe(process.platform === 'linux' && Number(process.versions.node.split('.')[0]) === 24, 'linux_node24_required');
    class LimitedProcesses extends TransferProcesses {
      run(command, args, options) {
        // Keep the real copy path and its observers; bound only the fixture's synthetic upload.
        return super.run(command, command === 'scp' ? ['-l', String(BANDWIDTH_KBIT), '-X', 'nrequests=1',
          '-X', 'buffer=16384', ...args] : args, options);
      }
    }
    const processes = new LimitedProcesses();
    const config = transferConfiguration({ diagnostic: true, 'key-file': `${CONTAINER_ROOT}/credentials/client`,
      'known-hosts-file': `${CONTAINER_ROOT}/credentials/known_hosts` }, {
      DEPLOY_HOST: '127.0.0.1', DEPLOY_PORT: '2222', DEPLOY_USER: 'root', DEPLOY_PATH: `${CONTAINER_ROOT}/remote`,
      REVISION: 'b'.repeat(40), GITHUB_RUN_ID: '987654321', GITHUB_RUN_ATTEMPT: '1',
    });
    config.root = `${CONTAINER_ROOT}/payload`;
    await mkdir(config.root, { recursive: true });
    await mkdir(config.stage, { recursive: true });
    await chmod(config.key, 0o600);
    await writeFile(join(config.root, 'telemetry.bin'), Buffer.alloc(PAYLOAD_BYTES, 't'));
    const transfer = new ReleaseTransfer(config, { processes, signal: abort.signal,
      log: line => logs.push(JSON.parse(line)), beforeActivate: () => { throw new ProbeFailure('unexpected_activation'); } });
    let signalReceived = false, completed = false, outcome;
    stop = () => { signalReceived = true; abort.abort(); };
    process.on('SIGTERM', stop);
    timer = setTimeout(() => abort.abort(), CANCEL_MS);
    phase = 'sender_runtime';
    copying = transfer.copy([{ name: 'telemetry.bin', bytes: PAYLOAD_BYTES }])
      .then(value => { completed = true; return { value }; }, error => { completed = true; return { error }; });
    const deadline = started + SAMPLE_WAIT_MS;
    let scheduled;
    while (Date.now() < deadline && !completed && !abort.signal.aborted) {
      scheduled = logs.find(event => event.event === 'sender_telemetry' && event.status === 'available');
      if (scheduled) break;
      await delay(SAMPLE_MS);
    }
    phase = 'sender_validation';
    requireProbe(scheduled, 'scheduled_sample_unavailable');
    requireProbe(Number.isSafeInteger(scheduled.process_group_pid) && Number.isSafeInteger(scheduled.ssh_pid), 'pid_binding_missing');
    requireProbe(scheduled.process_group_pid !== scheduled.ssh_pid && Number.isSafeInteger(scheduled.socket_fd), 'pid_binding_invalid');
    samples.push(scheduled);
    phase = 'sender_runtime';
    while (Date.now() < deadline && !completed && !abort.signal.aborted) {
      await delay(SAMPLE_MS);
      const sample = await transfer.telemetry.sample({ processGroupPid: scheduled.process_group_pid, signal: abort.signal });
      if (sample.status === 'available' && sample.tcp.bytes_sent > scheduled.tcp.bytes_sent) {
        samples.push(sample);
        break;
      }
    }
    phase = 'sender_validation';
    requireProbe(samples.length === 2, 'send_bytes_not_increasing');
    for (const sample of samples) {
      requireProbe(sample.ssh_pid === scheduled.ssh_pid && sample.socket_fd === scheduled.socket_fd, 'socket_binding_changed');
      requireProbe(Number.isFinite(sample.tcp.rtt_ms) && sample.tcp.rtt_ms >= 0 &&
        Number.isFinite(sample.tcp.rtt_variance_ms) && sample.tcp.rtt_variance_ms >= 0, 'rtt_missing');
      requireProbe(Number.isFinite(sample.tcp.min_rtt_ms) && sample.tcp.min_rtt_ms >= 0, 'min_rtt_missing');
      requireProbe(Number.isSafeInteger(sample.tcp.bytes_sent) && sample.tcp.bytes_sent > 0, 'send_bytes_missing');
    }
    const received = (await stat(join(config.stage, 'telemetry.bin'))).size;
    requireProbe(received > 0 && received < PAYLOAD_BYTES && !completed, 'partial_upload_missing');
    phase = 'sender_runtime';
    process.kill(process.pid, 'SIGTERM');
    outcome = await copying;
    phase = 'sender_validation';
    requireProbe(signalReceived && !outcome.error && outcome.value.reason === 'cancelled' && outcome.value.code !== 0, 'sigterm_cancel_failed');
    requireProbe(processes.children.size === 0, 'children_survived');
    requireProbe(!logs.some(event => /activation|deployment|release_complete/.test(event.event)), 'unexpected_activation');
    assertSafeLogs(JSON.stringify({ logs, samples }));
    requireProbe(Date.now() - started < PROBE_MS, 'probe_deadline');
    return { event: 'linux_sender_telemetry_verified', node_major: 24, payload_bytes: PAYLOAD_BYTES,
      bandwidth_kbit_per_second: BANDWIDTH_KBIT, elapsed_ms: Date.now() - started,
      first: samples[0], second: samples[1], received_bytes: received,
      sigterm_cancelled: true, children_active: processes.children.size };
  } catch (error) {
    failure = failureFor(error, phase); throw failure;
  } finally {
    await cleanupActions([() => clearTimeout(timer), () => abort.abort(), async () => {
      const result = await copying;
      if (result?.error) throw result.error;
    },
      () => { if (stop) process.off('SIGTERM', stop); }], failure);
  }
}

export async function verifySenderTelemetry(fixture) {
  let temporary, phase = 'sender_prepare', failure;
  try {
    temporary = await mkdtemp(join(fixture.root, 'sender-telemetry-'));
    fixture.runInContainer(['mkdir', '-p', `${CONTAINER_ROOT}/scripts/deploy`,
      `${CONTAINER_ROOT}/tests/integration/deploy`, `${CONTAINER_ROOT}/credentials`]);
    for (const name of DEPLOY_MODULES) fixture.copyToContainer(fileURLToPath(new URL(`../../../scripts/deploy/${name}`, import.meta.url)),
      `${CONTAINER_ROOT}/scripts/deploy/${name}`);
    fixture.copyToContainer(fileURLToPath(import.meta.url), CONTAINER_TEST);
    fixture.copyToContainer(fixture.values['key-file'], `${CONTAINER_ROOT}/credentials/client`);
    const publicKey = (await readFile(fixture.values['known-hosts-file'], 'utf8')).trim().split(' ').slice(1).join(' ');
    const knownHosts = join(temporary, 'known_hosts');
    await writeFile(knownHosts, `[127.0.0.1]:2222 ${publicKey}\n`, { mode: 0o600 });
    fixture.copyToContainer(knownHosts, `${CONTAINER_ROOT}/credentials/known_hosts`);
    let output; phase = 'sender_runtime';
    try { output = fixture.runInContainer(['node', CONTAINER_TEST, '--in-container'], { timeout: PROBE_MS }); }
    catch (error) { throw containerFailure(error); }
    phase = 'host_validation';
    assertSafeLogs(output);
    const evidence = JSON.parse(output.trim());
    assert.equal(evidence.event, 'linux_sender_telemetry_verified');
    assert.equal(evidence.children_active, 0);
    assert.equal(evidence.sigterm_cancelled, true);
    assert.ok(evidence.elapsed_ms < PROBE_MS);
    assert.ok(evidence.second.tcp.bytes_sent > evidence.first.tcp.bytes_sent);
    console.log(`PASS real Linux sender telemetry: scheduled SCP/SSH socket binding, independent RTT/minrtt, bytes_sent ${evidence.first.tcp.bytes_sent}->${evidence.second.tcp.bytes_sent}, SIGTERM joins observers and leaves zero children (${evidence.elapsed_ms}ms)`);
    return evidence;
  } catch (error) {
    failure = failureFor(error, phase); throw failure;
  } finally {
    await cleanupActions([() => fixture.runInContainer(['rm', '-rf', CONTAINER_ROOT]),
      async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); }], failure);
  }
}

export async function runSenderTelemetry(createFixture) {
  let fixture, failure;
  try {
    fixture = await createFixture();
    return await verifySenderTelemetry(fixture);
  } catch (error) {
    failure = failureFor(error, 'fixture_create'); throw failure;
  } finally {
    if (fixture) await cleanupActions([() => fixture.close()], failure);
  }
}

async function main() {
  try {
    const { values } = parseArgs({ options: { run: { type: 'boolean' }, 'in-container': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' } } });
    if (values.help || (!values.run && !values['in-container'])) {
      console.log('Usage: node tests/integration/deploy/transfer-telemetry.mjs --run');
      return;
    }
    requireProbe(!(values.run && values['in-container']), 'conflicting_modes');
    if (values['in-container']) { console.log(JSON.stringify(await linuxProbe())); return; }
    await runSenderTelemetry(async () => {
      const { transferSshFixture } = await import('../../support/transfer-ssh-fixture.mjs');
      return transferSshFixture();
    });
  } catch (error) { throw failureFor(error, 'arguments'); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const failure = failureFor(error, 'sender_runtime');
    console.error(JSON.stringify({ event: 'linux_sender_telemetry_failed', phase: failure.phase, category: failure.category,
      ...(failure.cleanupCategory ? { cleanup_category: failure.cleanupCategory } : {}) }));
    process.exitCode = 1;
  });
}
