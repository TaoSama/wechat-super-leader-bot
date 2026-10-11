import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, symlinkSync, rmSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { authorizeWechat } from './authorize-wechat.mjs';

const cliPath = fileURLToPath(new URL('./authorize-wechat.mjs', import.meta.url));

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

function createFixture({
  accountData = { token: 'secret-token-xyz-999', accountId: 'acc_1', userId: 'wxid_owner_123' },
  envContent = 'POSTGRES_PASSWORD=super_secret_pg_pass\nCONTROLLER_TOKEN=super_secret_ctrl_tok\nALLOWED_CHAT_IDS=\nLEADER_MODE=model\n',
  dirMode = 0o700,
  credMode = 0o600,
  envMode = 0o600,
} = {}) {
  const baseDir = mkdtempSync(join(tmpdir(), 'auth-wechat-test-'));
  const secureDir = join(baseDir, 'runtime');
  mkdirSync(secureDir, { mode: dirMode });
  chmodSync(secureDir, dirMode);

  const credPath = join(secureDir, 'account.json');
  const envPath = join(secureDir, 'controller.env');

  if (accountData !== null) {
    const rawCred = typeof accountData === 'string' ? accountData : JSON.stringify(accountData, null, 2);
    writeFileSync(credPath, rawCred, { mode: credMode });
    chmodSync(credPath, credMode);
  }

  if (envContent !== null) {
    writeFileSync(envPath, envContent, { mode: envMode });
    chmodSync(envPath, envMode);
  }

  return {
    baseDir,
    secureDir,
    credPath,
    envPath,
    cleanup: () => rmSync(baseDir, { recursive: true, force: true }),
  };
}

test('CLI --help and -h print usage without reading files', () => {
  for (const flag of ['--help', '-h']) {
    const res = runCli([flag]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage: node deploy\/authorize-wechat\.mjs/);
    assert.match(res.stdout, /--credentials <path>/);
    assert.match(res.stdout, /--env-file <path>/);
    assert.match(res.stdout, /--apply/);
  }
});

test('CLI rejects positional arguments', () => {
  const res = runCli(['positional-arg']);
  assert.equal(res.status, 1);
});

