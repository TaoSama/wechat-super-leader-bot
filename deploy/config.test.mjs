import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execCompose } from '../scripts/compose-command.mjs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const fakeEnv = {
  PATH: process.env.PATH,
  COMPOSE_DISABLE_ENV_FILE: 'true',
  POSTGRES_PASSWORD: 'synthetic-test-password',
  CONTROLLER_TOKEN: 'synthetic-controller-token',
  NODE_TOKENS: '{"fixture":"synthetic-node-token"}',
};

const production = JSON.parse(execCompose([
  '--env-file', '/dev/null',
  '-f', fileURLToPath(new URL('../compose.yaml', import.meta.url)),
  '-f', fileURLToPath(new URL('./compose.production.yaml', import.meta.url)),
  'config', '--format', 'json',
], { encoding: 'utf8', timeout: 10000, env: fakeEnv }));

test('configuration validation ignores cwd dotenv and ambient Compose file selectors', () => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'compose-env-isolation-'));
  const selectors = ['COMPOSE_ENV_FILES', 'COMPOSE_FILE', 'COMPOSE_PROFILES'];
  const original = new Map(selectors.map(key => [key, process.env[key]]));
  try {
    const envBody = 'LEADER_MODEL_API_KEY=synthetic-file-api-key\nNODE_TOKENS=synthetic-file-node-token\n';
    writeFileSync(join(fixtureDir, '.env'), envBody);
    writeFileSync(join(fixtureDir, 'external.env'), envBody);
    const composePath = join(fixtureDir, 'compose.yaml');
    writeFileSync(composePath, [
      'services:',
      '  fixture:',
      '    image: alpine:synthetic-not-run',
      '    environment:',
      '      LEADER_MODEL_API_KEY: ${LEADER_MODEL_API_KEY:-}',
      '      NODE_TOKENS: ${NODE_TOKENS:?synthetic-token-required}',
    ].join('\n'));
    process.env.COMPOSE_ENV_FILES = join(fixtureDir, 'external.env');
    process.env.COMPOSE_FILE = join(fixtureDir, 'missing.yaml');
    process.env.COMPOSE_PROFILES = 'synthetic-unwanted-profile';
    const parsed = JSON.parse(execCompose([
      '--env-file', '/dev/null', '--project-directory', fixtureDir, '-f', composePath,
      'config', '--format', 'json',
    ], { encoding: 'utf8', timeout: 10000, cwd: fixtureDir, env: fakeEnv }));
    assert.equal(parsed.services.fixture.environment.LEADER_MODEL_API_KEY, '');
    assert.equal(parsed.services.fixture.environment.NODE_TOKENS, fakeEnv.NODE_TOKENS);
  } finally {
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('production tmpfs options form exactly one mount', () => {
  assert.deepEqual(production.services.controller.tmpfs, ['/tmp:size=16m,mode=1777']);
});

test('production uses the explicitly configured console origin', () => {
  assert.equal(production.services.controller.environment.CONSOLE_PUBLIC_URL, 'https://leader.taoai.site');
});

test('only loopback controller is published; PostgreSQL remains private', () => {
  assert.equal(production.services.controller.ports.length, 1);
  assert.equal(production.services.controller.ports[0].host_ip, '127.0.0.1');
  assert.equal(production.services.controller.ports[0].target, 8790);
  assert.equal(production.services.postgres.ports, undefined);
  assert.equal(production.services.controller.read_only, true);
  assert.deepEqual(production.services.controller.cap_drop, ['ALL']);
});

test('Nginx keeps WSS upgrades and HTTP requests on the same protected endpoint', () => {
  const nginx = readFileSync(new URL('./nginx.conf', import.meta.url), 'utf8');
  assert.match(nginx, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(nginx, /proxy_set_header Connection \$super_leader_connection_upgrade;/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:8790;/);
  assert.match(nginx, /return 308 https:\/\/leader\.taoai\.site\$request_uri;/);
  assert.match(nginx, /access_log off;/);
  assert.doesNotMatch(nginx, /proxy_set_header Authorization/);
});
