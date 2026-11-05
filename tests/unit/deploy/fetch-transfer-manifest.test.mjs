import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { RELEASE_FILES } from '../../../scripts/deploy/transfer-files.mjs';
import { MANIFEST_FILENAME, MANIFEST_MAX_BYTES } from '../../../scripts/deploy/transfer-manifest.mjs';
import { ARTIFACT_MAX_BYTES, extractManifestArchive,
  fetchTransferManifest } from '../../../scripts/deploy/fetch-transfer-manifest.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'scripts/deploy/fetch-transfer-manifest.mjs');
const REPOSITORY = 'owner/repo', REVISION = 'a'.repeat(40), HEAD = 'b'.repeat(40);
const RUN = 123, ATTEMPT = 2, JOB = 789, ARTIFACT = 456;
const INPUT = { repository: REPOSITORY, revision: REVISION, runId: RUN, attempt: ATTEMPT, jobId: JOB };
const BASE = `/repos/${REPOSITORY}/actions`;
const NAME = `release-transfer-manifest-${REVISION}-${RUN}-${ATTEMPT}`;
const STARTED = '2026-11-03T00:00:00Z', CREATED = '2026-11-03T00:00:10Z';
const NOW = Date.parse('2026-11-03T00:01:30Z'), EXPIRES = '2026-11-04T00:00:00Z';
const JOB_NAME = 'Build and deploy linux/amd64 images';
const SECRET = 'SYNTHETIC_PRIVATE_GITHUB_TOKEN';
const sha256 = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;

