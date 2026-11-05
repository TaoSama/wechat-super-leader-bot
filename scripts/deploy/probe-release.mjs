import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { TransferFailure, TransferProcesses, sshArguments } from './transfer-process.mjs';
import { quoteShell } from './transfer-files.mjs';

const PROBE_TIMEOUT_MS = 75_000;
const FINGERPRINT_TIMEOUT_MS = 10_000;
const SOURCE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const INPUT_FILES = Object.freeze({
  'compose.yaml': 'compose.yaml',
  'compose.release.yaml': 'deploy/compose.release.yaml',
  'compose.production.yaml': 'deploy/compose.production.yaml',
  'compose.gateway.yaml': 'deploy/compose.gateway.yaml',
  'codex-seccomp.json': 'deploy/security/codex-seccomp.json',
  'remote-release.sh': 'scripts/deploy/remote-release.sh',
  'release-state.py': 'scripts/deploy/release-state.py',
});

export async function probeRelease(config, { processes = new TransferProcesses(), signal, sourceRoot = SOURCE_ROOT } = {}) {
  signal?.throwIfAborted();
  if (config.force === true) return { schema: 1, revision: config.revision,
    decision: 'deploy_required', reason: 'manual_rebuild' };
  const root = await mkdtemp(join(tmpdir(), 'release-probe-'));
  try {
    await Promise.all(Object.entries(INPUT_FILES).map(([name, source]) => copyFile(join(sourceRoot, source), join(root, name))));
    const helper = join(root, 'release-state.py');
    const fingerprint = (await processes.checked('python3', [helper, 'fingerprint', '--bundle-dir', root],
      { signal, timeoutMs: FINGERPRINT_TIMEOUT_MS })).stdout.trim();
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new TransferFailure('probe_fingerprint');
    const command = ['python3', '-', 'probe', '--release-dir', config.path, '--revision', config.revision,
      '--fingerprint', fingerprint, '--env-file', config.envFile, '--lock-timeout', '60'].map(quoteShell).join(' ');
    const response = await processes.checked('ssh', [...sshArguments(config, PROBE_TIMEOUT_MS), '-p', String(config.port),
      `${config.user}@${config.host}`, command], { input: await readFile(helper, 'utf8'), signal, timeoutMs: PROBE_TIMEOUT_MS });
    let result;
    try { result = JSON.parse(response.stdout); }
    catch { throw new TransferFailure('remote_response'); }
    if (!result || Object.keys(result).sort().join(',') !== 'decision,reason,revision,schema' || result.schema !== 1 ||
      result.revision !== config.revision || !['duplicate_skipped', 'deploy_required'].includes(result.decision) ||
      typeof result.reason !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(result.reason)) {
      throw new TransferFailure('remote_response');
    }
    return result;
  } finally { await rm(root, { recursive: true, force: true }); }
}
