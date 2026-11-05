import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRevision } from '../../../scripts/deploy/resolve-revision.mjs';
import { probeRelease } from '../../../scripts/deploy/probe-release.mjs';

const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const PREVIOUS = 'c'.repeat(40);
const FINGERPRINT = 'd'.repeat(64);
const REPOSITORY = 'owner/repo';
const ROOT = `/repos/${REPOSITORY}`;
const RUN_ID = 123;
const PR_NUMBER = 94;
const EVENTS = ['workflow_run', 'pull_request_target'];
const NO_DEPLOYMENTS = { build: 0, transfer: 0, activate: 0 };
const CONFIG = {
  key: '/synthetic/deploy-key', knownHosts: '/synthetic/known-hosts',
  host: 'synthetic.invalid', user: 'deployer', port: 22,
  path: '/synthetic/app', revision: MERGE, envFile: '/synthetic/app/.env',
};

function fixture() {
  const metadata = { id: 1, full_name: REPOSITORY, default_branch: 'main', owner: { login: 'owner' } };
  const run = { id: RUN_ID, name: 'Verify', path: '.github/workflows/verify.yml',
    event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: HEAD,
    repository: { id: 1 }, head_repository: { id: 1 }, pull_requests: [] };
  const pr = { number: PR_NUMBER, state: 'closed', merged: true, merge_commit_sha: MERGE,
    draft: false, user: { login: 'owner' }, base: { ref: 'main', repo: { id: 1 } },
    head: { ref: 'fix/production-idempotency', sha: HEAD, repo: { id: 1 } } };
  const state = { current: MERGE, deployed: PREVIOUS, healthy: true,
    counters: { ...NO_DEPLOYMENTS }, commands: [], resolutions: [], probes: [],
    response: undefined, sshError: null, failActivation: false };
  const api = async path => {
    if (path === ROOT) return structuredClone(metadata);
    if (path === `${ROOT}/actions/runs/${RUN_ID}`) return structuredClone(run);
    if (path === `${ROOT}/commits/${HEAD}/pulls?per_page=100`) return [structuredClone(pr)];
    if (path === `${ROOT}/actions/workflows/verify.yml/runs?event=pull_request&head_sha=${HEAD}&status=success&per_page=100`) {
      return { workflow_runs: [structuredClone(run)] };
    }
    if (path === `${ROOT}/pulls/${PR_NUMBER}`) return structuredClone(pr);
    if (path === `${ROOT}/git/ref/heads/main`) return { object: { sha: state.current } };
    throw new Error(`Unexpected GitHub API request: ${path}`);
  };
  const processes = { async checked(command, args, options = {}) {
    state.commands.push({ command, args, options });
    if (command === 'python3') {
      assert.ok(args.includes('fingerprint'), 'only the local fingerprint helper may execute');
      assert.ok(args.includes('--bundle-dir'));
      return { stdout: `${FINGERPRINT}\n` };
    }
    assert.equal(command, 'ssh', 'all external commands are intercepted; no production process runs');
    assert.ok(Number.isFinite(options.timeoutMs) && options.timeoutMs > 0, 'SSH probe must have a bounded timeout');
    if (state.sshError) throw state.sshError;
    const duplicate = state.deployed === MERGE && state.healthy;
    const response = state.response ?? {
      schema: 1, revision: MERGE,
      decision: duplicate ? 'duplicate_skipped' : 'deploy_required',
      reason: duplicate ? 'healthy_same_revision' : 'release_not_current',
    };
    return { stdout: typeof response === 'string' ? response : JSON.stringify(response) };
  } };
  async function deliver(eventName, { force = false } = {}) {
    const event = eventName === 'workflow_run'
      ? { workflow_run: { id: RUN_ID } }
      : { pull_request: { number: PR_NUMBER } };
    const revision = await resolveRevision({ eventName, event, ref: 'refs/heads/main', sha: MERGE,
      repository: REPOSITORY, api,
      attempts: 1, wait: async () => assert.fail('already merged PRs do not wait'), log: () => {} });
    state.resolutions.push({ eventName, revision });
    if (!revision) return 'unresolved';
    const result = await probeRelease({ ...CONFIG, revision, force }, { processes, log: () => {} });
    state.probes.push(result);
    if (result.decision === 'duplicate_skipped') return result.decision;
    assert.equal(result.decision, 'deploy_required');
    state.counters.build++;
    state.counters.transfer++;
    state.counters.activate++;
    if (state.failActivation) throw new Error('synthetic activation failed');
    state.deployed = revision;
    state.healthy = true;
    return 'deployed';
  }
  return { state, deliver };
}

