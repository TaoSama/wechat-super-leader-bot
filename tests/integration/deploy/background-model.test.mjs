import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { execCompose } from '../../../scripts/lib/compose-command.mjs';

const backgroundModel = {
  BACKGROUND_MODEL_NAME: 'synthetic-background-model',
  BACKGROUND_MODEL_BASE_URL: 'https://background.invalid/v1',
  BACKGROUND_MODEL_API_KEY: 'synthetic-background-key',
};
const workerRoot = '/var/lib/super-leader-background';

function renderControllerEnv(overrides = {}) {
  const config = JSON.parse(execCompose([
    '--env-file', '/dev/null',
    '-f', fileURLToPath(new URL('../../../compose.yaml', import.meta.url)),
    '-f', fileURLToPath(new URL('../../../deploy/compose.production.yaml', import.meta.url)),
    'config', '--format', 'json',
  ], {
    encoding: 'utf8', timeout: 10_000,
    env: {
      PATH: process.env.PATH,
      COMPOSE_DISABLE_ENV_FILE: 'true',
      POSTGRES_PASSWORD: 'synthetic-test-password',
      CONTROLLER_TOKEN: 'synthetic-controller-token',
      NODE_TOKENS: '{"fixture":"synthetic-node-token"}',
      ...overrides,
    },
  }));
  return config.services.controller.environment;
}

test('production keeps background execution disabled by default', () => {
  const environment = renderControllerEnv();
  assert.equal(environment.LEADER_MODE, 'rules');
  assert.equal(environment.BACKGROUND_WORKER_ROOT, '');
  for (const name of Object.keys(backgroundModel)) assert.equal(environment[name], '');
});

test('rules mode passes the complete independent background provider into the container', () => {
  const environment = renderControllerEnv({ BACKGROUND_WORKER_ROOT: workerRoot, ...backgroundModel });
  assert.equal(environment.LEADER_MODE, 'rules');
  assert.equal(environment.BACKGROUND_WORKER_ROOT, workerRoot);
  for (const [name, value] of Object.entries(backgroundModel)) assert.equal(environment[name], value);
  assert.equal(environment.LEADER_MODEL_NAME, '');
  assert.equal(environment.LEADER_MODEL_BASE_URL, '');
  assert.equal(environment.LEADER_MODEL_API_KEY, '');
});

test('production preserves independent background overrides alongside a different leader provider', () => {
  const leaderModel = {
    LEADER_MODE: 'model',
    LEADER_MODEL_NAME: 'synthetic-leader-model',
    LEADER_MODEL_BASE_URL: 'https://leader.invalid/v1',
    LEADER_MODEL_API_KEY: 'synthetic-leader-key',
  };
  const environment = renderControllerEnv({
    BACKGROUND_WORKER_ROOT: workerRoot, ...leaderModel, ...backgroundModel,
  });
  for (const [name, value] of Object.entries({ ...leaderModel, ...backgroundModel })) {
    assert.equal(environment[name], value);
  }
});

test('background provider settings alone do not enable background execution', () => {
  const environment = renderControllerEnv(backgroundModel);
  assert.equal(environment.BACKGROUND_WORKER_ROOT, '');
  for (const [name, value] of Object.entries(backgroundModel)) assert.equal(environment[name], value);
});
