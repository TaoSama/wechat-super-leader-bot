import assert from 'node:assert/strict';
import { Server } from 'node:http';
import test from 'node:test';
import { createControlFixture } from '../../support/reliability-control.mjs';
import { withTestCleanup } from '../../support/cleanup.mjs';

const fixtureOptions = { env: {}, databaseUrl: 'postgres://synthetic', token: 'synthetic-controller',
  nodeId: 'synthetic-node', nodeToken: 'synthetic-node-token', chatIds: ['synthetic-chat'],
  modelUrl: 'http://127.0.0.1', evidence() {} };

test('proxy binds while the Controller port remains reserved', async t => {
  const listen = Server.prototype.listen;
  const servers = [];
  t.mock.method(Server.prototype, 'listen', function (...args) {
    servers.push(this);
    if (servers.length === 2) assert.equal(servers[0].listening, true);
    return listen.apply(this, args);
  });
  const fixture = await createControlFixture(fixtureOptions);
  await withTestCleanup(async () => {
    assert.equal(servers.length, 2);
    assert.equal(servers[0].listening, false);
    assert.equal(servers[1].listening, true);
    assert.notEqual(new URL(fixture.base).port, new URL(fixture.proxyUrl).port);
  }, [{ label: 'owned Controller fixture', cleanup: () => fixture.stop() }]);
  assert(servers.every(server => !server.listening));
});

test('failed proxy binding releases the reservation and preserves the error', async t => {
  const listen = Server.prototype.listen;
  const servers = [];
  const failure = new Error('Synthetic proxy bind failure');
  t.mock.method(Server.prototype, 'listen', function (...args) {
    servers.push(this);
    if (servers.length === 2) {
      assert.equal(servers[0].listening, true);
      queueMicrotask(() => this.emit('error', failure));
      return this;
    }
    return listen.apply(this, args);
  });
  await assert.rejects(createControlFixture(fixtureOptions), error => error === failure);
  assert.equal(servers.length, 2);
  assert(servers.every(server => !server.listening));
});
