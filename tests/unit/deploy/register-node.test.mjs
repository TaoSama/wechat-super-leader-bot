import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, symlinkSync, rmSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { inspectAndPatchEnv, registerNode } from '../../../deploy/register-node.mjs';

const cliPath = fileURLToPath(new URL('../../../deploy/register-node.mjs', import.meta.url));
const unsafeTokens = ['synthetic#token', 'synthetic$token', 'synthetic${TOKEN}', "synthetic'token",
  'synthetic"token', 'synthetic`token', 'synthetic\\token', 'synthetic/token', 'synthetic+token',
  'synthetic=token', 'synthetic token', 'synthetic\ntoken', 'synthetic\r', 'synthetic\u0000token', 'synthetic令牌'];

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' });
}

function createFixture({
  tokenData = 'synthetic-node-token-xyz-999',
  envContent = 'POSTGRES_PASSWORD=super_secret_pg_pass\nNODE_TOKENS={"demoair":"node_sec_999"}\n',
  dirMode = 0o700,
  tokenMode = 0o600,
  envMode = 0o600,
} = {}) {
  const baseDir = mkdtempSync(join(tmpdir(), 'reg-node-test-'));
  const secureDir = join(baseDir, 'runtime');
  mkdirSync(secureDir, { mode: dirMode });
  chmodSync(secureDir, dirMode);

  const tokenPath = join(secureDir, 'node-token.txt');
  const envPath = join(secureDir, 'controller.env');

  if (tokenData !== null) {
    writeFileSync(tokenPath, tokenData, { mode: tokenMode });
    chmodSync(tokenPath, tokenMode);
  }
  if (envContent !== null) {
    writeFileSync(envPath, envContent, { mode: envMode });
    chmodSync(envPath, envMode);
  }

  return {
    baseDir,
    secureDir,
    tokenPath,
    envPath,
    cleanup: () => rmSync(baseDir, { recursive: true, force: true }),
  };
}

test('CLI --help and -h print usage without reading files', () => {
  for (const flag of ['--help', '-h']) {
    const res = runCli([flag]);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage: node deploy\/register-node\.mjs/);
    assert.match(res.stdout, /--node-id <id>/);
    assert.match(res.stdout, /--token-file <path>/);
    assert.match(res.stdout, /--env-file <path>/);
    assert.match(res.stdout, /--apply/);
  }
});

test('CLI rejects positional arguments and missing options', () => {
  const resPos = runCli(['positional-arg']);
  assert.equal(resPos.status, 1);

  const fix = createFixture();
  try {
    const resNoNode = runCli(['--token-file', fix.tokenPath, '--env-file', fix.envPath]);
    assert.equal(resNoNode.status, 1);
    assert.match(resNoNode.stderr, /Missing required option: --node-id/);

    const resNoToken = runCli(['--node-id', 'demomini', '--env-file', fix.envPath]);
    assert.equal(resNoToken.status, 1);
    assert.match(resNoToken.stderr, /Missing required option: --token-file/);

    const resNoEnv = runCli(['--node-id', 'demomini', '--token-file', fix.tokenPath]);
    assert.equal(resNoEnv.status, 1);
    assert.match(resNoEnv.stderr, /Missing required option: --env-file/);
  } finally {
    fix.cleanup();
  }
});

