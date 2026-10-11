import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('./test-wechat-model.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('test-wechat-model --help exits 0 with options', () => {
  const result = run('--help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--session ID/);
  assert.match(result.stdout, /--url URL/);
});

test('test-wechat-model fails when --session is missing', () => {
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--session <sessionId> is required/);
});

test('test-wechat-model rejects userinfo, query parameters, and fragments in controller URL', () => {
  for (const badUrl of [
    'http://user:pass@127.0.0.1:8790',
    'https://token@leader.example.com',
    'http://127.0.0.1:8790?token=secret',
    'https://leader.example.com/?a=1',
    'http://127.0.0.1:8790#frag',
    'https://leader.example.com/#frag',
    'http://127.0.0.1:8790?',
    'http://127.0.0.1:8790/?',
    'http://127.0.0.1:8790#',
    'http://127.0.0.1:8790/#',
    'https://leader.example.com?',
    'https://leader.example.com/?',
    'https://leader.example.com#',
    'https://leader.example.com/#',
  ]) {
    const result = run('--session', '00000000-0000-0000-0000-000000000000', '--url', badUrl);
    assert.equal(result.status, 1, `Expected failure for ${badUrl}`);
    assert.match(result.stderr, /Controller URL must not contain credentials, query parameters, or fragments/);
  }
});

test('test-wechat-model rejects non-TLS remote controller URLs and non-HTTP schemes', () => {
  for (const badUrl of [
    'http://leader.example.com:8790',
    'http://192.168.1.10:8790',
    'ws://127.0.0.1:8790',
    'wss://leader.example.com',
  ]) {
    const result = run('--session', '00000000-0000-0000-0000-000000000000', '--url', badUrl);
    assert.equal(result.status, 1, `Expected failure for ${badUrl}`);
    assert.match(result.stderr, /Remote Controller requires HTTPS/);
  }
});

test('test-wechat-model accepts remote HTTPS and loopback HTTP URLs past URL validation', () => {
  for (const validUrl of [
    'https://leader.example.com',
    'https://leader.example.com:8443',
    'http://127.0.0.1:8790',
    'http://localhost:8790',
    'http://[::1]:8790',
  ]) {
    const result = run('--session', '00000000-0000-0000-0000-000000000000', '--url', validUrl, '--chat', 'not-synthetic');
    assert.equal(result.status, 1, `Expected chat validation failure for ${validUrl}`);
    assert.match(result.stderr, /Use a synthetic- test chat ID/);
  }
});
