import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { ACTIVATION_LOG, ACTIVATION_STATUS, REMOTE_FILES } from '../../../scripts/deploy/transfer-files.mjs';

const REVISION = 'a'.repeat(40);
const SCRIPT = fileURLToPath(new URL('../../../scripts/deploy/remote-release.sh', import.meta.url));
const STATE_SCRIPT = fileURLToPath(new URL('../../../scripts/deploy/release-state.py', import.meta.url));
const RELEASE_ENV = `CONTROLLER_IMAGE=super-leader-controller:${REVISION}\n` +
  `GATEWAY_IMAGE=super-leader-gateway:${REVISION}\nGATEWAY_CONTEXT_WINDOW_MS=82800000\n`;
const PREVIOUS_ENV = RELEASE_ENV.replaceAll(REVISION, 'b'.repeat(40));
const OWNER = 'synthetic-owner';
const STATUS_WAIT_MS = 10_000;
const POLL_MS = 50;
const SESSION_SETUP_DELAY_MS = 300;

function writeReleaseBundle(stage) {
  mkdirSync(stage, { recursive: true });
  const bundle = ['controller.tar', 'gateway.tar', 'compose.release.yaml', 'compose.yaml',
    'compose.production.yaml', 'compose.gateway.yaml', 'codex-seccomp.json'];
  for (const file of bundle) writeFileSync(join(stage, file), 'fixture\n');
  copyFileSync(SCRIPT, join(stage, 'remote-release.sh'));
  copyFileSync(STATE_SCRIPT, join(stage, 'release-state.py'));
  bundle.push('remote-release.sh', 'release-state.py');
  writeFileSync(join(stage, 'release.sha256'), bundle.map(file =>
    `${createHash('sha256').update(readFileSync(join(stage, file))).digest('hex')}  ${file}\n`).join(''));
}

