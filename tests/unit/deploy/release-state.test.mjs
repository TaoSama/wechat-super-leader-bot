import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const SCRIPT = fileURLToPath(new URL('../../../scripts/deploy/release-state.py', import.meta.url));
const SOURCE = readFileSync(SCRIPT, 'utf8');
const REVISION = 'a'.repeat(40);
const IMAGE_ID = 'sha256:' + 'b'.repeat(64);
const FILES = ['compose.yaml', 'compose.release.yaml', 'compose.production.yaml', 'compose.gateway.yaml',
  'codex-seccomp.json', 'remote-release.sh', 'release-state.py'];
const RECEIPT = 'deployment-receipt.json';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'release-state-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const runtime = join(root, '.runtime'), bin = join(root, 'bin'), bundle = join(root, 'bundle');
  for (const path of [runtime, bin, bundle]) mkdirSync(path);
  for (const name of FILES) writeFileSync(join(bundle, name), name + '\n');
  writeFileSync(join(runtime, 'activation.lock'), '', { mode: 0o600 });
  writeFileSync(join(runtime, 'controller.env'), 'SECRET=must-not-appear\n', { mode: 0o600 });
  writeFileSync(join(runtime, 'release.env'), `CONTROLLER_IMAGE=super-leader-controller:${REVISION}\n` +
    `GATEWAY_IMAGE=super-leader-gateway:${REVISION}\nGATEWAY_CONTEXT_WINDOW_MS=82800000\n`, { mode: 0o600 });
  const expectedReleaseEnvSha256 = createHash('sha256').update(readFileSync(join(runtime, 'release.env'))).digest('hex');
  const state = { containers: {}, images: {} };
  for (const service of ['controller', 'gateway']) {
    const image = `super-leader-${service}:${REVISION}`;
    state.containers[service] = {
      Image: IMAGE_ID, State: { Status: 'running', Health: { Status: 'healthy' } },
      Config: { Image: image, Env: ['SECRET=must-not-appear', 'GATEWAY_CONTEXT_WINDOW_MS=82800000'],
        Labels: { 'com.docker.compose.project': 'super-leader', 'com.docker.compose.service': service,
          'com.docker.compose.project.working_dir': root, 'org.opencontainers.image.revision': REVISION } },
      HostConfig: { Memory: 1024 }, Mounts: [{ Source: '/runtime', Destination: '/data' }],
      NetworkSettings: { Networks: { default: { Aliases: [service], IPAddress: '172.1.0.2', EndpointID: 'ephemeral' } } },
    };
    state.images[image] = { Id: IMAGE_ID, Os: 'linux', Architecture: 'amd64',
      Config: { Labels: { 'org.opencontainers.image.revision': REVISION } } };
  }
  const statePath = join(root, 'docker-state.json');
  const save = () => writeFileSync(statePath, JSON.stringify(state));
  save();
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const state = JSON.parse(readFileSync(process.env.TEST_STATE, 'utf8'));
if (state.fail) { console.error('SECRET=must-not-appear'); process.exit(1); }
if (state.malformed) { console.log('not-json'); process.exit(0); }
const args = process.argv.slice(2);
if (args[0] === 'ps') {
  const service = args.at(-1).split('=').at(-1);
  if (state.containers[service]) console.log(service);
  if (state.oneoffs && !args.includes('label=com.docker.compose.oneoff=False')) console.log(service + '-run');
  if (state.duplicateService) console.log(service + '-duplicate');
} else if (args[0] === 'image') console.log(JSON.stringify([state.images[args.at(-1)]]));
else {
  if (state.mutateEnvDuringInspect) writeFileSync(join(dirname(process.env.TEST_STATE), '.runtime/controller.env'), 'SECRET=changed\\n');
  if (state.mutateReleaseDuringInspect) writeFileSync(join(dirname(process.env.TEST_STATE), '.runtime/release.env'), 'GATEWAY_CONTEXT_WINDOW_MS=86400000\\n');
  console.log(JSON.stringify([state.containers[args.at(-1)]]));
}
`);
  chmodSync(join(bin, 'docker'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_STATE: statePath };
  const run = (command, extra = []) => {
    const args = command === 'fingerprint' ? ['--bundle-dir', bundle] :
      ['--release-dir', root, '--revision', REVISION, ...(command === 'record' ? ['--bundle-dir', bundle,
        '--expected-controller-env-sha256', createHash('sha256').update(readFileSync(join(runtime, 'controller.env'))).digest('hex'),
        '--expected-release-env-sha256', expectedReleaseEnvSha256] :
        ['--fingerprint', fp(), ...(command === 'probe' ? ['--lock-timeout', '0.1'] : [])])];
    const result = spawnSync('python3', ['-', command, ...args, ...extra], { input: SOURCE, env,
      encoding: 'utf8', timeout: 10_000 });
    if (result.error) throw result.error;
    assert.doesNotMatch(result.stdout + result.stderr, /must-not-appear/);
    return result;
  };
  const fp = () => {
    const result = run('fingerprint');
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const record = () => { const result = run('record'); assert.equal(result.status, 0, result.stderr); };
  const probe = extra => {
    const result = run('probe', extra);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  return { root, runtime, bundle, state, save, env, run, fp, record, probe, expectedReleaseEnvSha256,
    receipt: join(runtime, RECEIPT) };
}

test('fingerprint uses fixed filenames, order, and content and runs from stdin', t => {
  const f = fixture(t);
  const hash = value => createHash('sha256').update(value).digest('hex');
  assert.equal(f.fp(), hash(FILES.map(name => `${name}\0${hash(name + '\n')}\n`).join('')));
  writeFileSync(join(f.bundle, 'unrelated'), 'ignored');
  const before = f.fp();
  writeFileSync(join(f.bundle, 'compose.yaml'), 'changed');
  assert.notEqual(f.fp(), before);
  rmSync(join(f.bundle, 'release-state.py'));
  assert.notEqual(f.run('fingerprint').status, 0);
});

test('only an accepted receipt and matching live runtime can skip, with private atomic storage', t => {
  const f = fixture(t);
  assert.equal(f.probe().decision, 'deploy_required');
  f.record();
  assert.equal(statSync(f.receipt).mode & 0o777, 0o600);
  assert.deepEqual(f.probe(), { schema: 1, revision: REVISION, decision: 'duplicate_skipped', reason: 'healthy_receipt_match' });
  assert.doesNotMatch(readFileSync(f.receipt, 'utf8'), /must-not-appear/);
  assert.deepEqual(readdirSync(f.runtime).sort(), ['activation.lock', 'controller.env', RECEIPT, 'release.env'].sort());
});

test('new revision and changed deployment bundle cannot reuse a receipt', t => {
  const f = fixture(t); f.record();
  assert.equal(f.probe(['--revision', 'c'.repeat(40)]).reason, 'revision_changed');
  writeFileSync(join(f.bundle, 'compose.yaml'), 'changed');
  assert.equal(f.probe().reason, 'bundle_changed');
});

for (const [name, mutate] of [
  ['actual image ID', f => { f.state.containers.controller.Image = 'sha256:' + 'd'.repeat(64); }],
  ['retagged image', f => { f.state.images[`super-leader-controller:${REVISION}`].Id = 'sha256:' + 'd'.repeat(64); }],
  ['selected image', f => { f.state.containers.controller.Config.Image = 'unexpected'; }],
  ['revision label', f => { f.state.containers.controller.Config.Labels['org.opencontainers.image.revision'] = 'c'.repeat(40); }],
  ['architecture', f => { f.state.images[`super-leader-controller:${REVISION}`].Architecture = 'arm64'; }],
  ['working directory', f => { f.state.containers.controller.Config.Labels['com.docker.compose.project.working_dir'] = '/elsewhere'; }],
  ['project', f => { f.state.containers.controller.Config.Labels['com.docker.compose.project'] = 'elsewhere'; }],
  ['health', f => { f.state.containers.gateway.State.Health.Status = 'unhealthy'; }],
  ['stopped service', f => { f.state.containers.gateway.State.Status = 'exited'; }],
  ['window', f => { f.state.containers.gateway.Config.Env = ['GATEWAY_CONTEXT_WINDOW_MS=86400000']; }],
  ['environment', f => { f.state.containers.controller.Config.Env.push('CHANGED=1'); }],
  ['host configuration', f => { f.state.containers.controller.HostConfig.Memory = 2048; }],
  ['mount', f => { f.state.containers.controller.Mounts[0].Source = '/elsewhere'; }],
  ['network membership', f => { f.state.containers.controller.NetworkSettings.Networks.extra = { Aliases: ['extra'] }; }],
  ['missing service', f => { delete f.state.containers.gateway; }],
]) {
  test(`${name} drift requires deployment`, t => {
    const f = fixture(t); f.record(); mutate(f); f.save();
    assert.equal(f.probe().decision, 'deploy_required');
  });
}

test('dynamic endpoint identifiers do not change configured network membership', t => {
  const f = fixture(t); f.record();
  Object.assign(f.state.containers.controller.NetworkSettings.Networks.default,
    { EndpointID: 'new-ephemeral', IPAddress: '172.1.0.3' });
  f.save();
  assert.equal(f.probe().decision, 'duplicate_skipped');
});

for (const name of ['controller.env', 'release.env']) {
  test(`${name} changes and absence cannot skip`, t => {
    const f = fixture(t); f.record();
    writeFileSync(join(f.runtime, name), 'changed\n');
    assert.equal(f.probe().reason, 'environment_changed');
    rmSync(join(f.runtime, name));
    assert.equal(f.probe().reason, 'missing_environment');
  });
}

test('missing and corrupt receipts require deployment, unsafe permissions fail', t => {
  const f = fixture(t);
  assert.equal(f.probe().reason, 'missing_receipt');
  for (const invalid of ['{', '{}', 'null', '{"schema":1}']) {
    writeFileSync(f.receipt, invalid, { mode: 0o600 });
    assert.equal(f.probe().reason, 'invalid_receipt');
  }
  f.record(); chmodSync(f.receipt, 0o644);
  assert.notEqual(f.run('probe').status, 0);
});

test('Docker and malformed response failures are operational errors and preserve the accepted receipt', t => {
  const f = fixture(t); f.record();
  const before = readFileSync(f.receipt, 'utf8');
  for (const key of ['fail', 'malformed']) {
    f.state[key] = true; f.save();
    assert.notEqual(f.run('probe').status, 0);
    assert.notEqual(f.run('record').status, 0);
    assert.equal(readFileSync(f.receipt, 'utf8'), before);
    delete f.state[key];
  }
});

test('failed initial runtime verification cannot create a success receipt and can be retried', t => {
  const f = fixture(t);
  f.state.containers.gateway.State.Health.Status = 'unhealthy'; f.save();
  assert.notEqual(f.run('record').status, 0);
  assert.equal(existsSync(f.receipt), false);
  f.state.containers.gateway.State.Health.Status = 'healthy'; f.save();
  f.record();
  assert.equal(f.probe().decision, 'duplicate_skipped');
});

test('one-off containers do not interfere while duplicate regular services still require deployment', t => {
  const f = fixture(t); f.state.oneoffs = true; f.save();
  f.record();
  assert.equal(f.probe().decision, 'duplicate_skipped');
  f.state.duplicateService = true; f.save();
  assert.equal(f.probe().reason, 'service_count');
});

test('record binds the controller environment consumed by activation and rejects late changes', t => {
  const f = fixture(t); f.record();
  const accepted = readFileSync(f.receipt, 'utf8');
  const snapshot = createHash('sha256').update(readFileSync(join(f.runtime, 'controller.env'))).digest('hex');
  writeFileSync(join(f.runtime, 'controller.env'), 'SECRET=changed\n');
  const result = f.run('record', ['--expected-controller-env-sha256', snapshot]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /controller_environment_changed/);
  assert.equal(readFileSync(f.receipt, 'utf8'), accepted);
});

for (const accepted of [false, true]) {
  test(`late release environment snapshot mismatch cannot ${accepted ? 'replace an accepted' : 'create a'} receipt`, t => {
    const f = fixture(t);
    if (accepted) f.record();
    const before = accepted ? readFileSync(f.receipt, 'utf8') : null;
    writeFileSync(join(f.runtime, 'release.env'), 'GATEWAY_CONTEXT_WINDOW_MS=86400000\n');
    const result = f.run('record');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /release_environment_changed/);
    assert.equal(existsSync(f.receipt), accepted);
    if (accepted) assert.equal(readFileSync(f.receipt, 'utf8'), before);
    assert.equal(f.probe().decision, 'deploy_required');
  });
}

test('late release environment mutation during record inspection cannot establish a receipt', t => {
  const f = fixture(t);
  f.state.mutateReleaseDuringInspect = true; f.save();
  const result = f.run('record');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /release_environment_changed/);
  assert.equal(existsSync(f.receipt), false);
});

for (const command of ['check', 'probe']) {
  test(`late release environment mutation during ${command} cannot produce duplicate_skipped`, t => {
    const f = fixture(t); f.record();
    const before = readFileSync(f.receipt, 'utf8');
    f.state.mutateReleaseDuringInspect = true; f.save();
    const result = f.run(command, ['--expected-release-env-sha256', f.expectedReleaseEnvSha256]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /release_environment_changed/);
    assert.doesNotMatch(result.stdout, /duplicate_skipped/);
    assert.equal(readFileSync(f.receipt, 'utf8'), before);
  });
}

test('environment changes during Docker inspection cannot create a receipt or yield a duplicate decision', t => {
  const f = fixture(t);
  f.state.mutateEnvDuringInspect = true; f.save();
  const result = f.run('record');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /controller_environment_changed/);
  assert.equal(existsSync(f.receipt), false);
  f.state.mutateEnvDuringInspect = false; f.save(); f.record();
  writeFileSync(join(f.runtime, 'controller.env'), 'SECRET=must-not-appear\n');
  f.record();
  f.state.mutateEnvDuringInspect = true; f.save();
  assert.equal(f.probe().decision, 'deploy_required');
});

test('internal check distinguishes accepted, drift, and operational outcomes without creating a receipt', t => {
  const f = fixture(t);
  assert.equal(f.run('check').status, 3);
  assert.equal(existsSync(f.receipt), false);
  f.record();
  assert.equal(f.run('check').status, 0);
  f.state.containers.controller.HostConfig.Memory = 2048; f.save();
  assert.equal(f.run('check').status, 3);
  f.state.fail = true; f.save();
  assert.equal(f.run('check').status, 1);
});

test('probe shares the activation lock and fails with a bounded timeout while activation owns it', async t => {
  const f = fixture(t); f.record();
  const holder = spawn('python3', ['-c', 'import fcntl,sys,time\nf=open(sys.argv[1],"rb")\nfcntl.flock(f,fcntl.LOCK_EX)\nprint("locked",flush=True)\ntime.sleep(30)',
    join(f.runtime, 'activation.lock')], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    for await (const chunk of holder.stdout) if (chunk.toString().includes('locked')) break;
    assert.equal(f.run('check').status, 0, 'activation owner uses the internal check without relocking');
    const result = f.run('probe');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /activation_busy/);
  } finally {
    holder.kill('SIGKILL');
    await new Promise(resolve => holder.once('exit', resolve));
  }
  assert.equal(f.probe().decision, 'duplicate_skipped');
});
