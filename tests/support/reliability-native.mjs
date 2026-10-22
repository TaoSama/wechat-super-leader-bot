import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopTestProcess, withTestCleanup } from './cleanup.mjs';
import { waitFor } from './control-plane-fixture.mjs';
import { verificationEnvironment } from '../../scripts/verify.mjs';

const require = createRequire(new URL('../../controller/package.json', import.meta.url));
const { WebSocketServer, WebSocket } = require('ws');
const MAX_LOG_CHUNKS = 100;
const DAEMON_BINARY = fileURLToPath(new URL('../../daemon/bin/super-leader-daemon', import.meta.url));

/** Real Go daemon and journal, with only its native Codex transport replaced. */
export function createNativeFixture({ dir, env = verificationEnvironment(), controllerUrl, nodeId, nodeToken,
  sessionId = randomUUID(), evidence = () => {} }) {
  const socketPath = join(dir, 'native.sock');
  assert(Buffer.byteLength(socketPath) < 104, 'Use a short temporary directory for the Unix socket');
  const tokenPath = join(dir, 'node-token');
  const stateDir = join(dir, 'journal');
  const starts = [], resumes = [], errors = [], logs = [], requests = [], turns = [];
  const held = new Map();
  let status = 'idle', loaded = true, nextFault, daemon, server, sockets, spawnError, stopping = false;
  function healthy() {
    if (errors.length) throw new AggregateError(errors, 'Native fixture errors');
    if (spawnError) throw spawnError;
    if (daemon && !stopping && (daemon.exitCode !== null || daemon.signalCode !== null)) {
      throw new Error(`Owned daemon exited unexpectedly: ${logs.join('')}`);
    }
  }
  function socketError(error) {
    if (['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED'].includes(error.code)) {
      evidence('native-peer-disconnected', { code: error.code });
    } else errors.push(error);
  }
  const snapshot = includeTurns => ({ id: sessionId, title: 'Synthetic reliability session',
    cwd: dir, source: 'appServer', status: { type: status }, model: 'synthetic-model', updatedAt: Date.now(),
    ...(includeTurns ? { turns: structuredClone(turns) } : {}) });
  function reply(socket, id, result) {
    if (socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, result }), error => { if (error) socketError(error); });
    return true;
  }
  function handle(socket, message) {
    const { method, params = {}, id } = message;
    requests.push({ method, threadId: params.threadId, includeTurns: params.includeTurns, connectionId: socket.fixtureConnectionId });
    switch (method) {
      case 'initialized': return;
      case 'initialize': reply(socket, id, { userAgent: 'synthetic-reliability-native' }); return;
      case 'thread/loaded/list': reply(socket, id, { data: loaded ? [sessionId] : [], nextCursor: null }); return;
      case 'thread/list': reply(socket, id, { data: [snapshot(false)], nextCursor: null }); return;
      case 'thread/read':
        assert.equal(params.threadId, sessionId, 'Native read crossed session identity');
        reply(socket, id, { thread: snapshot(params.includeTurns === true) }); return;
      case 'thread/items/list':
        assert.equal(params.threadId, sessionId);
        reply(socket, id, { data: turns.flatMap(turn => turn.items), nextCursor: null }); return;
      case 'thread/resume': {
        assert.equal(params.threadId, sessionId);
        assert(['idle', 'notLoaded'].includes(status), 'Native resume bypassed busy or unknown state');
        const resume = { threadId: params.threadId, connectionId: socket.fixtureConnectionId, previouslyLoaded: loaded };
        resumes.push(resume);
        evidence('native-thread-resume', resume);
        loaded = true;
        status = 'idle';
        reply(socket, id, { thread: snapshot(false) }); return;
      }
      case 'turn/start': {
        assert.equal(params.threadId, sessionId, 'Native dispatch crossed session identity');
        assert.equal(status, 'idle', 'Native dispatch bypassed busy state');
        const turnId = randomUUID();
        const prompt = params.input.map(item => item.text ?? '').join('');
        const start = { threadId: params.threadId, prompt, turnId, connectionId: socket.fixtureConnectionId,
          clientUserMessageId: params.clientUserMessageId ?? null };
        starts.push(start);
        turns.push({ id: turnId, status: 'inProgress', items: [
          { id: randomUUID(), type: 'userMessage', content: [{ type: 'text', text: prompt }] },
        ] });
        status = 'active';
        const fault = nextFault;
        nextFault = undefined;
        evidence('native-turn-start', { ...start, fault: fault ?? 'none' });
        if (fault === 'drop') { socket.terminate(); return; }
        if (fault === 'hold') { held.set(turnId, { socket, id }); return; }
        reply(socket, id, { turn: { id: turnId } }); return;
      }
      default: throw new Error(`Unexpected synthetic native RPC: ${method}`);
    }
  }
  async function startServer() {
    if (server) return;
    await mkdir(dir, { recursive: true });
    await writeFile(tokenPath, nodeToken + '\n', { mode: 0o600 });
    server = createServer();
    sockets = new WebSocketServer({ server });
    sockets.on('error', error => errors.push(error));
    server.on('error', error => errors.push(error));
    sockets.on('connection', socket => {
      socket.fixtureConnectionId = randomUUID();
      socket.on('error', socketError);
      socket.on('message', data => {
        try { handle(socket, JSON.parse(data.toString())); }
        catch (error) { errors.push(error); socket.terminate(); }
      });
    });
    server.listen(socketPath);
    await once(server, 'listening');
  }
  async function startDaemon() {
    assert(server, 'Start the native server before its daemon');
    assert(!daemon, 'Owned daemon is already running');
    const target = new URL(controllerUrl);
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'Owned daemon requires a loopback Controller');
    assert(['http:', 'https:', 'ws:', 'wss:'].includes(target.protocol), 'Invalid Controller transport');
    assert(!target.username && !target.password && !target.search && !target.hash, 'Controller URL must not carry credentials or query');
    target.protocol = ['https:', 'wss:'].includes(target.protocol) ? 'wss:' : 'ws:';
    if (target.pathname === '/') target.pathname = '/v1/daemon';
    stopping = false;
    spawnError = undefined;
    daemon = spawn(DAEMON_BINARY, ['--node-id', nodeId, '--controller-url', target.href,
      '--token-file', tokenPath, '--sock', socketPath, '--state-dir', stateDir, '--heartbeat', '1'], {
      env: { ...verificationEnvironment(env), SKILL_ROOTS: '[]' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    evidence('process-start', { component: 'daemon', pid: daemon.pid });
    const append = chunk => {
      const text = chunk.toString().replaceAll(nodeToken, '[redacted]');
      logs.push(text);
      evidence('process-log', { component: 'daemon', text });
      if (logs.length > MAX_LOG_CHUNKS) logs.shift();
    };
    daemon.stdout.on('data', append);
    daemon.stderr.on('data', append);
    daemon.on('error', error => { spawnError = error; });
    const discoveredBefore = requests.filter(request => request.method === 'thread/list').length;
    await waitFor(() => { healthy(); return requests.filter(request => request.method === 'thread/list').length > discoveredBefore; },
      'Owned daemon discovers synthetic native session');
  }
  async function stopDaemon({ crash = false } = {}) {
    if (!daemon) return;
    stopping = true;
    if (crash && daemon.exitCode === null && daemon.signalCode === null) {
      const exited = once(daemon, 'exit');
      assert(daemon.kill('SIGKILL'), 'Could not kill owned daemon');
      await exited;
    } else await stopTestProcess(daemon);
    daemon = undefined;
    held.clear();
  }
  async function stopServer() {
    if (!server) return;
    for (const socket of sockets.clients) socket.terminate();
    await new Promise((resolve, reject) => sockets.close(error => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server = undefined;
  }
  return {
    sessionId, socketPath, stateDir, starts, resumes, turns, errors, logs, requests, healthy,
    async start() { await startServer(); await startDaemon(); },
    async stop() {
      await withTestCleanup(() => stopDaemon(), [{ label: 'synthetic native server', cleanup: stopServer }]);
    },
    startDaemon, stopDaemon,
    async restart({ crash = false } = {}) { await stopDaemon({ crash }); await startDaemon(); },
    async crashDaemon() { await stopDaemon({ crash: true }); },
    setStatus(value) { status = value === 'busy' ? 'active' : value; },
    setLoaded(value) { loaded = value; },
    complete(turnId, output) {
      const turn = turns.find(item => item.id === turnId);
      assert(turn, `Unknown synthetic turn: ${turnId}`);
      assert.equal(turn.status, 'inProgress', 'Synthetic turn completed twice');
      turn.status = 'completed';
      turn.items.push({ id: randomUUID(), type: 'agentMessage', text: output, phase: 'final_answer' });
      status = 'idle';
    },
    holdNextStart() { assert(!nextFault, 'Native fault already armed'); nextFault = 'hold'; },
    dropNextStartAck() { assert(!nextFault, 'Native fault already armed'); nextFault = 'drop'; },
    ackStart(turnId = [...held.keys()].at(-1)) {
      const pending = held.get(turnId);
      assert(pending, 'No held native turn acknowledgement');
      assert(reply(pending.socket, pending.id, { turn: { id: turnId } }), 'Held native socket already closed');
      held.delete(turnId);
    },
    async waitForStarts(count) {
      await waitFor(() => { healthy(); return starts.length >= count; }, `Native turn/start count ${count}`);
      assert.equal(starts.length, count, 'Unexpected duplicate native dispatch');
      return starts[count - 1];
    },
  };
}
