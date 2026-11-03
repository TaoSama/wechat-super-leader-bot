import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { containerFailure, failureEvent, failureFor, processState, stopEscaped,
  verifyReceiverTelemetry } from '../../integration/deploy/receiver-telemetry.mjs';
import { TransferFailure } from '../../../scripts/deploy/transfer-process.mjs';

const SECRET = 'SYNTHETIC_TOKEN https://credential.invalid/secret /private/key 192.0.2.10';
const unsafeError = fields => Object.assign(new Error(SECRET), fields);

function safeFailure(error, phase, category, cleanupCategory, metadata = {}) {
  assert.equal(error.phase, phase);
  assert.equal(error.category, category);
  assert.equal(error.message, category);
  assert.equal(error.cleanupCategory, cleanupCategory);
  assert.deepEqual(JSON.parse(JSON.stringify(error)), { category, phase,
    ...(cleanupCategory === undefined ? {} : { cleanupCategory }), ...metadata });
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
  safeFailure(failureFor(aggregate, 'fixture_create'), 'fixture_create', 'command_timeout', 'permission_denied',
    { errno: 'ETIMEDOUT', cleanupErrno: 'EACCES' });
});

test('explicit primary cause wins even when cleanup appears first in the aggregate', () => {
  const primary = unsafeError({ code: 'ETIMEDOUT' });
  const cleanup = new AggregateError([unsafeError({ code: 'EACCES' })], SECRET);
  safeFailure(failureFor(new AggregateError([cleanup, primary], SECRET, { cause: primary }), 'fixture_create'),
    'fixture_create', 'command_timeout', 'permission_denied', { errno: 'ETIMEDOUT', cleanupErrno: 'EACCES' });
});

test('cleanup-only aggregate uses its first error without replacing it with a later failure', () => {
  const cleanup = new AggregateError([unsafeError({ code: 'EACCES' }), unsafeError({ code: 'EIO' })], SECRET);
  safeFailure(failureFor(cleanup, 'cleanup'), 'cleanup', 'permission_denied', undefined, { errno: 'EACCES' });
});

test('a previously classified primary keeps its original phase and first cleanup category', () => {
  const primary = failureFor(unsafeError({ code: 'ETIMEDOUT' }), 'fixture_create');
  primary.cleanupCategory = 'permission_denied';
  const aggregate = new AggregateError([primary, unsafeError({ code: 'EIO' })], SECRET, { cause: primary });
  assert.equal(safeFailure(failureFor(aggregate, 'receiver_runtime'),
    'fixture_create', 'command_timeout', 'permission_denied', { errno: 'ETIMEDOUT' }), primary);
});

test('a known phase cannot bypass the category whitelist on a previously classified error', () => {
  const error = failureFor(unsafeError({ code: 'ETIMEDOUT' }), 'fixture_create');
  error.category = SECRET;
  safeFailure(failureFor(error, 'receiver_runtime'), 'receiver_runtime', 'probe_failed', undefined, { errno: 'ETIMEDOUT' });
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
    'fixture_create', 'command_timeout', 'probe_failed', { errno: 'ETIMEDOUT' });
});

// These injected boundaries test classification and lifecycle decisions, not kernel errno behavior.
const PID = 43210, START = 9876;
const IDENTITY = { pid: PID, start: START };
const EVENT = { event: 'linux_receiver_telemetry_failed', phase: 'escaped_helper', category: 'probe_failed' };
const OPERATIONS = ['process_stat_read', 'escaped_kill', 'escaped_prepare', 'escaped_collector_start',
  'escaped_collector_wait', 'escaped_collector_finish', 'escaped_identity_read', 'escaped_alive_check',
  'escaped_helper_stop', 'escaped_ps_probe', 'escaped_budget_check'];
const ERRNOS = ['ENOENT', 'ESRCH', 'EPERM', 'EACCES', 'EIO', 'ENOTDIR', 'EINVAL', 'EBADF', 'EINTR', 'ETIMEDOUT'];