function releaseFixture() {
  const root = mkdtempSync(join(tmpdir(), 'release-idempotency-'));
  const stage = join(root, 'stage');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(join(root, '.runtime'));
  writeFileSync(join(root, '.runtime/controller.env'), '', { mode: 0o600 });
  writeFileSync(join(root, '.runtime/release.env'), RELEASE_ENV, { mode: 0o600 });
  writeFileSync(join(root, '.runtime/release.env.previous'), PREVIOUS_ENV);
  writeReleaseBundle(stage);
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2);
appendFileSync(process.env.RELEASE_COMMAND_LOG, JSON.stringify(args) + '\\n');
const revision = process.env.TEST_RELEASE_REVISION;
const root = dirname(process.env.RELEASE_COMMAND_LOG);
const expectedId = 'sha256:' + 'a'.repeat(64);
const rebuiltId = 'sha256:' + 'c'.repeat(64);
const tagId = existsSync(join(root, 'retagged')) ? rebuiltId : expectedId;
const containerId = process.env.TEST_IMAGE_ID || (existsSync(join(root, 'recreated')) ? tagId : expectedId);
function mutateReleaseEnvironment() {
  writeFileSync(join(root, '.runtime/release.env'),
    'CONTROLLER_IMAGE=super-leader-controller:' + revision + '\\n' +
    'GATEWAY_IMAGE=super-leader-gateway:' + revision + '\\n' +
    'GATEWAY_CONTEXT_WINDOW_MS=86400000\\n');
}
if (args[0] === 'compose') {
  const ps = args.indexOf('ps');
  if (ps !== -1) console.log(args.at(-1));
  if (args.includes('--force-recreate')) writeFileSync(join(root, 'recreated'), 'yes');
  if (args.includes('--force-recreate') && process.env.TEST_MUTATE_RELEASE_ON_UP) mutateReleaseEnvironment();
  if ((args.includes('--force-recreate') && process.env.TEST_MUTATE_ENV_ON_UP) ||
      (args.includes('config') && process.env.TEST_MUTATE_ENV_ON_PREFLIGHT)) {
    writeFileSync(join(root, '.runtime/controller.env'), 'SECRET=changed\\n');
  }
  if (args.includes('--force-recreate') && process.env.TEST_RECREATE_MS) {
    // Block like a long stop_grace_period, then write to stderr as Compose does.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.TEST_RECREATE_MS));
    console.error('Container super-leader-gateway Recreated');
  }
} else if (args[0] === 'load') {
  if (process.env.TEST_LOAD_RETAG) writeFileSync(join(root, 'retagged'), 'yes');
} else if (args[0] === 'ps') {
  console.log(args.at(-1).split('=').at(-1));
} else if (args[0] === 'inspect' || (args[0] === 'image' && args[1] === 'inspect')) {
  if (!args.includes('--format')) {
    if (process.env.TEST_RECORD_FAILURE) process.exit(1);
    if (process.env.TEST_MUTATE_ENV_ON_INSPECT) writeFileSync(join(root, '.runtime/controller.env'), 'SECRET=changed\\n');
    if (process.env.TEST_MUTATE_RELEASE_ON_INSPECT) mutateReleaseEnvironment();
    const service = args.at(-1);
    const labels = { 'org.opencontainers.image.revision': revision,
      'com.docker.compose.project': 'super-leader', 'com.docker.compose.service': service,
      'com.docker.compose.project.working_dir': root };
    if (args[0] === 'image') console.log(JSON.stringify([{ Id: tagId, Os: 'linux', Architecture: 'amd64',
      Config: { Labels: labels } }]));
    else console.log(JSON.stringify([{ Image: containerId,
      State: { Status: 'running', Health: { Status: process.env.TEST_HEALTH || 'healthy' } },
      Config: { Image: 'super-leader-' + service + ':' + revision, Labels: labels,
        Env: ['GATEWAY_CONTEXT_WINDOW_MS=' + (process.env.TEST_WINDOW || '82800000')] },
      HostConfig: { Memory: Number(process.env.TEST_RUNTIME_MEMORY || 1024) },
      Mounts: [], NetworkSettings: { Networks: {} } }]));
    process.exit(0);
  }
  const format = args[args.indexOf('--format') + 1];
  const service = args.at(-1);
  if (format.includes('.State.Health') && process.env.TEST_MUTATE_RELEASE_DURING_HEALTH &&
      existsSync(join(root, 'recreated')) && !existsSync(join(root, 'release-mutated'))) {
    mutateReleaseEnvironment();
    writeFileSync(join(root, 'release-mutated'), 'yes');
  }
  if (format.includes('.Os')) console.log('linux/amd64');
  else if (format === '{{.Image}}') console.log(containerId);
  else if (format === '{{.Id}}') console.log(tagId);
  else if (format.includes('revision')) console.log(revision);
  else if (format.includes('.State.Status')) console.log('running');
  else if (format.includes('.State.Health')) console.log(process.env.TEST_HEALTH || 'healthy');
  else if (format.includes('.Config.Image')) console.log(process.env.TEST_IMAGE || 'super-leader-' + service + ':' + revision);
  else if (format.includes('.Config.Env')) console.log('GATEWAY_CONTEXT_WINDOW_MS=' + (process.env.TEST_WINDOW || '82800000'));
  else throw new Error('Unexpected inspect format ' + format);
}
`);
  chmodSync(join(bin, 'docker'), 0o755);
  const args = ['--release-dir', root, '--stage-dir', stage, '--revision', REVISION,
    '--controller-image', `super-leader-controller:${REVISION}`,
    '--gateway-image', `super-leader-gateway:${REVISION}`,
    '--controller-archive', join(stage, 'controller.tar'), '--gateway-archive', join(stage, 'gateway.tar'),
    '--checksums', join(stage, 'release.sha256'), '--compose-overlay', join(stage, 'compose.release.yaml'),
    '--compose-base', join(stage, 'compose.yaml'), '--compose-production', join(stage, 'compose.production.yaml'),
    '--compose-gateway', join(stage, 'compose.gateway.yaml'), '--seccomp-policy', join(stage, 'codex-seccomp.json')];
  return { root, stage, args: args.slice(), env: overrides => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`,
    TEST_RELEASE_REVISION: REVISION, RELEASE_COMMAND_LOG: join(root, 'commands.jsonl'), ...overrides }), run(overrides = {}) {
    const result = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_RELEASE_REVISION: REVISION,
        RELEASE_COMMAND_LOG: join(root, 'commands.jsonl'), ...overrides } });
    if (result.error) throw result.error;
    return { ...result, commands: readFileSync(join(root, 'commands.jsonl'), 'utf8') };
  }, restage() { writeReleaseBundle(stage); }, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}

