import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createPostgresFixture } from '../../support/control-plane-fixture.mjs';

const integration = fileURLToPath(new URL('../../integration/run.mjs', import.meta.url));
const live = fileURLToPath(new URL('../../live/control-plane.mjs', import.meta.url));
const env = { PATH: '/nonexistent', SUPER_LEADER_NO_DOTENV: '1' };
const run = (cli, ...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });

test('synthetic integration help works without tools and does not expose live flags', () => {
  for (const option of ['--help', '-h']) {
    const result = run(integration, option);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /simulated desktop sockets/);
    assert.match(result.stdout, /tests\/live\/control-plane\.mjs/);
    assert.doesNotMatch(result.stdout, /--live|--session/);
  }
});

test('synthetic integration rejects former live/session options before starting fixtures', () => {
  for (const args of [['--live'], ['--session', 'test-session'], ['--help', '--live'], ['unexpected']]) {
    const result = run(integration, ...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ERR_PARSE_ARGS/);
    assert.doesNotMatch(result.stderr, /docker|ENOENT/);
  }
});

test('readonly live control plane help documents explicit opt-in and socket selection', () => {
  for (const option of ['--help', '-h']) {
    const result = run(live, option);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--run --socket \/absolute\/codex\.sock/);
    assert.match(result.stdout, /--session ID/);
    assert.match(result.stdout, /Never contacts WeChat, sends prompts/);
  }
});

test('readonly live control plane requires opt-in before any resource access', () => {
  for (const args of [[], ['--session', 'test-session'], ['--socket', '/fixture/codex.sock']]) {
    const result = run(live, ...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Explicit --run required/);
    assert.doesNotMatch(result.stderr, /docker|ENOENT/);
  }
});

test('readonly live control plane requires an explicit absolute socket, ignoring inherited selection', () => {
  const missing = spawnSync(process.execPath, [live, '--run'], {
    encoding: 'utf8', env: { ...env, CODEX_APP_SERVER_SOCKET: '/existing/default.sock' },
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing required option: --socket/);
  for (const path of ['relative.sock', '/fixture/socket\n.sock']) {
    const invalid = run(live, '--run', '--socket', path);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /absolute path without control characters/);
  }
  const session = run(live, '--run', '--socket', '/fixture/codex.sock', '--session', ' ');
  assert.equal(session.status, 1);
  assert.match(session.stderr, /--session must not be empty/);
});

test('readonly live control plane rejects unknown or former integration opt-in flags', () => {
  for (const args of [['--live'], ['--run', '--send'], ['unexpected']]) {
    const result = run(live, ...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ERR_PARSE_ARGS/);
  }
});

test('temporary PostgreSQL fixture rejects remote Docker before container access', async () => {
  const postgres = createPostgresFixture({ env: { PATH: '/nonexistent', DOCKER_HOST: 'ssh://remote.example' } });
  await assert.rejects(postgres.start(), /local Unix Docker socket/);
  assert.doesNotThrow(() => postgres.stop(), 'Failed readiness must not stop an uncreated container');
});