function statText({ state = 'S', start = String(START), name = 'ss ) session' } = {}) {
  const fields = Array(20).fill('0');
  fields[0] = state; fields[19] = start;
  return `${PID} (${name}) ${fields.join(' ')}\n`;
}
function safeEvent(error, expected) {
  const event = failureEvent(error);
  assert.deepEqual(event, { ...EVENT, ...expected });
  for (const secret of [SECRET, 'credential.invalid', '/private/key', '192.0.2.10']) {
    assert.ok(!JSON.stringify(event).includes(secret));
  }
  return true;
}
function stateSequence(values) {
  const calls = [];
  return { calls, state: async pid => {
    calls.push(pid);
    assert.ok(values.length, 'unexpected extra process-state read');
    const value = values.shift();
    if (value instanceof Error) throw value;
    return value;
  } };
}

test('processState reads the fixed proc path and parses a comm containing parentheses', async () => {
  const calls = [];
  assert.deepEqual(await processState(PID, { read: async (...args) => {
    calls.push(args); return statText();
  } }), { state: 'S', start: START });
  assert.deepEqual(calls, [[`/proc/${PID}/stat`, 'utf8']]);
});

for (const code of ['ENOENT', 'ESRCH']) {
  test(`processState treats only disappeared-task ${code} as gone`, async () => {
    assert.equal(await processState(PID, { read: async () => { throw unsafeError({ code }); } }), null);
  });
}
for (const [code, category] of [['EPERM', 'permission_denied'], ['EACCES', 'permission_denied'],
  ['EIO', 'io_error'], ['ENOTDIR', 'io_error'], ['EBADF', 'probe_failed'], ['EINTR', 'probe_failed']]) {
  test(`processState preserves ${code} as a failure with safe read metadata`, async () => {
    await assert.rejects(processState(PID, { read: async () => { throw unsafeError({ code, path: SECRET }); } }),
      error => safeEvent(error, { category, operation: 'process_stat_read', errno: code }));
  });
}
test('processState never converts an unknown read failure into disappearance', async () => {
  await assert.rejects(processState(PID, { read: async () => { throw unsafeError({ code: SECRET }); } }),
    error => safeEvent(error, { operation: 'process_stat_read' }));
});
for (const [name, text] of [['missing comm', 'S 0'], ['missing start', `${PID} (ss) S 0`],
  ['unknown state', statText({ state: '?' })], ['negative start', statText({ start: '-1' })],
  ['fractional start', statText({ start: '1.5' })], ['non-numeric start', statText({ start: 'NaN' })],
  ['unsafe start integer', statText({ start: String(Number.MAX_SAFE_INTEGER + 1) })]]) {
  test(`processState rejects malformed stat: ${name}`, async () => {
    await assert.rejects(processState(PID, { read: async () => text }),
      error => safeEvent(error, { category: 'proc_invalid', operation: 'process_stat_read' }));
  });
}

