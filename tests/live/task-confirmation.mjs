import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { createControllerFixture, createPostgresFixture, waitFor } from '../support/control-plane-fixture.mjs';
import { verificationEnvironment } from '../../scripts/verify.mjs';
import { closeTestWebSocket, withTestCleanup } from '../support/cleanup.mjs';

const MODEL = 'gpt-6.1-sol';
const NODE = 'synthetic-confirmation-node';
const TIME = '2026-10-18T15:14:05Z';
const MAX_BODY_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 90_000;
const HEARTBEAT_MS = 1_000;
const EVIDENCE = new URL('../../.runtime/verification/task-confirmation-live.json', import.meta.url);
const require = createRequire(new URL('../../controller/package.json', import.meta.url));
const { WebSocket } = require('ws');
const { values } = parseArgs({ options: { run: { type: 'boolean' }, postgres: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });

if (values.help || !values.run) {
  console.log('Usage: node tests/live/task-confirmation.mjs --run [--postgres]\nRequires built Controller and LIVE_MODEL_BASE_URL, LIVE_MODEL_API_KEY in environment. Uses an isolated Controller and synthetic WS sessions. --postgres creates and removes a dedicated local Docker PostgreSQL database, allowing real durable receipt IO before confirmation. Only acknowledgement requests reach the real gpt-6.1-sol model; planning uses a deterministic synthetic tool response. Never reads local credentials or contacts WeChat or desktop sessions.');
  if (!values.help) process.exitCode = 1;
} else {
  await main().catch(error => { console.error(`Task confirmation acceptance failed: ${error.name}`); process.exitCode = 1; });
}

async function readBody(request) {
  const parts = []; let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    assert(total <= MAX_BODY_BYTES, 'Model payload exceeds fixture bound');
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

async function main() {
  const key = process.env.LIVE_MODEL_API_KEY;
  assert(key?.trim(), 'LIVE_MODEL_API_KEY is required');
  const endpoint = new URL(process.env.LIVE_MODEL_BASE_URL ?? '');
  assert(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash,
    'LIVE_MODEL_BASE_URL requires credential-free HTTPS');
  assert(endpoint.pathname.replace(/\/+$/, '').endsWith('/v1'));
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + '/responses';
  const token = randomBytes(32).toString('hex'), nodeToken = randomBytes(32).toString('hex');
  const chats = ['synthetic-confirmation-accepted', 'synthetic-confirmation-completed'];
  const sessions = ['accepted', 'completed'].map(mode => ({
    id: `synthetic-${mode}`, title: `合成${mode}任务`, provider: 'codex-app', cwd: '/synthetic',
    status: 'idle', loaded: true, capabilities: ['read', 'send'], observedAt: new Date().toISOString(),
  }));
  const sends = [], histories = [], acknowledgements = [], queries = [], errors = [], logs = [], events = [];
  const results = new Map();
  const evidence = { model: MODEL, scope: 'real HTTP Controller + synthetic WS execution + real model acknowledgement',
    syntheticPlanning: true, wechatRequests: 0, desktopRequests: 0, startedAt: new Date().toISOString() };
  let controller, socket, heartbeat;
  const database = values.postgres ? createPostgresFixture({ env: verificationEnvironment() }) : undefined;
  const realModel = async payload => {
    const forwarded = await fetch(endpoint, { method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!forwarded.ok) throw new Error(`UpstreamModelHTTP${forwarded.status}`);
    const native = await forwarded.json();
    const text = (native.output ?? []).filter(item => item.type === 'message')
      .flatMap(item => item.content ?? []).filter(item => item.type === 'output_text').map(item => item.text).join('\n');
    assert.equal(native.status, 'completed');
    assert(text.trim(), 'Real model returned no confirmation');
    return { native, text };
  };
  const modelServer = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/responses');
      const payload = await readBody(request);
      const acknowledgement = payload.input.some(item => item.role === 'system' &&
        item.content?.startsWith('你负责根据刚刚核查的真实执行记录'));
      if (!acknowledgement) {
        const last = payload.input.at(-1);
        const finalQuery = payload.input.some(item => item.role === 'user' && item.content?.startsWith('请核查合成completed'));
        if (finalQuery) {
          const queryOutputs = payload.input.filter(item => item.type === 'function_call_output' && item.call_id?.startsWith('synthetic-final-'));
          if (!queryOutputs.length) {
            const result = [...results.values()].find(item => item.command.sessionId === 'synthetic-completed');
            assert(result?.command.commandId);
            const calls = [
              ['read_session', { nodeId: NODE, sessionId: 'synthetic-completed' }],
              ['get_plan_progress', {}],
              ['get_command', { commandId: result.command.commandId }],
            ];
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ status: 'completed', output: calls.map(([name, args]) => ({
              type: 'function_call', call_id: `synthetic-final-${name}`, name, arguments: JSON.stringify(args),
            })) }));
          } else {
            const byName = Object.fromEntries(queryOutputs.map(item => [item.call_id.slice('synthetic-final-'.length), JSON.parse(item.output)]));
            assert.equal(byName.get_command.status, 'completed');
            assert.equal(byName.get_command.turnId, byName.get_plan_progress.steps[0].turnId);
            const exact = byName.read_session.items.filter(item => item.turnId === byName.get_command.turnId);
            assert.equal(exact.length, 1);
            assert.equal(exact[0].timestamp, TIME);
            assert(histories.filter(item => item.sessionId === 'synthetic-completed').length >= 2, 'Final query reused old history');
            events.push({ type: 'real-model-final-query', sessionId: 'synthetic-completed' });
            const { native, text } = await realModel(payload);
            queries.push({ receiptStatus: byName.get_command.status, turnId: byName.get_command.turnId,
              exactHistoryItems: exact.length, text });
            response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(native));
          }
          return;
        }
        const mode = last.content?.includes('合成accepted') ? 'accepted' : 'completed';
        const output = last.type === 'function_call_output'
          ? [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '计划已准备，请确认。' }] }]
          : [{ type: 'function_call', call_id: `synthetic-plan-${mode}`, name: 'propose_plan', arguments: JSON.stringify({
            actions: [{ nodeId: NODE, sessionId: `synthetic-${mode}`, prompt: `合成${mode}验收：仅报告本次处理状态与记录时间，报告证据中的实际北京时间。` }],
          }) }];
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'completed', output }));
        return;
      }
      assert.deepEqual(payload.tools, []);
      assert.equal(payload.model, MODEL);
      const observed = JSON.parse(payload.input.at(-1).content);
      assert.equal(observed.targets.length, 1);
      const target = observed.targets[0];
      assert.equal(target.nodeId, NODE);
      assert(target.exactReceipt, 'Missing exact receipt');
      assert.equal(target.historyError, undefined);
      assert(Number.isFinite(Date.parse(target.historyFetchedAt)));
      const history = histories.filter(item => item.sessionId === target.sessionId).at(-1);
      assert(history && history.afterSend && history.responded, 'Model confirmation preceded execution history read');
      assert.equal(target.exactTurnHistory.some(item => item.turnId === 'old-unrelated-turn'), false);
      for (const item of target.exactTurnHistory) assert.equal(item.turnId, target.exactReceipt.turnId);
      events.push({ type: 'real-model-request', sessionId: target.sessionId, afterHistory: history.sequence });
      const { native, text } = await realModel(payload);
      acknowledgements.push({ sessionId: target.sessionId, receiptStatus: target.exactReceipt.status,
        exactHistoryItems: target.exactTurnHistory.length, excludedUnrelatedItems: target.excludedUnrelatedItems,
        turnId: target.exactReceipt.turnId, text, historySequence: history.sequence });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(native));
    } catch (error) {
      errors.push({ category: error.name, message: error.message.replaceAll(key, '[redacted]') });
      response.writeHead(502, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'isolated acknowledgement fixture failed' }));
    }
  });
  const http = async (path, body) => {
    const response = await fetch(controller.base + path, { method: body ? 'POST' : 'GET', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    assert(response.ok, `Isolated Controller HTTP ${response.status}`);
    return response.json();
  };
  const send = message => socket.send(JSON.stringify(message), error => {
    if (error) errors.push({ category: error.name, message: 'Synthetic WS send failed' });
  });
  await withTestCleanup(async () => {
   try {
    modelServer.listen(0, '127.0.0.1'); await once(modelServer, 'listening');
    const cleared = Object.fromEntries(Object.keys(process.env).map(name => [name, undefined]));
    const databaseUrl = database ? await database.start() : undefined;
    controller = await createControllerFixture({ secrets: [token, nodeToken, key, ...(database ? [database.password] : [])], logs, env: {
      ...cleared, SUPER_LEADER_NO_DOTENV: '1', PATH: process.env.PATH,
      PERSISTENCE_MODE: database ? 'postgres' : 'memory', DATABASE_URL: databaseUrl, CONTROLLER_TOKEN: token,
      NODE_TOKENS: JSON.stringify({ [NODE]: nodeToken }), ALLOWED_CHAT_IDS: chats.join(','),
      LEADER_MODE: 'model', LEADER_MODEL_NAME: MODEL, LEADER_MODEL_API_KEY: 'synthetic-loopback-key',
      LEADER_MODEL_BASE_URL: `http://127.0.0.1:${modelServer.address().port}/v1`, TASK_NOTIFICATION_TICK_MS: '60000',
    } });
    await controller.start();
    socket = new WebSocket(controller.base.replace('http:', 'ws:') + '/v1/daemon', { headers: { authorization: `Bearer ${nodeToken}` } });
    socket.on('error', error => errors.push({ category: error.name, message: 'Synthetic WS transport failed' }));
    socket.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'command') {
          assert.equal(message.nodeId, NODE); assert.equal(message.action, 'send');
          assert(sessions.some(session => session.id === message.sessionId));
          sends.push(message); events.push({ type: 'send', sessionId: message.sessionId });
          const turnId = 'turn-' + message.commandId;
          results.set(message.commandId, { command: message, turnId, status: 'accepted' });
          send({ type: 'result', commandId: message.commandId, status: 'accepted', turnId });
        } else if (message.type === 'result_ack' && message.status === 'accepted') {
          const result = results.get(message.commandId);
          if (result?.command.sessionId === 'synthetic-completed' && result.status === 'accepted') {
            result.status = 'completed';
            result.output = `本次合成检查已完成，实际记录时间 ${TIME}（UTC）。请在确认中报告换算后的北京时间。`;
            send({ type: 'result', commandId: message.commandId, status: 'completed', turnId: result.turnId, output: result.output });
          }
        } else if (message.type === 'read_history') {
          const session = sessions.find(item => item.id === message.sessionId);
          assert(session);
          const result = [...results.values()].find(item => item.command.sessionId === session.id);
          const history = { sessionId: session.id, afterSend: Boolean(result), sequence: events.length, responded: true };
          histories.push(history); events.push({ type: 'history', sessionId: session.id });
          const items = [{ id: 'old-history', turnId: 'old-unrelated-turn', kind: 'assistant', type: 'message',
            text: '旧任务已开始，OLD_UNRELATED_OUTPUT，不能作为本次进展。' }];
          if (result?.status === 'completed') items.push({ id: result.command.commandId, turnId: result.turnId,
            kind: 'assistant', type: 'message', text: result.output, timestamp: TIME });
          send({ type: 'history', requestId: message.requestId, sessionId: session.id, history: {
            session, historyContext: message.historyContext ?? randomUUID(), source: 'control-socket',
            fetchedAt: new Date().toISOString(), nextCursor: null, truncated: false, items,
          } });
        }
      } catch (error) { errors.push({ category: error.name, message: error.message.replaceAll(key, '[redacted]') }); }
    });
    await once(socket, 'open');
    const frame = type => ({ type, ...(type === 'hello' ? { version: 1, nodeId: NODE } : {}),
      sessions: sessions.map(session => ({ ...session, observedAt: new Date().toISOString() })), skills: [] });
    send(frame('hello'));
    heartbeat = setInterval(() => send(frame('heartbeat')), HEARTBEAT_MS);
    await waitFor(async () => (await http('/v1/status')).sessions.length === sessions.length, 'Synthetic sessions discovered');
    for (const [index, mode] of ['accepted', 'completed'].entries()) {
      const chatId = chats[index];
      const preview = await http('/v1/messages', { chatId, messageId: randomUUID(), text: `请给合成${mode}会话制定一个单步计划` });
      assert.match(preview.text, /尚未派发|待执行|待确认/);
      assert.equal(sends.filter(item => item.sessionId === `synthetic-${mode}`).length, 0);
      const reply = await http('/v1/messages', { chatId, messageId: randomUUID(), text: '确认执行' });
      const actual = acknowledgements.find(item => item.sessionId === `synthetic-${mode}`);
      assert(actual, 'Confirmation did not come from the real model');
      assert.equal(reply.text, actual.text, 'Controller replaced the real model confirmation');
      assert.equal(sends.filter(item => item.sessionId === actual.sessionId).length, 1, 'Task dispatched more than once');
      assert(!actual.text.includes('OLD_UNRELATED_OUTPUT'), 'Old task output leaked into confirmation');
      if (mode === 'accepted') {
        assert.equal(actual.receiptStatus, 'accepted');
        assert.equal(actual.exactHistoryItems, 0);
        assert.match(actual.text, /接收|受理|收到/);
        assert.match(actual.text, /尚未|尚无|暂未|待核查|未确认|无法确认|不能确认|没有.*(?:开始|执行)|还不能/);
        const affirmative = actual.text.split(/[。！？；，\n]|但是|不过|然而|但/)
          .filter(clause => !/尚无|尚未|暂未|待核查|未确认|无法确认|不能确认|没有|还不能/.test(clause)).join('；');
        assert(!/(?:已经|已)(?:开始|完成|执行中)|正在执行/.test(affirmative), 'Accepted promoted to execution');
      } else {
        assert(['accepted', 'completed'].includes(actual.receiptStatus));
        assert.equal(actual.exactHistoryItems, 1);
        assert.match(actual.text, /完成/);
        assert.match(actual.text, /23:14:05/);
        assert.match(actual.text, /北京|UTC\+8|UTC \+8|Asia\/Shanghai/);
        if (actual.receiptStatus === 'accepted') {
          assert.match(actual.text, /(?:回执|状态).*(?:未|待|尚)|尚未.*完成/,
            'Snapshot race must retain uncertainty about the incomplete receipt');
          assert(!/本次指令(?:已经|已)完成/.test(actual.text), 'Output alone promoted to completed receipt');
        }
      }
    }
    const completedCommand = sends.find(item => item.sessionId === 'synthetic-completed');
    await waitFor(async () => (await http(`/v1/commands/${completedCommand.commandId}`)).status === 'completed', 'Exact completed receipt persisted');
    const final = await http('/v1/messages', { chatId: chats[1], messageId: randomUUID(),
      text: '请核查合成completed任务的最新指令回执和匹配轮次历史，说明是否完成，并将原始UTC记录时间换算为北京时间。仅查询，不派发任务。' });
    assert.equal(queries.length, 1);
    assert.equal(final.text, queries[0].text);
    assert.match(final.text, /完成/); assert.match(final.text, /23:14:05/);
    assert.match(final.text, /北京|UTC\+8|UTC \+8|Asia\/Shanghai/);
    assert.equal(sends.length, 2, 'Status query dispatched another task');
    assert.equal(errors.length, 0, 'Runtime transport/model fixture errors');
    evidence.outcome = 'PASS';
    evidence.acknowledgements = acknowledgements;
    evidence.finalQueries = queries;
    evidence.nativeSends = sends.length;
    evidence.historyReads = histories.length;
    evidence.ordering = events;
    console.log(JSON.stringify({ outcome: 'PASS', model: MODEL, nativeSends: sends.length,
      historyReads: histories.length, acknowledgements, finalQueries: queries }));
  } catch (error) {
    evidence.outcome = 'FAIL'; evidence.failure = { category: error.name, message: error.message.replaceAll(key, '[redacted]') };
    evidence.errors = errors; evidence.acknowledgements = acknowledgements; evidence.finalQueries = queries;
    evidence.nativeSends = sends.length; evidence.historyReads = histories.length; evidence.ordering = events;
    throw error;
   }
  }, [
    { label: 'heartbeat', cleanup: () => clearInterval(heartbeat) },
    { label: 'synthetic websocket', cleanup: () => closeTestWebSocket(socket) },
    { label: 'isolated Controller', cleanup: () => controller?.stop() },
    { label: 'model proxy', cleanup: () => new Promise((resolve, reject) => modelServer.close(error => error ? reject(error) : resolve())) },
    { label: 'isolated PostgreSQL', cleanup: () => database?.stop() },
    { label: 'sanitized acceptance evidence', cleanup: async () => {
      evidence.finishedAt = new Date().toISOString();
      await mkdir(new URL('./', EVIDENCE), { recursive: true });
      await writeFile(EVIDENCE, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    } },
  ]);
}
