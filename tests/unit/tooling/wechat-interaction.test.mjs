import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { RAW_REPLY, RESUMABLE_REPLY } from '../../integration/leader/reliable-delivery.mjs';

const cli = fileURLToPath(new URL('../../integration/leader/wechat-interaction.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
  encoding: 'utf8', env: { PATH: '/nonexistent', SUPER_LEADER_NO_DOTENV: '1' },
});

test('WeChat synthetic integration requires run opt-in before any fixture or credentials access', () => {
  for (const args of [[], ['--help'], ['-h']]) {
    const result = run(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--run/);
    assert.match(result.stdout, /disposable PostgreSQL/);
    assert.match(result.stdout, /Never reads live credentials or sessions/);
    assert.doesNotMatch(result.stderr, /ENOENT|docker|credentials/);
  }
});

test('WeChat synthetic integration rejects remote/live selectors before startup', () => {
  for (const args of [['--live'], ['--url', 'https://production.example'], ['--session', 'real-session'], ['unexpected']]) {
    const result = run(...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ERR_PARSE_ARGS/);
    assert.doesNotMatch(result.stderr, /ENOENT|docker/);
  }
});

test('large-result acceptance fixture covers the former 128KiB boundary with Markdown and Unicode', () => {
  assert(Buffer.byteLength(RAW_REPLY, 'utf8') > 128 * 1_024);
  assert.match(RAW_REPLY, /\| 项目 \| 数量 \|/u);
  assert.match(RAW_REPLY, /```typescript\nconst 结果 = "中文😀";/u);
  assert(RAW_REPLY.endsWith('\n完整报告终段。'));
});

test('ordinary reply fixture crosses the WeChat split boundary within the planner response budget', () => {
  assert(RESUMABLE_REPLY.length > 4_000);
  assert(RESUMABLE_REPLY.length < 4_500);
  assert.equal(RESUMABLE_REPLY, RESUMABLE_REPLY.trim());
});