for (const initial of [null, { state: 'Z', start: START }]) {
  test(`stopEscaped sends no signal for ${initial ? 'the matching zombie' : 'an absent process'}`, async () => {
    const { state, calls } = stateSequence([initial]);
    await stopEscaped(IDENTITY, { state, kill: () => assert.fail('must not signal') });
    assert.deepEqual(calls, [PID]);
  });
}
for (const processState of ['S', 'Z']) {
  test(`stopEscaped rejects a reused initial ${processState} PID without signaling it`, async () => {
    const { state, calls } = stateSequence([{ state: processState, start: START + 1 }]);
    await assert.rejects(stopEscaped(IDENTITY, { state, kill: () => assert.fail('must not signal a reused PID') }),
      error => error.category === 'escaped_pid_reused');
    assert.deepEqual(calls, [PID]);
  });
}
for (const final of [null, { state: 'Z', start: START }]) {
  test(`stopEscaped confirms ${final ? 'a matching zombie' : 'disappearance'} after exactly one SIGKILL`, async () => {
    const { state, calls } = stateSequence([{ state: 'S', start: START }, final]);
    const signals = [];
    await stopEscaped(IDENTITY, { state, kill: (...args) => signals.push(args) });
    assert.deepEqual(signals, [[PID, 'SIGKILL']]);
    assert.deepEqual(calls, [PID, PID]);
  });
}
test('a kill ESRCH still polls until the observed process actually disappears', async () => {
  const { state, calls } = stateSequence([{ state: 'S', start: START }, { state: 'S', start: START }, null]);
  const signals = [];
  await stopEscaped(IDENTITY, { state, kill: (...args) => { signals.push(args); throw unsafeError({ code: 'ESRCH' }); } });
  assert.deepEqual(signals, [[PID, 'SIGKILL']]);
  assert.deepEqual(calls, [PID, PID, PID]);
});
for (const finalState of ['S', 'Z']) {
  test(`a kill ESRCH cannot hide post-signal PID reuse in state ${finalState}`, async () => {
    const { state, calls } = stateSequence([{ state: 'S', start: START }, { state: finalState, start: START + 1 }]);
    const signals = [];
    await assert.rejects(stopEscaped(IDENTITY, { state, kill: (...args) => {
      signals.push(args); throw unsafeError({ code: 'ESRCH' });
    } }), error => error.category === 'escaped_pid_reused');
    assert.deepEqual(signals, [[PID, 'SIGKILL']]);
    assert.deepEqual(calls, [PID, PID]);
  });
}
for (const [code, category] of [['EPERM', 'permission_denied'], ['EACCES', 'permission_denied'],
  ['EIO', 'io_error'], ['ENOENT', 'file_missing'], ['EINVAL', 'probe_failed']]) {
  test(`stopEscaped does not swallow kill ${code}`, async () => {
    const { state, calls } = stateSequence([{ state: 'S', start: START }]);
    await assert.rejects(stopEscaped(IDENTITY, { state, kill: () => { throw unsafeError({ code }); } }),
      error => safeEvent(error, { category, operation: 'escaped_kill', errno: code }));
    assert.deepEqual(calls, [PID]);
  });
}
test('post-signal read permission failure keeps the precise read operation', async () => {
  let reads = 0;
  const state = pid => processState(pid, { read: async () => {
    if (++reads === 1) return statText();
    throw unsafeError({ code: 'EACCES' });
  } });
  await assert.rejects(stopEscaped(IDENTITY, { state, kill() {} }),
    error => safeEvent(failureFor(error, 'escaped_helper', 'escaped_helper_stop'),
      { category: 'permission_denied', operation: 'process_stat_read', errno: 'EACCES' }));
});
test('a surviving helper after kill ESRCH remains a bounded cleanup failure', async t => {
  let now = 0, reads = 0, signals = 0;
  t.mock.method(Date, 'now', () => now += 1_000);
  await assert.rejects(stopEscaped(IDENTITY, {
    state: async () => { reads++; return { state: 'S', start: START }; },
    kill: () => { signals++; throw unsafeError({ code: 'ESRCH' }); },
  }), error => error.category === 'escaped_helper_survived_cleanup');
  assert.equal(signals, 1);
  assert.equal(reads, 2);
});

