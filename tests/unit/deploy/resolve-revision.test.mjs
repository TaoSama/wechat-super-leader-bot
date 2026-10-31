import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCurrentRevision, resolveRevision } from '../../../scripts/deploy/resolve-revision.mjs';

const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const NEWER = 'c'.repeat(40);
const REPOSITORY = 'owner/repo';
const ROOT = `/repos/${REPOSITORY}`;

function fixture() {
  const metadata = { id: 1, full_name: REPOSITORY, default_branch: 'main', owner: { login: 'owner' } };
  const run = { id: 123, name: 'Verify', path: '.github/workflows/verify.yml', event: 'pull_request',
    status: 'completed', conclusion: 'success', head_sha: HEAD, repository: { id: 1 },
    head_repository: { id: 1 }, pull_requests: [] };
  const pr = { number: 73, state: 'closed', merged: true, merge_commit_sha: MERGE, draft: false,
    user: { login: 'owner' }, base: { ref: 'main', repo: { id: 1 } },
    head: { ref: 'codex/release', sha: HEAD, repo: { id: 1 } } };
  const state = { metadata, run, pr, current: MERGE, reads: 0, waits: 0, logs: [] };
  const api = async path => {
    if (path === ROOT) return structuredClone(state.metadata);
    if (path === `${ROOT}/actions/runs/123`) return structuredClone(state.run);
    if (path === `${ROOT}/commits/${HEAD}/pulls?per_page=100`) return [structuredClone(state.pr)];
    if (path === `${ROOT}/actions/workflows/verify.yml/runs?event=pull_request&head_sha=${HEAD}&status=success&per_page=100`) {
      return { workflow_runs: [structuredClone(state.run)] };
    }
    if (path === `${ROOT}/pulls/73`) { state.reads++; return structuredClone(state.pr); }
    if (path === `${ROOT}/git/ref/heads/main`) return { object: { sha: state.current } };
    throw new Error(`Unexpected API request ${path}`);
  };
  const options = { eventName: 'workflow_run', event: { workflow_run: { id: 123 } },
    repository: REPOSITORY, api, wait: async () => { state.waits++; }, attempts: 3,
    log: message => state.logs.push(message) };
  return { state, api, options };
}

test('successful PR Verify resolves its actual merged SHA even without event PR metadata', async () => {
  const { options, state } = fixture();
  assert.equal(await resolveRevision(options), MERGE);
  assert.equal(state.reads, 1);
  assert.match(state.logs.join('\n'), /run=123 PR=73.*merge=/);
});

test('Verify completion before automatic merge waits and then resolves', async () => {
  const { options, state } = fixture();
  Object.assign(state.pr, { state: 'open', merged: false, auto_merge: { merge_method: 'squash' } });
  options.wait = async () => {
    state.waits++;
    Object.assign(state.pr, { state: 'closed', merged: true, auto_merge: null });
  };
  assert.equal(await resolveRevision(options), MERGE);
  assert.equal(state.waits, 1);
  assert.equal(state.reads, 2);
});

test('manual merge hours after successful CI still deploys through the closed event', async () => {
  const { options, state } = fixture();
  Object.assign(state.pr, { state: 'open', merged: false });
  assert.equal(await resolveRevision(options), null);
  Object.assign(state.pr, { state: 'closed', merged: true });
  Object.assign(options, { eventName: 'pull_request_target', event: { pull_request: { number: 73 } } });
  assert.equal(await resolveRevision(options), MERGE);
  assert.equal(state.waits, 0);
});

test('closed PR event still requires successful Verify and an actual merged PR', async () => {
  const { options, state } = fixture();
  Object.assign(options, { eventName: 'pull_request_target', event: { pull_request: { number: 73 } } });
  state.run.conclusion = 'failure';
  assert.equal(await resolveRevision(options), null);
  state.run.conclusion = 'success';
  state.pr.merged = false;
  assert.equal(await resolveRevision(options), null);
});

test('automatic merge timeout fails explicitly without selecting a revision', async () => {
  const { options, state } = fixture();
  Object.assign(state.pr, { state: 'open', merged: false, auto_merge: {} });
  await assert.rejects(resolveRevision(options), /Timed out.*no deployment/);
  assert.equal(state.waits, 2);
  assert.equal(state.reads, 3);
});

const rejected = {
  'failed CI': s => { s.run.conclusion = 'failure'; },
  'cancelled CI': s => { s.run.conclusion = 'cancelled'; },
  'incomplete CI': s => { s.run.status = 'in_progress'; },
  'unrelated workflow': s => { s.run.path = '.github/workflows/other.yml'; },
  'push CI': s => { s.run.event = 'push'; },
  'external source repository': s => { s.run.head_repository.id = 2; },
  'external run repository': s => { s.run.repository.id = 2; },
  'fork PR': s => { s.pr.head.repo.id = 2; },
  'foreign target repository': s => { s.pr.base.repo.id = 2; },
  'non-main target': s => { s.pr.base.ref = 'release'; },
  'non-owner PR': s => { s.pr.user.login = 'contributor'; },
  'draft PR': s => { s.pr.draft = true; },
  'old CI head': s => { s.pr.head.sha = NEWER; },
  'closed unmerged PR': s => { s.pr.merged = false; },
  'unmerged PR without auto merge': s => { s.pr.state = 'open'; s.pr.merged = false; },
  'superseded merge': s => { s.current = NEWER; },
};
for (const [name, mutate] of Object.entries(rejected)) {
  test(`${name} cannot select a deployment revision`, async () => {
    const { state, options } = fixture();
    mutate(state);
    assert.equal(await resolveRevision(options), null);
    assert.equal(state.waits, 0);
    assert.match(state.logs.join('\n'), /deployment skipped:/);
  });
}

test('head update while waiting for merge prevents deployment', async () => {
  const { options, state } = fixture();
  Object.assign(state.pr, { state: 'open', merged: false, auto_merge: {} });
  options.wait = async () => { state.pr.head.sha = NEWER; };
  assert.equal(await resolveRevision(options), null);
});

test('API errors and invalid merge revisions fail closed', async () => {
  const { options, state } = fixture();
  await assert.rejects(resolveRevision({ ...options, api: async () => { throw new Error('HTTP 403'); } }), /HTTP 403/);
  state.pr.merge_commit_sha = 'invalid';
  await assert.rejects(resolveRevision(options), /no valid merge revision/);
});

test('manual dispatch is limited to the current main revision', async () => {
  const { options } = fixture();
  Object.assign(options, { eventName: 'workflow_dispatch', ref: 'refs/heads/main', sha: MERGE });
  assert.equal(await resolveRevision(options), MERGE);
  assert.equal(await resolveRevision({ ...options, ref: 'refs/heads/codex/release' }), null);
  await assert.rejects(resolveRevision({ ...options, sha: HEAD }), /Refusing stale deployment/);
});

test('main advancing during queue, build or transfer rejects activation', async () => {
  const { options, state, api } = fixture();
  const selected = await resolveRevision(options);
  state.current = NEWER;
  await assert.rejects(assertCurrentRevision(api, REPOSITORY, 'main', selected), /Refusing stale deployment/);
});

test('duplicate workflow completions resolve the same immutable merged revision', async () => {
  const { options } = fixture();
  assert.deepEqual(await Promise.all([resolveRevision(options), resolveRevision(options)]), [MERGE, MERGE]);
});
