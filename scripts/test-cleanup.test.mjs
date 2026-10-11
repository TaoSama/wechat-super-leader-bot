import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { closeTestWebSocket, stopTestProcess, withTestCleanup } from './test-cleanup.mjs';

const OPEN = 1;
const CLOSED = 3;

function fixtureSocket(close, terminate = () => {}) {
  return Object.assign(new EventEmitter(), { readyState: OPEN, close, terminate });
}

function assertListenersReleased(socket) {
  assert.equal(socket.listenerCount('close'), 0);
  assert.equal(socket.listenerCount('error'), 0);
}

test('already CLOSED socket returns without closing or waiting for another close event', { timeout: 1000 }, async () => {
  const socket = fixtureSocket(() => assert.fail('must not close again'));
  socket.readyState = CLOSED;
  await closeTestWebSocket(socket);
  assertListenersReleased(socket);
  await closeTestWebSocket(undefined);
});

test('registers before close so a synchronous close event cannot be missed', { timeout: 1000 }, async () => {
  const socket = fixtureSocket(function () {
    assert.equal(this.listenerCount('close'), 1);
    this.readyState = CLOSED;
    this.emit('close');
  });
  await closeTestWebSocket(socket);
  assertListenersReleased(socket);
});

test('asynchronous close releases all helper listeners', { timeout: 1000 }, async () => {
  const socket = fixtureSocket(function () { queueMicrotask(() => { this.readyState = CLOSED; this.emit('close'); }); });
  await closeTestWebSocket(socket);
  assertListenersReleased(socket);
});

test('synchronous error then close is reported after the socket is closed', { timeout: 1000 }, async () => {
  const failure = new Error('synthetic connecting socket failure');
  const socket = fixtureSocket(function () {
    this.emit('error', failure);
    this.readyState = CLOSED;
    this.emit('close');
  });
  await assert.rejects(closeTestWebSocket(socket), error => error === failure);
  assert.equal(socket.readyState, CLOSED);
  assertListenersReleased(socket);
});

test('a thrown close propagates and releases listeners', async () => {
  const failure = new Error('synthetic close failure');
  const socket = fixtureSocket(() => { throw failure; });
  await assert.rejects(closeTestWebSocket(socket), error => error === failure);
  assertListenersReleased(socket);
});

test('deadline terminates only the supplied fixture and still reports timeout on synchronous close', { timeout: 1000 }, async () => {
  let terminated = 0;
  const socket = fixtureSocket(() => {}, function () { terminated++; this.readyState = CLOSED; this.emit('close'); });
  await assert.rejects(closeTestWebSocket(socket, { timeoutMs: 5 }), /Timed out closing test WebSocket/);
  assert.equal(terminated, 1);
  assertListenersReleased(socket);
});

test('termination failure is preserved with the timeout and listeners are released', { timeout: 1000 }, async () => {
  const failure = new Error('synthetic termination failure');
  const socket = fixtureSocket(() => {}, () => { throw failure; });
  await assert.rejects(closeTestWebSocket(socket, { timeoutMs: 5 }), error => {
    assert(error instanceof AggregateError);
    assert.match(error.errors[0].message, /Timed out/);
    assert.equal(error.errors[1], failure);
    return true;
  });
  assertListenersReleased(socket);
});

test('cleanup failure does not skip later resources and all failures remain observable', async () => {
  const calls = [], first = new Error('first'), last = new Error('last');
  await assert.rejects(withTestCleanup(async () => { calls.push('operation'); }, [
    { label: 'socket', cleanup() { calls.push('socket'); throw first; } },
    { label: 'controller', async cleanup() { calls.push('controller'); } },
    { label: 'container', async cleanup() { calls.push('container'); throw last; } },
  ]), error => {
    assert(error instanceof AggregateError);
    assert.match(error.message, /socket, container/);
    assert.deepEqual(error.errors.map(item => item.cause), [first, last]);
    return true;
  });
  assert.deepEqual(calls, ['operation', 'socket', 'controller', 'container']);
});