for (const operation of OPERATIONS) {
  test(`safe diagnostics retain operation ${operation} across container projection`, () => {
    const event = failureEvent(failureFor(unsafeError({ operation, code: 'ESRCH' }), 'escaped_helper'));
    assert.deepEqual(event, { ...EVENT, operation, errno: 'ESRCH' });
    assert.deepEqual(failureEvent(containerFailure(JSON.stringify(event))), event);
  });
}
for (const errno of ERRNOS) {
  test(`safe diagnostics retain errno ${errno} across container projection`, () => {
    const event = failureEvent(failureFor(unsafeError({ errno }), 'escaped_helper', 'escaped_helper_stop'));
    assert.deepEqual(event, { ...EVENT, operation: 'escaped_helper_stop', errno });
    assert.deepEqual(failureEvent(containerFailure(JSON.stringify(event))), event);
  });
}
test('specific error metadata wins over outer operation and native numeric errno falls back to code', () => {
  safeEvent(failureFor(unsafeError({ operation: 'process_stat_read', errno: -13, code: 'EACCES' }),
    'escaped_helper', 'escaped_helper_stop'), { category: 'permission_denied', operation: 'process_stat_read', errno: 'EACCES' });
  safeEvent(failureFor(unsafeError({ operation: SECRET, errno: 'EIO', code: 'EACCES' }),
    'escaped_helper', 'escaped_alive_check'), { category: 'permission_denied', operation: 'escaped_alive_check', errno: 'EIO' });
});
test('unknown raw metadata never reaches a failure event', () => {
  safeEvent(failureFor(unsafeError({ operation: SECRET, errno: SECRET, code: SECRET }),
    'escaped_helper', SECRET), {});
});
test('reclassified errors discard injected metadata and event projection strips arbitrary fields', () => {
  const error = failureFor(unsafeError({}), 'escaped_helper');
  Object.assign(error, { operation: SECRET, errno: SECRET, path: SECRET, detail: SECRET,
    cleanupCategory: SECRET, cleanupOperation: SECRET, cleanupErrno: SECRET });
  safeEvent(failureFor(error, 'receiver_runtime'), {});
});
for (const [name, cleanup, expectedCleanup] of [
  ['unknown cleanup category', { cleanupCategory: SECRET, cleanupOperation: 'escaped_kill', cleanupErrno: 'EPERM' }, {}],
  ['unknown cleanup metadata', { cleanupCategory: 'permission_denied', cleanupOperation: SECRET, cleanupErrno: SECRET },
    { cleanupCategory: 'permission_denied' }],
  ['valid cleanup metadata', { cleanupCategory: 'permission_denied', cleanupOperation: 'escaped_kill', cleanupErrno: 'EPERM' },
    { cleanupCategory: 'permission_denied', cleanupOperation: 'escaped_kill', cleanupErrno: 'EPERM' }],
]) {
  test(`classified-error reentry keeps identity while projecting ${name}`, () => {
    const original = failureFor(unsafeError({ code: 'EIO' }), 'escaped_helper', 'process_stat_read');
    Object.assign(original, cleanup, { detail: SECRET, path: SECRET, source: { secret: SECRET }, code: SECRET });
    const result = failureFor(original, 'receiver_runtime', 'escaped_helper_stop');
    assert.equal(result, original);
    const expected = { category: 'io_error', phase: 'escaped_helper', operation: 'process_stat_read', errno: 'EIO',
      ...expectedCleanup };
    assert.deepEqual(JSON.parse(JSON.stringify(result)), expected);
    const event = { ...EVENT, category: 'io_error', operation: 'process_stat_read', errno: 'EIO',
      ...(expectedCleanup.cleanupCategory ? { cleanup_category: expectedCleanup.cleanupCategory } : {}),
      ...(expectedCleanup.cleanupOperation ? { cleanup_operation: expectedCleanup.cleanupOperation } : {}),
      ...(expectedCleanup.cleanupErrno ? { cleanup_errno: expectedCleanup.cleanupErrno } : {}) };
    safeEvent(result, event);
    safeEvent(containerFailure(JSON.stringify(failureEvent(result))), event);
  });
}
test('nested aggregate and container layers preserve primary and first cleanup metadata as a group', () => {
  const primary = unsafeError({ code: 'EIO', operation: 'process_stat_read' });
  const first = unsafeError({ code: 'EPERM', operation: 'escaped_kill' });
  const later = unsafeError({ code: 'ETIMEDOUT', operation: 'escaped_budget_check' });
  const cleanup = new AggregateError([first, later], SECRET);
  const inner = failureFor(new AggregateError([cleanup, primary], SECRET, { cause: primary }),
    'escaped_helper', 'escaped_alive_check');
  const outer = failureFor(new AggregateError([inner, later], SECRET, { cause: inner }),
    'receiver_runtime', 'escaped_helper_stop');
  const expected = { category: 'io_error', operation: 'process_stat_read', errno: 'EIO',
    cleanup_category: 'permission_denied', cleanup_operation: 'escaped_kill', cleanup_errno: 'EPERM' };
  safeEvent(outer, expected);
  safeEvent(containerFailure(`\n${JSON.stringify(failureEvent(outer))}\n`), expected);
});
test('unknown first cleanup metadata is not filled from a later known cleanup', () => {
  const primary = unsafeError({ operation: 'escaped_alive_check', code: 'EIO' });
  const first = unsafeError({ operation: SECRET, code: SECRET });
  const later = unsafeError({ operation: 'escaped_kill', code: 'EPERM' });
  const inner = failureFor(new AggregateError([primary, first], SECRET, { cause: primary }), 'escaped_helper');
  const outer = failureFor(new AggregateError([inner, later], SECRET, { cause: inner }), 'receiver_runtime');
  safeEvent(outer, { category: 'io_error', operation: 'escaped_alive_check', errno: 'EIO', cleanup_category: 'probe_failed' });
});
test('container diagnostics project only the event whitelist, including cleanup metadata', () => {
  const event = { ...EVENT, operation: 'escaped_alive_check', errno: 'ESRCH',
    cleanup_category: 'permission_denied', cleanup_operation: 'escaped_kill', cleanup_errno: 'EPERM' };
  const result = containerFailure(JSON.stringify({ ...event, message: SECRET, stack: SECRET, path: SECRET,
    cause: { secret: SECRET }, arbitrary: SECRET }));
  safeEvent(result, event);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { category: 'probe_failed', phase: 'escaped_helper',
    operation: 'escaped_alive_check', errno: 'ESRCH', cleanupCategory: 'permission_denied',
    cleanupOperation: 'escaped_kill', cleanupErrno: 'EPERM' });
});
test('container diagnostics discard untrusted optional metadata rather than echo it', () => {
  safeEvent(containerFailure(JSON.stringify({ ...EVENT, operation: SECRET, errno: SECRET,
    cleanup_category: 'permission_denied', cleanup_operation: SECRET, cleanup_errno: SECRET, arbitrary: SECRET })),
  { cleanup_category: 'permission_denied' });
  safeEvent(containerFailure(JSON.stringify({ ...EVENT, cleanup_category: SECRET,
    cleanup_operation: 'escaped_kill', cleanup_errno: 'EPERM' })), {});
});
test('container diagnostics do not accept a raw code field as projected errno', () => {
  safeEvent(containerFailure(JSON.stringify({ ...EVENT, code: 'EIO', message: SECRET })), {});
});
for (const [name, value] of [['null', null], ['array', []], ['wrong event', { ...EVENT, event: SECRET }],
  ['unknown phase', { ...EVENT, phase: SECRET }], ['unknown category', { ...EVENT, category: SECRET }],
  ['encoded JSON string', JSON.stringify(EVENT)]]) {
  test(`container diagnostics reject ${name}`, () => {
    assert.equal(containerFailure(JSON.stringify(value)), undefined);
  });
}
test('container diagnostics reject malformed or embedded JSON instead of scanning raw stderr', () => {
  for (const text of ['{', SECRET, `${SECRET}\n${JSON.stringify(EVENT)}`, `${JSON.stringify(EVENT)}\n${SECRET}`]) {
    assert.equal(containerFailure(text), undefined);
  }
});

