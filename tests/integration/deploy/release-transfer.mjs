import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer, connect } from 'node:net';
import { transferSshFixture } from '../../support/transfer-ssh-fixture.mjs';
import { ReleaseTransfer, transferConfiguration } from '../../../scripts/deploy/transfer-release.mjs';
import { RELEASE_FILES } from '../../../scripts/deploy/transfer-files.mjs';

const CLI = fileURLToPath(new URL('../../../scripts/deploy/transfer-release.mjs', import.meta.url));
const { values } = parseArgs({ options: { run: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
if (!values.run || values.help) { console.log('Usage: node tests/integration/deploy/release-transfer.mjs --run'); process.exit(0); }

const fixture = await transferSshFixture();
const lines = text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const absent = stage => assert.equal(fixture.python(`import os; print(os.path.exists(${JSON.stringify(stage)}))`).trim(), 'False');
const safeLogs = async output => {
  for (const secret of [await fixture.privateKey(), 'SYNTHETIC_TOKEN_MUST_NOT_LEAK', 'SYNTHETIC_KEY_MUST_NOT_LEAK',
    'SYNTHETIC_REMOTE_STDERR_MUST_NOT_LEAK', fixture.root]) assert.ok(!output.includes(secret));
};

async function cli(env, { interrupt, args = [] } = {}) {
  const child = spawn(process.execPath, [CLI, '--diagnostic', '--key-file', fixture.values['key-file'],
    '--known-hosts-file', fixture.values['known-hosts-file'], ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', signalled = false, groups = [], observerFailure;
  const timeout = setTimeout(() => child.kill('SIGKILL'), 65_000);
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (interrupt && !signalled && /"name":"cancel.bin","received_bytes":[1-9]/.test(stdout)) {
      try {
        groups = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n')
          .map(row => row.trim().split(/\s+/).map(Number)).filter(([, parent]) => parent === child.pid).map(([pid]) => pid);
        signalled = true;
        child.kill(interrupt);
      } catch (error) { observerFailure = error; child.kill('SIGTERM'); }
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  if (observerFailure) throw observerFailure;
  await safeLogs(stdout + stderr);
  if (interrupt) {
    assert.ok(signalled && groups.length > 0, 'interrupt occurred during a real partial SCP');
    for (const group of groups) assert.throws(() => process.kill(-group, 0), { code: 'ESRCH' });
  }
  return { ...result, events: lines(stdout), errors: lines(stderr) };
}

try {
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
    copy(files) { return super.copy(files, { limited: true }); }
  }
  const slowAbort = new AbortController(), slowLog = [];
  const slow = new SlowTransfer(configFor(), { signal: slowAbort.signal,
    beforeActivate: async () => { throw new Error('must not activate'); }, log: value => {
      const event = JSON.parse(value);
      slowLog.push(event);
      if (event.event === 'transfer_progress' && event.elapsed_ms >= 15000 && event.received_bytes > 0) slowAbort.abort();
    } });
  await assert.rejects(slow.execute(), { category: 'cancelled' });
  assert.ok(slowLog.some(event => event.event === 'transfer_progress' && event.elapsed_ms >= 15000 && event.received_bytes > 0));
  absent(slow.config.stage);
  await writeFile(join(root, 'controller.tar'), 'synthetic controller.tar\n');
  console.log('PASS 15-second periodic sampler observes real slow SFTP before cancellation; owned stage removed');

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
