import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { ReleaseTransfer, transferConfiguration } from '../../../scripts/deploy/transfer-release.mjs';
import { TransferProcesses } from '../../../scripts/deploy/transfer-process.mjs';

const CONTAINER_ROOT = '/fixture/sender-telemetry';
const CONTAINER_TEST = `${CONTAINER_ROOT}/tests/integration/deploy/transfer-telemetry.mjs`;
const PAYLOAD_BYTES = 512 * 1024;
const BANDWIDTH_KBIT = 128;
const PROBE_MS = 20_000;
const CANCEL_MS = 15_000;
const SAMPLE_MS = 250;
const SAMPLE_WAIT_MS = 8_000;
const DEPLOY_MODULES = ['transfer-release.mjs', 'transfer-process.mjs', 'transfer-telemetry.mjs',
  'transfer-files.mjs', 'resolve-revision.mjs'];

class ProbeFailure extends Error {
  constructor(category) { super(category); this.category = category; }
}

function requireProbe(condition, category) {
  if (!condition) throw new ProbeFailure(category);
}

function assertSafeLogs(text) {
  requireProbe(!/https?:\/\/|(?:[0-9]{1,3}\.){3}[0-9]{1,3}|SYNTHETIC_.*(?:TOKEN|KEY)|PRIVATE KEY/.test(text), 'unsafe_logs');
}

async function linuxProbe() {
  const started = Date.now(), logs = [], samples = [], abort = new AbortController();
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
  const stop = () => { signalReceived = true; abort.abort(); };
  process.on('SIGTERM', stop);
  const timer = setTimeout(() => abort.abort(), CANCEL_MS);
  const copying = transfer.copy([{ name: 'telemetry.bin', bytes: PAYLOAD_BYTES }])
    .then(value => { completed = true; return { value }; }, error => { completed = true; return { error }; });
  try {
    const deadline = started + SAMPLE_WAIT_MS;
    let scheduled;
    while (Date.now() < deadline && !completed && !abort.signal.aborted) {
      scheduled = logs.find(event => event.event === 'sender_telemetry' && event.status === 'available');
      if (scheduled) break;
      await delay(SAMPLE_MS);
    }
    requireProbe(scheduled, 'scheduled_sample_unavailable');
    requireProbe(Number.isSafeInteger(scheduled.process_group_pid) && Number.isSafeInteger(scheduled.ssh_pid), 'pid_binding_missing');
    requireProbe(scheduled.process_group_pid !== scheduled.ssh_pid && Number.isSafeInteger(scheduled.socket_fd), 'pid_binding_invalid');
    samples.push(scheduled);
    while (Date.now() < deadline && !completed && !abort.signal.aborted) {
      await delay(SAMPLE_MS);
      const sample = await transfer.telemetry.sample({ processGroupPid: scheduled.process_group_pid, signal: abort.signal });
      if (sample.status === 'available' && sample.tcp.bytes_sent > scheduled.tcp.bytes_sent) {
        samples.push(sample);
        break;
      }
    }
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
    process.kill(process.pid, 'SIGTERM');
    outcome = await copying;
    requireProbe(signalReceived && !outcome.error && outcome.value.reason === 'cancelled' && outcome.value.code !== 0, 'sigterm_cancel_failed');
    requireProbe(processes.children.size === 0, 'children_survived');
    requireProbe(!logs.some(event => /activation|deployment|release_complete/.test(event.event)), 'unexpected_activation');
    assertSafeLogs(JSON.stringify({ logs, samples }));
    requireProbe(Date.now() - started < PROBE_MS, 'probe_deadline');
    return { event: 'linux_sender_telemetry_verified', node_major: 24, payload_bytes: PAYLOAD_BYTES,
      bandwidth_kbit_per_second: BANDWIDTH_KBIT, elapsed_ms: Date.now() - started,
      first: samples[0], second: samples[1], received_bytes: received,
      sigterm_cancelled: true, children_active: processes.children.size };
  } finally {
    clearTimeout(timer);
    abort.abort();
    await copying;
    process.off('SIGTERM', stop);
  }
}

export async function verifySenderTelemetry(fixture) {
  const temporary = await mkdtemp(join(fixture.root, 'sender-telemetry-'));
  try {
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
    let output;
    try { output = fixture.runInContainer(['node', CONTAINER_TEST, '--in-container'], { timeout: PROBE_MS }); }
    catch (error) {
      let category = 'container_probe_failed';
      try {
        const failure = JSON.parse(String(error.stderr ?? '').trim());
        if (failure.event === 'linux_sender_telemetry_failed' && /^[a-z_]+$/.test(failure.category ?? '')) category = failure.category;
      } catch { category = 'container_probe_failed'; }
      throw new ProbeFailure(category);
    }
    assertSafeLogs(output);
    const evidence = JSON.parse(output.trim());
    assert.equal(evidence.event, 'linux_sender_telemetry_verified');
    assert.equal(evidence.children_active, 0);
    assert.equal(evidence.sigterm_cancelled, true);
    assert.ok(evidence.elapsed_ms < PROBE_MS);
    assert.ok(evidence.second.tcp.bytes_sent > evidence.first.tcp.bytes_sent);
    console.log(`PASS real Linux sender telemetry: scheduled SCP/SSH socket binding, independent RTT/minrtt, bytes_sent ${evidence.first.tcp.bytes_sent}->${evidence.second.tcp.bytes_sent}, SIGTERM joins observers and leaves zero children (${evidence.elapsed_ms}ms)`);
    return evidence;
  } finally {
    try { fixture.runInContainer(['rm', '-rf', CONTAINER_ROOT]); }
    finally { await rm(temporary, { recursive: true, force: true }); }
  }
}

async function main() {
  const { values } = parseArgs({ options: { run: { type: 'boolean' }, 'in-container': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' } } });
  if (values.help || (!values.run && !values['in-container'])) {
    console.log('Usage: node tests/integration/deploy/transfer-telemetry.mjs --run');
    return;
  }
  requireProbe(!(values.run && values['in-container']), 'conflicting_modes');
  if (values['in-container']) { console.log(JSON.stringify(await linuxProbe())); return; }
  const { transferSshFixture } = await import('../../support/transfer-ssh-fixture.mjs');
  const fixture = await transferSshFixture();
  try { await verifySenderTelemetry(fixture); }
  finally { await fixture.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(JSON.stringify({ event: 'linux_sender_telemetry_failed',
      category: error instanceof ProbeFailure ? error.category : 'probe_failed' }));
    process.exitCode = 1;
  });
}
