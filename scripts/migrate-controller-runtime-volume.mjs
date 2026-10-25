import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { chmod, chown, copyFile, lstat, mkdir, readFile, readdir, rm, rename, rmdir, utimes, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

const COMPONENTS = Object.freeze({
  settings: 'settings',
  workers: 'background/workers',
  artifacts: 'background/artifacts',
});
const OWNER = Object.freeze({ uid: 1000, gid: 1000 });

function requiredPath(raw, name) {
  if (typeof raw !== 'string' || !raw.trim() || !isAbsolute(raw) || resolve(raw) === dirname(resolve(raw))) {
    throw new Error(`${name} must be a non-root absolute path`);
  }
  return resolve(raw);
}

function safeChild(root, child, name) {
  const candidate = resolve(root, child);
  if (candidate === root || !candidate.startsWith(`${root}${sep}`)) throw new Error(`${name} escapes target root`);
  return candidate;
}

function assertDisjoint(paths) {
  for (let left = 0; left < paths.length; left++) for (let right = left + 1; right < paths.length; right++) {
    if (paths[left] === paths[right] || paths[left].startsWith(`${paths[right]}${sep}`) || paths[right].startsWith(`${paths[left]}${sep}`)) {
      throw new Error(`Source and target directories must be disjoint: ${paths[left]} / ${paths[right]}`);
    }
  }
}

async function metadata(pathname, relativePath) {
  const stat = await lstat(pathname);
  if (stat.isSymbolicLink()) throw new Error(`Symbolic links are not supported: ${pathname}`);
  if (!stat.isDirectory() && !stat.isFile()) throw new Error(`Only regular files and directories are supported: ${pathname}`);
  const entry = { path: relativePath, type: stat.isDirectory() ? 'directory' : 'file', mode: stat.mode & 0o7777,
    uid: stat.uid, gid: stat.gid, size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
  if (stat.isFile()) entry.sha256 = createHash('sha256').update(await readFile(pathname)).digest('hex');
  return entry;
}

export async function treeManifest(root) {
  const entries = [];
  async function visit(directory, prefix) {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      if (name === '.' || name === '..') throw new Error(`Invalid entry name: ${name}`);
      const pathname = join(directory, name);
      const entryPath = prefix ? `${prefix}/${name}` : name;
      const entry = await metadata(pathname, entryPath);
      entries.push(entry);
      if (entry.type === 'directory') await visit(pathname, entryPath);
    }
  }
  const rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`Source must be a real directory: ${root}`);
  await visit(root, '');
  const serialized = JSON.stringify(entries);
  return { root: { mode: rootStat.mode & 0o7777, uid: rootStat.uid, gid: rootStat.gid, mtimeMs: Math.trunc(rootStat.mtimeMs) },
    entries, sha256: createHash('sha256').update(serialized).digest('hex') };
}

async function copyTree(source, destination, owner) {
  const sourceStat = await lstat(source);
  await mkdir(destination, { recursive: true, mode: sourceStat.mode & 0o7777 });
  await chmod(destination, sourceStat.mode & 0o7777);
  await chown(destination, owner.uid, owner.gid);
  for (const name of (await readdir(source)).sort()) {
    const sourcePath = join(source, name), destinationPath = join(destination, name), stat = await lstat(sourcePath);
    if (stat.isSymbolicLink()) throw new Error(`Symbol links are not supported: ${sourcePath}`);
    if (stat.isDirectory()) await copyTree(sourcePath, destinationPath, owner);
    else if (stat.isFile()) {
      await copyFile(sourcePath, destinationPath);
      await chmod(destinationPath, stat.mode & 0o7777);
      await chown(destinationPath, owner.uid, owner.gid);
    } else throw new Error(`Only regular files and directories are supported: ${sourcePath}`);
    await utimes(destinationPath, stat.atime, stat.mtime);
  }
  await utimes(destination, sourceStat.atime, sourceStat.mtime);
}

