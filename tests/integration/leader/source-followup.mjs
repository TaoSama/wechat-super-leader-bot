import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createControllerFixture, waitFor } from '../../support/control-plane-fixture.mjs';
import { closeTestWebSocket, withTestCleanup } from '../../support/cleanup.mjs';
import { verificationEnvironment } from '../../../scripts/verify.mjs';

const { values } = parseArgs({ options: { run: { type: 'boolean' },
  output: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
if (!values.run || values.help) {
  console.log('Usage: node tests/integration/leader/source-followup.mjs --run [--output evidence.json]\nRequires a built Controller. Drives real HTTP tools against an authenticated synthetic node. No model, Codex chat or WeChat is used; this checks tool behavior and captures injected instructions, not model tool selection.');
} else {
  await verify().catch(error => { console.error(error); process.exitCode = 1; });
}

/** Drives four isolated CLI scenarios and captures injected rules; tool order is scripted, with no model inference. */
async function verify() {
  const require = createRequire(new URL('../../../controller/package.json', import.meta.url));
  const { WebSocket } = require('ws');
  const root = await mkdtemp(path.join(tmpdir(), 'source-followup-'));
  const token = randomBytes(24).toString('hex'), nodeToken = randomBytes(24).toString('hex');
  const chatId = 'synthetic-followup-chat', nodeId = 'synthetic-followup-node', sessionId = 'synthetic-source-session';
  const observedAt = new Date().toISOString(), expectedAt = Date.now() - 3_600_000;
  const target = { nodeId, sessionId }, source = { nodeId, automationId: 'daily', expectedAt, notAfter: expectedAt + 3_600_000 };
  const session = { id: sessionId, title: 'Synthetic daily report', status: 'notLoaded', loaded: false,
    capabilities: ['read'], observedAt };
  const failed = { automationId: source.automationId, expectedAt, notAfter: source.notAfter, status: 'failed',
    sessionId, turnId: 'scheduled-failed-turn', reason: 'scheduled turn was aborted or failed',
    sources: ['synthetic:scheduled-failed-turn'], observedAt: Date.now() };
  const final = { id: 'later-final', turnId: 'later-independent-turn', kind: 'assistant', type: 'agentMessage',
    text: '日报已完成，采用修复后快照。', timestamp: observedAt };
  const logs = [], errors = [], frames = [], calls = [], scenarios = [];
  let mode = 'later-result', socket, controller;
  const send = frame => socket.send(JSON.stringify(frame), error => { if (error) errors.push(error); });
  const request = async (route, body) => {
    const response = await controller.request(route, body);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    if (errors.length) throw errors[0];
    return response.body;
  };
  await withTestCleanup(async () => {
    controller = await createControllerFixture({ logs, secrets: [token, nodeToken],
      env: { ...verificationEnvironment(), PERSISTENCE_MODE: 'memory', CONTROLLER_TOKEN: token,
        NODE_TOKENS: JSON.stringify({ [nodeId]: nodeToken }), ALLOWED_CHAT_IDS: chatId,
        LEADER_MODE: 'rules', CONTROLLER_DATA_ROOT: root,
        BACKGROUND_WORKER_ROOT: path.join(root, 'background', 'workers'), BACKGROUND_EXECUTOR: 'codex',
        BACKGROUND_MODEL_NAME: 'synthetic-unused-model', BACKGROUND_MODEL_API_KEY: 'synthetic-unused-key',
        BACKGROUND_MODEL_BASE_URL: 'https://fixture.invalid/v1' } });
    await controller.start();
    socket = new WebSocket(controller.base.replace('http:', 'ws:') + '/v1/daemon', {
      headers: { authorization: `Bearer ${nodeToken}` } });
    socket.on('error', error => errors.push(error));
    socket.on('message', bytes => {
      try {
        const frame = JSON.parse(bytes.toString()); frames.push(frame);
        if (frame.type === 'command') throw new Error('Read-only follow-up sent a source command');
        if (frame.type === 'list_automations') send({ type: 'automation_response', requestId: frame.requestId,
          automations: [{ id: 'daily', name: 'Synthetic daily report', kind: 'heartbeat', status: 'ACTIVE',
            prompt: 'Synthetic daily task', rrule: 'FREQ=DAILY', targetSessionId: sessionId }] });
        if (frame.type === 'inspect_automation') {
          for (const [key, value] of Object.entries(source)) assert.equal(frame[key], value);
          send({ type: 'automation_response', requestId: frame.requestId, inspection: failed });
        }
        if (frame.type === 'read_history') {
          assert.equal(frame.nodeId, nodeId); assert.equal(frame.sessionId, sessionId); assert.equal(frame.limit, 8);
          if (mode === 'read-failed') send({ type: 'history', requestId: frame.requestId, sessionId,
            error: 'Synthetic read failure' });
          else send({ type: 'history', requestId: frame.requestId, sessionId,
            history: { session, source: 'control-socket', historyContext: randomUUID(), fetchedAt: observedAt,
              nextCursor: mode === 'truncated' ? 'synthetic-older-page' : null, truncated: mode === 'truncated',
              items: mode === 'empty' ? [] : mode === 'truncated'
                ? [{ ...final, text: '尚未取得最终报告。', truncated: true }] : [final] } });
        }
      } catch (error) { errors.push(error); }
    });
    await once(socket, 'open');
    send({ type: 'hello', version: 1, nodeId, sessions: [session], skills: [] });
    await waitFor(async () => (await request('/v1/status')).nodes.some(node => node.nodeId === nodeId && node.connected), 'Synthetic node inventory');
    let catalog;
    for (mode of ['later-result', 'empty', 'truncated', 'read-failed']) {
      const user = { chatId, messageId: randomUUID(), text: '但是他最终成功了，你不信再读一下' };
      catalog = await request('/v1/tools/list', user);
      const tools = new Map(catalog.tools.map(tool => [tool.name, tool]));
      assert(catalog.instructions.includes('继续用 read_session 只读查询工具已定位的原机器和会话'));
      assert(catalog.instructions.includes('后续独立轮次的结果不能改写原 occurrence'));
      assert(tools.get('inspect_source_automation')?.description.includes('不包含同一会话后续独立轮次的结果'));
      for (const name of ['list_nodes', 'list_source_automations', 'inspect_source_automation', 'read_session']) {
        assert.equal(tools.get(name)?.annotations.readOnlyHint, true);
      }
      assert.equal(tools.get('follow_up_background_task')?.annotations.readOnlyHint, false);
      const call = async (name, arguments_) => {
        calls.push({ scenario: mode, name, arguments: arguments_ });
        return (await request('/v1/tools/call', { ...user, callId: randomUUID(), name, arguments: arguments_ })).result;
      };
      await call('list_nodes', {});
      const sources = await call('list_source_automations', { nodeId });
      assert.equal(sources[0].targetSessionId, sessionId);
      const original = await call('inspect_source_automation', source);
      assert.deepEqual(original, failed);
      const history = await call('read_session', target);
      assert.equal(Object.hasOwn(history, 'status'), false);
      if (mode === 'read-failed') {
        assert.equal(history.code, 'history_failed');
        assert.equal(Object.hasOwn(history, 'items'), false);
      }
      else {
        assert.equal(history.scope, 'recent_recorded_history');
        assert.equal(history.completeHistory, false);
        assert.equal(history.truncated, mode === 'truncated');
        assert.equal(history.hasOlder, mode === 'truncated');
        assert.equal(history.items.length, mode === 'empty' ? 0 : 1);
        if (mode === 'later-result') assert.deepEqual(history.items[0], { ...final, truncated: false });
        if (mode === 'truncated') assert.equal(history.items[0].truncated, true);
      }
      assert.deepEqual(await call('inspect_source_automation', source), original);
      assert.deepEqual(await call('list_background_tasks', {}), []);
      assert.deepEqual(await call('list_automations', {}), []);
      scenarios.push({ scenario: mode, original, history });
    }
    assert(frames.every(frame => ['list_automations', 'inspect_automation', 'read_history'].includes(frame.type)));
    assert.equal(errors.length, 0);
    const evidence = { observedAt: new Date().toISOString(), surface: 'built Controller CLI → HTTP → synthetic daemon WebSocket',
      modelInference: false, modelToolSelectionVerified: false,
      instructions: catalog.instructions,
      tools: catalog.tools.filter(tool => ['read_session', 'inspect_source_automation', 'follow_up_background_task'].includes(tool.name)),
      calls, scenarios, daemonFrameCounts: Object.fromEntries([...new Set(frames.map(frame => frame.type))]
        .map(type => [type, frames.filter(frame => frame.type === type).length])),
      mutations: { sourceCommands: 0, backgroundTasks: 0, automations: 0 } };
    if (values.output) await writeFile(values.output, JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify({ verdict: 'PASS', modelToolSelectionVerified: false,
      scenarios: scenarios.map(item => item.scenario), daemonFrameCounts: evidence.daemonFrameCounts, mutations: evidence.mutations }));
  }, [{ label: 'synthetic WebSocket', cleanup: () => closeTestWebSocket(socket) },
    { label: 'isolated Controller', cleanup: () => controller?.stop() },
    { label: 'temporary runtime', cleanup: () => rm(root, { recursive: true, force: true }) }]);
}