test('import does not execute caller CLI', () => {
  const moduleUrl = new URL('./authorize-wechat.mjs', import.meta.url).href;
  const res = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)}); console.log('ok');`, '--', '--unknown-flag'],
    { encoding: 'utf8' }
  );
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'ok');
});

test('dry-run (default) detects change without modifying .env or leaking secrets', () => {
  const fix = createFixture();
  try {
    const originalBytes = readFileSync(fix.envPath);
    const res = runCli(['--credentials', fix.credPath, '--env-file', fix.envPath]);
    assert.equal(res.status, 0, res.stderr);

    // Must not leak token, userId, or env secrets in stdout/stderr
    assert.doesNotMatch(res.stdout, /secret-token-xyz-999/);
    assert.doesNotMatch(res.stdout, /wxid_owner_123/);
    assert.doesNotMatch(res.stdout, /super_secret_pg_pass/);
    assert.doesNotMatch(res.stdout, /super_secret_ctrl_tok/);

    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.hasOwner, true);
    assert.equal(parsed.alreadyAuthorized, false);
    assert.equal(parsed.changed, true);
    assert.equal(parsed.applied, false);
    assert.equal(parsed.dryRun, true);

    // File bytes unchanged in dry-run
    assert.deepEqual(readFileSync(fix.envPath), originalBytes);
  } finally {
    fix.cleanup();
  }
});

test('--apply updates only ALLOWED_CHAT_IDS=, preserves other bytes and 0600 mode, and is idempotent on re-run', () => {
  const envWithSpecialBytes =
    '# Header comment with special chars: $!@#%^&*()\r\n' +
    'POSTGRES_PASSWORD=super_secret_pg_pass\r\n' +
    'CONTROLLER_TOKEN="tok=123$abc"\n' +
    'ALLOWED_CHAT_IDS=\n' +
    'NODE_TOKENS={"macair":"node_sec_999"}\n' +
    'TRAILING_NO_NEWLINE=1';
  const fix = createFixture({ envContent: envWithSpecialBytes });
  try {
    // First run with --apply
    const res1 = runCli(['--credentials', fix.credPath, '--env-file', fix.envPath, '--apply']);
    assert.equal(res1.status, 0, res1.stderr);
    assert.doesNotMatch(res1.stdout, /secret-token-xyz-999|wxid_owner_123|super_secret_pg_pass|node_sec_999/);

    const out1 = JSON.parse(res1.stdout);
    assert.equal(out1.hasOwner, true);
    assert.equal(out1.alreadyAuthorized, false);
    assert.equal(out1.changed, true);
    assert.equal(out1.applied, true);

    const updatedContent = readFileSync(fix.envPath, 'utf8');
    const expectedContent =
      '# Header comment with special chars: $!@#%^&*()\r\n' +
      'POSTGRES_PASSWORD=super_secret_pg_pass\r\n' +
      'CONTROLLER_TOKEN="tok=123$abc"\n' +
      'ALLOWED_CHAT_IDS=wxid_owner_123\n' +
      'NODE_TOKENS={"macair":"node_sec_999"}\n' +
      'TRAILING_NO_NEWLINE=1';
    assert.equal(updatedContent, expectedContent);
    assert.equal(lstatSync(fix.envPath).mode & 0o777, 0o600);

    // Second run with --apply (idempotent)
    const res2 = runCli(['--credentials', fix.credPath, '--env-file', fix.envPath, '--apply']);
    assert.equal(res2.status, 0, res2.stderr);
    assert.doesNotMatch(res2.stdout, /secret-token-xyz-999|wxid_owner_123|super_secret_pg_pass|node_sec_999/);

    const out2 = JSON.parse(res2.stdout);
    assert.equal(out2.hasOwner, true);
    assert.equal(out2.alreadyAuthorized, true);
    assert.equal(out2.changed, false);
    assert.equal(out2.applied, false);
    assert.equal(readFileSync(fix.envPath, 'utf8'), expectedContent);
  } finally {
    fix.cleanup();
  }
});

test('refuses to overwrite when ALLOWED_CHAT_IDS has another ID or multiple IDs', () => {
  for (const existing of ['ALLOWED_CHAT_IDS=other_user_id', 'ALLOWED_CHAT_IDS=wxid_owner_123,other_id', 'ALLOWED_CHAT_IDS=synthetic-test']) {
    const envContent = `CONTROLLER_TOKEN=sec_tok\n${existing}\n`;
    const fix = createFixture({ envContent });
    try {
      const res = runCli(['--credentials', fix.credPath, '--env-file', fix.envPath, '--apply']);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /refusing to overwrite/);
      assert.doesNotMatch(res.stderr, /sec_tok|other_user_id|wxid_owner_123|secret-token-xyz-999/);
      assert.equal(readFileSync(fix.envPath, 'utf8'), envContent);
    } finally {
      fix.cleanup();
    }
  }
});

test('refuses when ALLOWED_CHAT_IDS= is missing or duplicated', () => {
  const fixMissing = createFixture({ envContent: 'CONTROLLER_TOKEN=sec_tok\n' });
  try {
    const res = runCli(['--credentials', fixMissing.credPath, '--env-file', fixMissing.envPath, '--apply']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /missing required ALLOWED_CHAT_IDS=/);
    assert.doesNotMatch(res.stderr, /sec_tok/);
  } finally {
    fixMissing.cleanup();
  }

  const fixDup = createFixture({ envContent: 'ALLOWED_CHAT_IDS=\nALLOWED_CHAT_IDS=\n' });
  try {
    const res = runCli(['--credentials', fixDup.credPath, '--env-file', fixDup.envPath, '--apply']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /multiple ALLOWED_CHAT_IDS=/);
  } finally {
    fixDup.cleanup();
  }

  for (const ambiguous of [
    'export ALLOWED_CHAT_IDS=\n',
    'ALLOWED_CHAT_IDS=\nexport ALLOWED_CHAT_IDS=other\n',
    '  ALLOWED_CHAT_IDS=\n',
    'ALLOWED_CHAT_IDS =\n',
  ]) {
    const fixAmb = createFixture({ envContent: `CONTROLLER_TOKEN=sec_tok\n${ambiguous}` });
    try {
      const res = runCli(['--credentials', fixAmb.credPath, '--env-file', fixAmb.envPath, '--apply']);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /ambiguous ALLOWED_CHAT_IDS/);
      assert.doesNotMatch(res.stderr, /sec_tok/);
    } finally {
      fixAmb.cleanup();
    }
  }
});

test('rejects invalid JSON, missing userId, or unsafe userId characters without leaking secrets', () => {
  const badPayloads = [
    '{bad json with secret-token-xyz-999',
    JSON.stringify({ token: 'secret-token-xyz-999' }),
    JSON.stringify({ token: 'secret-token-xyz-999', userId: '   ' }),
    JSON.stringify({ token: 'secret-token-xyz-999', userId: 'id with spaces' }),
    JSON.stringify({ token: 'secret-token-xyz-999', userId: 'id1,id2' }),
    JSON.stringify({ token: 'secret-token-xyz-999', userId: 'id1\nid2' }),
    JSON.stringify({ token: 'secret-token-xyz-999', userId: 'id$unsafe;rm' }),
  ];

  for (const payload of badPayloads) {
    const fix = createFixture({ accountData: payload });
    try {
      const res = runCli(['--credentials', fix.credPath, '--env-file', fix.envPath, '--apply']);
      assert.equal(res.status, 1);
      assert.doesNotMatch(res.stderr, /secret-token-xyz-999/);
      assert.doesNotMatch(res.stdout, /secret-token-xyz-999/);
    } finally {
      fix.cleanup();
    }
  }
});

test('rejects insecure file permissions, directory permissions, symlinks, and non-regular files', () => {
  // 1. Loose credentials file mode (0644)
  const fixLooseCred = createFixture({ credMode: 0o644 });
  try {
    const res = runCli(['--credentials', fixLooseCred.credPath, '--env-file', fixLooseCred.envPath]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Credentials file must have 0600 permissions/);
  } finally {
    fixLooseCred.cleanup();
  }

  // 2. Loose env file mode (0640)
  const fixLooseEnv = createFixture({ envMode: 0o640 });
  try {
    const res = runCli(['--credentials', fixLooseEnv.credPath, '--env-file', fixLooseEnv.envPath]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Env file must have 0600 permissions/);
  } finally {
    fixLooseEnv.cleanup();
  }

  // 3. Loose parent directory mode (0755)
  const fixLooseDir = createFixture({ dirMode: 0o755 });
  try {
    const res = runCli(['--credentials', fixLooseDir.credPath, '--env-file', fixLooseDir.envPath]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Parent directory .* must have 0700 permissions/);
  } finally {
    chmodSync(fixLooseDir.secureDir, 0o700);
    fixLooseDir.cleanup();
  }

  // 4. Symlink rejection
  const fixSym = createFixture();
  try {
    const symEnv = join(fixSym.secureDir, 'symlink.env');
    symlinkSync(fixSym.envPath, symEnv);
    const res = runCli(['--credentials', fixSym.credPath, '--env-file', symEnv]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /must not be a symbolic link/);
  } finally {
    fixSym.cleanup();
  }

  // 5. Non-regular file (directory passed as file)
  const fixNonReg = createFixture();
  try {
    const subDir = join(fixNonReg.secureDir, 'subdir');
    mkdirSync(subDir, { mode: 0o600 });
    const res = runCli(['--credentials', subDir, '--env-file', fixNonReg.envPath]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /must be a regular file/);
  } finally {
    fixNonReg.cleanup();
  }
});