async function assertTarget(target) {
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Target must be a real directory: ${target}`);
    if ((await readdir(target)).length) throw new Error(`Target must be empty: ${target}`);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}

function equalManifest(actual, expected, owner) {
  if (actual.entries.length !== expected.entries.length) return false;
  return actual.entries.every((entry, index) => {
    const source = expected.entries[index];
    const comparable = value => ({ path: value.path, type: value.type, mode: value.mode, uid: owner.uid,
      gid: owner.gid, ...(value.type === 'file' ? { size: value.size, sha256: value.sha256 } : {}) });
    return JSON.stringify(comparable(entry)) === JSON.stringify(comparable(source)) && Math.abs(entry.mtimeMs - source.mtimeMs) <= 2;
  });
}

export async function planMigration({ sources, target, owner = OWNER, execute = false }) {
  const targetRoot = requiredPath(target, 'target');
  const normalizedOwner = { uid: Number(owner.uid), gid: Number(owner.gid) };
  if (![normalizedOwner.uid, normalizedOwner.gid].every(value => Number.isInteger(value) && value >= 0)) throw new Error('uid and gid must be non-negative integers');
  const sourcePaths = Object.fromEntries(Object.entries(COMPONENTS).map(([name, child]) => [name, requiredPath(sources[name], `source-${name}`)]));
  assertDisjoint([targetRoot, ...Object.values(sourcePaths)]);
  const manifests = {};
  for (const [name, source] of Object.entries(sourcePaths)) manifests[name] = await treeManifest(source);
  await assertTarget(targetRoot);
  const report = { version: 1, mode: execute ? 'execute' : 'dry-run', target: targetRoot, owner: normalizedOwner,
    sources: sourcePaths, components: Object.fromEntries(Object.keys(COMPONENTS).map(name => [name, { destination: safeChild(targetRoot, COMPONENTS[name], name), source: manifests[name] }])), rollback: 'Remove the three destination directories only after verifying the recorded post-migration manifest.' };
  if (!execute) return report;
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  await chmod(targetRoot, 0o700);
  await chown(targetRoot, normalizedOwner.uid, normalizedOwner.gid);
  await assertTarget(targetRoot);
  const staging = join(dirname(targetRoot), `.${targetRoot.split(sep).pop()}-migration-${process.pid}-${Date.now()}`);
  const moved = [];
  try {
    await mkdir(staging, { recursive: true, mode: 0o700 });
    for (const [name, source] of Object.entries(sourcePaths)) await copyTree(source, join(staging, COMPONENTS[name]), normalizedOwner);
    const after = {};
    for (const [name] of Object.entries(COMPONENTS)) {
      after[name] = await treeManifest(join(staging, COMPONENTS[name]));
      if (!equalManifest(after[name], manifests[name], normalizedOwner)) {
        throw new Error(`Post-copy manifest mismatch: ${name}`);
      }
    }
    for (const name of Object.keys(COMPONENTS)) {
      const destination = join(targetRoot, COMPONENTS[name]);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await rename(join(staging, COMPONENTS[name]), destination);
      moved.push(destination);
    }
    report.after = after;
  } catch (error) {
    for (const destination of moved.reverse()) await rm(destination, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  await rm(staging, { recursive: true, force: true });
  return report;
}

async function rollback({ target, manifest, execute }) {
  const targetRoot = requiredPath(target, 'target');
  const saved = JSON.parse(await readFile(requiredPath(manifest, 'manifest'), 'utf8'));
  if (!saved.after || saved.target !== targetRoot) throw new Error('Manifest does not describe this target');
  const current = {};
  for (const [name, child] of Object.entries(COMPONENTS)) current[name] = await treeManifest(safeChild(targetRoot, child, name));
  for (const name of Object.keys(COMPONENTS)) if (current[name].sha256 !== saved.after[name].sha256) throw new Error(`Target changed since migration: ${name}`);
  if (!execute) return { version: 1, mode: 'dry-run-rollback', target: targetRoot, components: Object.keys(COMPONENTS) };
  for (const child of Object.values(COMPONENTS)) await rm(safeChild(targetRoot, child, child), { recursive: true, force: false });
  try { await rmdir(join(targetRoot, 'background')); }
  catch (error) { if (!['ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error; }
  return { version: 1, mode: 'rollback', target: targetRoot, components: Object.keys(COMPONENTS) };
}

async function main() {
  const { values } = parseArgs({ options: {
    'source-settings': { type: 'string' }, 'source-workers': { type: 'string' }, 'source-artifacts': { type: 'string' },
    target: { type: 'string' }, manifest: { type: 'string' }, execute: { type: 'boolean' }, rollback: { type: 'boolean' },
    uid: { type: 'string', default: String(OWNER.uid) }, gid: { type: 'string', default: String(OWNER.gid) },
    help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) {
    console.log('Usage: node scripts/migrate-controller-runtime-volume.mjs --target DIR --source-settings DIR --source-workers DIR --source-artifacts DIR [--execute] [--manifest FILE]\n       node scripts/migrate-controller-runtime-volume.mjs --rollback --target DIR --manifest FILE [--execute]\nDefault mode audits and prints a manifest; --execute is required for writes. All source trees must be real directories without symlinks.');
    return;
  }
  if (values.rollback) {
    if (!values.target || !values.manifest) throw new Error('--rollback requires --target and --manifest');
    const report = await rollback({ target: values.target, manifest: values.manifest, execute: values.execute === true });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (!values.target || !values['source-settings'] || !values['source-workers'] || !values['source-artifacts']) {
    throw new Error('--target, --source-settings, --source-workers and --source-artifacts are required');
  }
  const report = await planMigration({ target: values.target, execute: values.execute === true, owner: { uid: values.uid, gid: values.gid }, sources: {
    settings: values['source-settings'], workers: values['source-workers'], artifacts: values['source-artifacts'],
  } });
  if (values.manifest) await writeFile(requiredPath(values.manifest, 'manifest'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url))) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
