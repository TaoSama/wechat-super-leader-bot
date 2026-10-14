import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { stopTestProcess, withTestCleanup } from '../../support/cleanup.mjs';
import { createTerminalRelay } from './terminal-relay.mjs';

export const TERMINAL_INPUT_NODE = 'terminal-input-node';
const PANE = 'w2:p3';
const PROMPT = '仅向合成目标输入。\n保留中文、多行与结尾空格  ';
const PLAN_PROMPT = 'terminal-natural-language';
const PLAN_PREFIX = '规划终端输入 ';
const DEPENDENCY_PREFIX = '规划终端依赖 ';
const FRAME_LIMIT = 1024 * 1024;

export function terminalInputModelCall(text) {
  if (typeof text !== 'string') return null;
  const dependent = text.startsWith(DEPENDENCY_PREFIX);
  if (!dependent && !text.startsWith(PLAN_PREFIX)) return null;
  const sessionId = text.slice((dependent ? DEPENDENCY_PREFIX : PLAN_PREFIX).length);
  const action = { nodeId: TERMINAL_INPUT_NODE, sessionId, prompt: PLAN_PROMPT };
  return { name: 'propose_plan', args: { actions: dependent ? [action, { ...action, dependsOn: [1] }] : [action] } };
}

// HTTP → real PostgreSQL/Controller → captured WS → real Go process/journal →
// owned terminal socket. No external terminal, Agent, model or WeChat is used.
export async function verifyTerminalControl({ base, request, nodeToken, waitFor, restart, openStore }) {
  const directory = await mkdtemp(join(tmpdir(), 'sltc-'));
  const socketPath = join(directory, 'terminal.sock'), binary = join(directory, 'daemon');
  const stateDir = join(directory, 'journal');
  const peers = new Set(), failures = [], logs = [], prompts = [];
  const state = { session: 'synthetic-original', status: 'idle', revision: 1, dropReceipt: false };
  let daemon, relay;
  const agent = () => ({ pane_id: PANE, terminal_id: 'synthetic-terminal', workspace_id: 'w2', tab_id: 'w2:t1',
    agent: 'codex', agent_status: state.status, focused: false, revision: state.revision,
    interactive_ready: true, launch_pending: false, screen_detection_skipped: false,
    agent_session: { source: 'fixture', agent: 'codex', kind: 'id', value: state.session }, cwd: '/fixture' });
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
          let result;
          if (message.method === 'ping') {
            assert.deepEqual(message.params, {}); pinged = true;
            result = { type: 'pong', protocol: 22, version: 'synthetic' };
          } else {
            assert(pinged, 'Terminal request preceded protocol negotiation');
            assert.equal(message.params.target, PANE);
            if (message.method === 'agent.get') {
              assert.deepEqual(message.params, { target: PANE });
              result = { type: 'agent_info', agent: agent() };
            } else if (message.method === 'agent.prompt') {
              assert.deepEqual(Object.keys(message.params).sort(), ['target', 'text']);
              assert.match(message.id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
              prompts.push({ requestId: message.id, text: message.params.text, session: state.session });
              result = { type: 'agent_prompted', agent: agent() };
              state.revision++;
              if (state.dropReceipt) { socket.end(); return; }
            } else throw new Error(`Unexpected terminal write/read method: ${message.method}`);
          }
          socket.write(JSON.stringify({ id: message.id, result }) + '\n');
        }
      } catch (error) { failures.push(error); socket.destroy(); }
    });
  });
  const status = async () => (await request('/v1/status')).body.sessions.find(session => session.nodeId === TERMINAL_INPUT_NODE);
  const check = () => {
    relay?.check();
    if (failures.length) throw new AggregateError(failures, 'Synthetic terminal host failure');
    if (daemon && (daemon.exitCode !== null || daemon.signalCode !== null)) throw new Error(`Synthetic daemon exited: ${logs.join('')}`);
  };
  const resultCount = id => relay.results.filter(result => result.commandId === id).length;
  const readCommand = async id => (await request(`/v1/commands/${id}`)).body;
  const waitReady = () => waitFor(async () => { check(); return (await status())?.sendAvailability?.state === 'ready'; }, 'Terminal input admission');
  async function launch(enabled) {
    daemon = spawn(binary, ['--node-id', TERMINAL_INPUT_NODE, '--controller-url', relay.url,
      '--sock', join(directory, 'absent-control.sock'), '--state-dir', stateDir, '--heartbeat', '1',
      '--terminal-sock', socketPath, '--terminal-pane', PANE,
      ...(enabled ? ['--terminal-send-mode', 'non-atomic'] : [])], {
      env: { PATH: process.env.PATH, NODE_TOKEN: nodeToken, SKILL_ROOTS: '[]' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    daemon.on('error', error => failures.push(error));
    for (const stream of [daemon.stdout, daemon.stderr]) stream.on('data', chunk => {
      logs.push(chunk.toString().replaceAll(nodeToken, '[redacted]')); if (logs.length > 30) logs.shift();
    });
    await waitFor(async () => { check(); return !!(await status()); }, 'Synthetic terminal input node registration');
    if (enabled) await waitReady();
  }
  async function shutdown() {
    await stopTestProcess(daemon); daemon = undefined;
    await waitFor(async () => !(await request('/v1/status')).body.nodes.some(node => node.nodeId === TERMINAL_INPUT_NODE), 'Synthetic terminal node disconnect');
  }
  const message = text => request('/v1/messages', { chatId: 'test-chat', messageId: randomUUID(), text });
  return withTestCleanup(async () => {
    execFileSync('go', ['build', '-o', binary, './cmd/super-leader-daemon'], { cwd: fileURLToPath(new URL('../../../daemon/', import.meta.url)), timeout: 60_000, stdio: 'pipe' });
    server.listen(socketPath); await once(server, 'listening');
    relay = await createTerminalRelay(base, nodeToken);
    await launch(false);
    const discovered = await status();
    const path = `/v1/sessions/${TERMINAL_INPUT_NODE}/${encodeURIComponent(discovered.id)}/messages`;
    const payload = { requestId: randomUUID(), prompt: PROMPT };
    assert.equal(discovered.sendAvailability, undefined);
    assert.equal((await request(path, payload)).status, 409, 'Default mode admitted terminal input');
    assert.equal(prompts.length, 0);
    await shutdown(); await launch(true);
    const ready = await status();
    assert.equal(ready.id, discovered.id); assert.equal(ready.loaded, false);
    assert.equal(ready.sendAvailability.route, 'terminal-pane');
    assert.equal(ready.sendAvailability.mode, 'non-atomic');
    assert.equal(prompts.length, 0, 'Admission preparation sent input');
    const sent = await request(path, payload);
    assert([200, 202].includes(sent.status), JSON.stringify(sent.body));
    const id = sent.body.commandId;
    await waitFor(async () => { check(); return (await readCommand(id)).status === 'input-written'; }, 'Exact terminal input receipt');
    const receipt = await readCommand(id);
    assert.equal(receipt.sendRoute, 'terminal-pane'); assert.equal(receipt.turnId, undefined);
    assert.equal(receipt.output ?? '', ''); assert.equal(receipt.error, undefined);
    assert.equal(prompts.length, 1); assert.equal(prompts[0].text, PROMPT);
    assert.deepEqual(receipt.inputReceipt, { kind: 'terminal-input-written', sessionId: discovered.id,
      requestId: prompts[0].requestId, promptSHA256: createHash('sha256').update(PROMPT).digest('hex'),
      responseRevision: state.revision - 1, observedRevision: state.revision });
    assert(!JSON.stringify(receipt).includes(socketPath), 'Private endpoint leaked');
    await waitFor(async () => relay.acks.some(ack => ack.commandId === id), 'Persisted receipt ACK');
    const ack = relay.acks.find(ack => ack.commandId === id);
    assert.deepEqual(ack.inputReceipt, receipt.inputReceipt);
    relay.toDaemon({ ...ack, inputReceipt: { ...ack.inputReceipt, requestId: randomUUID() } });
    await delay(100);
    const beforeWrongAckRestart = resultCount(id);
    await shutdown(); await launch(true);
    await waitFor(async () => resultCount(id) > beforeWrongAckRestart, 'Wrong ACK preserves durable result replay');
    assert.equal(prompts.length, 1, 'Restart reissued terminal input');
    relay.toDaemon(ack); await delay(100);
    const beforeCorrectAckRestart = resultCount(id);
    await shutdown(); await launch(true);
    await delay(1200);
    assert.equal(resultCount(id), beforeCorrectAckRestart, 'Correct ACK did not remove pending result');
    relay.allowAcks();
    const originalWire = relay.commands.find(command => command.commandId === id);
    assert(originalWire);
    relay.toDaemon(originalWire);
    await waitFor(async () => resultCount(id) > beforeCorrectAckRestart, 'Same wire command returns durable receipt');
    assert.equal(prompts.length, 1);
    for (const duplicate of await Promise.all(Array.from({ length: 8 }, () => request(path, payload)))) assert.equal(duplicate.body.commandId, id);
    assert.equal(prompts.length, 1);
    assert.equal((await request(path, { ...payload, prompt: 'different input' })).status, 409);
    relay.toController({ type: 'result', commandId: id, status: 'completed', turnId: 'invented-native-turn', output: 'unproven completion' });
    relay.toController({ type: 'result', commandId: id, status: 'input-written', output: '', inputReceipt: { ...receipt.inputReceipt, requestId: randomUUID() } });
    await delay(100);
    assert.deepEqual(await readCommand(id), receipt, 'Invalid late receipt changed input proof');
    await shutdown(); await restart(); await launch(true);
    assert.deepEqual(await readCommand(id), receipt, 'Controller restart changed terminal receipt');
    assert.equal(prompts.length, 1);
    console.log('PASS HTTP → PostgreSQL → WS → real Go durable journal → explicit synthetic pane: exact input-written proof, no turn/output/completed; disabled by default; wrong/correct ACK, raw-command and HTTP dedup, both process restarts never resend');

    // A fresh route hint cannot authorize a replacement session inside the same pane.
    state.session = 'synthetic-replacement'; state.revision++;
    const changed = await request(path, { ...payload, requestId: randomUUID() });
    if (changed.body.commandId) {
      await waitFor(async () => ['failed', 'uncertain'].includes((await readCommand(changed.body.commandId)).status), 'Changed binding rejected');
    } else assert.equal(changed.status, 409);
    assert.equal(prompts.length, 1, 'Changed session binding received input');
    state.session = 'synthetic-original'; state.revision++;
    await shutdown(); await launch(true);
    state.dropReceipt = true;
    const lostPayload = { requestId: randomUUID(), prompt: 'synthetic-lost-ack' };
    const lost = await request(path, lostPayload);
    assert(lost.body.commandId, JSON.stringify(lost.body));
    await waitFor(async () => (await readCommand(lost.body.commandId)).status === 'uncertain', 'Lost terminal acknowledgement');
    const uncertain = await readCommand(lost.body.commandId);
    assert.equal(uncertain.turnId, undefined); assert.equal(uncertain.inputReceipt, undefined);
    assert.equal(prompts.length, 2);
    state.dropReceipt = false; state.status = 'done'; state.revision++;
    await shutdown(); await launch(true);
    const lostWire = relay.commands.find(command => command.commandId === lost.body.commandId);
    assert(lostWire); relay.toDaemon(lostWire);
    await delay(100);
    assert.equal((await request(path, lostPayload)).body.commandId, uncertain.commandId);
    assert.equal((await readCommand(uncertain.commandId)).status, 'uncertain', 'Lifecycle done invented command completion');
    assert.equal(prompts.length, 2, 'Uncertain input was replayed');
    console.log('PASS same-pane session replacement rejects before input; lost native receipt persists uncertain through restart/raw replay; lifecycle done is not completion evidence');

    const preview = await message(PLAN_PREFIX + discovered.id);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.match(preview.body.text, /非原子/);
    assert.equal(prompts.length, 2, 'Natural-language preview wrote input');
    const confirmation = await message('确认执行');
    assert.equal(confirmation.status, 200, JSON.stringify(confirmation.body));
    assert(confirmation.body.commandId, JSON.stringify(confirmation.body));
    await waitFor(async () => (await readCommand(confirmation.body.commandId)).status === 'input-written', 'Confirmed natural-language terminal input');
    assert.equal(prompts.length, 3); assert.equal(prompts.at(-1).text, PLAN_PROMPT);
    const store = openStore();
    await withTestCleanup(async () => {
      const command = await store.getCommand(confirmation.body.commandId);
      assert.equal(command.status, 'input-written'); assert.equal(command.turnId, undefined);
      assert.deepEqual(command.inputReceipt, (await readCommand(command.commandId)).inputReceipt);
      const dependencies = await message(DEPENDENCY_PREFIX + discovered.id);
      assert.equal(dependencies.status, 200, JSON.stringify(dependencies.body));
      assert.match(dependencies.body.text, /终端/);
      const retryConfirmation = await message('确认执行');
      assert.equal(retryConfirmation.status, 200, JSON.stringify(retryConfirmation.body));
      assert.equal(retryConfirmation.body.commandId, undefined, 'Dependent terminal plan remained executable');
      assert.equal(prompts.length, 3, 'Terminal dependency plan sent input');
    }, [{ label: 'terminal input PostgreSQL store', cleanup: () => store.close() }]);
    check();
    console.log('PASS natural-language terminal preview zero writes with non-atomic disclosure → confirmation single input-written; terminal dependency plan rejected with no pending execution');
    return receipt;
  }, [
    { label: 'terminal control daemon', cleanup: () => stopTestProcess(daemon) },
    { label: 'terminal control relay', cleanup: () => relay?.close() },
    { label: 'terminal control host', cleanup: async () => {
      for (const peer of peers) peer.destroy();
      if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } },
    { label: 'terminal control files', cleanup: () => rm(directory, { recursive: true, force: true }) },
  ]);
}
