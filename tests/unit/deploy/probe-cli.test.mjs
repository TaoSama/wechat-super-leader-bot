import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'scripts/deploy/transfer-release.mjs');
const REVISION = 'b'.repeat(40);
const SECRET = 'SYNTHETIC_PROBE_PRIVATE_VALUE';
const TIMEOUT_MS = 15_000;
const evidence = [];
const reply = (decision, reason) => JSON.stringify({ schema: 1, revision: REVISION, decision, reason });
const cases = [
  { name: 'healthy duplicate', stdout: reply('duplicate_skipped', 'healthy_receipt_match'),
    expectedStatus: 0, required: false, event: 'duplicate_skipped' },
  { name: 'deployment required', stdout: reply('deploy_required', 'missing_receipt'),
    expectedStatus: 0, required: true, event: 'deploy_required' },
  { name: 'SSH nonzero', stdout: '', stderr: SECRET, sshStatus: 255, expectedStatus: 1 },
  { name: 'invalid JSON', stdout: `${SECRET}{invalid`, expectedStatus: 1 },
  { name: 'manual dispatch', stdout: '', sshStatus: 255, manual: true,
    expectedStatus: 0, required: true, event: 'deploy_required', noSsh: true },
  { name: 'conflicting probe and diagnostic', stdout: '', diagnostic: true,
    expectedStatus: 1, noSsh: true },
];

async function readOptional(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function runFixture(scenario) {
  const directory = await mkdtemp(join(tmpdir(), 'probe-cli-test-'));
  let observation;
  try {
    const bin = join(directory, 'bin'), credentials = join(directory, 'credentials');
    const output = join(directory, 'github-output'), summary = join(directory, 'summary');
    const trace = join(directory, 'ssh-trace.json');
    await Promise.all([mkdir(bin), mkdir(credentials)]);
    const script = `#!${process.execPath}
const fs = require('node:fs');
process.stdin.resume();
process.stdin.on('end', () => {
  const args = process.argv.slice(2);
  const key = args[args.indexOf('-i') + 1];
  const knownHosts = args.find(value => value.startsWith('UserKnownHostsFile=')).split('=')[1];
  fs.writeFileSync(${JSON.stringify(trace)}, JSON.stringify({
    env_keys: Object.keys(process.env), key_present: fs.readFileSync(key, 'utf8') === ${JSON.stringify(`${SECRET}\n`)},
    key_mode: fs.statSync(key).mode & 0o777, known_hosts_mode: fs.statSync(knownHosts).mode & 0o777
  }));
  process.stdout.write(${JSON.stringify(scenario.stdout)});
  process.stderr.write(${JSON.stringify(scenario.stderr ?? '')});
  process.exitCode = ${scenario.sshStatus ?? 0};
});
`;
    await writeFile(join(bin, 'ssh'), script, { mode: 0o755, flag: 'wx' });
    const args = [CLI, '--probe', '--credentials-root', credentials,
      ...(scenario.diagnostic ? ['--diagnostic'] : [])];
    const env = { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME, TMPDIR: directory,
      DEPLOY_HOST: 'synthetic.invalid', DEPLOY_USER: 'fixture', DEPLOY_PORT: '22',
      DEPLOY_PATH: '/synthetic/app', DEPLOY_ENV_FILE: '.runtime/controller.env',
      DEPLOY_SSH_PRIVATE_KEY: SECRET, DEPLOY_KNOWN_HOSTS: 'synthetic.invalid ssh-ed25519 SYNTHETIC',
      GH_TOKEN: SECRET, SYNTHETIC_PROBE_SECRET: SECRET, REVISION,
      GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_EVENT_NAME: scenario.manual ? 'workflow_dispatch' : 'workflow_run',
      GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary };
    const started = Date.now();
    const result = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: 'utf8', timeout: TIMEOUT_MS });
    if (result.error) throw result.error;
    const captured = await readOptional(trace);
    observation = { case: scenario.name, command: [process.execPath, ...args],
      exit_status: result.status, signal: result.signal, elapsed_ms: Date.now() - started,
      stdout: result.stdout, stderr: result.stderr,
      github_output: await readOptional(output), step_summary: await readOptional(summary),
      ssh: captured ? JSON.parse(captured) : null,
      credential_entries_after_exit: await readdir(credentials),
      probe_temp_entries_after_exit: (await readdir(directory)).filter(name => name.startsWith('release-probe-')) };
  } finally { await rm(directory, { recursive: true, force: true }); }
  observation.fixture_removed = !await exists(directory);
  evidence.push(observation);
  return observation;
}

for (const scenario of cases) {
  test(`real probe CLI: ${scenario.name}`, async () => {
    const actual = await runFixture(scenario);
    assert.equal(actual.exit_status, scenario.expectedStatus, actual.stdout + actual.stderr);
    assert.equal(actual.signal, null);
    assert.equal(actual.github_output, scenario.required === undefined ? '' : `deploy_required=${scenario.required}\n`);
    assert.doesNotMatch(actual.stdout + actual.stderr + actual.step_summary, new RegExp(SECRET));
    assert.doesNotMatch(actual.stdout, /deployment_verified|activation_start|transfer_start|release_complete/);
    assert.deepEqual(actual.credential_entries_after_exit, [], 'temporary credentials are removed on success and failure');
    assert.deepEqual(actual.probe_temp_entries_after_exit, []);
    assert.equal(actual.fixture_removed, true);
    assert.match(actual.stdout, /"event":"credential_cleanup_state","cleanup":"confirmed"/);
    if (scenario.event) {
      assert.match(actual.stdout, new RegExp(`"event":"${scenario.event}"`));
      assert.match(actual.step_summary, new RegExp(scenario.event));
    } else {
      assert.match(actual.stderr, /"event":"command_failed"/);
      assert.equal(actual.step_summary, '');
    }
    if (scenario.noSsh) {
      assert.equal(actual.ssh, null, 'manual bypass and conflicting modes never execute SSH');
    } else {
      assert.equal(actual.ssh.key_present, true, 'the real CLI materializes credentials before SSH');
      assert.equal(actual.ssh.key_mode, 0o600);
      assert.equal(actual.ssh.known_hosts_mode, 0o600);
      assert.deepEqual(actual.ssh.env_keys.filter(key => /^(DEPLOY_|GH_TOKEN$|GITHUB_|SYNTHETIC_)/.test(key)), [],
        'the SSH subprocess cannot inherit deployment credentials or synthetic private environment');
    }
    if (scenario.manual) assert.match(actual.stdout, /"reason":"manual_rebuild"/);
    actual.assertions = 'passed';
  });
}

after(async () => {
  const path = process.env.PROBE_CLI_EVIDENCE_PATH;
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ schema: 1, recorded_at: new Date().toISOString(),
    verification: 'real node CLI with local fixed-response fake SSH; no production access',
    node: process.version, cases: evidence }, null, 2) + '\n');
});