test('import does not execute caller CLI', () => {
  const moduleUrl = new URL('../../../deploy/register-node.mjs', import.meta.url).href;
  const res = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)}); console.log('ok');`, '--', '--unknown-flag'],
    { encoding: 'utf8' }
  );
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), 'ok');
});

test('dry-run (default) detects addition without modifying .env or leaking secrets', () => {
  const fix = createFixture();
  try {
    const originalBytes = readFileSync(fix.envPath);
    const res = runCli(['--node-id', 'demomini', '--token-file', fix.tokenPath, '--env-file', fix.envPath]);
    assert.equal(res.status, 0, res.stderr);

    // Output must be redacted: no token and no env secrets
    assert.doesNotMatch(res.stdout, /synthetic-node-token/);
    assert.doesNotMatch(res.stdout, /node_sec_999/);
    assert.doesNotMatch(res.stdout, /super_secret_pg_pass/);

    const parsed = JSON.parse(res.stdout);
    assert.equal(parsed.nodeId, 'demomini');
    assert.equal(parsed.nodeCount, 2);
    assert.equal(parsed.alreadyRegistered, false);
    assert.equal(parsed.changed, true);
    assert.equal(parsed.applied, false);
    assert.equal(parsed.dryRun, true);

    assert.deepEqual(readFileSync(fix.envPath), originalBytes);
  } finally {
    fix.cleanup();
  }
});

test('--apply updates NODE_TOKENS, preserves other lines/bytes, and preserves 0600 mode', () => {
  const envWithSpecialBytes =
    '# Header comment with special chars: $!@#%^&*()\r\n' +
    'POSTGRES_PASSWORD=super_secret_pg_pass\r\n' +
    'NODE_TOKENS={"demoair":"node_sec_999"}\n' +
    'TRAILING_NO_NEWLINE=1';
  const fix = createFixture({ envContent: envWithSpecialBytes });
  try {
    const res = runCli(['--node-id', 'demomini', '--token-file', fix.tokenPath, '--env-file', fix.envPath, '--apply']);
    assert.equal(res.status, 0, res.stderr);
    assert.doesNotMatch(res.stdout, /synthetic-node-token|node_sec_999|super_secret_pg_pass/);

    const out = JSON.parse(res.stdout);
    assert.equal(out.nodeId, 'demomini');
    assert.equal(out.nodeCount, 2);
    assert.equal(out.alreadyRegistered, false);
    assert.equal(out.changed, true);
    assert.equal(out.applied, true);

    const updated = readFileSync(fix.envPath, 'utf8');
    const expected =
      '# Header comment with special chars: $!@#%^&*()\r\n' +
      'POSTGRES_PASSWORD=super_secret_pg_pass\r\n' +
      'NODE_TOKENS={"demoair":"node_sec_999","demomini":"synthetic-node-token-xyz-999"}\n' +
      'TRAILING_NO_NEWLINE=1';
    assert.equal(updated, expected);
    assert.equal(lstatSync(fix.envPath).mode & 0o777, 0o600);
  } finally {
    fix.cleanup();
  }
});

test('--apply preserves single-quoted NODE_TOKENS format in env file', () => {
  const envSingleQuoted = "POSTGRES_PASSWORD=pass\nNODE_TOKENS='{\"demoair\":\"node_sec_999\"}'\n";
  const fix = createFixture({ envContent: envSingleQuoted });
  try {
    const res = runCli(['--node-id', 'demomini', '--token-file', fix.tokenPath, '--env-file', fix.envPath, '--apply']);
    assert.equal(res.status, 0, res.stderr);
    const updated = readFileSync(fix.envPath, 'utf8');
    const expected = "POSTGRES_PASSWORD=pass\nNODE_TOKENS='{\"demoair\":\"node_sec_999\",\"demomini\":\"synthetic-node-token-xyz-999\"}'\n";
    assert.equal(updated, expected);
  } finally {
    fix.cleanup();
  }
});

test('idempotent when node already registered with same token', () => {
  const fix = createFixture();
  try {
    // Register once
    const res1 = runCli(['--node-id', 'demomini', '--token-file', fix.tokenPath, '--env-file', fix.envPath, '--apply']);
    assert.equal(res1.status, 0);
    const contentAfterFirst = readFileSync(fix.envPath, 'utf8');

    // Register again with exact same node and token
    const res2 = runCli(['--node-id', 'demomini', '--token-file', fix.tokenPath, '--env-file', fix.envPath, '--apply']);
    assert.equal(res2.status, 0, res2.stderr);
    assert.doesNotMatch(res2.stdout, /synthetic-node-token|node_sec_999/);

    const out2 = JSON.parse(res2.stdout);
    assert.equal(out2.nodeId, 'demomini');
    assert.equal(out2.alreadyRegistered, true);
    assert.equal(out2.changed, false);
    assert.equal(out2.applied, false);
    assert.equal(readFileSync(fix.envPath, 'utf8'), contentAfterFirst);
  } finally {
    fix.cleanup();
  }
});

test('refuses to overwrite when node already registered with a different token', () => {
  const fix = createFixture({ envContent: 'NODE_TOKENS={"demoair":"token_a"}\n' });
  try {
    // Attempt to register demoair with token in fix.tokenPath (synthetic-node-token-xyz-999)
    const res = runCli(['--node-id', 'demoair', '--token-file', fix.tokenPath, '--env-file', fix.envPath, '--apply']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /refusing to overwrite/);
    assert.doesNotMatch(res.stderr, /token_a|synthetic-node-token/);
    assert.equal(readFileSync(fix.envPath, 'utf8'), 'NODE_TOKENS={"demoair":"token_a"}\n');
  } finally {
    fix.cleanup();
  }
});

test('refuses duplicate token used by another node', () => {
  const fix = createFixture({
    tokenData: 'shared-node-token-xyz-999',
    envContent: 'NODE_TOKENS={"demoair":"shared-node-token-xyz-999"}\n',
  });
  try {
    const res = runCli(['--node-id', 'demomini', '--token-file', fix.tokenPath, '--env-file', fix.envPath, '--apply']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /duplicate token rejected/);
    assert.doesNotMatch(res.stderr, /shared-node-token/);
  } finally {
    fix.cleanup();
  }
});

test('refuses when NODE_TOKENS= is missing, duplicated, or ambiguous', () => {
  const fixMissing = createFixture({ envContent: 'CONTROLLER_TOKEN=sec_tok\n' });
  try {
    const res = runCli(['--node-id', 'demomini', '--token-file', fixMissing.tokenPath, '--env-file', fixMissing.envPath, '--apply']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /missing required NODE_TOKENS=/);
  } finally {
    fixMissing.cleanup();
  }

  const fixDup = createFixture({ envContent: 'NODE_TOKENS={}\nNODE_TOKENS={}\n' });
  try {
    const res = runCli(['--node-id', 'demomini', '--token-file', fixDup.tokenPath, '--env-file', fixDup.envPath, '--apply']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /multiple NODE_TOKENS=/);
  } finally {
    fixDup.cleanup();
  }

  for (const ambiguous of [
    'export NODE_TOKENS={}\n',
    'NODE_TOKENS={}\nexport NODE_TOKENS={}\n',
    '  NODE_TOKENS={}\n',
    'NODE_TOKENS ={}\n',
  ]) {
    const fixAmb = createFixture({ envContent: ambiguous });
    try {
      const res = runCli(['--node-id', 'demomini', '--token-file', fixAmb.tokenPath, '--env-file', fixAmb.envPath, '--apply']);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /ambiguous NODE_TOKENS entry/);
    } finally {
      fixAmb.cleanup();
    }
  }
});

test('refuses when NODE_TOKENS is invalid JSON, null, array, or contains non-string tokens', () => {
  const badContents = [
    'NODE_TOKENS=not_valid_json_at_all\n',
    'NODE_TOKENS=null\n',
    'NODE_TOKENS=[]\n',
    'NODE_TOKENS="just-a-string"\n',
    'NODE_TOKENS={"node1": 12345}\n',
  ];
  for (const content of badContents) {
    const fix = createFixture({ envContent: content });
    try {
      const res = runCli(['--node-id', 'demomini', '--token-file', fix.tokenPath, '--env-file', fix.envPath, '--apply']);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /NODE_TOKENS in env file/);
    } finally {
      fix.cleanup();
    }
  }
});

test('refuses invalid nodeId characters and length', () => {
  const badNodeIds = [
    'node with spaces',
    'node$injection',
    'node;rm',
    'node/slash',
    'a'.repeat(65),
  ];
  const fix = createFixture();
  try {
    for (const badId of badNodeIds) {
      const res = runCli(['--node-id', badId, '--token-file', fix.tokenPath, '--env-file', fix.envPath]);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /Node ID contains invalid characters/);
    }
  } finally {
    fix.cleanup();
  }
});

test('refuses invalid token file contents (empty, whitespace, multi-line, too short, too long)', () => {
  const badTokens = [
    '',
    'short',
    'token with spaces',
    'token\nwith\nnewlines',
    'x'.repeat(513),
  ];
  for (const badTok of badTokens) {
    const fix = createFixture({ tokenData: badTok });
    try {
      const res = runCli(['--node-id', 'demomini', '--token-file', fix.tokenPath, '--env-file', fix.envPath]);
      assert.equal(res.status, 1);
      assert.match(res.stderr, /Token/);
    } finally {
      fix.cleanup();
    }
  }
});

test('exported env patcher rejects unsafe tokens without leaking input or accepting an unsafe idempotent token', () => {
  const original = 'NODE_TOKENS={"demoair":"node_sec_999"}\n';
  for (const token of unsafeTokens) {
    for (const content of [original, `NODE_TOKENS=${JSON.stringify({ demomini: token })}\n`]) {
      assert.throws(() => inspectAndPatchEnv(content, 'demomini', token), error => {
        assert.match(error.message, /Token must contain only ASCII/);
        assert.equal(error.message.includes(token), false);
        return true;
      });
    }
  }
  for (const token of [undefined, null, 123, {}, '', 'short', 'x'.repeat(513)]) {
    assert.throws(() => inspectAndPatchEnv(original, 'demomini', token), /Token/);
  }
});

test('CLI rejects unsafe token characters before modifying env in dry-run and apply modes', () => {
  for (const token of unsafeTokens) {
    const fix = createFixture({ tokenData: token });
    try {
      const before = readFileSync(fix.envPath);
      for (const flags of [[], ['--apply']]) {
        const result = runCli(['--node-id', 'demomini', '--token-file', fix.tokenPath, '--env-file', fix.envPath, ...flags]);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Token must contain only ASCII/);
        assert.equal(`${result.stdout}${result.stderr}`.includes(token), false);
        assert.doesNotMatch(`${result.stdout}${result.stderr}`, /node_sec_999|super_secret_pg_pass/);
        assert.deepEqual(readFileSync(fix.envPath), before);
        assert.deepEqual(readdirSync(fix.secureDir).sort(), ['controller.env', 'node-token.txt']);
      }
    } finally { fix.cleanup(); }
  }
});

test('safe hex and base64url tokens register and remain byte-idempotent through both entry points', () => {
  const tokens = ['0123456789abcdef'.repeat(4), 'Aa0_-Bb1'.repeat(6)];
  for (const token of tokens) {
    const original = 'KEEP_LINE=unchanged\r\nNODE_TOKENS={"demoair":"node_sec_999","other":"old_token_unchanged"}\n';
    const patch = inspectAndPatchEnv(original, 'demomini', token);
    assert.equal(patch.changed, true);
    assert.equal(patch.nodeCount, 3);
    assert.equal(patch.newContent, `KEEP_LINE=unchanged\r\nNODE_TOKENS=${JSON.stringify({ demoair: 'node_sec_999', other: 'old_token_unchanged', demomini: token })}\n`);
    assert.equal(inspectAndPatchEnv(patch.newContent, 'demomini', token).newContent, patch.newContent);
    assert.equal(inspectAndPatchEnv(patch.newContent, 'demomini', token).changed, false);
    const fix = createFixture({ tokenData: `${token}\r\n`, envContent: original });
    try {
      for (const expectedApplied of [true, false]) {
        const result = runCli(['--node-id', 'demomini', '--token-file', fix.tokenPath, '--env-file', fix.envPath, '--apply']);
        assert.equal(result.status, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.equal(output.applied, expectedApplied);
        assert.equal(output.alreadyRegistered, !expectedApplied);
        assert.equal(readFileSync(fix.envPath, 'utf8'), patch.newContent);
        assert.equal(result.stdout.includes(token), false);
      }
    } finally { fix.cleanup(); }
  }
});

test('rejects insecure file permissions, parent directory permissions, symlinks, and non-regular files', () => {
  // 1. Loose token file mode (0644)
  const fixLooseToken = createFixture({ tokenMode: 0o644 });
  try {
    const res = runCli(['--node-id', 'demomini', '--token-file', fixLooseToken.tokenPath, '--env-file', fixLooseToken.envPath]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Token file must have 0600 permissions/);
  } finally {
    fixLooseToken.cleanup();
  }

  // 2. Loose env file mode (0644)
  const fixLooseEnv = createFixture({ envMode: 0o644 });
  try {
    const res = runCli(['--node-id', 'demomini', '--token-file', fixLooseEnv.tokenPath, '--env-file', fixLooseEnv.envPath]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Env file must have 0600 permissions/);
  } finally {
    fixLooseEnv.cleanup();
  }

  // 3. Loose parent directory mode (0755)
  const fixLooseDir = createFixture({ dirMode: 0o755 });
  try {
    const res = runCli(['--node-id', 'demomini', '--token-file', fixLooseDir.tokenPath, '--env-file', fixLooseDir.envPath]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Parent directory for Token must have 0700 permissions/);
  } finally {
    chmodSync(fixLooseDir.secureDir, 0o700);
    fixLooseDir.cleanup();
  }

  // 4. Symlink token file
  const fixSymToken = createFixture();
  try {
    const symPath = join(fixSymToken.secureDir, 'sym-token.txt');
    symlinkSync(fixSymToken.tokenPath, symPath);
    const res = runCli(['--node-id', 'demomini', '--token-file', symPath, '--env-file', fixSymToken.envPath]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Token file must not be a symbolic link/);
  } finally {
    fixSymToken.cleanup();
  }

  // 5. Directory passed as token file
  const fixDirAsFile = createFixture();
  try {
    const subDir = join(fixDirAsFile.secureDir, 'token-dir');
    mkdirSync(subDir, { mode: 0o600 });
    const res = runCli(['--node-id', 'demomini', '--token-file', subDir, '--env-file', fixDirAsFile.envPath]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /Token path must be a regular file/);
  } finally {
    fixDirAsFile.cleanup();
  }
});

test('detects concurrent modification and aborts write', () => {
  const fix = createFixture();
  try {
    assert.throws(
      () => {
        registerNode({
          nodeId: 'demomini',
          tokenFilePath: fix.tokenPath,
          envPath: fix.envPath,
          apply: true,
          _onBeforeCommit: () => {
            // Mutate file right before atomic commit
            writeFileSync(fix.envPath, 'NODE_TOKENS={"interfering":"modification"}\n');
          },
        });
      },
      (err) => err instanceof Error && /Concurrent modification detected on env file/.test(err.message)
    );
  } finally {
    fix.cleanup();
  }
});

test('atomic write does not leave temp or backup files on failure or success', () => {
  const fix = createFixture();
  try {
    const res = runCli(['--node-id', 'demomini', '--token-file', fix.tokenPath, '--env-file', fix.envPath, '--apply']);
    assert.equal(res.status, 0);
    const files = readdirSync(fix.secureDir);
    for (const file of files) {
      assert.equal(file.endsWith('.tmp'), false, `Temporary file leaked: ${file}`);
      assert.equal(file.endsWith('.bak'), false, `Backup file found: ${file}`);
    }
  } finally {
    fix.cleanup();
  }
});
