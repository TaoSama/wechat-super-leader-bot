import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { closeTestWebSocket } from './scripts/test-cleanup.mjs';

// Test-owned relay permits dropping/replacing only synthetic ACKs. It never
// discovers an existing endpoint, process, node token or desktop session.
export async function createTerminalRelay(base, token) {
  const require = createRequire(new URL('./controller/package.json', import.meta.url));
  const { WebSocket, WebSocketServer } = require('ws');
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1', maxPayload: 1024 * 1024 });
  const links = new Set(), errors = [], commands = [], results = [], acks = [];
  let current, passAcks = false, stopping = false;
  server.on('error', error => errors.push(error));
  server.on('connection', (downstream, request) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      errors.push(new Error('Synthetic relay authentication mismatch'));
      downstream.close();
      return;
    }
    const upstream = new WebSocket(base.replace('http:', 'ws:') + '/v1/daemon', {
      headers: { authorization: `Bearer ${token}` }, maxPayload: 1024 * 1024,
    });
    const link = { downstream, upstream, queued: [] };
    links.add(link);
    current = link;
    const send = (socket, message) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(message), error => { if (error && !stopping) errors.push(error); });
    };
    downstream.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'result') results.push(message);
        if (upstream.readyState === WebSocket.OPEN) send(upstream, message);
        else link.queued.push(message);
      } catch (error) { errors.push(error); downstream.close(); }
    });
    upstream.on('open', () => {
      for (const message of link.queued) send(upstream, message);
      link.queued = [];
      if (downstream.readyState !== WebSocket.OPEN) upstream.close();
    });
    upstream.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'command') commands.push(message);
        if (message.type === 'result_ack') {
          acks.push(message);
          if (!passAcks) return;
        }
        send(downstream, message);
      } catch (error) { errors.push(error); upstream.close(); }
    });
    const cleanupLink = () => {
      if (downstream.readyState === WebSocket.CLOSED && upstream.readyState === WebSocket.CLOSED) links.delete(link);
    };
    downstream.on('close', () => {
      if (current === link) current = undefined;
      if (upstream.readyState === WebSocket.OPEN) upstream.close();
      cleanupLink();
    });
    upstream.on('close', () => { if (downstream.readyState === WebSocket.OPEN) downstream.close(); cleanupLink(); });
    for (const socket of [downstream, upstream]) socket.on('error', error => { if (!stopping) errors.push(error); });
  });
  await once(server, 'listening');
  const inject = (direction, message) => {
    const socket = current?.[direction];
    assert.equal(socket?.readyState, WebSocket.OPEN, 'Synthetic relay has no active connection');
    socket.send(JSON.stringify(message), error => { if (error) errors.push(error); });
  };
  return {
    url: `ws://127.0.0.1:${server.address().port}/v1/daemon`, commands, results, acks,
    allowAcks() { passAcks = true; },
    toDaemon(message) { inject('downstream', message); },
    toController(message) { inject('upstream', message); },
    check() { if (errors.length) throw new AggregateError(errors, 'Synthetic terminal relay failure'); },
    async close() {
      stopping = true;
      const failures = [];
      for (const { downstream, upstream } of links) {
        for (const socket of [downstream, upstream]) {
          try { await closeTestWebSocket(socket); } catch (error) { failures.push(error); }
        }
      }
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      if (failures.length) throw new AggregateError(failures, 'Synthetic relay cleanup failed');
    },
  };
}
