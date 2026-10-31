import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const MERGE_ATTEMPTS = 60;
const MERGE_INTERVAL_MS = 5_000;
const API_TIMEOUT_MS = 30_000;
const VERIFY_PATH = '.github/workflows/verify.yml';

export async function currentRevision(api, repository, branch) {
  const ref = await api(`/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`);
  if (!SHA_PATTERN.test(ref.object?.sha ?? '')) throw new Error('GitHub returned an invalid branch revision');
  return ref.object.sha;
}

export async function assertCurrentRevision(api, repository, branch, revision) {
  if (!SHA_PATTERN.test(revision)) throw new Error('Deployment revision must be a full commit SHA');
  const current = await currentRevision(api, repository, branch);
  if (current !== revision) throw new Error(`Refusing stale deployment ${revision}; ${branch} is ${current}`);
}

export async function resolveRevision({ eventName, event, ref, sha, repository, api,
  wait = delay, attempts = MERGE_ATTEMPTS, log = console.log }) {
  const metadata = await api(`/repos/${repository}`);
  const branch = metadata.default_branch;
  const skip = reason => { log(`deployment skipped: ${reason}`); return null; };
  if (metadata.full_name !== repository || branch !== 'main') throw new Error('Unexpected repository or default branch');

  if (eventName === 'workflow_dispatch') {
    if (ref !== `refs/heads/${branch}`) return skip('manual deployments require main');
    await assertCurrentRevision(api, repository, branch, sha);
    return sha;
  }
  const validRun = run => run.name === 'Verify' && run.path === VERIFY_PATH && run.event === 'pull_request' &&
    run.status === 'completed' && run.conclusion === 'success' &&
    run.repository?.id === metadata.id && run.head_repository?.id === metadata.id &&
    SHA_PATTERN.test(run.head_sha ?? '');
  const eligible = (pr, head) => SHA_PATTERN.test(head ?? '') &&
    pr.base?.repo?.id === metadata.id && pr.head?.repo?.id === metadata.id &&
    pr.base.ref === branch && pr.head.ref !== branch && pr.head.sha === head &&
    pr.user?.login?.toLowerCase() === metadata.owner.login.toLowerCase() && !pr.draft;
  let run;
  let related;
  // Re-read the run and PR through the API; never trust PR artifacts or checkout its head.
  if (eventName === 'workflow_run' && Number.isSafeInteger(event.workflow_run?.id)) {
    run = await api(`/repos/${repository}/actions/runs/${event.workflow_run.id}`);
    if (!validRun(run)) return skip('run is not a successful same-repository PR Verify');
    // GitHub can omit pull_requests from a workflow_run after the PR has merged.
    related = await api(`/repos/${repository}/commits/${run.head_sha}/pulls?per_page=100`);
  } else if (eventName === 'pull_request_target' && Number.isSafeInteger(event.pull_request?.number)) {
    const pr = await api(`/repos/${repository}/pulls/${event.pull_request.number}`);
    if (!pr.merged || !eligible(pr, pr.head?.sha)) return skip('closed PR is not an eligible merged main PR');
    const runs = await api(`/repos/${repository}/actions/workflows/verify.yml/runs?event=pull_request&head_sha=${pr.head.sha}&status=success&per_page=100`);
    run = runs.workflow_runs.find(candidate => validRun(candidate) && candidate.head_sha === pr.head.sha);
    if (!run) return skip('merged PR has no successful Verify for its current head');
    related = [pr];
  } else {
    return skip('not a verification completion or merged PR event');
  }
  const candidates = related.filter(pr => eligible(pr, run.head_sha));
  if (candidates.length !== 1) return skip('no unique eligible PR for the verified head');

  for (let attempt = 0; attempt < attempts; attempt++) {
    const pr = await api(`/repos/${repository}/pulls/${candidates[0].number}`);
    if (!eligible(pr, run.head_sha)) return skip('PR head, source, author or target changed after verification');
    if (pr.merged === true) {
      if (!SHA_PATTERN.test(pr.merge_commit_sha ?? '')) throw new Error('Merged PR has no valid merge revision');
      const current = await currentRevision(api, repository, branch);
      if (current !== pr.merge_commit_sha) return skip(`merged revision ${pr.merge_commit_sha} is superseded by ${current}`);
      log(`verified run=${run.id} PR=${pr.number} head=${run.head_sha} merge=${pr.merge_commit_sha}`);
      return pr.merge_commit_sha;
    }
    if (pr.state !== 'open' || !pr.auto_merge) return skip('PR is not merged or awaiting automatic merge');
    if (attempt + 1 < attempts) {
      log(`waiting for PR #${pr.number} automatic merge (${attempt + 1}/${attempts})`);
      await wait(MERGE_INTERVAL_MS);
    }
  }
  throw new Error('Timed out waiting for the verified PR to merge; no deployment was started');
}

export async function githubApi(path) {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error('GH_TOKEN is required');
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28' },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub API ${path}: HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const { values } = parseArgs({ options: {
    'assert-current': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/deploy/resolve-revision.mjs [--assert-current SHA] [-h|--help]\n' +
      'Resolve a verified merged PR from the GitHub Actions environment, or reject a stale deployment.');
    return;
  }
  const repository = process.env.GITHUB_REPOSITORY;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '')) throw new Error('GITHUB_REPOSITORY is invalid');
  if (values['assert-current']) {
    await assertCurrentRevision(githubApi, repository, 'main', values['assert-current']);
    return;
  }
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const revision = await resolveRevision({ eventName: process.env.GITHUB_EVENT_NAME, event,
    ref: process.env.GITHUB_REF, sha: process.env.GITHUB_SHA, repository, api: githubApi });
  if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
  appendFileSync(process.env.GITHUB_OUTPUT, `revision=${revision ?? ''}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
