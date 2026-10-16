import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../../live/session.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('test-live-session --help exits 0 with standard options', () => {
  const result = run('--help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--session <id>/);
  assert.match(result.stdout, /--controller <url>/);
  assert.match(result.stdout, /--timeout <ms>/);
  assert.match(result.stdout, /--pollInterval <ms>/);
  assert.doesNotMatch(result.stdout, /--message/);
  assert.doesNotMatch(result.stdout, /--chat/);
});

test('test-live-session fails when --session is missing', () => {
  const result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing required option: --session/);
});

test('test-live-session strictly validates timeout and pollInterval numbers', () => {
  const badTimeout = run('--session', '00000000-0000-0000-0000-000000000000', '--timeout', 'not-a-number');
  assert.equal(badTimeout.status, 1);
  assert.match(badTimeout.stderr, /must be a positive integer/);

  const zeroInterval = run('--session', '00000000-0000-0000-0000-000000000000', '--pollInterval', '0');
  assert.equal(zeroInterval.status, 1);
  assert.match(zeroInterval.stderr, /must be a positive integer/);
});

test('test-live-session rejects credentials in controller URL', () => {
  const result = run('--session', '00000000-0000-0000-0000-000000000000', '--controller', 'http://user:pass@127.0.0.1:8790');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Controller URL must not contain credentials/);
});

test('test-live-session rejects query parameters and fragments including empty ? and #', () => {
  for (const badUrl of [
    'http://127.0.0.1:8790?token=secret',
    'http://127.0.0.1:8790#frag',
    'http://127.0.0.1:8790?',
    'http://127.0.0.1:8790/?',
    'http://127.0.0.1:8790#',
    'http://127.0.0.1:8790/#',
    'https://leader.example.com?',
    'https://leader.example.com#',
  ]) {
    const result = run('--session', '00000000-0000-0000-0000-000000000000', '--controller', badUrl);
    assert.equal(result.status, 1, `Expected failure for ${badUrl}`);
    assert.match(result.stderr, /Controller URL must not contain credentials, query parameters, or fragments/);
  }
});

test('test-live-session fails safely when targeting nonexistent session', async () => {
  let writes = 0;
  const server = createServer((request, response) => {
    if (request.method !== 'GET') writes++;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ nodes: [{ nodeId: 'demoair', connected: true }], sessions: [] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const child = spawn(process.execPath, [cli, '--session', 'missing', '--controller', `http://127.0.0.1:${server.address().port}`], {
      env: { ...process.env, CONTROLLER_TOKEN: 'synthetic-test-token' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let error = '';
    child.stderr.on('data', chunk => { error += chunk; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 1);
    assert.match(error, /not found in Controller status/);
    assert.equal(writes, 0);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