for (const order of [EVENTS, [...EVENTS].reverse()]) {
  test(`${order.join(' then ')} resolves the actual merge twice but builds, transfers and activates once`, async () => {
    const { state, deliver } = fixture();
    assert.equal(await deliver(order[0]), 'deployed');
    assert.equal(await deliver(order[1]), 'duplicate_skipped');
    assert.deepEqual(state.resolutions, order.map(eventName => ({ eventName, revision: MERGE })));
    assert.notEqual(MERGE, HEAD, 'the deployment identity is the actual merge, not the PR head');
    assert.deepEqual(state.probes.map(value => value.decision), ['deploy_required', 'duplicate_skipped']);
    assert.deepEqual(state.counters, { build: 1, transfer: 1, activate: 1 });
    assert.equal(state.commands.filter(value => value.command === 'ssh').length, 2,
      'the queued second event must observe production after the first event finishes');
  });
}

test('the second natural event retries when the first activation failed and production stayed on the previous revision', async () => {
  const { state, deliver } = fixture();
  state.failActivation = true;
  await assert.rejects(deliver(EVENTS[0]), /synthetic activation failed/);
  assert.equal(state.deployed, PREVIOUS);
  state.failActivation = false;
  assert.equal(await deliver(EVENTS[1]), 'deployed');
  assert.deepEqual(state.probes.map(value => value.decision), ['deploy_required', 'deploy_required']);
  assert.deepEqual(state.counters, { build: 2, transfer: 2, activate: 2 });
});

test('both natural events skip every deployment stage when production already runs the healthy merge revision', async () => {
  const { state, deliver } = fixture();
  state.deployed = MERGE;
  for (const eventName of EVENTS) assert.equal(await deliver(eventName), 'duplicate_skipped');
  assert.deepEqual(state.counters, NO_DEPLOYMENTS);
});

test('the same revision without healthy production remains eligible for repair', async () => {
  const { state, deliver } = fixture();
  state.deployed = MERGE;
  state.healthy = false;
  assert.equal(await deliver(EVENTS[0]), 'deployed');
  assert.equal(await deliver(EVENTS[1]), 'duplicate_skipped');
  assert.deepEqual(state.counters, { build: 1, transfer: 1, activate: 1 });
});

test('an explicit manual rebuild bypasses the production probe even for an already healthy merge', async () => {
  const { state, deliver } = fixture();
  state.deployed = MERGE;
  state.sshError = new Error('the manual override must not attempt SSH');
  assert.equal(await deliver('workflow_dispatch', { force: true }), 'deployed');
  assert.deepEqual(state.resolutions, [{ eventName: 'workflow_dispatch', revision: MERGE }]);
  assert.equal(state.probes[0].decision, 'deploy_required');
  assert.equal(state.probes[0].reason, 'manual_rebuild');
  assert.deepEqual(state.commands, []);
  assert.deepEqual(state.counters, { build: 1, transfer: 1, activate: 1 });
});

for (const [name, response] of [
  ['a response for a different revision', { schema: 1, revision: PREVIOUS, decision: 'duplicate_skipped', reason: 'healthy_same_revision' }],
  ['malformed JSON', '{broken'],
  ['an unsupported response schema', { schema: 2, revision: MERGE, decision: 'duplicate_skipped', reason: 'healthy_same_revision' }],
  ['an unknown decision', { schema: 1, revision: MERGE, decision: 'unknown', reason: 'unknown' }],
]) {
  test(`${name} cannot skip or start any deployment stage`, async () => {
    const { state, deliver } = fixture();
    state.response = response;
    await assert.rejects(deliver(EVENTS[0]));
    assert.deepEqual(state.counters, NO_DEPLOYMENTS);
    assert.equal(state.probes.length, 0, 'invalid observations cannot become accepted deployment decisions');
  });
}

test('an SSH failure blocks build, transfer and activation instead of guessing whether production is current', async () => {
  const { state, deliver } = fixture();
  state.sshError = new Error('synthetic SSH timeout');
  await assert.rejects(deliver(EVENTS[0]), /synthetic SSH timeout/);
  assert.deepEqual(state.counters, NO_DEPLOYMENTS);
});

test('a superseded merge is rejected before the production probe and every deployment stage', async () => {
  const { state, deliver } = fixture();
  state.current = PREVIOUS;
  for (const eventName of EVENTS) assert.equal(await deliver(eventName), 'unresolved');
  assert.deepEqual(state.commands, []);
  assert.deepEqual(state.counters, NO_DEPLOYMENTS);
});
