import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PROJECT_ROOT, verificationEnvironment } from '../verify.mjs';

// Resolve the real build configuration against disposable synthetic env files.
// The fs audit proves disabled loading skips the files, not merely their values.
test('Web verification skips dotenv files while ordinary builds still load them', () => {
  const root = mkdtempSync(join(tmpdir(), 'super-leader-vite-env-'));
  try {
    for (const suffix of ['', '.local', '.production', '.production.local']) {
      writeFileSync(join(root, `.env${suffix}`), 'VITE_VERIFICATION_SENTINEL=synthetic-only\n');
    }
    const code = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const root = ${JSON.stringify(root)};
      const originalRead = fs.readFileSync;
      let reads = 0;
      fs.readFileSync = function(path, ...args) {
        if (String(path).startsWith(root + '/.env')) reads++;
        return originalRead.call(this, path, ...args);
      };
      syncBuiltinESMExports();
      const { resolveConfig } = await import('vite');
      const config = await resolveConfig({ root, mode: 'production', configFile: ${JSON.stringify(join(PROJECT_ROOT, 'web/vite.config.ts'))}, logLevel: 'silent' }, 'build');
      console.log(JSON.stringify({ reads, value: config.env.VITE_VERIFICATION_SENTINEL ?? null }));
    `;
    for (const disabled of [true, false]) {
      const env = verificationEnvironment();
      if (!disabled) delete env.SUPER_LEADER_NO_DOTENV;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
        cwd: join(PROJECT_ROOT, 'web'), env, encoding: 'utf8', timeout: 20_000,
      });
      assert.equal(child.status, 0, child.stderr);
      const result = JSON.parse(child.stdout.trim());
      assert.equal(result.reads, disabled ? 0 : 4);
      assert.equal(result.value, disabled ? null : 'synthetic-only');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
