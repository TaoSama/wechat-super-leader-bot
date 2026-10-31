import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REVISION = 'a'.repeat(40);
const SCRIPT = fileURLToPath(new URL('../../../scripts/deploy/remote-release.sh', import.meta.url));
const RELEASE_ENV = `CONTROLLER_IMAGE=super-leader-controller:${REVISION}\n` +
  `GATEWAY_IMAGE=super-leader-gateway:${REVISION}\nGATEWAY_CONTEXT_WINDOW_MS=82800000\n`;
const PREVIOUS_ENV = RELEASE_ENV.replaceAll(REVISION, 'b'.repeat(40));

function releaseFixture() {
  const root = mkdtempSync(join(tmpdir(), 'release-idempotency-'));
  const stage = join(root, 'stage');
  const bin = join(root, 'bin');
  mkdirSync(stage);
  mkdirSync(bin);
  mkdirSync(join(root, '.runtime'));
  writeFileSync(join(root, '.runtime/controller.env'), '', { mode: 0o600 });
  writeFileSync(join(root, '.runtime/release.env'), RELEASE_ENV);
  writeFileSync(join(root, '.runtime/release.env.previous'), PREVIOUS_ENV);
  const bundle = ['controller.tar', 'gateway.tar', 'compose.release.yaml', 'compose.yaml',
    'compose.production.yaml', 'compose.gateway.yaml', 'codex-seccomp.json'];
  for (const file of bundle) writeFileSync(join(stage, file), 'fixture\n');
  const digest = createHash('sha256').update('fixture\n').digest('hex');
  writeFileSync(join(stage, 'release.sha256'), bundle.map(file => `${digest}  ${file}\n`).join(''));
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.RELEASE_COMMAND_LOG, JSON.stringify(args) + '\\n');
const revision = process.env.TEST_RELEASE_REVISION;
if (args[0] === 'compose') {
  const ps = args.indexOf('ps');
  if (ps !== -1) console.log(args.at(-1));
} else if (args[0] === 'inspect' || (args[0] === 'image' && args[1] === 'inspect')) {
  const format = args[args.indexOf('--format') + 1];
  const service = args.at(-1);
  if (format.includes('.Os')) console.log('linux/amd64');
  else if (format === '{{.Image}}') console.log(process.env.TEST_IMAGE_ID || 'sha256:expected');
  else if (format === '{{.Id}}') console.log('sha256:expected');
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
  return { root, run(overrides = {}) {
    const result = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', timeout: 10_000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TEST_RELEASE_REVISION: REVISION,
        RELEASE_COMMAND_LOG: join(root, 'commands.jsonl'), ...overrides } });
    if (result.error) throw result.error;
    return { ...result, commands: readFileSync(join(root, 'commands.jsonl'), 'utf8') };
  }, cleanup() { rmSync(root, { recursive: true, force: true }); } };
}

test('duplicate healthy release skips recreation and preserves previous rollback selection', () => {
  const fixture = releaseFixture();
  try {
    const result = fixture.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /deployment already healthy.*skipping recreation/);
    assert.doesNotMatch(result.commands, /force-recreate/);
    assert.equal(readFileSync(join(fixture.root, '.runtime/release.env.previous'), 'utf8'), PREVIOUS_ENV);
    assert.equal(readFileSync(join(fixture.root, '.runtime/release.env'), 'utf8'), RELEASE_ENV);
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
    assert.equal(readFileSync(join(fixture.root, '.runtime/release.env.previous'), 'utf8'), PREVIOUS_ENV);
    assert.equal(readFileSync(join(fixture.root, '.runtime/release.env'), 'utf8'), RELEASE_ENV);
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
      assert.equal(readFileSync(join(fixture.root, '.runtime/release.env'), 'utf8'), PREVIOUS_ENV);
    } finally { fixture.cleanup(); }
  });
}
