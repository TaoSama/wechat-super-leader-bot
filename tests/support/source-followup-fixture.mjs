import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createControllerFixture, waitFor } from './control-plane-fixture.mjs';
import { closeTestWebSocket, withTestCleanup } from './cleanup.mjs';
import { verificationEnvironment } from '../../scripts/verify.mjs';

const READ_TOOLS = new Set(['list_nodes', 'list_sessions', 'read_session', 'list_source_automations',
  'inspect_source_automation', 'list_background_tasks', 'query_background_task', 'list_automations', 'automation_runs']);

/** Real Controller HTTP tools, with only an authenticated synthetic source and no usable executor credentials. */
export async function withSourceFollowupFixture(operation) {
  const require = createRequire(new URL('../../controller/package.json', import.meta.url));
  const { WebSocket } = require('ws');
  const root = await mkdtemp(path.join(tmpdir(), 'source-followup-model-'));
  const token = randomBytes(24).toString('hex'), nodeToken = randomBytes(24).toString('hex');
  const chatId = 'synthetic-followup-model-chat', nodeId = 'synthetic-followup-node', sessionId = 'synthetic-source-session';
  const observedAt = new Date().toISOString(), expectedAt = Date.parse('2026-11-06T00:00:00Z');
  const source = { nodeId, automationId: 'daily', expectedAt, notAfter: expectedAt + 3_600_000 };
  const session = { id: sessionId, title: '日报', status: 'notLoaded', loaded: false, capabilities: ['read'], observedAt };
  const failed = { automationId: 'daily', expectedAt, notAfter: source.notAfter, status: 'failed', sessionId,
    turnId: 'scheduled-failed-turn', reason: 'scheduled turn was aborted or failed', sources: ['synthetic:scheduled-failed-turn'],
    observedAt: Date.parse(observedAt) };
  const final = { id: 'later-final', turnId: 'later-independent-turn', kind: 'assistant', type: 'agentMessage',
    text: '11月6日日报已完成，采用08:31:12修复后快照。', timestamp: '2026-11-06T00:34:24Z' };
  const logs = [], errors = [], frames = [];
  let mode = 'later-result', socket, controller;
  const send = frame => socket.send(JSON.stringify(frame), error => { if (error) errors.push(error); });
  const request = async (route, body) => {
    const response = await controller.request(route, body);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    if (errors.length) throw errors[0];
    return response.body;
  };
  return withTestCleanup(async () => {
    controller = await createControllerFixture({ logs, secrets: [token, nodeToken],
      env: { ...verificationEnvironment(), PERSISTENCE_MODE: 'memory', CONTROLLER_TOKEN: token,
        NODE_TOKENS: JSON.stringify({ [nodeId]: nodeToken }), ALLOWED_CHAT_IDS: chatId, LEADER_MODE: 'rules',
        CONTROLLER_DATA_ROOT: root, BACKGROUND_WORKER_ROOT: path.join(root, 'background', 'workers'),
        BACKGROUND_EXECUTOR: 'codex', BACKGROUND_MODEL_NAME: 'synthetic-unused-model',
        BACKGROUND_MODEL_API_KEY: 'synthetic-unused-key', BACKGROUND_MODEL_BASE_URL: 'https://fixture.invalid/v1' } });
    await controller.start();
    socket = new WebSocket(controller.base.replace('http:', 'ws:') + '/v1/daemon', {
      headers: { authorization: `Bearer ${nodeToken}` } });
    socket.on('error', error => errors.push(error));
    socket.on('message', bytes => {
      try {
        const frame = JSON.parse(bytes.toString()); frames.push(frame);
        if (!['list_automations', 'inspect_automation', 'read_history'].includes(frame.type)) {
          throw new Error(`Forbidden synthetic source operation: ${frame.type}`);
        }
        if (frame.type === 'list_automations') send({ type: 'automation_response', requestId: frame.requestId,
          automations: [{ id: 'daily', name: '日报', kind: 'heartbeat', status: 'ACTIVE',
            prompt: '生成日报', rrule: 'FREQ=DAILY', targetSessionId: sessionId }] });
        if (frame.type === 'inspect_automation') {
          for (const [key, value] of Object.entries(source)) assert.equal(frame[key], value);
          send({ type: 'automation_response', requestId: frame.requestId, inspection: failed });
        }
        if (frame.type === 'read_history') {
          assert.equal(frame.nodeId, nodeId); assert.equal(frame.sessionId, sessionId);
          if (mode === 'read-failed') send({ type: 'history', requestId: frame.requestId, sessionId, error: 'Synthetic read failure' });
          else send({ type: 'history', requestId: frame.requestId, sessionId,
            history: { session, source: 'control-socket', historyContext: randomUUID(), fetchedAt: new Date().toISOString(),
              nextCursor: mode === 'truncated' ? 'synthetic-older-page' : null, truncated: mode === 'truncated',
              items: mode === 'empty' ? [] : mode === 'truncated'
                ? [{ ...final, text: '正在核对修复后快照，尚未取得最终报告。', truncated: true }] : [final] } });
        }
      } catch (error) { errors.push(error); }
    });
    await once(socket, 'open');
    send({ type: 'hello', version: 1, nodeId, sessions: [session], skills: [] });
    await waitFor(async () => (await request('/v1/status')).nodes.some(node => node.nodeId === nodeId && node.connected), 'Synthetic inventory');
    const call = async (user, name, args) => {
      if (!READ_TOOLS.has(name)) throw new Error(`Forbidden tool blocked before routing: ${name}`);
      return (await request('/v1/tools/call', { ...user, callId: randomUUID(), name, arguments: args })).result;
    };
    return operation({ chatId, nodeId, sessionId, source, failed, frames, errors,
      catalog: user => request('/v1/tools/list', user), call, setMode: value => { mode = value; } });
  }, [{ label: 'synthetic WebSocket', cleanup: () => closeTestWebSocket(socket) },
    { label: 'isolated Controller', cleanup: () => controller?.stop() },
    { label: 'temporary runtime', cleanup: () => rm(root, { recursive: true, force: true }) }]);
}
