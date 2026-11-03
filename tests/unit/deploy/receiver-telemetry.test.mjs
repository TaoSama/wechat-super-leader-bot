import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const TEST_DIRECTORY = fileURLToPath(new URL('.', import.meta.url));

test('receiver telemetry satisfies its Python unit contract', { timeout: 60_000 }, () => {
  const result = spawnSync('python3', ['-B', '-m', 'unittest', 'discover',
    '-s', TEST_DIRECTORY, '-p', 'receiver_*_test.py', '-v'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 50_000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null, `Python suite stopped by ${result.signal}`);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
