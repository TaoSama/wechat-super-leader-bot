import assert from 'node:assert/strict';
import test from 'node:test';
import { failureFor } from '../../integration/deploy/receiver-telemetry.mjs';
import { TransferFailure } from '../../../scripts/deploy/transfer-process.mjs';

const SECRET = 'SYNTHETIC_TOKEN https://credential.invalid/secret /private/key 192.0.2.10';
const unsafeError = fields => Object.assign(new Error(SECRET), fields);

function safeFailure(error, phase, category, cleanupCategory) {
  assert.equal(error.phase, phase);
  assert.equal(error.category, category);
  assert.equal(error.message, category);
  assert.equal(error.cleanupCategory, cleanupCategory);
  assert.deepEqual(JSON.parse(JSON.stringify(error)), { category, phase,
    ...(cleanupCategory === undefined ? {} : { cleanupCategory }) });
  for (const text of [SECRET, 'credential.invalid', '/private/key', '192.0.2.10']) {
    assert.ok(!JSON.stringify(error).includes(text));
    assert.ok(!error.stack.includes(text));
  }
  return error;
}

test('fixture initialization aggregate retains primary timeout and first cleanup permission failure', () => {
  const primary = unsafeError({ code: 'ETIMEDOUT' });
  const cleanup = new AggregateError([unsafeError({ code: 'EACCES' }), unsafeError({ status: 1 })], SECRET);
  const aggregate = new AggregateError([primary, cleanup], SECRET, { cause: primary });
  safeFailure(failureFor(aggregate, 'fixture_create'), 'fixture_create', 'command_timeout', 'permission_denied');
});

test('explicit primary cause wins even when cleanup appears first in the aggregate', () => {
  const primary = unsafeError({ code: 'ETIMEDOUT' });
  const cleanup = new AggregateError([unsafeError({ code: 'EACCES' })], SECRET);
  safeFailure(failureFor(new AggregateError([cleanup, primary], SECRET, { cause: primary }), 'fixture_create'),
    'fixture_create', 'command_timeout', 'permission_denied');
});

test('cleanup-only aggregate uses its first error without replacing it with a later failure', () => {
  const cleanup = new AggregateError([unsafeError({ code: 'EACCES' }), unsafeError({ code: 'EIO' })], SECRET);
  safeFailure(failureFor(cleanup, 'cleanup'), 'cleanup', 'permission_denied');
});

test('a previously classified primary keeps its original phase and first cleanup category', () => {
  const primary = failureFor(unsafeError({ code: 'ETIMEDOUT' }), 'fixture_create');
  primary.cleanupCategory = 'permission_denied';
  const aggregate = new AggregateError([primary, unsafeError({ code: 'EIO' })], SECRET, { cause: primary });
  assert.equal(safeFailure(failureFor(aggregate, 'receiver_runtime'),
    'fixture_create', 'command_timeout', 'permission_denied'), primary);
});

test('a known phase cannot bypass the category whitelist on a previously classified error', () => {
  const error = failureFor(unsafeError({ code: 'ETIMEDOUT' }), 'fixture_create');
  error.category = SECRET;
  safeFailure(failureFor(error, 'receiver_runtime'), 'receiver_runtime', 'probe_failed');
});

for (const [name, error] of [
  ['empty aggregate', new AggregateError([], SECRET)],
  ['untrusted category fields', unsafeError({ category: SECRET, phase: 'fixture_create' })],
  ['unknown transfer category', new TransferFailure(SECRET)],
]) {
  test(`${name} stays within the fixed receiver diagnostic whitelist`, () => {
    safeFailure(failureFor(error, SECRET), 'receiver_runtime', 'probe_failed');
  });
}

test('an unknown first cleanup error is safely classified rather than skipped for a later known error', () => {
  const primary = unsafeError({ code: 'ETIMEDOUT' });
  const cleanup = new AggregateError([unsafeError({ category: SECRET }), unsafeError({ code: 'EACCES' })], SECRET);
  safeFailure(failureFor(new AggregateError([primary, cleanup], SECRET, { cause: primary }), 'fixture_create'),
    'fixture_create', 'command_timeout', 'probe_failed');
});
