import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execCompose } from '../../../scripts/lib/compose-command.mjs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const composeYamlPath = fileURLToPath(new URL('../../../compose.yaml', import.meta.url));
const composeProdPath = fileURLToPath(new URL('../../../deploy/compose.production.yaml', import.meta.url));
const composeGatewayPath = fileURLToPath(new URL('../../../deploy/compose.gateway.yaml', import.meta.url));

const fakeEnv = {
  PATH: process.env.PATH,
  COMPOSE_DISABLE_ENV_FILE: 'true',
  POSTGRES_PASSWORD: 'synthetic-test-password',
  CONTROLLER_TOKEN: 'synthetic-controller-token',
  NODE_TOKENS: '{"fixture":"synthetic-node-token"}',
};

// Compose versions differ on whether true or false is omitted from JSON. Probe
// both explicit policies instead of guessing the meaning of an absent field.
const bindPolicyFixture = JSON.parse(execCompose([
  '--env-file', '/dev/null', '-f', '-', 'config', '--format', 'json',
], { encoding: 'utf8', timeout: 10000, env: fakeEnv, input: JSON.stringify({ services: {
  fixture: { image: 'alpine:synthetic-not-run', volumes: [false, true].map(createHostPath => ({
    type: 'bind', source: '/synthetic-not-created', target: createHostPath ? '/enabled' : '/disabled',
    bind: { create_host_path: createHostPath },
  })) },
} }) })).services.fixture.volumes;
const disabledBind = bindPolicyFixture.find(volume => volume.target === '/disabled');
const enabledBind = bindPolicyFixture.find(volume => volume.target === '/enabled');
assert.ok(disabledBind && enabledBind, 'Compose must render both bind policy fixtures');
assert.notEqual(disabledBind.bind?.create_host_path, enabledBind.bind?.create_host_path,
  'Compose must distinguish disabled and enabled host path creation');

function assertHostPathCreationDisabled(volume) {
  assert.equal(volume.bind?.create_host_path, disabledBind.bind?.create_host_path,
    'bind mount must not create missing host paths');
}

test('without --profile wechat, gateway is omitted from active services', () => {
  const configJson = execCompose([
    '--env-file', '/dev/null',
    '-f', composeYamlPath,
    '-f', composeProdPath,
    '-f', composeGatewayPath,
    'config', '--format', 'json',
  ], { encoding: 'utf8', timeout: 10000, env: fakeEnv });

  const parsed = JSON.parse(configJson);
  assert.equal(parsed.services.gateway, undefined, 'gateway should not be active without profile');
  assert.ok(parsed.services.controller, 'controller must be present');
  assert.ok(parsed.services.postgres, 'postgres must be present');
});

test('with --profile wechat, gateway is configured with exact production constraints and long-syntax binds', () => {
  const configJson = execCompose([
    '--env-file', '/dev/null',
    '--profile', 'wechat',
    '-f', composeYamlPath,
    '-f', composeProdPath,
    '-f', composeGatewayPath,
    'config', '--format', 'json',
  ], { encoding: 'utf8', timeout: 10000, env: fakeEnv });

  const parsed = JSON.parse(configJson);
  const gateway = parsed.services.gateway;
  assert.ok(gateway, 'gateway service must exist with --profile wechat');

  // Security & user isolation
  assert.equal(gateway.user, '1000:1000');
  assert.equal(gateway.read_only, true);
  assert.deepEqual(gateway.cap_drop, ['ALL']);
  assert.deepEqual(gateway.security_opt, ['no-new-privileges:true']);

  // Resource limits
  assert.equal(gateway.mem_limit, '268435456'); // 256m in bytes
  assert.equal(gateway.cpus, 0.25);
  assert.equal(gateway.pids_limit, 128);
  assert.equal(gateway.stop_grace_period, '10m0s');
  assert.equal(gateway.init, true);
  assert.equal(gateway.restart, 'unless-stopped');

  // Logging limits
  assert.equal(gateway.logging?.driver, 'json-file');
  assert.equal(gateway.logging?.options?.['max-size'], '10m');
  assert.equal(gateway.logging?.options?.['max-file'], '3');

  // No published ports
  assert.equal(gateway.ports, undefined, 'gateway must not publish any host ports');

  // Environment variables: only controller token & urls/paths, no DB/node tokens
  assert.equal(gateway.environment.CONTROLLER_URL, 'https://leader.taoai.site');
  assert.equal(gateway.environment.CONTROLLER_TOKEN, 'synthetic-controller-token');
  assert.equal(gateway.environment.WECHAT_CREDENTIALS_PATH, '/etc/super-leader/wechat-account.json');
  assert.equal(gateway.environment.WECHAT_STATE_PATH, '/var/lib/super-leader-gateway/state.json');
  assert.equal(gateway.environment.GATEWAY_HEALTH_PATH, '/var/lib/super-leader-gateway/health.json');
  assert.equal(gateway.environment.GATEWAY_NOTIFICATIONS, 'false');
  assert.equal(gateway.environment.GATEWAY_PLAN_NOTIFICATIONS, undefined);
  assert.equal(gateway.environment.POSTGRES_PASSWORD, undefined);
  assert.equal(gateway.environment.NODE_TOKENS, undefined);
  assert.equal(gateway.environment.DATABASE_URL, undefined);

  // Volumes with long syntax type:bind and bind.create_host_path:false
  assert.equal(gateway.volumes.length, 2);
  const roBind = gateway.volumes.find((v) => v.target === '/etc/super-leader/wechat-account.json');
  assert.ok(roBind, 'readonly account bind mount must be configured');
  assert.equal(roBind.type, 'bind');
  assert.equal(roBind.read_only, true);
  assertHostPathCreationDisabled(roBind);

  const stateBind = gateway.volumes.find((v) => v.target === '/var/lib/super-leader-gateway');
  assert.ok(stateBind, 'state read-write bind mount must be configured');
  assert.equal(stateBind.type, 'bind');
  assert.notEqual(stateBind.read_only, true);
  assertHostPathCreationDisabled(stateBind);

  // Also require explicit opt-outs in source, independent of JSON omission.
  const gatewaySource = readFileSync(composeGatewayPath, 'utf8');
  assert.match(gatewaySource, /target: \/etc\/super-leader\/wechat-account\.json\r?\n\s+read_only: true\r?\n\s+bind:\r?\n\s+create_host_path: false(?:\r?\n|$)/);
  assert.match(gatewaySource, /target: \/var\/lib\/super-leader-gateway\r?\n\s+bind:\r?\n\s+create_host_path: false(?:\r?\n|$)/);

  // tmpfs
  assert.deepEqual(gateway.tmpfs, ['/tmp:size=16m,mode=1777']);

  // Healthcheck
  assert.deepEqual(gateway.healthcheck?.test, ['CMD', 'node', 'dist/index.js', '--healthcheck']);
  assert.equal(gateway.healthcheck?.interval, '30s');
  assert.equal(gateway.healthcheck?.timeout, '5s');
  assert.equal(gateway.healthcheck?.retries, 3);
  assert.equal(gateway.healthcheck?.start_period, '1m0s'); // 60s
});

