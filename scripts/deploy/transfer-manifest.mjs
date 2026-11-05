import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { TextDecoder } from 'node:util';
import { RELEASE_FILES, manifestFor } from './transfer-files.mjs';
import { TransferFailure } from './transfer-process.mjs';

export const MANIFEST_MAX_BYTES = 16 * 1024;
export const MANIFEST_FILENAME = 'transfer-manifest.json';
const MANIFEST_KEYS = ['schema', 'revision', 'run_id', 'attempt', 'files', 'total_bytes'];
const FILE_KEYS = ['name', 'bytes', 'sha256'];
const HEX_REVISION = /^[0-9a-f]{40}$/;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const LEGACY_RELEASE_FILES = Object.freeze(['controller.tar', 'gateway.tar', 'release.sha256', 'manifest.env',
  'compose.release.yaml', 'compose.yaml', 'compose.production.yaml', 'compose.gateway.yaml',
  'codex-seccomp.json', 'remote-release.sh']);

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function positiveInteger(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value))) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

export function manifestIdentity(identity = {}) {
  if (identity === null || typeof identity !== 'object' || Array.isArray(identity)) throw new TransferFailure('manifest_identity');
  const { revision, run, run_id: runId, attempt } = identity;
  const normalized = { revision, run_id: positiveInteger(run ?? runId), attempt: positiveInteger(attempt) };
  if (typeof revision !== 'string' || !HEX_REVISION.test(revision) || normalized.run_id === null ||
    normalized.attempt === null || (run !== undefined && runId !== undefined && positiveInteger(run) !== positiveInteger(runId))) {
    throw new TransferFailure('manifest_identity');
  }
  return Object.freeze(normalized);
}

export function validateTransferManifest(value, identity, { allowLegacy = false } = {}) {
  const expected = manifestIdentity(identity);
  // Historical artifacts remain readable; activation always requires the current bundle.
  const releaseFiles = allowLegacy === true && Array.isArray(value?.files) &&
    value.files.length === LEGACY_RELEASE_FILES.length ? LEGACY_RELEASE_FILES : RELEASE_FILES;
  if (!exactKeys(value, MANIFEST_KEYS) || value.schema !== 1 || typeof value.revision !== 'string' ||
    !HEX_REVISION.test(value.revision) || !Number.isSafeInteger(value.run_id) || value.run_id <= 0 ||
    !Number.isSafeInteger(value.attempt) || value.attempt <= 0 || !Array.isArray(value.files) ||
    value.files.length !== releaseFiles.length || !Number.isSafeInteger(value.total_bytes) || value.total_bytes < 0) {
    throw new TransferFailure('manifest_invalid');
  }
  if (['revision', 'run_id', 'attempt'].some(key => value[key] !== expected[key])) {
    throw new TransferFailure('manifest_identity');
  }
  const names = new Set();
  let total = 0;
  for (const file of value.files) {
    if (!exactKeys(file, FILE_KEYS) || !releaseFiles.includes(file.name) || names.has(file.name) ||
      !Number.isSafeInteger(file.bytes) || file.bytes < 0 || typeof file.sha256 !== 'string' || !HEX_SHA256.test(file.sha256)) {
      throw new TransferFailure('manifest_invalid');
    }
    names.add(file.name);
    total += file.bytes;
    if (!Number.isSafeInteger(total)) throw new TransferFailure('manifest_invalid');
  }
  if (total !== value.total_bytes) throw new TransferFailure('manifest_invalid');
  const files = Object.freeze(releaseFiles.map(name => {
    const file = value.files.find(item => item.name === name);
    return Object.freeze({ name: file.name, bytes: file.bytes, sha256: file.sha256 });
  }));
  return Object.freeze({ schema: 1, ...expected, files, total_bytes: total });
}

export async function readTransferManifest(path, identity) {
  if (typeof path !== 'string' || basename(path) !== MANIFEST_FILENAME) throw new TransferFailure('manifest_file');
  let handle, text, closeFailed = false;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > MANIFEST_MAX_BYTES) throw new TransferFailure('manifest_file');
    const buffer = Buffer.alloc(MANIFEST_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length > MANIFEST_MAX_BYTES || length !== before.size || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new TransferFailure('manifest_file');
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } catch (error) {
    throw error instanceof TransferFailure ? error : new TransferFailure('manifest_file');
  } finally {
    if (handle) {
      try { await handle.close(); }
      catch { closeFailed = true; }
    }
  }
  if (closeFailed) throw new TransferFailure('manifest_file');
  let value;
  try { value = JSON.parse(text); }
  catch { throw new TransferFailure('manifest_invalid'); }
  return validateTransferManifest(value, identity);
}

export async function createTransferManifest(root, identity, signal) {
  const expected = manifestIdentity(identity);
  let files;
  try { files = await manifestFor(root, RELEASE_FILES, signal); }
  catch { throw new TransferFailure(signal?.aborted ? 'cancelled' : 'manifest_local_mismatch'); }
  return validateTransferManifest({ schema: 1, ...expected, files,
    total_bytes: files.reduce((total, file) => total + file.bytes, 0) }, expected);
}

export async function verifyLocalManifest(root, manifest, signal) {
  const frozen = validateTransferManifest(manifest, manifest);
  let actual;
  try { actual = await manifestFor(root, RELEASE_FILES, signal); }
  catch { throw new TransferFailure(signal?.aborted ? 'cancelled' : 'manifest_local_mismatch'); }
  if (actual.some((file, index) => FILE_KEYS.some(key => file[key] !== frozen.files[index][key]))) {
    throw new TransferFailure('manifest_local_mismatch');
  }
  return frozen;
}

export function manifestArtifactName(identity) {
  const { revision, run_id: runId, attempt } = manifestIdentity(identity);
  return `release-transfer-manifest-${revision}-${runId}-${attempt}`;
}
