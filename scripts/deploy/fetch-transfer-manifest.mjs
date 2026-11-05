import { createHash } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { isAbsolute, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { TransferFailure, TransferProcesses } from './transfer-process.mjs';
import { MANIFEST_MAX_BYTES, MANIFEST_FILENAME, manifestIdentity,
  manifestArtifactName, validateTransferManifest } from './transfer-manifest.mjs';

export const ARTIFACT_MAX_BYTES = 64 * 1024;
const API_MAX_BYTES = 2 * 1024 * 1024;
const REQUEST_MS = 15_000;
const READER_MS = 60_000;
const JOB_NAME = 'Build and deploy linux/amd64 images';
const WORKFLOW_PATH = '.github/workflows/deploy-production.yml';
const OBSERVATION_FILENAME = 'observation.json';
const requireValue = (value, category) => { if (!value) throw new TransferFailure(category); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const timestamp = value => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ? Date.parse(value) : NaN;

async function boundedBody(response, limit) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel();
    throw new TransferFailure('artifact_response_limit');
  }
  const chunks = [];
  let bytes = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      requireValue(bytes <= limit, 'artifact_response_limit');
      chunks.push(Buffer.from(chunk));
    }
  }
  return Buffer.concat(chunks);
}

function githubReader(repository, token) {
  requireValue(typeof token === 'string' && token.length > 0, 'github_authentication');
  const deadline = AbortSignal.timeout(READER_MS);
  const request = (url, authenticated = true) => fetch(url, {
    redirect: 'manual', signal: AbortSignal.any([deadline, AbortSignal.timeout(REQUEST_MS)]),
    headers: authenticated ? { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28' } : {},
  });
  const api = async path => {
    const response = await request(`https://api.github.com${path}`);
    if (!response.ok) {
      await response.body?.cancel();
      throw new TransferFailure('github_api');
    }
    try { return JSON.parse((await boundedBody(response, API_MAX_BYTES)).toString('utf8')); }
    catch (error) { throw error instanceof TransferFailure ? error : new TransferFailure('github_response'); }
  };
  const download = async id => {
    let response = await request(`https://api.github.com/repos/${repository}/actions/artifacts/${id}/zip`);
    if (response.status === 302) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      let url;
      try { url = new URL(location); } catch { throw new TransferFailure('artifact_redirect'); }
      requireValue(url.protocol === 'https:' && !url.username && !url.password, 'artifact_redirect');
      // The signed storage URL must never receive the GitHub credential or reach logs.
      response = await request(url, false);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new TransferFailure('artifact_download');
    }
    return boundedBody(response, ARTIFACT_MAX_BYTES);
  };
  return { api, download };
}

// zipfile provides CRC and decompression checks without extracting arbitrary paths.
const EXTRACT_MANIFEST = `
import io,stat,sys,zipfile
try:
 data=sys.stdin.buffer.read(${ARTIFACT_MAX_BYTES + 1})
 if len(data)>${ARTIFACT_MAX_BYTES}:raise ValueError()
 with zipfile.ZipFile(io.BytesIO(data)) as archive:
  entries=archive.infolist()
  if len(entries)!=1:raise ValueError()
  item=entries[0]
  mode=item.external_attr>>16
  if item.filename!=${JSON.stringify(MANIFEST_FILENAME)} or item.is_dir() or stat.S_IFMT(mode) not in (0,stat.S_IFREG):raise ValueError()
  if item.flag_bits&1 or item.compress_type not in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED):raise ValueError()
  if not 0<item.file_size<=${MANIFEST_MAX_BYTES} or item.compress_size>${ARTIFACT_MAX_BYTES}:raise ValueError()
  with archive.open(item) as stream:content=stream.read(${MANIFEST_MAX_BYTES + 1})
  if len(content)!=item.file_size or len(content)>${MANIFEST_MAX_BYTES}:raise ValueError()
  sys.stdout.buffer.write(content)
except Exception:
 sys.exit(1)
`;

export async function extractManifestArchive(buffer, { processes = new TransferProcesses() } = {}) {
  requireValue(Buffer.isBuffer(buffer) && buffer.length > 0 && buffer.length <= ARTIFACT_MAX_BYTES,
    'artifact_archive_limit');
  const result = await processes.run('python3', ['-B', '-c', EXTRACT_MANIFEST], { input: buffer, timeoutMs: 3_000 });
  requireValue(processes.children.size === 0, 'process_stop');
  requireValue(result.code === 0 && !result.reason && !result.stderr &&
    Buffer.byteLength(result.stdout) <= MANIFEST_MAX_BYTES, 'artifact_archive_invalid');
  try { return JSON.parse(result.stdout); }
  catch { throw new TransferFailure('artifact_manifest_invalid'); }
}