test('bind policy accepts canonical false but rejects canonical true and invalid values', () => {
  assertHostPathCreationDisabled(disabledBind);
  assert.throws(() => assertHostPathCreationDisabled(enabledBind), assert.AssertionError);
  for (const value of [null, 0, 'false']) {
    assert.throws(() => assertHostPathCreationDisabled({ bind: { create_host_path: value } }), assert.AssertionError);
  }
});

test('bind policy rejects explicit host path creation after Compose normalization', () => {
  const unsafeSource = readFileSync(composeGatewayPath, 'utf8').replaceAll('create_host_path: false', 'create_host_path: true');
  const parsed = JSON.parse(execCompose([
    '--env-file', '/dev/null', '--profile', 'wechat',
    '-f', composeYamlPath, '-f', composeProdPath, '-f', '-',
    'config', '--format', 'json',
  ], { encoding: 'utf8', timeout: 10000, env: fakeEnv, input: unsafeSource }));
  assert.equal(parsed.services.gateway.volumes.length, 2);
  for (const volume of parsed.services.gateway.volumes) {
    assert.equal(volume.bind?.create_host_path, enabledBind.bind?.create_host_path);
    assert.throws(() => assertHostPathCreationDisabled(volume), assert.AssertionError);
  }
});

test('plan and goal notifications require an explicit gateway-only opt-in', () => {
  const parsed = JSON.parse(execCompose([
    '--env-file', '/dev/null',
    '--profile', 'wechat', '-f', composeYamlPath, '-f', composeProdPath, '-f', composeGatewayPath,
    'config', '--format', 'json',
  ], { encoding: 'utf8', timeout: 10000, env: { ...fakeEnv, GATEWAY_NOTIFICATIONS: 'true' } }));
  assert.equal(parsed.services.gateway.environment.GATEWAY_NOTIFICATIONS, 'true');
  assert.equal(parsed.services.controller.environment.GATEWAY_NOTIFICATIONS, undefined);
});

test('Dockerfile.gateway defines valid non-root UID 1000 and standard ENTRYPOINT/CMD', () => {
  const dockerfilePath = fileURLToPath(new URL('../../../deploy/Dockerfile.gateway', import.meta.url));
  assert.ok(existsSync(dockerfilePath), 'Dockerfile.gateway must exist');
  const content = readFileSync(dockerfilePath, 'utf8');

  assert.match(content, /FROM --platform=\$BUILDPLATFORM node:24-bookworm-slim AS toolchain/);
  assert.match(content, /RUN npm install --global pnpm@11.8.0/);
  assert.match(content, /pnpm install --frozen-lockfile/);
  assert.match(content, /USER node/);
  assert.match(content, /ENTRYPOINT \["node", "dist\/index\.js"\]/);
  assert.match(content, /CMD \["--run"\]/);
});