function seedReceipt(fixture) {
  const result = spawnSync('python3', [STATE_SCRIPT, 'record', '--release-dir', fixture.root,
    '--revision', REVISION, '--bundle-dir', fixture.stage, '--expected-controller-env-sha256',
    createHash('sha256').update(readFileSync(join(fixture.root, '.runtime/controller.env'))).digest('hex'),
    '--expected-release-env-sha256', createHash('sha256').update(RELEASE_ENV).digest('hex')],
  { env: fixture.env({}), encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr);
}

test('duplicate healthy release skips recreation and preserves previous rollback selection', () => {
  const fixture = releaseFixture();
  try {
    seedReceipt(fixture);
    const receiptBefore = readFileSync(join(fixture.root, '.runtime/deployment-receipt.json'), 'utf8');
    const result = fixture.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /deployment already healthy.*skipping recreation/);
    assert.doesNotMatch(result.commands, /force-recreate/);
    assert.match(result.stdout, /deployment_result=activation_skipped/);
    assert.equal(readFileSync(join(fixture.root, '.runtime/deployment-receipt.json'), 'utf8'), receiptBefore);
    assert.equal(readFileSync(join(fixture.root, '.runtime/release.env.previous'), 'utf8'), PREVIOUS_ENV);
    assert.equal(readFileSync(join(fixture.root, '.runtime/release.env'), 'utf8'), RELEASE_ENV);
  } finally { fixture.cleanup(); }
});

test('same healthy image IDs without an accepted receipt recreate once and establish a receipt', () => {
  const fixture = releaseFixture();
  try {
    const result = fixture.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.commands, /force-recreate/);
    assert.match(result.stdout, /deployment_result=deployment_verified/);
    assert.equal(existsSync(join(fixture.root, '.runtime/deployment-receipt.json')), true);
  } finally { fixture.cleanup(); }
});

test('same image IDs with container configuration drift cannot use the activation skip', () => {
  const fixture = releaseFixture();
  try {
    seedReceipt(fixture);
    const result = fixture.run({ TEST_RUNTIME_MEMORY: '2048' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.commands, /force-recreate/);
    assert.match(result.stdout, /runtime_changed/);
    assert.doesNotMatch(result.stdout, /deployment_result=activation_skipped/);
    assert.match(result.stdout, /deployment_result=deployment_verified/);
  } finally { fixture.cleanup(); }
});

test('different release environment activates the new revision and retains the old selection', () => {
  const fixture = releaseFixture();
  try {
    writeFileSync(join(fixture.root, '.runtime/release.env'), PREVIOUS_ENV);
    const result = fixture.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.commands, /force-recreate/);
    assert.match(result.stdout, /deployment verified for revision/);
    assert.match(result.stdout, /deployment_result=deployment_verified/);
    assert.equal(existsSync(join(fixture.root, '.runtime/deployment-receipt.json')), true);
    assert.equal(readFileSync(join(fixture.root, '.runtime/release.env.previous'), 'utf8'), PREVIOUS_ENV);
    assert.equal(readFileSync(join(fixture.root, '.runtime/release.env'), 'utf8'), RELEASE_ENV);
  } finally { fixture.cleanup(); }
});

