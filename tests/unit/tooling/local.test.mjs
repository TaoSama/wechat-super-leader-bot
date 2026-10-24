import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { resolveControllerUrls } from '../../../scripts/local.mjs';

const cli = fileURLToPath(new URL('../../../scripts/local.mjs', import.meta.url));
const run = (args, envOverrides = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, ...envOverrides } });

test('import does not parse or execute the caller CLI', () => {
  const moduleUrl = new URL('../../../scripts/local.mjs', import.meta.url).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(moduleUrl)}); console.log('imported');`, '--', '--caller-option'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'imported');
});

test('help describes the explicit simulation boundary without loading credentials', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--simulation-chat/);
  assert.match(result.stdout, /does not change private config or start WeChat/);
  assert.match(result.stdout, /--controller URL/);
});

test('simulation identities cannot be used for gateway or status modes', () => {
  for (const mode of ['--gateway', '--check', '--daemon']) {
    const result = run([mode, '--simulation-chat', 'synthetic-test']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires --up/);
  }
});

test('simulation option rejects real-looking and malformed identities before deployment', () => {
  for (const chat of ['real-user', 'synthetic-', 'synthetic-a,b', 'synthetic-a\n']) {
    const result = run(['--up', '--simulation-chat', chat]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /synthetic- prefixed test ID/);
  }
});

test('resolveControllerUrls validates and normalizes loopback and remote HTTPS targets', () => {
  const loopback = resolveControllerUrls('http://127.0.0.1:8790');
  assert.equal(loopback.httpUrl, 'http://127.0.0.1:8790');
  assert.equal(loopback.wsUrl, 'ws://127.0.0.1:8790/v1/daemon');
  assert.equal(loopback.isRemote, false);

  const remote = resolveControllerUrls('https://leader.example.com');
  assert.equal(remote.httpUrl, 'https://leader.example.com');
  assert.equal(remote.wsUrl, 'wss://leader.example.com/v1/daemon');
  assert.equal(remote.isRemote, true);

  const customPortAndPath = resolveControllerUrls('https://leader.example.com:8443/custom/path/');
  assert.equal(customPortAndPath.httpUrl, 'https://leader.example.com:8443/custom/path');
  assert.equal(customPortAndPath.wsUrl, 'wss://leader.example.com:8443/custom/path/v1/daemon');
  assert.equal(customPortAndPath.isRemote, true);
});

test('resolveControllerUrls rejects insecure, userinfo, queries and fragments', () => {
  assert.throws(() => resolveControllerUrls('http://remote.host.site:8790'), /Remote controller URL requires https/);
  assert.throws(() => resolveControllerUrls('https://user:pass@leader.example.com'), /user credentials/);
  assert.throws(() => resolveControllerUrls('https://leader.example.com?foo=bar'), /query parameters/);
  assert.throws(() => resolveControllerUrls('https://leader.example.com?'), /query parameters/);
  assert.throws(() => resolveControllerUrls('https://leader.example.com#hash'), /URL fragments/);
  assert.throws(() => resolveControllerUrls('https://leader.example.com#'), /URL fragments/);
  assert.throws(() => resolveControllerUrls('ftp://leader.example.com'), /Unsupported protocol/);
  assert.throws(() => resolveControllerUrls(''), /non-empty string/);
});

test('--controller flag is rejected for --up and --down to protect local Docker lifecycle', () => {
  for (const mode of ['--up', '--down']) {
    const result = run([mode, '--controller', 'https://leader.example.com']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--controller is not allowed with --up or --down/);
  }
});

test('remote CONTROLLER_URL environment variable rejects --up and --down', () => {
  for (const mode of ['--up', '--down']) {
    const result = run([mode], { CONTROLLER_URL: 'https://leader.example.com' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /CONTROLLER_URL points to a remote controller/);
  }
});
