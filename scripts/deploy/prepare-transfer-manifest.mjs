import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { createTransferManifest, MANIFEST_FILENAME, MANIFEST_MAX_BYTES,
  manifestArtifactName, manifestIdentity } from './transfer-manifest.mjs';
import { TransferFailure } from './transfer-process.mjs';

function within(root, path) {
  const child = relative(root, path);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

export async function prepareTransferManifest({ releaseRoot, output }, env = process.env, signal) {
  if (typeof releaseRoot !== 'string' || !releaseRoot || typeof output !== 'string' ||
    !output || basename(output) !== MANIFEST_FILENAME || within(resolve(releaseRoot), resolve(output))) {
    throw new TransferFailure('configuration');
  }
  const identity = manifestIdentity({ revision: env.REVISION, run: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT });
  let canonicalRoot, canonicalOutput;
  try {
    canonicalRoot = await realpath(releaseRoot);
    await mkdir(dirname(output), { recursive: true });
    canonicalOutput = join(await realpath(dirname(output)), MANIFEST_FILENAME);
  } catch { throw new TransferFailure('manifest_output'); }
  if (within(canonicalRoot, canonicalOutput)) throw new TransferFailure('configuration');
  const manifest = await createTransferManifest(canonicalRoot, identity, signal);
  const encoded = `${JSON.stringify(manifest)}\n`;
  if (Buffer.byteLength(encoded) > MANIFEST_MAX_BYTES) throw new TransferFailure('manifest_invalid');
  try { await writeFile(canonicalOutput, encoded, { encoding: 'utf8', flag: 'wx', mode: 0o600, signal }); }
  catch { throw new TransferFailure(signal?.aborted ? 'cancelled' : 'manifest_output'); }
  return manifest;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  let values;
  try {
    ({ values } = parseArgs({ args, options: { 'release-root': { type: 'string' },
      output: { type: 'string' }, help: { type: 'boolean', short: 'h' } } }));
  } catch { throw new TransferFailure('configuration'); }
  if (values.help) {
    console.log('Usage: node scripts/deploy/prepare-transfer-manifest.mjs --release-root PATH --output PATH\n' +
      'Uses REVISION and GITHUB_RUN_ID/GITHUB_RUN_ATTEMPT; output must be an external transfer-manifest.json.');
    return;
  }
  const abort = new AbortController(), cancel = () => abort.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  try {
    const manifest = await prepareTransferManifest({ releaseRoot: values['release-root'], output: values.output }, env, abort.signal);
    console.log(JSON.stringify({ schema: 1, event: 'transfer_manifest_prepared', revision: manifest.revision,
      run_id: manifest.run_id, attempt: manifest.attempt, artifact_name: manifestArtifactName(manifest),
      total_bytes: manifest.total_bytes }));
  } finally { process.off('SIGINT', cancel); process.off('SIGTERM', cancel); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(JSON.stringify({ schema: 1, event: 'command_failed',
      category: error instanceof TransferFailure ? error.category : 'configuration_or_local' }));
    process.exitCode = 1;
  });
}