function wire(names = RELEASE_FILES) {
  const files = names.map((name, index) => ({ name, bytes: index + 1, sha256: 'c'.repeat(64) }));
  return { schema: 1, revision: REVISION, run_id: RUN, attempt: ATTEMPT,
    files, total_bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}

function zip(entries = [{ name: MANIFEST_FILENAME, content: JSON.stringify(wire()) }], compression = 'deflated') {
  const source = `import io,json,stat,sys,warnings,zipfile
warnings.simplefilter('ignore', UserWarning)
value=json.load(sys.stdin); output=io.BytesIO()
with zipfile.ZipFile(output,'w') as archive:
 for entry in value['entries']:
  info=zipfile.ZipInfo(entry['name']); info.create_system=3
  info.external_attr=entry.get('mode',stat.S_IFREG|0o600)<<16
  info.compress_type=zipfile.ZIP_DEFLATED if value['compression']=='deflated' else zipfile.ZIP_STORED
  archive.writestr(info,entry['content'].encode('utf-8'))
sys.stdout.buffer.write(output.getvalue())
`;
  const result = spawnSync('python3', ['-B', '-c', source], {
    input: JSON.stringify({ entries, compression }), timeout: 5_000, maxBuffer: 2 * 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
}

const VALID_ZIP = zip();

function fixture() {
  const job = { id: JOB, run_id: RUN, run_attempt: ATTEMPT, name: JOB_NAME,
    status: 'in_progress', started_at: STARTED, completed_at: null };
  const artifact = { id: ARTIFACT, name: NAME, expired: false, created_at: CREATED, expires_at: EXPIRES,
    size_in_bytes: VALID_ZIP.length, digest: sha256(VALID_ZIP),
    workflow_run: { id: RUN, repository_id: 1, head_repository_id: 1, head_sha: HEAD } };
  const state = { run: { id: RUN, run_attempt: ATTEMPT, path: '.github/workflows/deploy-production.yml',
    status: 'in_progress', head_sha: HEAD, repository: { id: 1, full_name: REPOSITORY }, head_repository: { id: 1 } },
  jobs: { total_count: 1, jobs: [structuredClone(job)] }, job,
  artifacts: { total_count: 1, artifacts: [structuredClone(artifact)] }, artifact,
  manifest: wire(), archive: VALID_ZIP, calls: [] };
  const routes = new Map([
    [`${BASE}/runs/${RUN}`, 'run'],
    [`${BASE}/runs/${RUN}/attempts/${ATTEMPT}/jobs?per_page=100`, 'jobs'],
    [`${BASE}/jobs/${JOB}`, 'job'],
    [`${BASE}/runs/${RUN}/artifacts?per_page=100`, 'artifacts'],
    [`${BASE}/artifacts/${ARTIFACT}`, 'artifact'],
  ]);
  const options = {
    api: async path => {
      state.calls.push(['api', path]);
      assert.ok(routes.has(path), `Unexpected API request ${path}`);
      return structuredClone(state[routes.get(path)]);
    },
    download: async id => { state.calls.push(['download', id]); return state.archive; },
    extract: async archive => {
      state.calls.push(['extract']);
      assert.equal(archive, state.archive);
      return structuredClone(state.manifest);
    },
    now: () => NOW,
  };
  return { state, options };
}

async function rejectsFixture(mutate, { beforeDownload = false, beforeExtract = false } = {}) {
  const f = fixture();
  mutate(f.state);
  await assert.rejects(fetchTransferManifest(INPUT, f.options), error => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(SECRET));
    return true;
  });
  if (beforeDownload) assert.ok(!f.state.calls.some(([type]) => type === 'download'));
  if (beforeExtract) assert.ok(!f.state.calls.some(([type]) => type === 'extract'));
}

test('reader binds the actual deployment job and artifact while preserving M independently of head_sha', async () => {
  const { state, options } = fixture();
  state.jobs.jobs[0].started_at = '2026-11-02T23:59:00Z';
  state.artifacts.artifacts.unshift({ id: 999, name: 'unrelated-artifact' });
  state.artifacts.total_count++;
  const result = await fetchTransferManifest(INPUT, options);
  assert.deepEqual(result, { manifest: wire(), job_started_at: STARTED, job_id: JOB,
    artifact_id: ARTIFACT, artifact_name: NAME });
  assert.ok(Object.isFrozen(result.manifest) && result.manifest.files.every(Object.isFrozen));
  assert.notEqual(result.manifest.revision, state.run.head_sha);
  assert.deepEqual(state.calls.filter(([type]) => type === 'download'), [['download', ARTIFACT]]);
  assert.ok(state.calls.some(([type, path]) => type === 'api' && path === `${BASE}/jobs/${JOB}`));
});

test('completed jobs accept only an artifact created within their own start and completion interval', async () => {
  const { state, options } = fixture();
  state.run.status = 'completed';
  Object.assign(state.job, { status: 'completed', completed_at: '2026-11-03T00:00:20Z' });
  assert.equal((await fetchTransferManifest(INPUT, options)).job_started_at, STARTED);
});

test('one complete page of exactly 100 jobs and artifacts remains eligible', async () => {
  const { state, options } = fixture();
  for (let index = 0; index < 99; index++) {
    state.jobs.jobs.push({ id: 1000 + index, name: `unrelated job ${index}` });
    state.artifacts.artifacts.push({ id: 1000 + index, name: `unrelated artifact ${index}` });
  }
  state.jobs.total_count = state.jobs.jobs.length;
  state.artifacts.total_count = state.artifacts.artifacts.length;
  assert.equal((await fetchTransferManifest(INPUT, options)).artifact_id, ARTIFACT);
});

for (const [name, patch] of [
  ['invalid repository', { repository: `owner/${SECRET}/extra` }],
  ['branch revision', { revision: 'main' }], ['uppercase revision', { revision: 'A'.repeat(40) }],
  ['zero run', { runId: 0 }], ['unsafe run', { runId: Number.MAX_SAFE_INTEGER + 1 }],
  ['fractional attempt', { attempt: 1.5 }], ['zero job', { jobId: 0 }],
  ['unsafe job', { jobId: Number.MAX_SAFE_INTEGER + 1 }],
]) {
  test(`reader rejects ${name} before GitHub or helper access`, async () => {
    const { state, options } = fixture();
    await assert.rejects(fetchTransferManifest({ ...INPUT, ...patch }, options));
    assert.deepEqual(state.calls, []);
  });
}

for (const [name, mutate] of [
  ['wrong current run', s => { s.run.id++; }],
  ['superseded run attempt', s => { s.run.run_attempt++; }],
  ['different repository', s => { s.run.repository.full_name = 'other/repo'; }],
  ['fork source', s => { s.run.head_repository.id++; }],
  ['different workflow', s => { s.run.path = '.github/workflows/verify.yml'; }],
  ['queued workflow', s => { s.run.status = 'queued'; }],
  ['missing deployment job', s => { s.jobs.jobs[0].name = 'Verify'; }],
  ['wrong listed job ID', s => { s.jobs.jobs[0].id++; }],
  ['ambiguous job name', s => { s.jobs.jobs.push({ ...s.jobs.jobs[0], id: JOB + 1 }); s.jobs.total_count++; }],
  ['truncated jobs page', s => { s.jobs.total_count = 101; }],
  ['cross-run independent job', s => { s.job.run_id++; }],
  ['cross-attempt independent job', s => { s.job.run_attempt++; }],
  ['wrong independent job ID', s => { s.job.id++; }],
  ['different independent job name', s => { s.job.name = 'Verify'; }],
  ['missing job start', s => { s.job.started_at = null; }],
  ['invalid job start', s => { s.job.started_at = SECRET; }],
  ['future job start', s => { s.job.started_at = new Date(NOW + 1_000).toISOString(); }],
  ['completed job without completion time', s => { s.job.status = 'completed'; s.job.completed_at = null; }],
  ['completion before job start', s => { Object.assign(s.job, { status: 'completed', completed_at: '2026-11-02T23:59:59Z' }); }],
  ['future job completion', s => { Object.assign(s.job, { status: 'completed', completed_at: new Date(NOW + 1_000).toISOString() }); }],
]) {
  test(`reader rejects ${name} without downloading an archive`, () => rejectsFixture(mutate, { beforeDownload: true }));
}

for (const [name, mutate] of [
  ['missing manifest artifact', s => { s.artifacts.artifacts = []; s.artifacts.total_count = 0; }],
  ['cross-revision artifact name', s => { s.artifacts.artifacts[0].name = NAME.replace(REVISION, HEAD); }],
  ['ambiguous artifact name', s => { s.artifacts.artifacts.push({ ...s.artifact, id: ARTIFACT + 1 }); s.artifacts.total_count++; }],
  ['truncated artifact page', s => { s.artifacts.total_count = 101; }],
  ['overlong artifact page', s => { s.artifacts.artifacts = Array(101).fill(s.artifact); s.artifacts.total_count = 101; }],
  ['wrong artifact metadata ID', s => { s.artifact.id++; }],
  ['wrong artifact metadata name', s => { s.artifact.name = NAME.replace('-2', '-3'); }],
  ['expired metadata', s => { s.artifact.expired = true; }],
  ['elapsed expiry', s => { s.artifact.expires_at = '2026-11-03T00:01:29Z'; }],
  ['expiry exactly now', s => { s.artifact.expires_at = new Date(NOW).toISOString(); }],
  ['cross-run artifact', s => { s.artifact.workflow_run.id++; }],
  ['foreign artifact repository', s => { s.artifact.workflow_run.repository_id++; }],
  ['foreign artifact head repository', s => { s.artifact.workflow_run.head_repository_id++; }],
  ['artifact predating the job', s => { s.artifact.created_at = '2026-11-02T23:59:59Z'; }],
  ['artifact after job completion', s => { Object.assign(s.job, { status: 'completed', completed_at: '2026-11-03T00:00:09Z' }); }],
  ['future artifact creation', s => { s.artifact.created_at = new Date(NOW + 1_000).toISOString(); }],
  ['invalid artifact timestamp', s => { s.artifact.created_at = SECRET; }],
  ['oversized archive metadata', s => { s.artifact.size_in_bytes = ARTIFACT_MAX_BYTES + 1; }],
  ['zero archive metadata', s => { s.artifact.size_in_bytes = 0; }],
  ['non-SHA256 digest', s => { s.artifact.digest = 'md5:' + 'a'.repeat(32); }],
  ['malformed SHA256 digest', s => { s.artifact.digest = 'sha256:' + SECRET; }],
]) {
  test(`reader rejects ${name} before download`, () => rejectsFixture(mutate, { beforeDownload: true }));
}

test('reader checks the downloaded digest before passing data to an extractor', () => rejectsFixture(s => {
  s.artifact.digest = 'sha256:' + '0'.repeat(64);
}, { beforeExtract: true }));

test('an artifact that expires during download cannot be returned as verified evidence', async () => {
  const { state, options } = fixture();
  let clock = NOW;
  const download = options.download;
  options.now = () => clock;
  options.download = async id => { const archive = await download(id); clock = Date.parse(EXPIRES); return archive; };
  await assert.rejects(fetchTransferManifest(INPUT, options), { category: 'artifact_identity' });
  assert.ok(state.calls.some(([type]) => type === 'download'));
});

test('digest is optional when GitHub does not expose it, including legacy null metadata', async () => {
  for (const digest of [undefined, null]) {
    const { state, options } = fixture();
    state.artifact.digest = digest;
    assert.deepEqual((await fetchTransferManifest(INPUT, options)).manifest, wire());
  }
});

for (const [name, archive] of [['oversized', Buffer.alloc(64 * 1024 + 1)], ['empty', Buffer.alloc(0)], ['non-Buffer', SECRET]]) {
  test(`reader rejects ${name} download before extraction`, () => rejectsFixture(s => {
    s.archive = archive; delete s.artifact.digest;
  }, { beforeExtract: true }));
}

for (const [name, mutate] of [
  ['wrong schema', value => { value.schema = 2; }], ['HEAD substituted for M', value => { value.revision = HEAD; }],
  ['different run', value => { value.run_id++; }], ['different attempt', value => { value.attempt++; }],
  ['unknown filename', value => { value.files[0].name = '../controller.tar'; }],
  ['duplicate filename', value => { value.files[1].name = value.files[0].name; }],
  ['missing hash', value => { delete value.files[0].sha256; }],
  ['unsafe size', value => { value.files[0].bytes = Number.MAX_SAFE_INTEGER + 1; }],
  ['incorrect total', value => { value.total_bytes--; }],
  ['additional private field', value => { value.private = SECRET; }],
]) {
  test(`downloaded manifest cannot bypass shared validation: ${name}`, () => rejectsFixture(s => mutate(s.manifest)));
}

test('the default real Python ZIP reader preserves the complete current manifest', async () => {
  const f = fixture();
  delete f.options.extract;
  assert.deepEqual((await fetchTransferManifest(INPUT, f.options)).manifest, wire());
  const padded = JSON.stringify(wire()).padEnd(MANIFEST_MAX_BYTES, ' ');
  assert.deepEqual(await extractManifestArchive(zip([{ name: MANIFEST_FILENAME, content: padded }])), wire());
});

test('the reader preserves a historical artifact without requiring the new receipt helper', async () => {
  const f = fixture();
  const historical = wire(['controller.tar', 'gateway.tar', 'release.sha256', 'manifest.env',
    'compose.release.yaml', 'compose.yaml', 'compose.production.yaml', 'compose.gateway.yaml',
    'codex-seccomp.json', 'remote-release.sh']);
  f.state.archive = zip([{ name: MANIFEST_FILENAME, content: JSON.stringify(historical) }]);
  f.state.artifact.size_in_bytes = f.state.archive.length;
  f.state.artifact.digest = sha256(f.state.archive);
  delete f.options.extract;
  assert.deepEqual((await fetchTransferManifest(INPUT, f.options)).manifest, historical);
});

test('historical artifact compatibility rejects an incomplete old file set', () => rejectsFixture(state => {
  state.manifest.files = state.manifest.files.filter(file => file.name !== 'remote-release.sh');
  state.manifest.total_bytes = state.manifest.files.reduce((sum, file) => sum + file.bytes, 0);
}));

const badArchives = [
  ['empty ZIP', () => zip([])],
  ['duplicate fixed entries', () => zip(Array(2).fill({ name: MANIFEST_FILENAME, content: JSON.stringify(wire()) }))],
  ['additional entry', () => zip([{ name: MANIFEST_FILENAME, content: JSON.stringify(wire()) }, { name: 'extra', content: '' }])],
  ['traversal path', () => zip([{ name: `../${MANIFEST_FILENAME}`, content: JSON.stringify(wire()) }])],
  ['nested path', () => zip([{ name: `nested/${MANIFEST_FILENAME}`, content: JSON.stringify(wire()) }])],
  ['absolute path', () => zip([{ name: `/tmp/${MANIFEST_FILENAME}`, content: JSON.stringify(wire()) }])],
  ['directory', () => zip([{ name: `${MANIFEST_FILENAME}/`, content: '' }])],
  ['symbolic link', () => zip([{ name: MANIFEST_FILENAME, content: JSON.stringify(wire()), mode: 0o120777 }])],
  ['oversized decoded manifest', () => zip([{ name: MANIFEST_FILENAME, content: JSON.stringify(wire()).padEnd(MANIFEST_MAX_BYTES + 1, ' ') }])],
  ['one-MiB compressed bomb', () => zip([{ name: MANIFEST_FILENAME, content: 'x'.repeat(1024 * 1024) }])],
  ['malformed JSON', () => zip([{ name: MANIFEST_FILENAME, content: SECRET }])],
  ['truncated ZIP', () => VALID_ZIP.subarray(0, VALID_ZIP.length - 10)],
  ['arbitrary raw text', () => Buffer.from(SECRET)],
  ['CRC corruption', () => {
    const archive = zip(undefined, 'stored'), index = archive.indexOf(Buffer.from('"schema":1'));
    assert.ok(index >= 0); archive[index + 9] ^= 1; return archive;
  }],
];
for (const [name, makeArchive] of badArchives) {
  test(`real ZIP extraction rejects ${name} without exposing archive content`, { timeout: 10_000 }, async () => {
    const archive = makeArchive();
    assert.ok(archive.length < ARTIFACT_MAX_BYTES, 'fixture must exercise extraction rather than only the ZIP length cap');
    await assert.rejects(extractManifestArchive(archive), error => {
      assert.ok(!error.message.includes(SECRET)); return true;
    });
  });
}

test('unconfirmed Python helper cleanup cannot return a parsed manifest', async () => {
  const processes = { children: new Set([{}]), run: async () => ({ code: 0, stdout: JSON.stringify(wire()), stderr: '' }) };
  await assert.rejects(extractManifestArchive(VALID_ZIP, { processes }), { category: 'process_stop' });
});

function cli(args, { preload, token = SECRET } = {}) {
  return spawnSync(process.execPath, [...(preload ? ['--import', `data:text/javascript;base64,${Buffer.from(preload).toString('base64')}`] : []),
    CLI, ...args], { cwd: ROOT, env: { ...process.env, GH_TOKEN: token }, encoding: 'utf8', timeout: 10_000 });
}

function githubPreload(failure = null) {
  const { state } = fixture();
  state.artifact.expires_at = '2099-01-01T00:00:00Z';
  if (failure === 'digest') state.artifact.digest = 'sha256:' + '0'.repeat(64);
  const responses = Object.fromEntries([
    [`${BASE}/runs/${RUN}`, state.run], [`${BASE}/runs/${RUN}/attempts/${ATTEMPT}/jobs?per_page=100`, state.jobs],
    [`${BASE}/jobs/${JOB}`, state.job], [`${BASE}/runs/${RUN}/artifacts?per_page=100`, state.artifacts],
    [`${BASE}/artifacts/${ARTIFACT}`, state.artifact],
  ]);
  return `import assert from 'node:assert/strict';
const responses=${JSON.stringify(responses)},failure=${JSON.stringify(failure)};
Date.now=()=>${NOW};
globalThis.fetch=async (input,options)=>{
 const url=new URL(input); assert.equal(options.method,undefined);
 if(url.hostname==='storage.invalid'){
  assert.equal(options.headers.Authorization,undefined);
  if(failure==='download_error')throw new Error(process.env.GH_TOKEN+' PRIVATE_SIGNED_TOKEN');
  if(failure==='declared_limit')return new Response('small',{headers:{'content-length':'${ARTIFACT_MAX_BYTES + 1}'}});
  if(failure==='stream_limit')return new Response(Buffer.alloc(${ARTIFACT_MAX_BYTES + 1}));
  return new Response(Buffer.from('${VALID_ZIP.toString('base64')}','base64'));
 }
 assert.equal(url.origin,'https://api.github.com');
 assert.equal(options.headers.Authorization,'Bearer '+process.env.GH_TOKEN);
 if(failure==='api_error')return new Response(process.env.GH_TOKEN,{status:403});
 if(failure==='api_json')return new Response(process.env.GH_TOKEN);
 if(url.pathname.endsWith('/zip'))return new Response(null,{status:302,headers:{location:'https://storage.invalid/signed?token=PRIVATE_SIGNED_TOKEN'}});
 const response=responses[url.pathname+url.search];assert.ok(response);
 return new Response(JSON.stringify(response),{headers:{'content-type':'application/json'}});
};`;
}

test('CLI help and invalid options stay local and never echo the environment token or argument values', () => {
  const help = cli(['--help'], { token: '' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--repository/);
  for (const args of [['--unknown', SECRET], ['--output-dir', SECRET], ['--revision', SECRET]]) {
    const result = cli(args);
    assert.notEqual(result.status, 0);
    assert.ok(!(result.stdout + result.stderr).includes(SECRET));
    assert.equal(JSON.parse(result.stderr).event, 'transfer_manifest_download_failed');
  }
});

test('CLI uses the read-only API, strips credentials from a signed download redirect and writes only verified evidence', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'manifest-reader-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = join(directory, 'verified');
  const result = cli(['--repository', REPOSITORY, '--revision', REVISION, '--run-id', String(RUN),
    '--attempt', String(ATTEMPT), '--job-id', String(JOB), '--output-dir', output], { preload: githubPreload() });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(output, MANIFEST_FILENAME), 'utf8')), wire());
  const observation = JSON.parse(await readFile(join(output, 'observation.json'), 'utf8'));
  assert.equal(observation.job_started_at, STARTED);
  assert.equal(observation.artifact_id, ARTIFACT);
  assert.equal((await stat(output)).mode & 0o777, 0o700);
  assert.equal((await stat(join(output, MANIFEST_FILENAME))).mode & 0o777, 0o600);
  assert.ok(!/SYNTHETIC_PRIVATE|PRIVATE_SIGNED_TOKEN|storage\.invalid/.test(result.stdout + result.stderr));
});

for (const failure of ['api_error', 'api_json', 'digest', 'download_error', 'declared_limit', 'stream_limit']) {
  test(`CLI ${failure} failure exposes no credentials and leaves no unverified output`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'manifest-reader-failure-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const output = join(directory, 'unverified');
    const result = cli(['--repository', REPOSITORY, '--revision', REVISION, '--run-id', String(RUN),
      '--attempt', String(ATTEMPT), '--job-id', String(JOB), '--output-dir', output], { preload: githubPreload(failure) });
    assert.equal(result.error, undefined, result.error?.message);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    const event = JSON.parse(result.stderr);
    assert.equal(event.event, 'transfer_manifest_download_failed');
    assert.ok(!/SYNTHETIC_PRIVATE|PRIVATE_SIGNED_TOKEN|storage\.invalid/.test(result.stderr));
    await assert.rejects(stat(output), { code: 'ENOENT' });
  });
}
