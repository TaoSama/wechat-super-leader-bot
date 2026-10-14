import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'leader-build-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  const script = join(root, 'scripts/clean-build.mjs');
  copyFileSync(new URL('../../../scripts/clean-build.mjs', import.meta.url), script);
  for (const component of ['controller', 'gateway']) {
    for (const folder of ['src', 'dist', 'dist-test']) {
      mkdirSync(join(root, component, folder), { recursive: true });
      writeFileSync(join(root, component, folder, 'keep-or-clean'), 'fixture');
    }
  }
  return { root, run: args => spawnSync(process.execPath, [script, ...args], {
    cwd: tmpdir(), encoding: 'utf8', env: { PATH: process.env.PATH },
  }) };
}

test('cleaning resolves from the script and removes only the requested generated output', t => {
  const { root, run } = fixture(t);
  const result = run(['--component', 'controller']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(root, 'controller/dist')), false);
  for (const path of ['controller/src/keep-or-clean', 'controller/dist-test/keep-or-clean', 'gateway/dist/keep-or-clean']) {
    assert.equal(existsSync(join(root, path)), true);
  }
  assert.equal(run(['--component', 'controller']).status, 0, 'missing output is safe');
  assert.equal(run(['--component', 'gateway', '--tests']).status, 0);
  assert.equal(existsSync(join(root, 'gateway/dist-test')), false);
  assert.equal(existsSync(join(root, 'gateway/dist/keep-or-clean')), true);
});

test('invalid components, options and symlinked outputs cannot remove arbitrary directories', t => {
  const { root, run } = fixture(t);
  for (const args of [[], ['--component', '../'], ['--component', 'web'], ['--unknown']]) {
    assert.notEqual(run(args).status, 0);
  }
  rmSync(join(root, 'controller/dist'), { recursive: true });
  symlinkSync(join(root, 'gateway/dist'), join(root, 'controller/dist'));
  assert.notEqual(run(['--component', 'controller']).status, 0);
  assert.equal(existsSync(join(root, 'gateway/dist/keep-or-clean')), true);
  assert.equal(run(['--help']).status, 0);
  assert.equal(run(['-h']).status, 0);
});
