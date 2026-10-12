import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopTestProcess, withTestCleanup } from './scripts/test-cleanup.mjs';

export const TERMINAL_NODE = 'terminal-fixture-node';
const PANE_ID = 'w1:p1';
const OUTPUT = 'SYNTHETIC_TERMINAL_SNAPSHOT';
const READ_PREFIX = '读取测试终端记录 ';
const FRAME_LIMIT = 1024 * 1024;

export function terminalModelCall(text) {
  if (text === '查询测试终端状态') return { name: 'list_sessions', args: { nodeId: TERMINAL_NODE } };
  if (typeof text === 'string' && text.startsWith(READ_PREFIX)) {
    return { name: 'read_session', args: { nodeId: TERMINAL_NODE, sessionId: text.slice(READ_PREFIX.length) } };
  }
  return null;
}

// Real Controller/PostgreSQL and Go daemon; the only terminal is this owned fixture socket.
export async function verifyTerminalObservation({ base, request, nodeToken, waitFor }) {
  const directory = await mkdtemp(join(tmpdir(), 'slt-'));
  const socketPath = join(directory, 'terminal.sock');
  const binary = join(directory, 'daemon');
  const stateDir = join(directory, 'journal');
  const errors = [], logs = [], methods = [], peers = new Set();
  const state = { available: true, status: 'working', revision: 1 };
  let daemon;
  const agent = () => ({ terminal_id: 'fixture-terminal', agent: 'claude',
    agent_session: { agent: 'claude', kind: 'id', source: 'fixture', value: 'fixture-session' },
    agent_status: state.status, workspace_id: 'w1', tab_id: 'w1:t1', pane_id: PANE_ID,
    focused: false, interactive_ready: true, launch_pending: false, revision: state.revision,
    cwd: '/fixture', title: '合成终端观测', tokens: { private: 'synthetic-private-metadata' } });
  const server = createServer(socket => {
    peers.add(socket);
    socket.on('close', () => peers.delete(socket));
    socket.on('error', error => errors.push(error));
    let buffer = '';
    let pinged = false;
    socket.on('data', chunk => {
      try {
        buffer += chunk.toString();
        assert(Buffer.byteLength(buffer) <= FRAME_LIMIT);
        while (buffer.includes('\n')) {
          const newline = buffer.indexOf('\n');
          const message = JSON.parse(buffer.slice(0, newline));
          buffer = buffer.slice(newline + 1);
          assert.match(message.id, /^[a-f0-9-]{36}$/i);
          methods.push(message.method);
          let result;
          switch (message.method) {
            case 'ping':
              assert.deepEqual(message.params, {});
              pinged = true;
              result = { type: 'pong', protocol: state.available ? 22 : 23, version: '0.9.0' };
              break;
            case 'agent.get':
              assert(pinged, 'Must negotiate protocol before reading');
              assert.deepEqual(message.params, { target: PANE_ID });
              result = { type: 'agent_info', agent: agent() };
              break;
            case 'pane.read':
              assert(pinged);
              assert.deepEqual(message.params, { pane_id: PANE_ID, source: 'recent_unwrapped', format: 'text', strip_ansi: true, lines: 120 });
              result = { type: 'pane_read', read: { pane_id: PANE_ID, workspace_id: 'w1', tab_id: 'w1:t1',
                source: 'recent_unwrapped', format: 'text', text: OUTPUT, revision: state.revision, truncated: true } };
              break;
            default: throw new Error(`Unexpected terminal method: ${message.method}`);
          }
          socket.write(JSON.stringify({ id: message.id, result }) + '\n');
        }
      } catch (error) { errors.push(error); socket.destroy(); }
    });
  });
  const terminalArgs = ['--terminal-sock', socketPath, '--terminal-pane', PANE_ID];
  const env = { PATH: process.env.PATH, SKILL_ROOTS: '[]' };
  const status = async () => (await request('/v1/status')).body.sessions.find(value => value.nodeId === TERMINAL_NODE);
  const healthy = () => {
    if (errors.length) throw new AggregateError(errors, 'Terminal fixture protocol failure');
    if (daemon && (daemon.exitCode !== null || daemon.signalCode !== null)) throw new Error(`Terminal fixture daemon exited: ${logs.join('')}`);
  };
  async function probe(args) {
    const child = spawn(binary, ['--probe', '--sock', join(directory, 'missing-control.sock'), '--state-dir', stateDir, ...args],
      { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    const [code] = await once(child, 'exit');
    return { code, stdout, stderr };
  }
  await withTestCleanup(async () => {
    execFileSync('go', ['build', '-o', binary, '.'], {
      cwd: fileURLToPath(new URL('./daemon/', import.meta.url)), timeout: 60_000, stdio: 'pipe',
    });
    server.listen(socketPath);
    await once(server, 'listening');
    const disabled = await probe([]);
    assert.notEqual(disabled.code, 0, 'No sources should not silently succeed');
    assert.equal(methods.length, 0, 'Default probe must not contact terminal');
    const enabled = await probe(terminalArgs);
    assert.equal(enabled.code, 0, enabled.stderr);
    const observed = JSON.parse(enabled.stdout);
    assert.deepEqual(observed.sources, { control: false, catalog: false, desktop: false, terminal: true });
    assert.equal(observed.sessions.length, 1);
    await assert.rejects(access(stateDir), { code: 'ENOENT' }, 'Probe must not create journal or require token');
    assert(!methods.includes('pane.read'), 'Discovery read terminal content without a request');
    daemon = spawn(binary, ['--node-id', TERMINAL_NODE, '--controller-url', `${base.replace('http:', 'ws:')}/v1/daemon`,
      '--sock', join(directory, 'missing-control.sock'), '--state-dir', stateDir, '--heartbeat', '1', ...terminalArgs],
    { env: { ...env, NODE_TOKEN: nodeToken }, stdio: ['ignore', 'pipe', 'pipe'] });
    daemon.on('error', error => errors.push(error));
    for (const stream of [daemon.stdout, daemon.stderr]) stream.on('data', chunk => {
      logs.push(chunk.toString().replaceAll(nodeToken, '[redacted]'));
      if (logs.length > 30) logs.shift();
    });
    await waitFor(async () => { healthy(); return (await status())?.status === 'active'; }, 'Terminal registration');
    const session = await status();
    assert.match(session.id, /^terminal:[A-Za-z0-9_-]{43}$/);
    assert.equal(session.provider, 'terminal/claude');
    assert.equal(session.loaded, false);
    assert.deepEqual(session.capabilities, ['read']);
    assert.equal(session.model, undefined);
    assert.equal(session.desktopObservation, undefined);
    assert.equal(session.sendAvailability, undefined);
    assert(!JSON.stringify(session).includes('synthetic-private-metadata'));
    const message = text => request('/v1/messages', { chatId: 'test-chat', messageId: randomUUID(), text });
    const listed = await message('查询测试终端状态');
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert(listed.body.text.includes('"statusSource":"terminal"'));
    assert(listed.body.text.includes('"executionStatus":"active"'));
    assert(!methods.includes('pane.read'), 'List tool must not read terminal content');
    const commandsBeforeRead = (await request('/v1/status')).body.commands.length;
    const read = await message(READ_PREFIX + session.id);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert(read.body.text.includes('history_unavailable'), JSON.stringify(read.body));
    assert(!read.body.text.includes(OUTPUT));
    assert(!methods.includes('pane.read'), 'History tool must not fall back to terminal screen');
    assert.equal((await request('/v1/status')).body.commands.length, commandsBeforeRead);
    // Explicit diagnostic commands still expose labeled pane snapshots, not history.
    const snapshot = await request('/v1/commands', { nodeId: TERMINAL_NODE, sessionId: session.id,
      action: 'read', requestId: randomUUID() });
    assert.equal(snapshot.status, 200, JSON.stringify(snapshot.body));
    assert(snapshot.body.output.includes(OUTPUT));
    assert(snapshot.body.output.includes('终端快照') && snapshot.body.output.includes('裁剪'));
    assert.equal(snapshot.body.turnId, undefined, 'Snapshot must not invent a native turn');
    const target = `/v1/sessions/${TERMINAL_NODE}/${encodeURIComponent(session.id)}`;
    const history = await request(target + '/history');
    assert.equal(history.status, 502, JSON.stringify(history.body));
    assert.equal(history.body.code, 'history_unavailable');
    assert.equal(history.body.history, undefined);
    for (const [path, body] of [[target + '/messages', { prompt: 'must not send', requestId: randomUUID() }],
      ['/v1/commands', { nodeId: TERMINAL_NODE, sessionId: session.id, action: 'send', prompt: 'must not send', requestId: randomUUID() }]]) {
      const denied = await request(path, body);
      assert.equal(denied.status, 409, JSON.stringify(denied.body));
    }
    state.status = 'blocked'; state.revision++;
    await waitFor(async () => { healthy(); return (await status())?.status === 'blocked'; }, 'Blocked terminal observation');
    const beforeFailure = await status();
    state.available = false;
    await waitFor(async () => { healthy(); return (await status())?.status === 'unknown'; }, 'Revoked failed terminal source');
    const stale = await status();
    assert(Date.parse(stale.observedAt) <= Date.now());
    assert.equal(stale.observedAt, beforeFailure.observedAt, 'Failure must not refresh the old observation time');
    state.available = true; state.status = 'done'; state.revision++;
    await waitFor(async () => { healthy(); return (await status())?.status === 'idle'; }, 'Terminal source recovery');
    assert.equal((await status()).id, session.id, 'Lifecycle transition changed identity');
    assert(methods.every(method => ['ping', 'agent.get', 'pane.read'].includes(method)));
    healthy();
    console.log('PASS real Go terminal observer → PostgreSQL Controller → Leader list/history-unavailable with zero commands or pane reads; explicit diagnostic snapshot, source failure/recovery, no history/send/native turn; default disabled probe');
  }, [
    { label: 'terminal fixture daemon', cleanup: () => stopTestProcess(daemon) },
    { label: 'terminal fixture socket', cleanup: async () => {
      for (const peer of peers) peer.destroy();
      if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } },
    { label: 'terminal fixture files', cleanup: () => rm(directory, { recursive: true, force: true }) },
  ]);
}