test('failed operation and failed cleanup are retained together without skipping subsequent cleanup', async () => {
  const operationFailure = new Error('assertion failed'), cleanupFailure = new Error('pool failed');
  let laterCleaned = false;
  await assert.rejects(withTestCleanup(() => { throw operationFailure; }, [
    { label: 'pool', cleanup() { throw cleanupFailure; } },
    { label: 'container', cleanup() { laterCleaned = true; } },
  ]), error => {
    assert.equal(error.cause, operationFailure);
    assert.equal(error.errors[0], operationFailure);
    assert.equal(error.errors[1].cause, cleanupFailure);
    return true;
  });
  assert(laterCleaned);
});

test('successful cleanup preserves the original operation failure or return value', async () => {
  const failure = new Error('assertion failed');
  let cleaned = 0;
  const resources = [{ label: 'fixture', cleanup() { cleaned++; } }];
  await assert.rejects(withTestCleanup(() => { throw failure; }, resources), error => error === failure);
  assert.equal(await withTestCleanup(() => 42, resources), 42);
  assert.equal(cleaned, 2);
});

test('WebSocket failure cannot prevent fixture process and container cleanup', { timeout: 1000 }, async () => {
  const failure = new Error('synthetic socket failure'), calls = [];
  const socket = fixtureSocket(function () { this.emit('error', failure); this.readyState = CLOSED; this.emit('close'); });
  await assert.rejects(withTestCleanup(() => {}, [
    { label: 'socket', cleanup: () => closeTestWebSocket(socket) },
    { label: 'controller', cleanup: () => calls.push('controller') },
    { label: 'container', cleanup: () => calls.push('container') },
  ]), error => error.errors[0].cause === failure);
  assert.deepEqual(calls, ['controller', 'container']);
  assertListenersReleased(socket);
});

function fixtureProcess(kill) {
  return Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill });
}

test('owned process cleanup handles absent/already exited and synchronous graceful exit', async () => {
  await stopTestProcess(undefined);
  const exited = fixtureProcess(() => assert.fail('already exited'));
  exited.exitCode = 0;
  await stopTestProcess(exited);
  const child = fixtureProcess(function (signal) {
    assert.equal(signal, 'SIGTERM'); this.signalCode = signal; this.emit('exit'); return true;
  });
  await stopTestProcess(child);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
});

test('owned process timeout is reported even after forced exit, and later cleanup proceeds', { timeout: 1000 }, async () => {
  const signals = [], cleaned = [];
  const child = fixtureProcess(function (signal) {
    signals.push(signal);
    if (signal === 'SIGKILL') { this.signalCode = signal; this.emit('exit'); }
    return true;
  });
  await assert.rejects(withTestCleanup(() => {}, [
    { label: 'owned process', cleanup: () => stopTestProcess(child, { timeoutMs: 5 }) },
    { label: 'socket', cleanup: () => cleaned.push('socket') },
    { label: 'files', cleanup: () => cleaned.push('files') },
  ]), error => /Timed out stopping/.test(error.errors[0].cause.message));
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(cleaned, ['socket', 'files']);
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
});

test('owned process never exiting is bounded and retains the graceful timeout as cause', { timeout: 1000 }, async () => {
  const child = fixtureProcess(() => true);
  await assert.rejects(stopTestProcess(child, { timeoutMs: 5 }), error => {
    assert.match(error.message, /exit unconfirmed/);
    assert.match(error.cause.message, /Timed out/);
    return true;
  });
  assert.equal(child.listenerCount('exit'), 0);
  assert.equal(child.listenerCount('error'), 0);
});

test('owned process signal errors are observable and release listeners', async () => {
  for (const kill of [() => false, () => { throw new Error('signal failed'); }, function () { this.emit('error', new Error('async signal failed')); return true; }]) {
    const child = fixtureProcess(kill);
    await assert.rejects(stopTestProcess(child));
    assert.equal(child.listenerCount('exit'), 0);
    assert.equal(child.listenerCount('error'), 0);
  }
});