export async function fetchTransferManifest({ repository, revision, runId, attempt, jobId },
  { api, download, extract = extractManifestArchive, now = Date.now } = {}) {
  requireValue(typeof repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'configuration');
  const identity = manifestIdentity({ revision, run: runId, attempt });
  const run = identity.run_id;
  requireValue(/^[1-9][0-9]*$/.test(String(jobId)) && positive(Number(jobId)), 'configuration');
  jobId = Number(jobId);
  if (!api || !download) {
    const reader = githubReader(repository, process.env.GH_TOKEN);
    api ??= reader.api; download ??= reader.download;
  }
  const base = `/repos/${repository}/actions`;
  const metadata = await api(`${base}/runs/${run}`);
  requireValue(metadata.id === run && metadata.run_attempt === identity.attempt &&
    metadata.path === WORKFLOW_PATH && metadata.repository?.full_name === repository &&
    positive(metadata.repository?.id) && metadata.head_repository?.id === metadata.repository.id &&
    ['in_progress', 'completed'].includes(metadata.status), 'workflow_identity');
  const jobs = await api(`${base}/runs/${run}/attempts/${identity.attempt}/jobs?per_page=100`);
  requireValue(Array.isArray(jobs.jobs) && jobs.jobs.length <= 100 && jobs.total_count === jobs.jobs.length, 'job_list');
  const candidates = jobs.jobs.filter(job => job.name === JOB_NAME);
  requireValue(candidates.length === 1 && candidates[0].id === jobId, 'job_identity');
  const job = await api(`${base}/jobs/${jobId}`);
  requireValue(job.id === jobId && job.run_id === run && job.run_attempt === identity.attempt &&
    job.name === JOB_NAME && ['in_progress', 'completed'].includes(job.status) &&
    Number.isFinite(timestamp(job.started_at)), 'job_identity');
  const observedAt = now();
  const end = job.status === 'completed' ? timestamp(job.completed_at) : observedAt;
  requireValue((job.status === 'completed' || job.completed_at == null) &&
    Number.isFinite(end) && timestamp(job.started_at) <= end && end <= observedAt,
    'job_identity');
  const artifacts = await api(`${base}/runs/${run}/artifacts?per_page=100`);
  requireValue(Array.isArray(artifacts.artifacts) && artifacts.artifacts.length <= 100 &&
    artifacts.total_count === artifacts.artifacts.length, 'artifact_list');
  const name = manifestArtifactName(identity);
  const matches = artifacts.artifacts.filter(item => item.name === name);
  requireValue(matches.length === 1 && positive(matches[0].id), 'artifact_identity');
  const artifact = await api(`${base}/artifacts/${matches[0].id}`);
  const created = timestamp(artifact.created_at), expires = timestamp(artifact.expires_at);
  requireValue(artifact.id === matches[0].id && artifact.name === name && artifact.expired === false &&
    artifact.workflow_run?.id === run && artifact.workflow_run?.repository_id === metadata.repository.id &&
    artifact.workflow_run?.head_repository_id === metadata.repository.id &&
    Number.isFinite(created) && created >= timestamp(job.started_at) &&
    created <= end &&
    Number.isFinite(expires) && expires > now() && positive(artifact.size_in_bytes) &&
    artifact.size_in_bytes <= ARTIFACT_MAX_BYTES, 'artifact_identity');
  if (artifact.digest != null) requireValue(/^sha256:[0-9a-f]{64}$/.test(artifact.digest), 'artifact_digest');
  const archive = await download(artifact.id);
  requireValue(Buffer.isBuffer(archive) && archive.length > 0 && archive.length <= ARTIFACT_MAX_BYTES,
    'artifact_archive_limit');
  if (artifact.digest != null) requireValue(`sha256:${createHash('sha256').update(archive).digest('hex')}` === artifact.digest,
    'artifact_digest');
  const manifest = validateTransferManifest(await extract(archive), identity, { allowLegacy: true });
  requireValue(expires > now(), 'artifact_identity');
  return { manifest, job_started_at: job.started_at, job_id: jobId, artifact_id: artifact.id, artifact_name: name };
}

async function main() {
  const { values } = parseArgs({ options: Object.fromEntries([
    ...['repository', 'revision', 'run-id', 'attempt', 'job-id', 'output-dir'].map(name => [name, { type: 'string' }]),
    ['help', { type: 'boolean', short: 'h' }],
  ]) });
  if (values.help) {
    console.log('Usage: node scripts/deploy/fetch-transfer-manifest.mjs --repository OWNER/REPO --revision SHA\n' +
      '  --run-id R --attempt A --job-id J --output-dir NEW_ABSOLUTE_DIRECTORY\n' +
      'Uses GH_TOKEN for read-only GitHub Actions access and local Python 3 zipfile.');
    return;
  }
  const directory = values['output-dir'];
  requireValue(typeof directory === 'string' && isAbsolute(directory) && directory !== '/' && normalize(directory) === directory,
    'configuration');
  const result = await fetchTransferManifest({ repository: values.repository, revision: values.revision,
    runId: values['run-id'], attempt: values.attempt, jobId: values['job-id'] });
  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 }); created = true;
    const { manifest, ...observation } = result;
    await writeFile(join(directory, MANIFEST_FILENAME), `${JSON.stringify(manifest)}\n`, { flag: 'wx', mode: 0o600 });
    await writeFile(join(directory, OBSERVATION_FILENAME), `${JSON.stringify({ schema: 1,
      revision: manifest.revision, run_id: manifest.run_id, attempt: manifest.attempt, ...observation })}\n`,
    { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ event: 'transfer_manifest_downloaded', revision: manifest.revision,
      run_id: manifest.run_id, attempt: manifest.attempt, ...observation }));
  } catch (error) {
    if (created) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(JSON.stringify({ event: 'transfer_manifest_download_failed',
      category: error instanceof TransferFailure ? error.category : 'artifact_read' }));
    process.exitCode = 1;
  });
}
