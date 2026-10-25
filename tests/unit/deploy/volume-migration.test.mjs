import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const script = new URL('../../../scripts/migrate-controller-runtime-volume.mjs', import.meta.url);

function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-volume-migration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = { settings: join(root, 'old-settings'), workers: join(root, 'old-workers'), artifacts: join(root, 'old-artifacts') };
  for (const path of Object.values(source)) mkdirSync(path, { recursive: true });
  writeFileSync(join(source.settings, 'runtime-settings.json'), '{"format":1}');
  mkdirSync(join(source.workers, 'worker', 'workspace'), { recursive: true });
  writeFileSync(join(source.workers, '.slot'), 'reserved');
  writeFileSync(join(source.workers, 'worker', 'workspace', 'result.txt'), 'worker-result');
  mkdirSync(join(source.artifacts, 'worker', 'invocation'), { recursive: true });
  writeFileSync(join(source.artifacts, 'worker', 'invocation', 'result.json'), 'artifact-result');
  let target = join(root, 'new-runtime'); const manifest = join(root, 'migration.json');
  const args = extra => [script.pathname, '--target', target, '--source-settings', source.settings,
    '--source-workers', source.workers, '--source-artifacts', source.artifacts, '--uid', String(process.getuid?.() ?? 0),
    '--gid', String(process.getgid?.() ?? 0), ...extra];
  return { root, source, get target() { return target; }, setTarget: value => { target = value; }, manifest,
    args, run: extra => spawnSync(process.execPath, args(extra), { encoding: 'utf8' }) };
}

test('migration is dry-run by default and emits a manifest without touching target', t => {
  const fixture = createFixture(t);
  const result = fixture.run(['--manifest', fixture.manifest]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'dry-run');
  assert.equal(existsSync(fixture.target), false);
  assert.equal(JSON.parse(readFileSync(fixture.manifest, 'utf8')).mode, 'dry-run');
});

test('execute copies hidden runtime state into isolated subdirectories and records post-copy hashes', t => {
  const fixture = createFixture(t);
  const result = fixture.run(['--execute', '--manifest', fixture.manifest]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, 'execute');
  assert.equal(readFileSync(join(fixture.target, 'settings', 'runtime-settings.json'), 'utf8'), '{"format":1}');
  assert.equal(readFileSync(join(fixture.target, 'background', 'workers', '.slot'), 'utf8'), 'reserved');
  assert.equal(readFileSync(join(fixture.target, 'background', 'artifacts', 'worker', 'invocation', 'result.json'), 'utf8'), 'artifact-result');
  assert.deepEqual(Object.keys(report.after).sort(), ['artifacts', 'settings', 'workers']);
});

test('symlinked source content and non-empty targets are rejected without writes', t => {
  const fixture = createFixture(t);
  symlinkSync(join(fixture.source.settings, 'runtime-settings.json'), join(fixture.source.settings, 'link'));
  const linked = fixture.run(['--execute']);
  assert.notEqual(linked.status, 0);
  assert.equal(existsSync(fixture.target), false);

  const clean = createFixture(t);
  mkdirSync(clean.target, { recursive: true });
  writeFileSync(join(clean.target, 'unexpected'), 'keep');
  const nonEmpty = clean.run(['--execute']);
  assert.notEqual(nonEmpty.status, 0);
  assert.equal(readFileSync(join(clean.target, 'unexpected'), 'utf8'), 'keep');
});

test('source and target trees must be disjoint', t => {
  const fixture = createFixture(t);
  fixture.setTarget(join(fixture.source.settings, 'nested-target'));
  const result = fixture.run([]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be disjoint/);
});

test('rollback is dry-run by default and removes only an unchanged migration', t => {
  const fixture = createFixture(t);
  const migrated = fixture.run(['--execute', '--manifest', fixture.manifest]);
  assert.equal(migrated.status, 0, migrated.stderr);
  const dry = spawnSync(process.execPath, [script.pathname, '--rollback', '--target', fixture.target, '--manifest', fixture.manifest], { encoding: 'utf8' });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(existsSync(join(fixture.target, 'settings')), true);
  const rollback = spawnSync(process.execPath, [script.pathname, '--rollback', '--target', fixture.target, '--manifest', fixture.manifest, '--execute'], { encoding: 'utf8' });
  assert.equal(rollback.status, 0, rollback.stderr);
  assert.equal(existsSync(join(fixture.target, 'settings')), false);
  assert.equal(existsSync(join(fixture.target, 'background')), false);
});
