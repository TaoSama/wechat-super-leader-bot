import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execCompose } from '../../../scripts/lib/compose-command.mjs';
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
  '-f', fileURLToPath(new URL('../../../compose.yaml', import.meta.url)),
  '-f', fileURLToPath(new URL('../../../deploy/compose.production.yaml', import.meta.url)),
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
  assert.deepEqual(production.services.controller.tmpfs, ['/tmp:size=64m,mode=1777']);
});

test('database passwords with URI delimiters reach PostgreSQL and the controller unchanged', () => {
  for (const password of ['synthetic#password', 'synthetic/password', ' synthetic#/%:@? password ']) {
    const configured = JSON.parse(execCompose([
      '--env-file', '/dev/null',
      '-f', fileURLToPath(new URL('../../../compose.yaml', import.meta.url)),
      'config', '--format', 'json',
    ], { encoding: 'utf8', timeout: 10000, env: { ...fakeEnv, POSTGRES_PASSWORD: password } }));
    assert.equal(configured.services.postgres.environment.POSTGRES_PASSWORD, password);
    assert.equal(configured.services.controller.environment.PGPASSWORD, password);
    assert.equal(configured.services.controller.environment.DATABASE_URL, '');
    assert.equal(configured.services.controller.environment.PGHOST, 'postgres');
    assert.equal(configured.services.controller.environment.PGPORT, '5432');
    assert.equal(configured.services.controller.environment.PGUSER, 'leader');
    assert.equal(configured.services.controller.environment.PGDATABASE, 'leader');
  }
});

test('an explicit DATABASE_URL remains available as a controller override', () => {
  const databaseUrl = 'postgresql://synthetic:synthetic%23%2Fpassword@external-db.invalid:5544/external';
  const configured = JSON.parse(execCompose([
    '--env-file', '/dev/null',
    '-f', fileURLToPath(new URL('../../../compose.yaml', import.meta.url)),
    'config', '--format', 'json',
  ], { encoding: 'utf8', timeout: 10000, env: { ...fakeEnv, DATABASE_URL: databaseUrl } }));
  assert.equal(configured.services.controller.environment.DATABASE_URL, databaseUrl);
});

test('small-host memory and worker concurrency overrides preserve the sandbox', () => {
  const configured = JSON.parse(execCompose([
    '--env-file', '/dev/null',
    '-f', fileURLToPath(new URL('../../../compose.yaml', import.meta.url)),
    '-f', fileURLToPath(new URL('../../../deploy/compose.production.yaml', import.meta.url)),
    'config', '--format', 'json',
  ], { encoding: 'utf8', timeout: 10000,
    env: { ...fakeEnv, CONTROLLER_MEMORY_LIMIT: '512m', BACKGROUND_MAX_CONCURRENT: '1' } })).services.controller;
  assert.equal(configured.mem_limit, '536870912');
  assert.equal(configured.environment.BACKGROUND_MAX_CONCURRENT, '1');
  assert.deepEqual(configured.security_opt, production.services.controller.security_opt);
  assert.equal(configured.read_only, true);
  assert.equal(configured.init, true);
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
  const nginx = readFileSync(new URL('../../../deploy/nginx.conf', import.meta.url), 'utf8');
  assert.match(nginx, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(nginx, /proxy_set_header Connection \$super_leader_connection_upgrade;/);
  assert.match(nginx, /proxy_pass http:\/\/127\.0\.0\.1:8790;/);
  assert.match(nginx, /return 308 https:\/\/leader\.taoai\.site\$request_uri;/);
  assert.match(nginx, /access_log off;/);
  assert.doesNotMatch(nginx, /proxy_set_header Authorization/);
});


test('background workers use separate durable stores and a bounded sandbox container', () => {
  const controller = production.services.controller;
  assert.equal(controller.user, '1000:1000');
  assert.equal(controller.init, true);
  assert.equal(controller.environment.BACKGROUND_WORKER_ROOT, '');
  assert.equal(controller.environment.BACKGROUND_ARTIFACT_ROOT, '/var/lib/super-leader-artifacts');
  assert.equal(controller.environment.BACKGROUND_MAX_CONCURRENT, '2');
  assert.equal(controller.mem_limit, '1610612736');
  assert.equal(controller.pids_limit, 512);
  assert.equal(controller.cpus, 2);
  assert.equal(controller.stop_grace_period, '30s');
  assert.deepEqual(controller.security_opt, ['no-new-privileges:true',
    'seccomp:./deploy/security/codex-seccomp.json', 'apparmor:super-leader-codex']);
  const stores = controller.volumes.filter(volume => volume.type === 'volume');
  assert.equal(stores.length, 2);
  assert.deepEqual(stores.map(volume => volume.target).sort(), [
    '/var/lib/super-leader-artifacts', '/var/lib/super-leader-background']);
  assert.equal(new Set(stores.map(volume => volume.source)).size, 2);
  const dockerfile = readFileSync(new URL('../../../deploy/Dockerfile.controller', import.meta.url), 'utf8');
  assert.match(dockerfile, /@openai\/codex@0\.163\.0/);
  assert.match(dockerfile, /ca-certificates/);
  assert.match(dockerfile, /chown node:node \/var\/lib\/super-leader-background \/var\/lib\/super-leader-artifacts/);
});
