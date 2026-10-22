import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { stopTestProcess } from './cleanup.mjs';
import { waitFor } from './control-plane-fixture.mjs';

const require = createRequire(new URL('../../controller/package.json', import.meta.url));
const { WebSocket, WebSocketServer } = require('ws');
const HTTP_TIMEOUT_MS = 8_000;
const CONTROLLER_DIR = fileURLToPath(new URL('../../controller/', import.meta.url));

export async function listenLocal(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

export async function closeLocal(server) {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

// Barriers apply only to messages passing through this harness's own loopback proxy.
export function barrier(predicate) {
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  return { predicate, entered, release, released, enter, used: false };
}

export async function createControlFixture({ env, databaseUrl, token, nodeId, nodeToken, chatIds, modelUrl, evidence, commandTtlSeconds = 60 }) {
  const reservation = createServer();
  const port = await listenLocal(reservation);
  await closeLocal(reservation);
  const base = `http://127.0.0.1:${port}`;
  const logs = [], frames = [], requests = [], errors = [], peers = new Set(), barriers = new Set();
  let child, spawnError, offline = false, stopping = false, httpFault;
  const controllerEnv = { ...env, HOST: '127.0.0.1', PORT: String(port), CONSOLE_PUBLIC_URL: base,
    PERSISTENCE_MODE: 'postgres', DATABASE_URL: databaseUrl, CONTROLLER_TOKEN: token,
    NODE_TOKENS: JSON.stringify({ [nodeId]: nodeToken }), ALLOWED_CHAT_IDS: chatIds.join(','),
    COMMAND_TTL_SECONDS: String(commandTtlSeconds), TASK_NOTIFICATION_TICK_MS: '100', LEADER_MODE: 'model',
    LEADER_MODEL_BASE_URL: modelUrl, LEADER_MODEL_API_KEY: 'synthetic-model-key', LEADER_MODEL_NAME: 'synthetic-reliability' };
  const append = chunk => {
    const text = chunk.toString().replaceAll(token, '[controller-token]').replaceAll(nodeToken, '[node-token]')
      .replaceAll(databaseUrl, '[temporary-postgres]');
    logs.push(text);
    evidence('process-log', { component: 'controller', text });
  };
  const proxy = createServer((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const entry = { method: request.method, path: request.url,
        ...(body.length ? { body: JSON.parse(body.toString()) } : {}) };
      requests.push(entry);
      if (httpFault?.predicate(entry)) {
        const fault = httpFault; httpFault = undefined;
        if (fault.mode === 'offline') { fault.enter(entry); response.destroy(); return; }
        entry.fault = fault;
      }
      const upstream = httpRequest(base + request.url, { method: request.method,
        headers: { ...request.headers, host: new URL(base).host }, timeout: HTTP_TIMEOUT_MS }, incoming => {
        const parts = [];
        incoming.on('data', chunk => parts.push(chunk));
        incoming.on('error', error => { errors.push(error); response.destroy(error); });
        incoming.on('end', () => {
          entry.status = incoming.statusCode;
          const bytes = Buffer.concat(parts);
          if (entry.fault) {
            entry.fault.enter({ ...entry, response: bytes.toString() });
            response.destroy();
            return;
          }
          response.writeHead(incoming.statusCode, incoming.headers);
          response.end(bytes);
        });
      });
      upstream.on('timeout', () => upstream.destroy(new Error('Owned Controller proxy timeout')));
      upstream.on('error', error => {
        evidence('proxy-transport', { path: request.url, code: error.code ?? error.message });
        if (!response.destroyed) { response.writeHead(503); response.end(JSON.stringify({ error: 'Owned upstream unavailable' })); }
      });
      upstream.end(body);
    })().catch(error => { errors.push(error); response.destroy(error); });
  });
  const wss = new WebSocketServer({ noServer: true });
  const forward = async (direction, data, target) => {
    const frame = JSON.parse(data.toString());
    frames.push({ direction, ...frame });
    if (['command', 'result', 'inspect-command', 'command-receipt'].includes(frame.type)) evidence('wire-frame', { direction, frame });
    const hold = [...barriers].find(item => !item.used && item.predicate({ direction, frame }));
    if (hold) { hold.used = true; hold.enter(frame); await hold.released; }
    if (target.readyState === WebSocket.OPEN) target.send(data, error => { if (error) errors.push(error); });
  };
  proxy.on('upgrade', (request, socket, head) => {
    if (offline || stopping) { socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n'); return; }
    wss.handleUpgrade(request, socket, head, downstream => {
      const upstream = new WebSocket(base.replace('http:', 'ws:') + request.url,
        { headers: { authorization: request.headers.authorization } });
      const pair = { downstream, upstream };
      peers.add(pair);
      const pending = [];
      downstream.on('message', data => {
        if (upstream.readyState === WebSocket.OPEN) void forward('daemon-controller', data, upstream).catch(error => errors.push(error));
        else pending.push(data);
      });
      upstream.on('open', () => { for (const data of pending) void forward('daemon-controller', data, upstream).catch(error => errors.push(error)); });
      upstream.on('message', data => { void forward('controller-daemon', data, downstream).catch(error => errors.push(error)); });
      for (const [source, other] of [[upstream, downstream], [downstream, upstream]]) {
        source.on('close', () => { peers.delete(pair); if (other.readyState < WebSocket.CLOSING) other.terminate(); });
        source.on('error', error => evidence('proxy-socket', { code: error.code ?? error.message }));
      }
    });
  });
  const proxyUrl = `http://127.0.0.1:${await listenLocal(proxy)}`;
  controllerEnv.CONSOLE_PUBLIC_URL = proxyUrl;
  const fixture = {
    base, proxyUrl, logs, frames, requests, errors, env: controllerEnv,
    healthy() { if (errors.length) throw new AggregateError(errors, 'Control fixture failed'); },
    async start() {
      stopping = false; spawnError = undefined;
      child = spawn(process.execPath, ['dist/index.js'], { cwd: CONTROLLER_DIR, env: controllerEnv, stdio: ['ignore', 'pipe', 'pipe'] });
      child.once('error', error => { spawnError = error; });
      child.stdout.on('data', append); child.stderr.on('data', append);
      evidence('process-start', { component: 'controller', pid: child.pid });
      await waitFor(async () => {
        if (spawnError) throw spawnError;
        assert.equal(child.exitCode, null, logs.join(''));
        try { return (await fetch(base + '/health', { signal: AbortSignal.timeout(1_000) })).ok; }
        catch (error) { if (error instanceof TypeError || error.name === 'TimeoutError') return false; throw error; }
      }, 'real Controller ready');
    },
    async crash() {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      assert(child.kill('SIGKILL'));
      await exited;
      evidence('process-crash', { component: 'controller', signal: 'SIGKILL' });
    },
    async restart() { await fixture.crash(); await fixture.start(); },
    async request(path, body) {
      const result = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      return { status: result.status, body: await result.json() };
    },
    setOffline(value) {
      offline = value;
      if (value) for (const pair of peers) { pair.upstream.terminate(); pair.downstream.terminate(); }
      evidence('daemon-link', { offline: value });
    },
    replayResult(frame) {
      assert.equal(frame.type, 'result');
      const peer = [...peers].find(pair => pair.upstream.readyState === WebSocket.OPEN);
      assert(peer, 'No owned Daemon connection for receipt replay');
      peer.upstream.send(JSON.stringify(frame), error => { if (error) errors.push(error); });
      evidence('result-replay', { frame });
    },
    holdFrame(predicate) { const hold = barrier(predicate); barriers.add(hold); return hold; },
    failHttp(predicate, mode = 'after-commit') { const fault = barrier(predicate); fault.mode = mode; httpFault = fault; return fault; },
    async stop() {
      stopping = true;
      for (const hold of barriers) hold.release();
      for (const pair of peers) { pair.upstream.terminate(); pair.downstream.terminate(); }
      await stopTestProcess(child); child = undefined;
      await new Promise((resolve, reject) => wss.close(error => error ? reject(error) : resolve()));
      await closeLocal(proxy);
    },
  };
  return fixture;
}