test('docker load retagging the same revision still recreates and verifies the actual new image ID', () => {
  const fixture = releaseFixture();
  try {
    const result = fixture.run({ TEST_LOAD_RETAG: '1' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.commands, /force-recreate/);
    assert.doesNotMatch(result.stdout, /deployment_result=activation_skipped/);
    const receipt = JSON.parse(readFileSync(join(fixture.root, '.runtime/deployment-receipt.json'), 'utf8'));
    assert.equal(receipt.services.controller.image_id, 'sha256:' + 'c'.repeat(64));
    assert.equal(receipt.services.gateway.image_id, 'sha256:' + 'c'.repeat(64));
    assert.equal(readFileSync(join(fixture.root, '.runtime/release.env.previous'), 'utf8'), PREVIOUS_ENV);
  } finally { fixture.cleanup(); }
});

test('first release health failure remains retryable and cannot create a successful receipt', () => {
  const fixture = releaseFixture();
  try {
    rmSync(join(fixture.root, '.runtime/release.env'));
    rmSync(join(fixture.root, '.runtime/release.env.previous'));
    const result = fixture.run({ TEST_HEALTH: 'unhealthy' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /rollback is unavailable/);
    assert.equal(existsSync(join(fixture.root, '.runtime/deployment-receipt.json')), false);
    assert.doesNotMatch(result.stdout, /deployment_result=deployment_verified/);
    fixture.restage();
    const retry = fixture.run();
    assert.equal(retry.status, 0, retry.stderr);
    assert.match(retry.commands, /force-recreate/);
    assert.match(retry.stdout, /deployment_result=deployment_verified/);
    assert.equal(existsSync(join(fixture.root, '.runtime/deployment-receipt.json')), true);
  } finally { fixture.cleanup(); }
});

test('receipt verification failure rolls back without replacing the last accepted receipt', () => {
  const fixture = releaseFixture();
  try {
    writeFileSync(join(fixture.root, '.runtime/release.env'), PREVIOUS_ENV);
    const receipt = join(fixture.root, '.runtime/deployment-receipt.json');
    writeFileSync(receipt, 'last accepted receipt', { mode: 0o600 });
    const result = fixture.run({ TEST_RECORD_FAILURE: '1' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /receipt could not be recorded/);
    assert.doesNotMatch(result.stdout, /deployment_result=deployment_verified/);
    assert.equal(readFileSync(receipt, 'utf8'), 'last accepted receipt');
    assert.equal(readFileSync(join(fixture.root, '.runtime/release.env'), 'utf8'), PREVIOUS_ENV);
  } finally { fixture.cleanup(); }
});

test('environment changed after Compose consumes it cannot replace a receipt or claim success', () => {
  const fixture = releaseFixture();
  try {
    seedReceipt(fixture);
    const receipt = join(fixture.root, '.runtime/deployment-receipt.json');
    const accepted = readFileSync(receipt, 'utf8');
    writeFileSync(join(fixture.root, '.runtime/release.env'), PREVIOUS_ENV);
    const result = fixture.run({ TEST_MUTATE_ENV_ON_UP: '1' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /controller_environment_changed/);
    assert.match(result.stdout, /restoring the previous image selection/);
    assert.doesNotMatch(result.stdout, /deployment_result=deployment_verified/);
    assert.equal(readFileSync(receipt, 'utf8'), accepted);
  } finally { fixture.cleanup(); }
});

for (const mutation of ['TEST_MUTATE_ENV_ON_PREFLIGHT', 'TEST_MUTATE_ENV_ON_INSPECT']) {
  test(`${mutation} cannot race into an activation skip`, () => {
    const fixture = releaseFixture();
    try {
      seedReceipt(fixture);
      const receipt = join(fixture.root, '.runtime/deployment-receipt.json');
      const accepted = readFileSync(receipt, 'utf8');
      const result = fixture.run({ [mutation]: '1' });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /controller_environment_changed/);
      assert.doesNotMatch(result.stdout, /deployment_result=/);
      assert.equal(readFileSync(receipt, 'utf8'), accepted);
    } finally { fixture.cleanup(); }
  });
}

for (const mutation of ['TEST_MUTATE_RELEASE_ON_UP', 'TEST_MUTATE_RELEASE_DURING_HEALTH']) {
  test(`late release environment ${mutation} rolls back and cannot establish a duplicate receipt`, t => {
    const fixture = releaseFixture();
    try {
      seedReceipt(fixture);
      const receipt = join(fixture.root, '.runtime/deployment-receipt.json');
      const accepted = readFileSync(receipt, 'utf8');
      const fingerprint = JSON.parse(accepted).fingerprint;
      writeFileSync(join(fixture.root, '.runtime/release.env'), PREVIOUS_ENV);
      const result = fixture.run({ [mutation]: '1' });
      const check = spawnSync('python3', [STATE_SCRIPT, 'check', '--release-dir', fixture.root,
        '--revision', REVISION, '--fingerprint', fingerprint], { env: fixture.env({}), encoding: 'utf8' });
      if (check.error) throw check.error;
      writeFileSync(join(fixture.root, '.runtime/activation.lock'), '', { mode: 0o600 });
      const probe = spawnSync('python3', [STATE_SCRIPT, 'probe', '--release-dir', fixture.root,
        '--revision', REVISION, '--fingerprint', fingerprint, '--lock-timeout', '0.1'],
      { env: fixture.env({}), encoding: 'utf8' });
      if (probe.error) throw probe.error;
      t.diagnostic(JSON.stringify({ mutation, activation_status: result.status,
        receipt_preserved: readFileSync(receipt, 'utf8') === accepted,
        verified_claimed: /deployment_result=deployment_verified/.test(result.stdout),
        subsequent_check_status: check.status, subsequent_check: check.stdout.trim(),
        subsequent_probe_status: probe.status, subsequent_probe: probe.stdout.trim() }));
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /release_environment_changed/);
      assert.match(result.stdout, /restoring the previous image selection/);
      assert.doesNotMatch(result.stdout, /deployment_result=/);
      assert.equal(readFileSync(receipt, 'utf8'), accepted);
      assert.equal(readFileSync(join(fixture.root, '.runtime/release.env'), 'utf8'), PREVIOUS_ENV);
      assert.equal(check.status, 3, check.stderr);
      assert.equal(JSON.parse(check.stdout).decision, 'deploy_required');
      assert.equal(probe.status, 0, probe.stderr);
      assert.equal(JSON.parse(probe.stdout).decision, 'deploy_required');
      assert.equal(JSON.parse(probe.stdout).reason, 'environment_changed');
    } finally { fixture.cleanup(); }
  });
}

test('late release environment mutation during the activation check cannot skip', () => {
  const fixture = releaseFixture();
  try {
    seedReceipt(fixture);
    const receipt = join(fixture.root, '.runtime/deployment-receipt.json');
    const accepted = readFileSync(receipt, 'utf8');
    const result = fixture.run({ TEST_MUTATE_RELEASE_ON_INSPECT: '1' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /release_environment_changed/);
    assert.doesNotMatch(result.stdout, /deployment_result=/);
    assert.equal(readFileSync(receipt, 'utf8'), accepted);
  } finally { fixture.cleanup(); }
});

for (const [name, overrides] of [
  ['unhealthy container', { TEST_HEALTH: 'unhealthy' }],
  ['wrong image selection', { TEST_IMAGE: 'unexpected-image' }],
  ['different image archive', { TEST_IMAGE_ID: 'sha256:old-archive' }],
  ['wrong reply window', { TEST_WINDOW: '86400000' }],
]) {
  test(`same revision with ${name} cannot skip activation or claim success`, () => {
    const fixture = releaseFixture();
    try {
      const result = fixture.run(overrides);
      assert.equal(result.status, 1, result.stderr);
      assert.doesNotMatch(result.stdout, /deployment already healthy/);
      assert.match(result.commands, /force-recreate/);
      assert.match(result.stderr, /deployment is not successful/);
      assert.equal(existsSync(join(fixture.root, '.runtime/deployment-receipt.json')), false);
      assert.equal(readFileSync(join(fixture.root, '.runtime/release.env'), 'utf8'), PREVIOUS_ENV);
    } finally { fixture.cleanup(); }
  });
}

function helper(fixture, op, payload, env) {
  return spawnSync('python3', ['-', fixture.stage, OWNER, op, Buffer.from(JSON.stringify(payload)).toString('base64')],
    { input: REMOTE_FILES, encoding: 'utf8', timeout: 10_000, env });
}

async function waitForStatus(stage) {
  const deadline = Date.now() + STATUS_WAIT_MS;
  while (!existsSync(join(stage, ACTIVATION_STATUS))) {
    assert.ok(Date.now() < deadline, 'detached activation publishes its exit status');
    await delay(POLL_MS);
  }
  return readFileSync(join(stage, ACTIVATION_STATUS), 'utf8');
}

test('detached activation finishes its rollback after the launching session is killed and its pipes close', async () => {
  const fixture = releaseFixture();
  try {
    copyFileSync(SCRIPT, join(fixture.stage, 'remote-release.sh'));
    writeFileSync(join(fixture.stage, '.transfer-owner'), OWNER);
    const startup = join(fixture.root, 'python-startup');
    mkdirSync(startup);
    writeFileSync(join(startup, 'sitecustomize.py'), `import os,time
setsid=os.setsid
def delayed_setsid():
 time.sleep(${SESSION_SETUP_DELAY_MS / 1000})
 return setsid()
os.setsid=delayed_setsid
`);
    const env = fixture.env({ TEST_HEALTH: 'unhealthy', TEST_RECREATE_MS: '1500', PYTHONPATH: startup });
    const launcher = spawn('python3', ['-', fixture.stage, OWNER, 'activate',
      Buffer.from(JSON.stringify(fixture.args)).toString('base64')], { detached: true, env, stdio: ['pipe', 'pipe', 'ignore'] });
    launcher.stdin.end(REMOTE_FILES);
    let stdout = '';
    for await (const chunk of launcher.stdout) {
      stdout += chunk;
      if (stdout.includes('"started"')) break;
    }
    assert.deepEqual(JSON.parse(stdout), { started: true });
    // Emulate a cancelled runner: kill the SSH-side process group and drop its output pipe.
    try { process.kill(-launcher.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    launcher.stdout.destroy();

    assert.equal(existsSync(join(fixture.stage, ACTIVATION_STATUS)), false, 'activation is still running');
    assert.equal(helper(fixture, 'cleanup', [], env).status, 77, 'cleanup refuses a stage in use');
    assert.equal(helper(fixture, 'activate', fixture.args, env).status, 78, 'a second launch is refused while the first holds the lock');
    assert.deepEqual(JSON.parse(helper(fixture, 'activation', [], env).stdout), { exit_code: null });

    assert.equal(await waitForStatus(fixture.stage), '1');
    const log = readFileSync(join(fixture.stage, ACTIVATION_LOG), 'utf8');
    assert.match(log, /Container super-leader-gateway Recreated/);
    assert.match(log, /restoring the previous image selection/);
    assert.match(log, /deployment is not successful/);
    assert.equal(readFileSync(join(fixture.root, '.runtime/release.env'), 'utf8'), PREVIOUS_ENV);
    const finished = JSON.parse(helper(fixture, 'activation', [], env).stdout);
    assert.equal(finished.exit_code, 1);
    assert.match(finished.output, /restoring the previous image selection/);

    const cleaned = helper(fixture, 'cleanup', [], env);
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(existsSync(fixture.stage), false, 'completed stage and its activation evidence are removable');
  } finally { fixture.cleanup(); }
});

test('detached activation publishes a successful exit status with the runtime verification output', async () => {
  const fixture = releaseFixture();
  try {
    copyFileSync(SCRIPT, join(fixture.stage, 'remote-release.sh'));
    writeFileSync(join(fixture.stage, '.transfer-owner'), OWNER);
    writeFileSync(join(fixture.root, '.runtime/release.env'), PREVIOUS_ENV);
    const env = fixture.env();
    const launched = helper(fixture, 'activate', fixture.args, env);
    assert.equal(launched.status, 0, launched.stderr);
    assert.equal(await waitForStatus(fixture.stage), '0');
    const finished = JSON.parse(helper(fixture, 'activation', [], env).stdout);
    assert.equal(finished.exit_code, 0);
    assert.match(finished.output, /^gateway_context_window_ms=82800000$/m);
    assert.equal(readFileSync(join(fixture.root, '.runtime/release.env'), 'utf8'), RELEASE_ENV);
  } finally { fixture.cleanup(); }
});

test('a second activation waits for the release-directory lock held by a still-running one', async () => {
  const fixture = releaseFixture();
  const holder = spawn('python3', ['-c', 'import fcntl,os,sys,time\nf=os.open(sys.argv[1],os.O_WRONLY|os.O_CREAT,0o600)\nfcntl.flock(f,fcntl.LOCK_EX)\nprint("held",flush=True)\ntime.sleep(60)',
    join(fixture.root, '.runtime/activation.lock')], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    copyFileSync(SCRIPT, join(fixture.stage, 'remote-release.sh'));
    writeFileSync(join(fixture.stage, '.transfer-owner'), OWNER);
    writeFileSync(join(fixture.root, '.runtime/release.env'), PREVIOUS_ENV);
    for await (const chunk of holder.stdout) if (String(chunk).includes('held')) break;
    const env = fixture.env();
    assert.equal(helper(fixture, 'activate', fixture.args, env).status, 78, 'a concurrent activation is refused');
    assert.equal(existsSync(join(fixture.stage, ACTIVATION_LOG)), false, 'a refused launch leaves the stage retryable');
    holder.kill('SIGKILL');
    await once(holder, 'exit');
    const launched = helper(fixture, 'activate', fixture.args, env);
    assert.equal(launched.status, 0, launched.stderr);
    assert.equal(await waitForStatus(fixture.stage), '0');
  } finally { holder.kill('SIGKILL'); fixture.cleanup(); }
});