test('host forwarding preserves container primary and first cleanup metadata through local cleanup', async t => {
  const root = await mkdtemp(join(tmpdir(), 'receiver-entry-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const knownHosts = join(root, 'known_hosts');
  await writeFile(knownHosts, 'synthetic ssh-ed25519 AAAASYNTHETIC\n');
  const event = { ...EVENT, category: 'io_error', operation: 'process_stat_read', errno: 'EIO',
    cleanup_category: 'permission_denied', cleanup_operation: 'escaped_kill', cleanup_errno: 'EPERM' };
  const calls = [];
  const fixture = { root, values: { 'key-file': join(root, 'client'), 'known-hosts-file': knownHosts },
    copyToContainer() {},
    runInContainer(args) {
      calls.push(args[0]);
      if (args[0] === 'node') throw unsafeError({ status: 1,
        stderr: JSON.stringify({ ...event, path: SECRET, message: SECRET }) });
      if (args[0] === 'rm') throw unsafeError({ code: 'EACCES', operation: 'escaped_budget_check' });
      return '';
    } };
  await assert.rejects(verifyReceiverTelemetry(fixture), error => safeEvent(error, event));
  assert.deepEqual(calls, ['mkdir', 'node', 'rm']);
  assert.deepEqual(await readdir(root), ['known_hosts']);
});
