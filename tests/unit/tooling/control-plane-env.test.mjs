import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import test from 'node:test';

const fixtureUrl = new URL('../../support/control-plane-fixture.mjs', import.meta.url).href;
const verifyUrl = new URL('../../../scripts/verify.mjs', import.meta.url).href;
const PROBE_TIMEOUT_MS = 15_000;
const ambient = {
  COMMAND_TTL_SECONDS: '1', WEB_DIST_DIR: '/synthetic/ambient-web',
  CONTROLLER_TOKEN: 'synthetic-ambient-controller-token', DATABASE_URL: 'synthetic-ambient-database',
  LEADER_MODEL_API_KEY: 'synthetic-ambient-model-key', WECHAT_CREDENTIALS_PATH: '/synthetic/ambient-credentials',
  LIVE_DESKTOP_SEND: 'synthetic-ambient-gate', NODE_OPTIONS: '--require=/synthetic/must-not-load.cjs',
  FIXTURE_AMBIENT_SENTINEL: 'synthetic-ambient-value',
};

function runFixtureProbe(setup, expected) {
  const childCode = `
    import assert from 'node:assert/strict';
    const expected = ${JSON.stringify(expected)};
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(process.env[key] ?? null, value, key);
    }
    assert.equal(process.env.HOST, '127.0.0.1');
    assert.equal(process.env.CONSOLE_PUBLIC_URL, 'http://127.0.0.1:' + process.env.PORT);
    console.log('isolated fixture child');
  `;
  const code = `
    import assert from 'node:assert/strict';
    import { spawnSync } from 'node:child_process';
    import { createControllerFixture } from ${JSON.stringify(fixtureUrl)};
    import { verificationEnvironment } from ${JSON.stringify(verifyUrl)};
    Object.assign(process.env, ${JSON.stringify(ambient)});
    ${setup}
    const fixture = await createControllerFixture(options);
    const expected = ${JSON.stringify(expected)};
    for (const [key, value] of Object.entries(expected)) {
      assert.equal(fixture.env[key] ?? null, value, key);
    }
    const child = spawnSync(command, ['--input-type=module', '-e', ${JSON.stringify(childCode)}], {
      env: fixture.env, encoding: 'utf8', timeout: ${PROBE_TIMEOUT_MS},
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim(), 'isolated fixture child');
    console.log('standalone fixture passed');
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    env: { PATH: dirname(process.execPath) }, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS,
  });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'standalone fixture passed');
}

const removedAmbient = Object.fromEntries(Object.keys(ambient).map(key => [key, null]));

test('standalone Controller fixture preserves a cleaned environment and tool PATH without restoring ambient inputs', () => {
  runFixtureProbe(`
    const env = { ...verificationEnvironment(), CONTROLLER_TOKEN: 'synthetic-fixture-token',
      PERSISTENCE_MODE: 'memory', FIXTURE_LOCAL_SETTING: 'synthetic-explicit-value' };
    const options = { env };
    const command = 'node';
  `, { ...removedAmbient, PATH: dirname(process.execPath), SUPER_LEADER_NO_DOTENV: '1',
    CONTROLLER_TOKEN: 'synthetic-fixture-token', PERSISTENCE_MODE: 'memory',
    FIXTURE_LOCAL_SETTING: 'synthetic-explicit-value' });
});

test('Controller fixture defaults to the verification environment without ambient hooks or credentials', () => {
  runFixtureProbe(`const options = {}; const command = 'node';`, {
    ...removedAmbient, PATH: dirname(process.execPath), SUPER_LEADER_NO_DOTENV: '1',
  });
});

test('an explicit Controller fixture environment is complete even when tool PATH is omitted', () => {
  runFixtureProbe(`
    const options = { env: { SUPER_LEADER_NO_DOTENV: '1', FIXTURE_LOCAL_SETTING: 'synthetic-explicit-value' } };
    const command = process.execPath;
  `, { ...removedAmbient, PATH: null, SUPER_LEADER_NO_DOTENV: '1', FIXTURE_LOCAL_SETTING: 'synthetic-explicit-value' });
});
