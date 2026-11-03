import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer, connect } from 'node:net';
import { transferSshFixture } from '../../support/transfer-ssh-fixture.mjs';
import { verifySenderTelemetry } from './transfer-telemetry.mjs';
import { ReleaseTransfer, transferConfiguration } from '../../../scripts/deploy/transfer-release.mjs';
import { TransferFailure } from '../../../scripts/deploy/transfer-process.mjs';
import { RELEASE_FILES } from '../../../scripts/deploy/transfer-files.mjs';

const CLI = fileURLToPath(new URL('../../../scripts/deploy/transfer-release.mjs', import.meta.url));
const { values } = parseArgs({ options: { run: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
if (!values.run || values.help) { console.log('Usage: node tests/integration/deploy/release-transfer.mjs --run'); process.exit(0); }

const fixture = await transferSshFixture();
const workflow = await readFile(new URL('../../../.github/workflows/deploy-production.yml', import.meta.url), 'utf8');
const lines = text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const absent = stage => assert.equal(fixture.python(`import os; print(os.path.exists(${JSON.stringify(stage)}))`).trim(), 'False');
const safeLogs = async output => {
  for (const secret of [await fixture.privateKey(), 'SYNTHETIC_TOKEN_MUST_NOT_LEAK', 'SYNTHETIC_KEY_MUST_NOT_LEAK',
    'SYNTHETIC_REMOTE_STDERR_MUST_NOT_LEAK', fixture.root]) assert.ok(!output.includes(secret));
};

// Hold the first successful file open independently of the CLI's own cancellation
// case. Observing that case's partial-byte log races its immediate self-cancel.
async function uploadProxy(env, onPartial) {
  const sockets = new Set(), timers = new Set();
  const server = createServer(client => {
    const upstream = connect(Number(env.DEPLOY_PORT), env.DEPLOY_HOST);
    sockets.add(client); sockets.add(upstream);
    let uploaded = 0;
    const close = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
    client.on('error', close); upstream.on('error', close);
    client.on('close', close); upstream.on('close', close);
    upstream.pipe(client);
    client.on('data', chunk => {
      client.pause();
      let offset = 0;
      const send = () => {
        if (client.destroyed || upstream.destroyed) return;
        const part = chunk.subarray(offset, offset + 1024);
        upstream.write(part, () => {
          offset += part.length; uploaded += part.length;
          if (uploaded >= 65536) onPartial();
          if (offset >= chunk.length) { client.resume(); return; }
          const timer = setTimeout(() => { timers.delete(timer); send(); }, 16);
          timers.add(timer);
        });
      };
      send();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port, knownHosts = join(fixture.root, `proxy-hosts-${port}`);
  const publicKey = (await readFile(fixture.values['known-hosts-file'], 'utf8')).trim().split(' ').slice(1).join(' ');
  await writeFile(knownHosts, `[127.0.0.1]:${port} ${publicKey}\n`);
  return { port, knownHosts, async close() {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  } };
}

async function cli(env, { interrupt, args = [], wrapper = false, production = false } = {}) {
  let child, stdout = '', stderr = '', signalled = false, groups = [], observerFailure;
  const signalEntry = () => {
    if (!interrupt || signalled || observerFailure) return;
    try {
      if (!production) {
        const stage = transferConfiguration(fixture.values, env).stage;
        const received = Number(fixture.python(`import os; p=${JSON.stringify(`${stage}/success.bin`)}; print(os.stat(p).st_size if os.path.isfile(p) else 0)`).trim());
        if (received <= 0 || received >= 1048576) return;
      }
      groups = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n')
        .map(row => row.trim().split(/\s+/).map(Number)).filter(([, parent]) => parent === child.pid).map(([pid]) => pid);
      signalled = true;
      child.kill(interrupt);
    } catch (error) { observerFailure = error; child.kill('SIGTERM'); }
  };
  const proxy = interrupt && !production ? await uploadProxy(env, signalEntry) : undefined;
  const knownHosts = proxy?.knownHosts ?? fixture.values['known-hosts-file'];
  if (proxy) env = { ...env, DEPLOY_PORT: String(proxy.port) };
  let command = process.execPath, commandArgs = [CLI, '--diagnostic', '--key-file', fixture.values['key-file'],
    '--known-hosts-file', knownHosts, ...args];
  if (wrapper) {
    const name = production ? 'Transfer and activate the release on the VPS' : 'Diagnostic-only transfer and cancellation;';
    const section = workflow.slice(workflow.indexOf(`      - name: ${name}`));
    const block = /^        run: \|\n((?:          [^\n]*\n)+)/m.exec(section)?.[1];
    assert.ok(block?.includes('exec node scripts/deploy/transfer-release.mjs'));
    const script = join(fixture.root, 'actions-entry.sh');
    await writeFile(script, block.split('\n').map(line => line.slice(10)).join('\n'));
    command = '/bin/bash'; commandArgs = ['--noprofile', '--norc', '-e', '-o', 'pipefail', script];
    env = { ...env, RUNNER_TEMP: fixture.root, DEPLOY_SSH_PRIVATE_KEY: (await fixture.privateKey()).trimEnd(),
      DEPLOY_KNOWN_HOSTS: await readFile(knownHosts, 'utf8') };
  }
  child = spawn(command, commandArgs, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 65_000);
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (production && stdout.includes('"event":"transfer_start"')) signalEntry();
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  await proxy?.close();
  if (observerFailure) throw observerFailure;
  await safeLogs(stdout + stderr);
  if (interrupt) {
    assert.ok(signalled && (production || groups.length > 0), 'interrupt reached the real entry PID during transport');
    for (const group of groups) assert.throws(() => process.kill(-group, 0), { code: 'ESRCH' });
  }
  if (wrapper) {
    const events = lines(stdout);
    const remoteCleanup = events.findIndex(event => event.event === 'cleanup_state' && event.cleanup === 'confirmed');
    const credentialCleanup = events.findIndex(event => event.event === 'credential_cleanup_state' && event.cleanup === 'confirmed');
    assert.ok(remoteCleanup >= 0 && credentialCleanup > remoteCleanup, 'credentials remain usable until remote cleanup completes');
    assert.ok(!(await readdir(fixture.root)).some(name => name.startsWith('release-transfer-credentials-')));
    assert.ok(!events.some(event => event.event === 'activation_start'));
  }
  return { ...result, events: lines(stdout), errors: lines(stderr) };
}

try {
  await verifySenderTelemetry(fixture);
  const env = fixture.environment(), config = transferConfiguration(fixture.values, env);
  const diagnostic = await cli(env);
  assert.equal(diagnostic.code, 0);
  assert.ok(diagnostic.events.some(event => event.event === 'diagnostic_success_case' && event.bytes === 1048576));
  assert.ok(diagnostic.events.some(event => event.event === 'diagnostic_cancel_case' && event.received_bytes > 0 && event.children_active === 0));
  assert.ok(diagnostic.events.some(event => event.event === 'cleanup_state' && event.cleanup === 'confirmed'));
  assert.equal(diagnostic.events.at(-1).event, 'diagnostic_passed');
  assert.ok(diagnostic.events.at(-1).elapsed_ms < 60_000);
  assert.equal(diagnostic.events.find(event => event.event === 'transfer_manifest').total_bytes, 1310720);
  assert.ok(!diagnostic.events.some(event => /activation|deployment|release_complete/.test(event.event)));
  absent(config.stage);
  console.log('PASS diagnostic CLI: real SFTP hash/length, partial cancellation, bounded payload/time, owned cleanup; no activation');

  for (const interrupt of ['SIGINT', 'SIGTERM']) {
    const interruptedEnv = fixture.environment();
    const interruptedConfig = transferConfiguration(fixture.values, interruptedEnv);
    const interrupted = await cli(interruptedEnv, { interrupt });
    assert.notEqual(interrupted.code, 0);
    assert.ok(interrupted.events.some(event => event.event === 'transfer_failed' && event.category === 'cancelled'));
    assert.ok(interrupted.events.some(event => event.event === 'cleanup_state' && event.cleanup === 'confirmed'));
    absent(interruptedConfig.stage);
    console.log(`PASS real CLI ${interrupt}: nonzero exit, client process groups gone, stage removed, no activation`);
  }

  for (const interrupt of ['SIGINT', 'SIGTERM']) {
    const wrapped = await cli(fixture.environment(), { interrupt, wrapper: true });
    assert.notEqual(wrapped.code, 0);
    assert.ok(wrapped.events.some(event => event.event === 'transfer_failed' && event.category === 'cancelled'));
    console.log(`PASS actual diagnostic Actions bash wrapper ${interrupt}: key without trailing newline authenticates, entry PID cancellation, keys removed after remote cleanup, no activation`);
  }

  const invalid = await cli(fixture.environment(), { args: ['--release-root', 'SYNTHETIC_REMOTE_STDERR_MUST_NOT_LEAK'] });
  assert.notEqual(invalid.code, 0);
  assert.equal(invalid.errors[0].category, 'configuration');
  assert.equal(invalid.events.length, 0);
  console.log('PASS conflicting diagnostic/release inputs rejected before SSH without echoing input');

  const root = join(fixture.root, 'bundle');
  await mkdir(root);
  for (const name of RELEASE_FILES) await writeFile(join(root, name), name === 'remote-release.sh'
    ? '#!/bin/sh\nprintf active > /tmp/activation-sentinel\nprintf SYNTHETIC_REMOTE_STDERR_MUST_NOT_LEAK >&2\nexit 0\n' : `synthetic ${name}\n`);
  const configFor = () => transferConfiguration({ ...fixture.values, diagnostic: false, 'release-root': root }, fixture.environment());
  const productionEnv = fixture.environment();
  const productionRoot = join(fixture.root, `super-leader-release-${productionEnv.REVISION}`);
  await mkdir(productionRoot);
  for (const name of RELEASE_FILES) await writeFile(join(productionRoot, name), await readFile(join(root, name)));
  const wrappedProduction = await cli(productionEnv, { interrupt: 'SIGTERM', wrapper: true, production: true });
  assert.notEqual(wrappedProduction.code, 0);
  assert.ok(wrappedProduction.events.some(event => event.event === 'transfer_failed' && event.category === 'cancelled'));
  console.log('PASS actual production Actions bash wrapper SIGTERM: nonzero, authentication retained through cleanup, no activation');
  const captured = [];
  let gated = 0;
  const rejected = new ReleaseTransfer(configFor(), { log: value => captured.push(value), beforeActivate: async () => {
    gated++; throw new Error('SYNTHETIC_TOKEN_MUST_NOT_LEAK');
  } });
  await assert.rejects(rejected.execute());
  assert.equal(gated, 1);
  absent(rejected.config.stage);
  assert.equal(fixture.python('import os; print(os.path.exists("/tmp/activation-sentinel"))').trim(), 'False');
  console.log('PASS real bundle transport followed by stale/gate rejection: activation sentinel absent');

  class CorruptedTransfer extends ReleaseTransfer {
    async remote(op, ...args) {
      if (op === 'verify') fixture.python(`open(${JSON.stringify(`${this.config.stage}/controller.tar`)},'wb').write(b'corrupted')`);
      return super.remote(op, ...args);
    }
  }
  gated = 0;
  const corrupted = new CorruptedTransfer(configFor(), { log: value => captured.push(value), beforeActivate: async () => { gated++; } });
  await assert.rejects(corrupted.execute(), { category: 'integrity' });
  assert.equal(gated, 0);
  absent(corrupted.config.stage);
  assert.equal(fixture.python('import os; print(os.path.exists("/tmp/activation-sentinel"))').trim(), 'False');
  console.log('PASS real remote integrity failure blocks both gate and activation');

  const badKey = join(fixture.root, 'unauthorized-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', badKey]);
  class UnauthorizedScp extends ReleaseTransfer {
    async copy(...args) {
      const key = this.config.key;
      this.config.key = badKey;
      try { return await super.copy(...args); }
      finally { this.config.key = key; }
    }
  }
  const unauthorized = new UnauthorizedScp(configFor(), { log: value => captured.push(value), beforeActivate: async () => { throw new Error('must not run'); } });
  await assert.rejects(unauthorized.execute(), { category: 'authentication' });
  absent(unauthorized.config.stage);
  assert.equal(fixture.python('import os; print(os.path.exists("/tmp/activation-sentinel"))').trim(), 'False');
  console.log('PASS real SCP authentication failure is classified, blocks activation, and retains no raw stderr');

  await writeFile(join(root, 'controller.tar'), Buffer.alloc(256 * 1024, 'p'));
  class SlowTransfer extends ReleaseTransfer {
    sampleFailed = false;
    copy(files) { return super.copy(files, { limited: true }); }
    async remote(op, ...args) {
      if (op === 'status' && this.copyStarted && Date.now() - this.copyStarted >= 15000 && !this.sampleFailed) {
        this.sampleFailed = true;
        throw new TransferFailure('network_closed');
      }
      return super.remote(op, ...args);
    }
  }
  const slowLog = [];
  const slow = new SlowTransfer(configFor(), {
    beforeActivate: async () => { throw new Error('gate intentionally rejects'); },
    log: value => slowLog.push(JSON.parse(value)) });
  await assert.rejects(slow.execute(), { category: 'revision_gate' });
  const unavailable = slowLog.findIndex(event => event.event === 'transfer_progress_unavailable' && event.category === 'network_closed');
  assert.ok(unavailable >= 0);
  const later = slowLog.slice(unavailable + 1).find(event => event.event === 'transfer_progress' &&
    event.transfer_elapsed_ms >= 30000 && event.received_bytes > 0 && event.received_bytes < 256 * 1024);
  assert.ok(later, 'sampling recovers while the real SCP remains active');
  assert.ok(slowLog.some(event => event.event === 'transfer_verified'));
  assert.ok(!slowLog.some(event => event.event === 'activation_start'));
  absent(slow.config.stage);
  await writeFile(join(root, 'controller.tar'), 'synthetic controller.tar\n');
  console.log('PASS real slow SFTP survives first 15-second sample failure, later sampling recovers, final hash verified, revision gate still blocks activation');

  const foreignConfig = configFor();
  fixture.python(`import os; os.makedirs(${JSON.stringify(foreignConfig.stage)}); open(${JSON.stringify(`${foreignConfig.stage}/.transfer-owner`)},'w').write('foreign'); open(${JSON.stringify(`${foreignConfig.stage}/controller.tar`)},'w').write('must-stay')`);
  const foreign = new ReleaseTransfer(foreignConfig, { log: value => captured.push(value), beforeActivate: async () => { throw new Error('must not run'); } });
  await assert.rejects(foreign.execute());
  assert.equal(fixture.python(`print(open(${JSON.stringify(`${foreignConfig.stage}/controller.tar`)}).read())`).trim(), 'must-stay');
  console.log('PASS foreign same-name stage is neither overwritten nor cleaned');

  class UnexpectedFileTransfer extends ReleaseTransfer {
    async remote(op, ...args) {
      const result = await super.remote(op, ...args);
      if (op === 'create') fixture.python(`open(${JSON.stringify(`${this.config.stage}/unowned-canary`)},'w').write('must-stay')`);
      return result;
    }
  }
  const unexpected = new UnexpectedFileTransfer(configFor(), { log: value => captured.push(value), beforeActivate: async () => { throw new Error('gate'); } });
  await assert.rejects(unexpected.execute());
  assert.equal(fixture.python(`print(open(${JSON.stringify(`${unexpected.config.stage}/unowned-canary`)}).read())`).trim(), 'must-stay');
  assert.ok(captured.some(value => value.includes('unexpected_stage_files')));
  console.log('PASS cleanup removes only allowed owned files, preserves unexpected canary, reports unconfirmed');

  const activeConfig = configFor(), activeLog = [], activeAbort = new AbortController();
  const holder = `import os,time,pathlib; pathlib.Path('/tmp/remote-holder-pid').write_text(str(os.getpid())); time.sleep(20); pathlib.Path('/tmp/remote-holder-read').write_bytes(pathlib.Path(${JSON.stringify(`${activeConfig.stage}/controller.tar`)}).read_bytes())`;
  await writeFile(join(root, 'remote-release.sh'), `#!/bin/sh\ntrap '' HUP TERM\npython3 -c '${holder.replaceAll("'", "'\\''")}' >/tmp/remote-holder-log 2>&1 &\nwait $!\n`);
  const active = new ReleaseTransfer(activeConfig, { signal: activeAbort.signal, beforeActivate: async () => {}, log: value => {
    activeLog.push(value);
    if (JSON.parse(value).event === 'activation_start') setTimeout(() => activeAbort.abort(), 1000);
  } });
  await assert.rejects(active.execute(), { category: 'cancelled' });
  const activeEvents = activeLog.map(value => JSON.parse(value));
  assert.ok(activeEvents.some(event => event.event === 'cleanup_state' && event.category === 'activation_completion_unknown'));
  assert.ok(!activeEvents.some(event => event.cleanup === 'confirmed'));
  fixture.python(`import os; pid=int(open('/tmp/remote-holder-pid').read()); os.kill(pid,0); assert os.path.isfile(${JSON.stringify(`${activeConfig.stage}/controller.tar`)})`);
  console.log('PASS local SSH cancelled while remote activation remains alive: stage retained, cleanup unconfirmed');
  await safeLogs(activeLog.join('\n'));
  fixture.python("import os,signal; os.kill(int(open('/tmp/remote-holder-pid').read()),signal.SIGKILL)");
  await delay(100);

  await writeFile(join(root, 'remote-release.sh'), '#!/bin/sh\nprintf active > /tmp/activation-sentinel\nprintf SYNTHETIC_REMOTE_STDERR_MUST_NOT_LEAK >&2\nexit 0\n');

  const acceptedConfig = configFor(), sockets = new Set(), timers = new Set();
  const upstreamPort = acceptedConfig.port, upstreamHost = acceptedConfig.host;
  const proxy = createServer(client => {
    sockets.add(client);
    client.pause();
    client.on('error', () => client.destroy());
    const timer = setTimeout(() => {
      timers.delete(timer);
      const upstream = connect(upstreamPort, upstreamHost);
      sockets.add(upstream);
      upstream.on('error', () => { upstream.destroy(); client.destroy(); });
      client.on('close', () => { sockets.delete(client); upstream.destroy(); });
      upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
      upstream.pipe(client); client.pipe(upstream); client.resume();
    }, 3500);
    timers.add(timer);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const proxyPort = proxy.address().port;
    const proxyKnown = join(fixture.root, 'proxy-known-hosts');
    const publicKey = (await readFile(fixture.values['known-hosts-file'], 'utf8')).trim().split(' ').slice(1).join(' ');
    await writeFile(proxyKnown, `[127.0.0.1]:${proxyPort} ${publicKey}\n`);
    class DelayedCleanup extends ReleaseTransfer {
      async remote(op, ...args) {
        if (op !== 'cleanup') return super.remote(op, ...args);
        const oldPort = this.config.port, oldKnown = this.config.knownHosts;
        this.config.port = proxyPort; this.config.knownHosts = proxyKnown;
        const started = Date.now();
        try {
          const result = await super.remote(op, ...args);
          assert.ok(Date.now() - started >= 3500);
          return result;
        } finally { this.config.port = oldPort; this.config.knownHosts = oldKnown; }
      }
    }
    const accepted = new DelayedCleanup(acceptedConfig, { log: value => captured.push(value), beforeActivate: async () => {} });
    await accepted.execute();
    assert.equal(fixture.python('print(open("/tmp/activation-sentinel").read())').trim(), 'active');
    absent(accepted.config.stage);
    console.log('PASS successful synthetic activation cleanup tolerates a real 3.5-second SSH handshake delay within its connection budget');
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => proxy.close(resolve));
  }
  await safeLogs(captured.join('\n'));
  assert.ok(captured.some(value => value.includes('deployment_verified')));
  console.log('PASS synthetic release script invoked only after verified transfer/gate; remote stderr and credentials absent from logs');
} finally { await fixture.close(); }
