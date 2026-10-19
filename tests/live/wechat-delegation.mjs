import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { verificationEnvironment } from '../../scripts/verify.mjs';
import { createControllerFixture, createPostgresFixture, waitFor } from '../support/control-plane-fixture.mjs';
import { closeTestWebSocket, withTestCleanup } from '../support/cleanup.mjs';
import { CodexReplyEngine } from '../../gateway/dist/leader/codex.js';
import { ControllerClient } from '../../gateway/dist/controller/client.js';
import { StateManager } from '../../gateway/dist/runtime/state.js';
import { ILinkClient } from '../../gateway/dist/wechat/client.js';
import { WeChatGateway } from '../../gateway/dist/gateway.js';
import { HttpLeaderModel } from '../../controller/dist/leader/model/client.js';
import { classifyUserAuthorization } from '../../controller/dist/leader/model/user-authorization.js';

const { values } = parseArgs({ options: { run: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
const EVIDENCE = new URL('../../.runtime/delegation-verification/live-delegation.json', import.meta.url);
const NODE = 'synthetic-delegation-node';
const MODEL = 'gpt-6.1-sol';
const PRODUCTION_DELEGATION_REQUEST = '让“微信 · 异步 typing · 合并上线”会话修改项目，开启原生网络搜索工具，并验证可用。';
const TITLE = '🟢 [微信] 微信 · 异步 typing · 合并上线 | GPT-6.1-Sol';
const SPECIAL_TITLE = '🧪 ① 原始__标题** · `tools` [资料](https://example.test) | GPT-6-astra';
const CHAT = 'synthetic-delegation-direct';
const CONTEXT = 'synthetic-context-only';
const TIMEOUT = 180_000;
const HOST = 'https://synthetic-ilink.invalid';
const require = createRequire(new URL('../../controller/package.json', import.meta.url));
const { WebSocket } = require('ws');
if (!values.run || values.help) {
  console.log('Usage: node tests/live/wechat-delegation.mjs --run\nRequires built Controller/Gateway, local Docker PG, LIVE_MODEL_BASE_URL/API_KEY or GATEWAY_LEADER_BASE_URL/API_KEY. Real authorization/planning/ack model; isolated Controller HTTP/PG, synthetic WS; real Gateway+CodexReplyEngine+loopback MCP with SDK runner fixture intentionally rewriting receipts. Zero real WeChat or desktop requests.');
} else await main().catch(error => { console.error('Live delegation failed:', error.name, error.message); process.exitCode = 1; });

async function main() {
  const apiKey = process.env.LIVE_MODEL_API_KEY ?? process.env.GATEWAY_LEADER_API_KEY;
  assert(apiKey?.trim(), 'Model API key required');
  const endpoint = new URL(process.env.LIVE_MODEL_BASE_URL ?? process.env.GATEWAY_LEADER_BASE_URL ?? '');
  assert.equal(endpoint.protocol, 'https:'); assert(!endpoint.username && !endpoint.password && !endpoint.search);
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + '/responses';
  const token = randomBytes(24).toString('hex'), nodeToken = randomBytes(24).toString('hex');
  const logs = [], errors = [], events = [], calls = [], receipts = [], messages = [], mcp = [];
  const inbox = [], outbox = [], histories = [], sends = [];
  const synthetic = new Map();
  const sessions = [
    { id: 'synthetic-typing', title: TITLE },
    { id: 'synthetic-special', title: SPECIAL_TITLE },
  ].map(s => ({ ...s, cwd: '/synthetic', provider: 'codex-app', loaded: true, status: 'idle', capabilities: ['read', 'send'], model: MODEL, observedAt: new Date().toISOString() }));
  let socket, heartbeat, controller, directory;
  const database = createPostgresFixture({ env: verificationEnvironment() });
  const evidence = { startedAt: new Date().toISOString(), model: MODEL, realModel: true, realControllerHttp: true,
    realPostgres: true, realGateway: true, realMcpHttp: true, sdkRunnerFixture: true, externalWechatRequests: 0, realDesktopRequests: 0 };
  const model = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/responses');
      let body = ''; for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      const ack = payload.input[0]?.content?.startsWith('你负责根据刚刚核查的真实执行记录');
      if (ack) {
        const observation = JSON.parse(payload.input.at(-1).content);
        for (const target of observation.targets) {
          assert(target.exactReceipt, 'Acknowledgement lacks exact persisted command');
          const sent = sends.find(s => s.commandId === target.exactReceipt.commandId);
          assert(sent, 'Acknowledgement refers to an undispatched command');
          const persisted = await http('/v1/commands/' + sent.commandId);
          assert(['pending', 'accepted'].includes(persisted.status));
          assert.equal(persisted.nodeId, NODE); assert.equal(persisted.sessionId, target.sessionId);
          if (target.exactReceipt.status === 'accepted') {
            assert.equal(target.exactReceipt.turnId, 'synthetic-turn-' + sent.commandId);
            assert.equal(persisted.turnId, target.exactReceipt.turnId);
          } else {
            assert.equal(target.exactReceipt.status, 'pending');
            assert.equal(target.exactReceipt.turnId, undefined, 'Pending receipt manufactured a turn');
          }
          const history = histories.findLast(h => h.sessionId === target.sessionId && h.fetchedAt === target.historyFetchedAt);
          assert(history?.afterSend, 'Acknowledgement did not freshly read after sending');
          assert(target.exactTurnHistory.every(item => item.turnId === target.exactReceipt.turnId));
          assert(!JSON.stringify(target.exactTurnHistory).includes('OLD_UNRELATED'));
          events.push({ type: 'model-ack', sessionId: target.sessionId, turnId: target.exactReceipt.turnId });
          receipts.push({ planId: observation.durableState.planId, commandId: sent.commandId, status: target.exactReceipt.status, persistedStatus: persisted.status, turnId: target.exactReceipt.turnId, historyFetchedAt: target.historyFetchedAt });
        }
      }
      const upstream = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT),
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body });
      assert(upstream.ok, 'Upstream model HTTP ' + upstream.status);
      const native = await upstream.json();
      const toolCalls = (native.output ?? []).filter(item => item.type === 'function_call');
      calls.push({ tools: payload.tools?.map(t => t.name), lastUser: payload.input.findLast(item => item.role === 'user')?.content,
        toolCalls: toolCalls.map(c => ({ name: c.name, arguments: c.arguments })),
        toolOutputs: payload.input.filter(item => item.type === 'function_call_output').map(item => ({ callId: item.call_id, output: item.output })),
        content: (native.output ?? []).filter(item => item.type === 'message').flatMap(m => m.content ?? []).map(c => c.text ?? '').join('\n') });
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(native));
    } catch (error) {
      errors.push({ category: error.name, message: error.message.replaceAll(apiKey, '[redacted]') });
      response.writeHead(502); response.end(JSON.stringify({ error: 'isolated live fixture failed' }));
    }
  });
  const healthy = () => assert.deepEqual(errors, [], 'Fixture transport errors');
  const http = async (path, body) => {
    const result = await fetch(controller.base + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(TIMEOUT),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.equal(result.status, 200, 'Controller HTTP ' + result.status); return result.json();
  };
  const send = message => socket.send(JSON.stringify(message), error => { if (error) errors.push({ category: error.name, message: 'WS write failed' }); });
  await withTestCleanup(async () => {
    try {
      directory = await mkdtemp(join(await realpath(tmpdir()), 'wechat-delegation-live-'));
      model.listen(0, '127.0.0.1'); await once(model, 'listening');
      const monitorText = '等他们执行完再汇总给我，使用独立后台会话，只读监控已有任务，不能向源会话发送消息或重跑。';
      const classifierModel = new HttpLeaderModel({ baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'synthetic-proxy-key', model: MODEL });
      evidence.semanticMonitorIntent = await classifyUserAuthorization(classifierModel, monitorText, AbortSignal.timeout(60000));
      assert.equal(evidence.semanticMonitorIntent, 'isolated_background');
      const dbUrl = await database.start();
      const cleared = Object.fromEntries(Object.keys(process.env).map(name => [name, undefined]));
      controller = await createControllerFixture({ logs, secrets: [token, nodeToken, apiKey, database.password], env: {
        ...cleared, ...verificationEnvironment(), PERSISTENCE_MODE: 'postgres', DATABASE_URL: dbUrl,
        CONTROLLER_TOKEN: token, NODE_TOKENS: JSON.stringify({ [NODE]: nodeToken }), ALLOWED_CHAT_IDS: CHAT,
        LEADER_MODE: 'model', LEADER_MODEL_NAME: MODEL, LEADER_MODEL_API_KEY: 'synthetic-proxy-key',
        LEADER_MODEL_BASE_URL: `http://127.0.0.1:${model.address().port}/v1`, TASK_NOTIFICATION_TICK_MS: '60000',
      } });
      await controller.start();
      socket = new WebSocket(controller.base.replace('http:', 'ws:') + '/v1/daemon', { headers: { authorization: 'Bearer ' + nodeToken } });
      socket.on('error', e => errors.push({ category: e.name, message: 'WS transport failed' }));
      socket.on('message', raw => {
        try {
          const frame = JSON.parse(raw.toString());
          if (frame.type === 'command') {
            assert.equal(frame.nodeId, NODE); assert.equal(frame.action, 'send');
            assert(sessions.some(s => s.id === frame.sessionId));
            sends.push(frame); events.push({ type: 'send', commandId: frame.commandId, sessionId: frame.sessionId });
            const result = { type: 'result', commandId: frame.commandId, status: 'accepted', turnId: 'synthetic-turn-' + frame.commandId };
            synthetic.set(frame.sessionId, result); send(result);
          } else if (frame.type === 'read_history') {
            const current = synthetic.get(frame.sessionId), fetchedAt = new Date().toISOString();
            histories.push({ sessionId: frame.sessionId, fetchedAt, afterSend: Boolean(current) });
            events.push({ type: 'history', sessionId: frame.sessionId, afterSend: Boolean(current) });
            send({ type: 'history', requestId: frame.requestId, sessionId: frame.sessionId, history: {
              session: sessions.find(s => s.id === frame.sessionId), historyContext: frame.historyContext ?? randomUUID(),
              source: 'control-socket', fetchedAt, truncated: false, nextCursor: null,
              items: [{ id: 'old', turnId: 'unrelated-old-turn', kind: 'assistant', type: 'message', text: 'OLD_UNRELATED：旧轮次已完成，不能据此声称新任务已开始。' }],
            } });
          }
        } catch (error) { errors.push({ category: error.name, message: error.message.replaceAll(apiKey, '[redacted]') }); }
      });
      await once(socket, 'open');
      const frame = type => ({ type, ...(type === 'hello' ? { nodeId: NODE, version: 1 } : {}),
        sessions: sessions.map(s => ({ ...s, observedAt: new Date().toISOString() })), skills: [] });
      send(frame('hello')); heartbeat = setInterval(() => send(frame('heartbeat')), 500);
      await waitFor(async () => (await http('/v1/status')).sessions.length === sessions.length, 'Synthetic sessions ready');
      const controllerClient = new ControllerClient({ controllerUrl: controller.base, controllerToken: token });
      const sdkFactory = sdk => {
        const run = (input, resumed, settings) => ({ events: (async function* () {
          assert.equal(settings.webSearchMode, 'live');
          const text = JSON.parse(input.match(/<current_user_message>(.*)<\/current_user_message>/)[1]).text;
          const url = sdk.config.mcp_servers.wechat_control.url;
          assert.equal(new URL(url).hostname, '127.0.0.1');
          yield { type: 'thread.started', thread_id: 'synthetic-live-thread' };
          const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + sdk.env.LEADER_TURN_MCP_TOKEN,
            'content-type': 'application/json', accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'control_current_request', arguments: {} } }) });
          assert.equal(response.status, 200); const body = await response.json();
          assert(!body.result.isError); const reply = JSON.parse(body.result.content[0].text);
          mcp.push({ text, resumed, reply });
          yield { type: 'item.completed', item: { id: 'rewrite', type: 'agent_message', text: 'SDK故意改写：我给它重新取了名字，任务已经完成。' } };
          yield { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 } };
        })() });
        return { startThread: settings => ({ runStreamed: async input => run(input, false, settings) }),
          resumeThread: (_id, settings) => ({ runStreamed: async input => run(input, true, settings) }) };
      };
      const engine = new CodexReplyEngine({ root: join(directory, 'leader'), model: 'synthetic-native-sdk', sdkFactory, timeoutMs: 300000 });
      const accountPath = join(directory, 'account.json'), statePath = join(directory, 'state.json');
      await writeFile(accountPath, JSON.stringify({ accountId: 'synthetic-account', token: 'synthetic-token', baseUrl: HOST }), { mode: 0o600 });
      const state = new StateManager(accountPath, statePath);
      const ilink = new ILinkClient({ stateManager: state, configuredBaseUrl: HOST, fetchImpl: async (url, init) => {
        assert.equal(new URL(url).origin, HOST); let result;
        if (url.includes('getupdates')) result = { ret: 0, get_updates_buf: randomUUID(), msgs: inbox.splice(0) };
        else if (url.includes('getconfig')) result = { ret: 0, typing_ticket: 'synthetic-ticket' };
        else if (url.includes('sendtyping')) result = { ret: 0 };
        else {
          assert(url.includes('sendmessage')); const body = JSON.parse(init.body); assert.equal(body.msg.to_user_id, CHAT);
          outbox.push(body.msg); result = { ret: 0, errcode: 0 };
        }
        return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
      } });
      const gateway = new WeChatGateway({ stateManager: state, ilink, controller: controllerClient, replyEngine: engine, splitMaxChars: 3800 });
      await gateway.establishBaseline();
      const query = async text => {
        healthy(); const id = randomUUID(), before = outbox.length, nativeBefore = mcp.length;
        inbox.push({ message_type: 1, from_user_id: CHAT, client_id: id, create_time_ms: Date.now(), context_token: CONTEXT,
          item_list: [{ type: 1, text_item: { text } }] });
        const cycle = await gateway.pollOnce(); healthy(); assert.equal(cycle.processedCount, 1);
        assert.equal(mcp.length, nativeBefore + 1, 'SDK did not call real MCP exactly once');
        const actual = outbox.slice(before).flatMap(message => message.item_list).map(item => item.text_item?.text ?? '').join('');
        assert(actual); assert(!actual.includes('SDK故意改写'), 'SDK rewrote trusted result');
        messages.push({ text, reply: actual, controllerReply: mcp.at(-1).reply.text, messageId: id, sends: sends.length });
        console.log(JSON.stringify({ step: messages.length, text, reply: actual, sends: sends.length }));
        return { id, actual };
      };
      const listing = await query('列出当前所有会话，展示它们完整原始标题，不要总结标题。');
      assert(listing.actual.includes(TITLE), 'Full original regular title lost');
      assert(listing.actual.includes(SPECIAL_TITLE), 'Markdown/emoji original title changed in real WeChat rendering');
      const direct = await query(PRODUCTION_DELEGATION_REQUEST);
      assert.equal(sends.length, 1, 'Production failed request did not dispatch exactly once');
      assert.equal(sends[0].sessionId, 'synthetic-typing');
      assert.match(sends[0].prompt, /网络搜索|搜索工具/); assert.equal(receipts.length, 1);
      await waitFor(async () => (await http('/v1/commands/' + sends[0].commandId)).status === 'accepted', 'Exact accepted command persisted');
      evidence.directAcceptedReceipt = await http('/v1/commands/' + sends[0].commandId);
      assert.equal(evidence.directAcceptedReceipt.turnId, 'synthetic-turn-' + sends[0].commandId);
      assert(direct.actual.includes(TITLE));
      const ids = sends.map(s => s.commandId);
      const replayed = await controllerClient.forwardMessage({ chatId: CHAT, messageId: direct.id, text: PRODUCTION_DELEGATION_REQUEST });
      assert.equal(replayed.commandId, mcp.find(item => item.text === PRODUCTION_DELEGATION_REQUEST).reply.commandId);
      assert.deepEqual(sends.map(s => s.commandId), ids, 'Controller replay duplicated dispatch');
      const nativeBeforeReplay = mcp.length, repliesBeforeReplay = outbox.length;
      inbox.push({ message_type: 1, from_user_id: CHAT, client_id: direct.id, create_time_ms: Date.now(), context_token: CONTEXT,
        item_list: [{ type: 1, text_item: { text: PRODUCTION_DELEGATION_REQUEST } }] });
      await gateway.pollOnce();
      assert.equal(mcp.length, nativeBeforeReplay, 'Gateway replay reran SDK/MCP');
      assert.equal(outbox.length, repliesBeforeReplay, 'Gateway replay resent reply');
      assert.deepEqual(sends.map(s => s.commandId), ids, 'Gateway replay duplicated dispatch');
      // Close the first authorization through its exact real WS receipt before
      // testing a distinct task. An accepted plan correctly owns this chat.
      send({ type: 'result', commandId: sends[0].commandId, status: 'completed',
        turnId: evidence.directAcceptedReceipt.turnId, output: 'SYNTHETIC_FIRST_TASK_COMPLETE：隔离验收任务完成。' });
      await waitFor(async () => (await http('/v1/commands/' + sends[0].commandId)).status === 'completed', 'Exact first task completed');
      await waitFor(async () => (await http('/v1/status')).executions.items.some(plan => plan.id === receipts[0].planId && plan.status === 'completed'), 'First plan terminal state');
      evidence.firstPlanTerminal = (await http('/v1/status')).executions.items.find(plan => plan.id === receipts[0].planId);
      const monitorReply = await query(monitorText);
      assert.equal(sends.length, 1, 'Monitor reran or modified source session');
      evidence.monitorBoundary = { sourceDispatches: 0, reply: monitorReply.actual, backgroundFeatureEnabled: false, backgroundExecutionVerified: false };
      // This Controller deliberately lacks a background executor; this case proves
      // source-session isolation only. The background suite verifies execution.
      const clarification = await query('你让「旧版标题 · 可靠通知交付 · 合并上线」会话修改项目，把网络搜索工具打开并验证可用。找不到这个原题时先问我是不是当前的微信异步 typing 会话，不要直接派发。');
      assert.equal(sends.length, 1, 'Unresolved clarification dispatched');
      assert(clarification.actual.includes(TITLE), 'Clarification lost exact candidate title');
      assert.match(clarification.actual, /(?:是不是|是指|指的是|确认|你指).*[？?]|[？?]/u, 'Title rendering erased the clarification question');
      assert(!clarification.actual.startsWith('已观测会话：'), 'Clarification was replaced by directory');
      await query('顺便列出当前会话完整原始标题。');
      assert.equal(sends.length, 1);
      const confirmation = await query('是');
      assert.equal(sends.length, 2, 'Natural confirmation across read-only query failed');
      assert.equal(sends[1].sessionId, 'synthetic-typing'); assert.match(sends[1].prompt, /网络搜索|搜索工具/);
      assert.equal(receipts.length, 2); assert(confirmation.actual.includes(TITLE));
      const classification = calls.filter(call => call.toolCalls.some(tool => tool.name === 'classify_user_authorization'));
      assert(classification.some(call => call.lastUser === PRODUCTION_DELEGATION_REQUEST && call.toolCalls.some(tool => JSON.parse(tool.arguments).intent === 'task')));
      assert(classification.some(call => call.lastUser === '是' && call.toolCalls.some(tool => JSON.parse(tool.arguments).intent === 'task')));
      assert(classification.some(call => call.lastUser?.startsWith('等他们执行完') && call.toolCalls.some(tool => JSON.parse(tool.arguments).intent === 'isolated_background')));
      evidence.outcome = 'PASS';
    } catch (error) { evidence.outcome = 'FAIL'; evidence.failure = { category: error.name, message: error.message.replaceAll(apiKey, '[redacted]') }; throw error; }
  }, [
    { label: 'heartbeat', cleanup: () => clearInterval(heartbeat) },
    { label: 'synthetic daemon WS', cleanup: () => closeTestWebSocket(socket) },
    { label: 'isolated Controller', cleanup: () => controller?.stop() },
    { label: 'proxy', cleanup: () => new Promise((resolve, reject) => model.close(error => error ? reject(error) : resolve())) },
    { label: 'temporary PG', cleanup: () => database.stop() },
    { label: 'private workspaces', cleanup: () => directory && rm(directory, { recursive: true, force: true }) },
    { label: 'sanitized evidence', cleanup: async () => {
      Object.assign(evidence, { finishedAt: new Date().toISOString(), messages, nativeSends: sends, receipts, calls, events, errors });
      await mkdir(new URL('./', EVIDENCE), { recursive: true });
      await writeFile(EVIDENCE, JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    } },
  ]);
  console.log('PASS real-model Gateway/MCP/Controller/PostgreSQL/WS delegation, title fidelity, receipt grounding, contextual confirmation and replay');
}
