import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopTestProcess, withTestCleanup } from './scripts/test-cleanup.mjs';

export const TERMINAL_HISTORY_NODE = 'terminal-history-node';
const FRAME_LIMIT = 1024 * 1024;
const PRIVATE_TEXT = 'PRIVATE-REASONING-NEVER-PUBLISH';
const PROVIDERS = ['codex', 'claude', 'grok'];
const IDS = {
  codex: '11111111-1111-4111-8111-111111111111',
  claude: '22222222-2222-4222-8222-222222222222',
  grok: 'synthetic-original',
};
const PANES = Object.fromEntries(PROVIDERS.map((provider, index) => [provider, `w2:p${index + 1}`]));
const jsonl = record => JSON.stringify(record) + '\n';
function record(provider, index, privateText = false) {
  const role = index % 2 ? 'assistant' : 'user';
  const text = privateText ? PRIVATE_TEXT : `${provider}-public-${index}`;
  if (provider === 'codex') return jsonl({ type: 'response_item', payload: privateText
    ? { type: 'reasoning', content: [{ type: 'output_text', text }] }
    : { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
  if (provider === 'claude') return jsonl({ type: role, sessionId: IDS.claude,
    message: { role, content: [{ type: privateText ? 'thinking' : 'text', text }] } });
  return jsonl({ method: 'session/update', params: { sessionId: IDS.grok,
    update: { sessionUpdate: privateText ? 'agent_thought_chunk' : role === 'user' ? 'user_message_chunk' : 'agent_message_chunk',
      content: { type: 'text', text } } } });
}
function records(provider) {
  const header = provider === 'codex' ? jsonl({ type: 'session_meta', payload: { id: IDS.codex, source: 'cli' } }) : '';
  return header + Array.from({ length: 6 }, (_, index) => record(provider, index)).join('') + record(provider, 7, true);
}

// Runs real Go and real Controller HTTP/WS, using only owned socket/files and
// the caller's temporary PostgreSQL. No production session or credentials.
export async function verifyTerminalHistory({ base, request, nodeToken, waitFor }) {
  const directory = await mkdtemp(join(tmpdir(), 'slth-'));
  const socketPath = join(directory, 'terminal.sock'), binary = join(directory, 'daemon');
  const roots = Object.fromEntries(PROVIDERS.map(provider => [provider, join(directory, provider)]));
  const paths = {
    codex: join(roots.codex, '2026/10/12', `rollout-2026-10-12T01-02-03-${IDS.codex}.jsonl`),
    claude: join(roots.claude, 'project', IDS.claude + '.jsonl'),
    grok: join(roots.grok, 'project', IDS.grok, 'updates.jsonl'),
  };
  const state = Object.fromEntries(PROVIDERS.map(provider => [provider, { id: IDS[provider], revision: 1 }]));
  const peers = new Set(), failures = [], methods = [], logs = [];
  let daemon;
  const server = createServer(socket => {
    peers.add(socket);
    socket.on('close', () => peers.delete(socket));
    socket.on('error', error => failures.push(error));
    let buffer = Buffer.alloc(0), pinged = false;
    socket.on('data', chunk => {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        assert(buffer.length <= FRAME_LIMIT);
        for (let newline; (newline = buffer.indexOf(10)) >= 0;) {
          const message = JSON.parse(buffer.subarray(0, newline).toString());
          buffer = buffer.subarray(newline + 1);
          methods.push(message.method);
          let result;
          if (message.method === 'ping') {
            assert.deepEqual(message.params, {}); pinged = true;
            result = { type: 'pong', protocol: 22, version: 'synthetic' };
          } else {
            assert(pinged);
            assert.equal(message.method, 'agent.get', 'History attempted terminal input or screen fallback');
            const provider = PROVIDERS.find(provider => PANES[provider] === message.params.target);
            assert(provider, 'History addressed an unauthorized pane');
            assert.deepEqual(message.params, { target: PANES[provider] });
            result = { type: 'agent_info', agent: {
              pane_id: PANES[provider], terminal_id: `terminal-${provider}`, workspace_id: 'w2', tab_id: 'w2:t1',
              agent: provider, agent_status: 'working', focused: false, revision: state[provider].revision,
              interactive_ready: true, launch_pending: false, screen_detection_skipped: false,
              agent_session: { source: `herdr:${provider}`, agent: provider, kind: 'id', value: state[provider].id },
              cwd: '/synthetic-terminal-history',
            } };
          }
          socket.write(jsonl({ id: message.id, result }));
        }
      } catch (error) { failures.push(error); socket.destroy(); }
    });
  });
  const check = () => {
    if (failures.length) throw new AggregateError(failures, 'Synthetic terminal history host failed');
    if (daemon && (daemon.exitCode !== null || daemon.signalCode !== null)) throw new Error(`History daemon exited: ${logs.join('')}`);
  };
  const sessions = async () => (await request('/v1/status')).body.sessions.filter(session => session.nodeId === TERMINAL_HISTORY_NODE);
  async function launch(enabled) {
    daemon = spawn(binary, ['--node-id', TERMINAL_HISTORY_NODE,
      '--controller-url', base.replace(/^http/, 'ws') + '/v1/daemon',
      '--sock', join(directory, 'absent.sock'), '--state-dir', join(directory, 'journal'), '--heartbeat', '1',
      '--terminal-sock', socketPath, ...PROVIDERS.flatMap(provider => ['--terminal-pane', PANES[provider]]),
      ...(enabled ? PROVIDERS.flatMap(provider => ['--terminal-history-root', `${provider}=${roots[provider]}`]) : [])], {
      env: { PATH: process.env.PATH, NODE_TOKEN: nodeToken, SKILL_ROOTS: '[]' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    daemon.on('error', error => failures.push(error));
    for (const stream of [daemon.stdout, daemon.stderr]) stream.on('data', chunk => {
      logs.push(chunk.toString().replaceAll(nodeToken, '[redacted]')); if (logs.length > 30) logs.shift();
    });
    await waitFor(async () => { check(); return (await sessions()).length === PROVIDERS.length; }, 'Terminal history discovery');
  }
  async function shutdown() {
    await stopTestProcess(daemon); daemon = undefined;
    await waitFor(async () => (await sessions()).length === 0, 'Terminal history disconnect');
  }
  const route = session => `/v1/sessions/${TERMINAL_HISTORY_NODE}/${encodeURIComponent(session.id)}/history`;
  const query = history => `historyContext=${encodeURIComponent(history.historyContext)}`;
  const expectHistory = response => { assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; };
  return withTestCleanup(async () => {
    execFileSync('go', ['build', '-o', binary, '.'], { cwd: fileURLToPath(new URL('./daemon/', import.meta.url)), timeout: 60_000, stdio: 'pipe' });
    for (const provider of PROVIDERS) {
      await mkdir(dirname(paths[provider]), { recursive: true });
      await writeFile(paths[provider], records(provider));
    }
    server.listen(socketPath); await once(server, 'listening');
    const commandsBefore = (await request('/v1/status')).body.commands;
    await launch(false);
    for (const session of await sessions()) {
      assert.equal(session.historySource, undefined);
      assert.equal((await request(route(session))).status, 502, 'Default-off exposed transcript');
    }
    await shutdown(); await launch(true);
    const selected = Object.fromEntries((await sessions()).map(session => [session.provider.slice('terminal/'.length), session]));
    const histories = {};
    for (const provider of PROVIDERS) {
      const session = selected[provider];
      assert.equal(session.historySource, 'terminal-transcript');
      assert.equal(session.status, 'active'); assert.equal(session.loaded, false);
      assert.equal(session.sendAvailability, undefined);
      const latest = expectHistory(await request(`${route(session)}?limit=2`));
      histories[provider] = latest;
      assert.equal(latest.source, 'terminal-transcript');
      assert.equal(latest.session.id, session.id); assert.equal(latest.session.loaded, false);
      assert.deepEqual(latest.items.map(item => item.text), [4, 5].map(index => `${provider}-public-${index}`));
      assert(latest.items.every(item => item.turnId === '' && item.status === undefined));
      if (provider === 'grok') assert(latest.items.every(item => item.type === 'transcript_chunk'));
      assert(!JSON.stringify(latest).includes(PRIVATE_TEXT));
      assert(!JSON.stringify(latest).includes(directory));
      const earlierPath = `${route(session)}?limit=2&${query(latest)}&cursor=${encodeURIComponent(latest.nextCursor)}`;
      const earlier = expectHistory(await request(earlierPath));
      assert.deepEqual(earlier.items.map(item => item.text), [2, 3].map(index => `${provider}-public-${index}`));
      await appendFile(paths[provider], record(provider, 6));
      const refreshed = expectHistory(await request(`${route(session)}?limit=2&${query(latest)}`));
      assert.equal(refreshed.historyContext, latest.historyContext);
      assert.equal(refreshed.items.at(-1).text, `${provider}-public-6`);
      assert.deepEqual(expectHistory(await request(earlierPath)).items, earlier.items, 'Append shifted previous page');
      const oldest = expectHistory(await request(`${route(session)}?limit=2&${query(latest)}&cursor=${encodeURIComponent(earlier.nextCursor)}`));
      assert.deepEqual(oldest.items.map(item => item.text), [0, 1].map(index => `${provider}-public-${index}`));
      assert.equal(oldest.nextCursor, null);
    }
    console.log('PASS terminal history real Go → WS → Controller/PostgreSQL → HTTP: default off, three explicit providers, working agents readable, public text only, fixed old pages after append, opaque context, no loaded/send/turn/completion invention');
    const codexRoute = route(selected.codex), oldQuery = query(histories.codex);
    assert.equal((await request(`${route(selected.claude)}?${oldQuery}`)).status, 409, 'Cross-session context accepted');
    await writeFile(paths.codex, records('codex').replace('codex-public-0', 'codex-edited-0'));
    assert.equal((await request(`${codexRoute}?${oldQuery}`)).status, 409, 'Prefix rewrite kept old context');
    const reset = expectHistory(await request(`${codexRoute}?limit=2`));
    assert.notEqual(reset.historyContext, histories.codex.historyContext);
    const replacement = paths.codex + '.replacement';
    await writeFile(replacement, records('codex')); await rename(replacement, paths.codex);
    assert.equal((await request(`${codexRoute}?${query(reset)}`)).status, 409, 'Inode replacement kept context');
    const beforeDelete = expectHistory(await request(codexRoute));
    await rm(paths.codex);
    assert.equal((await request(`${codexRoute}?${query(beforeDelete)}`)).status, 409, 'Deleted transcript kept context');
    assert.equal((await request(codexRoute)).status, 502, 'Missing file fell back to screen/control');
    await writeFile(paths.codex, records('codex'));
    const beforeBinding = expectHistory(await request(codexRoute));
    state.codex.id = '33333333-3333-4333-8333-333333333333'; state.codex.revision++;
    assert.equal((await request(`${codexRoute}?${query(beforeBinding)}`)).status, 409, 'Same pane replacement kept context');
    state.codex.id = IDS.codex; state.codex.revision++;
    assert.equal((await request(`${codexRoute}?${query(beforeBinding)}`)).status, 409, 'Restored binding revived expired context');
    await shutdown(); await launch(true);
    assert.equal((await request(`${route(selected.claude)}?${query(histories.claude)}`)).status, 409, 'Reconnect retained context');
    expectHistory(await request(route(selected.claude)));
    assert.deepEqual((await request('/v1/status')).body.commands, commandsBefore, 'History created a persistent command');
    assert(methods.every(method => method === 'ping' || method === 'agent.get'), 'Unexpected terminal operation');
    check();
    console.log('PASS history invalidation: cross-session, prefix rewrite, inode replacement, deletion, same-pane binding replacement and reconnect → HTTP 409; explicit reset recovers; no screen fallback, zero terminal writes and zero new commands');
  }, [
    { label: 'terminal history daemon', cleanup: () => stopTestProcess(daemon) },
    { label: 'terminal history host', cleanup: async () => {
      for (const peer of peers) peer.destroy();
      if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } },
    { label: 'terminal history files', cleanup: () => rm(directory, { recursive: true, force: true }) },
  ]);
}
