import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { verificationEnvironment } from '../../../scripts/verify.mjs';
import { closeTestWebSocket, stopTestProcess, withTestCleanup } from '../../support/cleanup.mjs';
import { createControllerFixture, createPostgresFixture, waitFor } from '../../support/control-plane-fixture.mjs';
import { PROGRESS_TASK, RAW_REPLY_TASK, RESUMABLE_REPLY, verifyReliableDelivery } from './reliable-delivery.mjs';
import { BUDGET_REPLY, BUDGET_REPLY_TASK, verifyWechatBudget } from './wechat-budget.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CHAT = 'synthetic-wechat-interaction-chat';
const NODE = 'synthetic-wechat-interaction-node';
const SESSION = 'synthetic-wechat-interaction-session';
const CONTEXT = 'synthetic-wechat-context';
const PROPOSAL = '请先给合成会话制定一个统计记录的单步计划，暂不执行';
const DIRECT_TASK = '请直接统计合成会话中的待办记录，并把最终结果告诉我';
const DIRECT_PROMPT = '统计合成待办记录并报告最终数量';
const DIRECT_FINAL = '**直接执行最终结果**：共 23 条待办，其中 5 条已完成。';
const QUERY = '开始执行了吗？';
const MISROUTED_QUERY = '合成会话里的待办记录统计完了吗？';
const NEGATIVE = '暂时不要执行';
const PROGRESS = 'SYNTHETIC_PROGRESS_ONLY：正在统计，尚未完成';
const FINAL = '**验收最终结果**：共 17 条记录，其中 3 条需要复核。';
const HTTP_MS = 5_000;
const PROCESS_MS = 30_000;
const HEARTBEAT_MS = 500;
const TICK_OBSERVATION_MS = 2_200;
const MESSAGE_TYPE_TEXT = 1;
const CONFIRMATION_INPUT = /^(?:请)?(?:确认|执行|开始|开始执行|确认执行|确认开始|按这个计划执行|就按这个执行|确认这个计划)[。！!]?$/u;
const { values } = parseArgs({ options: { help: { type: 'boolean', short: 'h' }, run: { type: 'boolean' },
  'budget-only': { type: 'boolean' } } });

if (values.help || !values.run) {
  console.log('Usage: node tests/integration/leader/wechat-interaction.mjs --run [--budget-only]\nRequires built Controller/Gateway, Node >=24, OpenSSL and local Docker with postgres:16-alpine. Starts real processes against disposable PostgreSQL, local model HTTP, local WeChat HTTPS and a synthetic Daemon WebSocket. Never reads live credentials or sessions.');
} else {
  await (async () => {
    await main();
    if (!values['budget-only']) await main({ budgetOnly: true });
  })().catch(error => { console.error(error.stack); process.exitCode = 1; });
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function closeServer(server) {
  if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function jsonBody(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}

function respond(response, body, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function main({ budgetOnly = values['budget-only'] } = {}) {
  const env = verificationEnvironment();
  const require = createRequire(new URL('../../../controller/package.json', import.meta.url));
  const { WebSocket } = require('ws');
  const postgres = createPostgresFixture({ env });
  const token = randomUUID();
  const nodeToken = randomUUID();
  const dir = await mkdtemp(join(tmpdir(), 'super-leader-wechat-interaction-'));
  const accountPath = join(dir, 'synthetic-account.json');
  const statePath = join(dir, 'synthetic-state.json');
  const certPath = join(dir, 'localhost-cert.pem');
  const keyPath = join(dir, 'localhost-key.pem');
  const sent = [], incoming = [], inputs = [], deliveries = [], acknowledgements = [], modelCalls = [], errors = [], logs = [];
  const wireEvents = [], notificationClientIds = new Set(), fault = { remaining: 0, mode: null };
  const fingerprint = createHash('sha256').update(JSON.stringify(['synthetic-account', 'synthetic-wechat-token'])).digest('hex');
  const clientId = (key, index) => 'super-leader:' + createHash('sha256')
    .update(JSON.stringify([fingerprint, CHAT, key, index])).digest('hex').slice(0, 24);
  const authorizationCalls = [], controllerRequests = [], validContexts = new Set([CONTEXT]);
  let controller, model, wechat, proxy, gatewayControllerUrl, socket, heartbeat, gatewayChild, cursor = 0;
  const healthy = () => { if (errors.length) throw errors[0]; };
  const evidence = (step, data) => console.log(JSON.stringify({ step, ...data }, (_key, value) =>
    typeof value === 'string' ? value.replace(/#login=[A-Za-z0-9_.~%-]+/gu, '#login=[synthetic-redacted]') : value));
  const notificationMessages = () => sent.filter(message => notificationClientIds.has(message.client_id));

  await withTestCleanup(async () => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-sha256',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', certPath],
    { env, timeout: HTTP_MS, stdio: ['ignore', 'pipe', 'pipe'] });

    model = createServer(async (request, response) => {
      try {
        assert.equal(request.url, '/v1/responses');
        assert.equal(request.method, 'POST');
        const body = await jsonBody(request);
        const last = body.input.at(-1);
        if (body.tools?.length === 1 && body.tools[0].name === 'classify_user_authorization') {
          assert.equal(body.input.length, 2, 'Authorization included planner history or tool results');
          assert.deepEqual(body.input.map(item => item.role), ['system', 'user']);
          assert([DIRECT_TASK, PROGRESS_TASK, MISROUTED_QUERY].includes(last.content), 'Unexpected authorization input: ' + JSON.stringify(last));
          for (const history of [PROPOSAL, DIRECT_PROMPT, PROGRESS, FINAL]) {
            assert(!JSON.stringify(body.input[0]).includes(history), 'Authorization system input included planner history');
          }
          authorizationCalls.push(last);
          respond(response, { status: 'completed', output: [{ type: 'function_call',
            call_id: 'synthetic-authorization-' + authorizationCalls.length, name: 'classify_user_authorization',
            arguments: JSON.stringify({ intent: last.content !== MISROUTED_QUERY ? 'task' : 'query' }) }] });
          return;
        }
        modelCalls.push(last);
        wireEvents.push({ kind: 'model', text: last.content });
        let output;
        if (last.content === PROPOSAL) {
          output = [{ type: 'function_call', call_id: 'synthetic-proposal-' + modelCalls.length, name: 'propose_plan',
            arguments: JSON.stringify({ actions: [{ nodeId: NODE, sessionId: SESSION,
              prompt: '统计合成记录并报告最终数量', dependsOn: [] }] }) }];
        } else if ([DIRECT_TASK, PROGRESS_TASK, MISROUTED_QUERY].includes(last.content)) {
          assert(body.tools.some(tool => tool.name === 'execute_plan'), 'Model was not offered the direct execution tool');
          output = [{ type: 'function_call', call_id: 'synthetic-execution-' + modelCalls.length, name: 'execute_plan',
            arguments: JSON.stringify({ actions: Array.from({ length: last.content === PROGRESS_TASK ? 4 : 1 },
              (_, index) => ({ nodeId: NODE, sessionId: SESSION,
                prompt: last.content === PROGRESS_TASK ? `合成进度任务 ${index + 1}` : DIRECT_PROMPT,
                dependsOn: index ? [index] : [] })) }) }];
        } else if ([RAW_REPLY_TASK, BUDGET_REPLY_TASK].includes(last.content)) {
          output = [{ type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: last.content === BUDGET_REPLY_TASK ? BUDGET_REPLY : RESUMABLE_REPLY }] }];
        } else {
          assert([QUERY, NEGATIVE].includes(last.content), 'Unexpected model input: ' + JSON.stringify(last));
          output = [{ type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: '当前尚未执行；等待你的明确确认。' }] }];
        }
        respond(response, { status: 'completed', output });
      } catch (error) { errors.push(error); respond(response, { error: 'Synthetic model protocol failure' }, 500); }
    });
    const modelPort = await listen(model);
    const databaseUrl = await postgres.start();
    controller = await createControllerFixture({ logs, secrets: [token, nodeToken, postgres.password], env: {
      ...env, PERSISTENCE_MODE: 'postgres', DATABASE_URL: databaseUrl, CONTROLLER_TOKEN: token,
      NODE_TOKENS: JSON.stringify({ [NODE]: nodeToken }), ALLOWED_CHAT_IDS: CHAT, LEADER_MODE: 'model',
      LEADER_MODEL_BASE_URL: `http://127.0.0.1:${modelPort}/v1`, LEADER_MODEL_API_KEY: 'synthetic-model-key',
      LEADER_MODEL_NAME: 'synthetic-wechat-model',
    } });
    // The fixture inherits process.env; explicitly replace it with the sanitized environment.
    for (const key of Object.keys(controller.env)) if (!Object.hasOwn(env, key) &&
      !['HOST', 'PORT', 'CONSOLE_PUBLIC_URL', 'PERSISTENCE_MODE', 'DATABASE_URL', 'CONTROLLER_TOKEN', 'NODE_TOKENS',
        'ALLOWED_CHAT_IDS', 'LEADER_MODE', 'LEADER_MODEL_BASE_URL', 'LEADER_MODEL_API_KEY', 'LEADER_MODEL_NAME'].includes(key)) {
      delete controller.env[key];
    }
    await controller.start();
    proxy = createServer(async (request, response) => {
      try {
        const body = request.method === 'POST' ? await jsonBody(request) : undefined;
        const observation = { method: request.method, path: request.url, body };
        controllerRequests.push(observation);
        const result = await fetch(controller.base + request.url, { method: request.method,
          headers: { authorization: request.headers.authorization, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(PROCESS_MS) });
        observation.status = result.status;
        response.writeHead(result.status, { 'content-type': 'application/json' });
        response.end(await result.text());
      } catch (error) { errors.push(error); respond(response, { error: 'Synthetic Controller proxy failure' }, 500); }
    });
    gatewayControllerUrl = `http://127.0.0.1:${await listen(proxy)}`;

    let sessionStatus = 'idle';
    const sendFrame = message => socket.send(JSON.stringify(message), error => { if (error) errors.push(error); });
    const frame = type => ({ type, ...(type === 'hello' ? { version: 1, nodeId: NODE } : {}), sessions: [{
      id: SESSION, title: '合成统计会话', provider: 'codex-app', cwd: '/synthetic', status: sessionStatus, loaded: true,
      capabilities: ['read', 'send'], observedAt: new Date().toISOString(),
    }], skills: [] });
    const connectDaemon = async () => {
      socket = new WebSocket(controller.base.replace('http:', 'ws:') + '/v1/daemon',
      { headers: { authorization: 'Bearer ' + nodeToken } });
    socket.on('error', error => errors.push(error));
    await once(socket, 'open');
    socket.on('message', raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.type === 'command') {
          assert.equal(message.nodeId, NODE);
          assert.equal(message.sessionId, SESSION);
          assert.equal(message.action, 'send');
          deliveries.push(message);
          sendFrame({ type: 'result', commandId: message.commandId, status: 'accepted',
            turnId: 'synthetic-turn-' + message.commandId, output: PROGRESS });
        } else if (message.type === 'result_ack') acknowledgements.push(message);
      } catch (error) { errors.push(error); }
    });
    sendFrame(frame('hello'));
    heartbeat = setInterval(() => sendFrame(frame('heartbeat')), HEARTBEAT_MS);
    await waitFor(async () => {
      healthy();
      return (await controller.request('/v1/status')).body.sessions.some(session => session.nodeId === NODE && session.id === SESSION);
    }, 'Synthetic Daemon session visible through Controller HTTP');
    };
    const disconnectDaemon = async () => { clearInterval(heartbeat); await closeTestWebSocket(socket); socket = undefined; };
    const restartController = async () => { await disconnectDaemon(); await controller.stop(); await controller.start(); };
    const setSessionStatus = async status => {
      sessionStatus = status;
      if (!socket) { await connectDaemon(); return; }
      sendFrame(frame('heartbeat'));
      await waitFor(async () => (await controller.request('/v1/status')).body.sessions.some(session =>
        session.id === SESSION && session.status === status), 'Synthetic session status ' + status);
    };
    await connectDaemon();

    wechat = createHttpsServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, async (request, response) => {
      try {
        assert.equal(request.method, 'POST');
        assert.equal(request.headers.authorization, 'Bearer synthetic-wechat-token');
        const body = await jsonBody(request);
        if (request.url === '/ilink/bot/getupdates') {
          cursor++;
          respond(response, { ret: 0, errcode: 0, get_updates_buf: 'synthetic-cursor-' + cursor, msgs: incoming.splice(0) });
        } else if (request.url === '/ilink/bot/getconfig') {
          assert.equal(body.ilink_user_id, CHAT);
          assert(validContexts.has(body.context_token), 'Typing used an unknown synthetic context');
          respond(response, { ret: 0, typing_ticket: 'synthetic-typing-ticket' });
        } else if (request.url === '/ilink/bot/sendtyping') {
          assert.equal(body.ilink_user_id, CHAT);
          assert.equal(body.typing_ticket, 'synthetic-typing-ticket');
          assert.equal(body.status, 1);
          wireEvents.push({ kind: 'typing' });
          respond(response, { ret: 0, errcode: 0 });
        } else {
          assert.equal(request.url, '/ilink/bot/sendmessage');
          assert.equal(body.msg.to_user_id, CHAT);
          assert(validContexts.has(body.msg.context_token), 'Send used an unknown synthetic context');
          assert.equal(body.msg.item_list.length, 1);
          assert.equal(body.msg.item_list[0].type, MESSAGE_TYPE_TEXT);
          sent.push(body.msg);
          wireEvents.push({ kind: 'send', message: body.msg });
          if (fault.remaining > 0 && --fault.remaining === 0) {
            if (fault.mode === 'disconnect') { response.destroy(); return; }
            assert.equal(fault.mode, 'reject');
            respond(response, { ret: -1, errcode: -1 });
            return;
          }
          respond(response, { ret: 0, errcode: 0 });
        }
      } catch (error) { errors.push(error); respond(response, { error: 'Synthetic WeChat protocol failure' }, 500); }
    });
    const wechatPort = await listen(wechat);
    await writeFile(accountPath, JSON.stringify({ token: 'synthetic-wechat-token', accountId: 'synthetic-account',
      baseUrl: `https://127.0.0.1:${wechatPort}` }), { mode: 0o600 });

    const runGateway = async (mode, { expectedExit = 0, gatewayEnv = {} } = {}) => {
      healthy();
      let output = '', stderr = '';
      gatewayChild = spawn(process.execPath, ['gateway/dist/index.js', mode, '--notifications', '--controller-url', gatewayControllerUrl,
        '--credentials-path', accountPath, '--state-path', statePath, '--health-path', join(dir, 'health.json')],
      { cwd: ROOT, env: { ...env, CONTROLLER_TOKEN: token, NODE_EXTRA_CA_CERTS: certPath,
        ...(budgetOnly ? {} : { GATEWAY_SEND_BUDGET: '1000' }), ...gatewayEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
      gatewayChild.stdout.on('data', chunk => { output += chunk; });
      gatewayChild.stderr.on('data', chunk => { stderr += chunk; });
      const timer = setTimeout(() => { errors.push(new Error('Gateway CLI timed out')); gatewayChild.kill('SIGTERM'); }, PROCESS_MS);
      let exit;
      try { [exit] = await once(gatewayChild, 'exit'); }
      finally { clearTimeout(timer); }
      healthy();
      assert.equal(exit, expectedExit, 'Unexpected Gateway CLI exit: ' + stderr + output);
      gatewayChild = undefined;
      return expectedExit === 0 ? JSON.parse(output.trim()) : { exit, stderr };
    };
    const input = async (text, messageId = randomUUID(), contextToken = CONTEXT, gatewayOptions) => {
      const before = sent.length;
      const eventsBefore = wireEvents.length;
      inputs.push({ text, messageId });
      validContexts.add(contextToken);
      incoming.push({ message_type: MESSAGE_TYPE_TEXT, from_user_id: CHAT, client_id: messageId,
        create_time_ms: Date.now(), context_token: contextToken, item_list: [{ type: MESSAGE_TYPE_TEXT, text_item: { text } }] });
      const summary = await runGateway('--poll-once', gatewayOptions);
      const replies = sent.slice(before).filter(message => !notificationClientIds.has(message.client_id));
      if (summary.processedCount > 0) {
        const events = wireEvents.slice(eventsBefore);
        const typing = events.findIndex(event => event.kind === 'typing');
        const model = events.findIndex(event => event.kind === 'model');
        assert(typing >= 0, 'New input did not send a typing indicator');
        if (model >= 0) assert(typing < model, 'Input reached model before its typing indicator');
      }
      evidence('wechat-input', { input: text, reply: replies.map(message => message.item_list[0].text_item.text).join('\n'), summary });
      return { messageId, summary, replies };
    };
    const pending = async () => {
      const response = await controller.request('/v1/notifications/pending', { chatIds: [CHAT] });
      assert.equal(response.status, 200);
      for (const item of response.body.items) {
        // IDs correlate exact delivery parts; no assumption about an outbound prefix identifies notifications.
        for (let index = 0; index <= Math.ceil(item.text.length / 2_000); index++) {
          notificationClientIds.add(clientId('notification:' + item.id, index));
        }
      }
      return response.body.items;
    };
    await runGateway('--establish-baseline');
    assert.equal(sent.length, 0);
    if (budgetOnly) {
      await verifyWechatBudget({ controller, input, runGateway, pending, sent, incoming, deliveries, sendFrame,
        statePath, wireEvents, evidence, healthy, chatId: CHAT, contextToken: CONTEXT, directTask: DIRECT_TASK,
        query: QUERY, clientId, controllerRequests, validContexts, restartController, setSessionStatus, databaseUrl });
      healthy();
      return;
    }
    await input(PROPOSAL);
    await input(QUERY);
    await input(NEGATIVE);
    assert.equal(deliveries.length, 0, 'Preview/query/negative wording dispatched a command');
    await input('不用执行');
    await input('执行');
    assert.equal(deliveries.length, 0, 'Cancellation left a dispatchable pending plan');

    const preview = await input(PROPOSAL);
    assert(preview.replies.some(message => message.item_list[0].text_item.text.includes('尚未派发')));
    await input(QUERY);
    await delay(TICK_OBSERVATION_MS);
    assert.equal(deliveries.length, 0, 'Query or background tick dispatched the preview');
    const confirmation = await input('执行');
    await waitFor(() => { healthy(); return deliveries.length === 1 && acknowledgements.some(item => item.status === 'accepted'); },
      'One accepted command after short confirmation');
    const command = deliveries[0];
    const commandPath = '/v1/commands/' + command.commandId;
    const accepted = await controller.request(commandPath);
    assert.equal(accepted.body.status, 'accepted');
    assert.equal(accepted.body.output, PROGRESS);
    assert.equal((await pending()).length, 0, 'Accepted progress created a completion notification');
    const sameInput = await input('执行', confirmation.messageId);
    assert.equal(sameInput.summary.processedCount, 0, 'Repeated poll input was processed twice');
    assert.equal(sameInput.replies.length, 0, 'Repeated poll input sent another reply');
    const replay = await controller.request('/v1/messages', { chatId: CHAT, messageId: confirmation.messageId, text: '执行' });
    assert.equal(replay.status, 200);
    await input('执行');
    assert.equal(deliveries.length, 1, 'Repeated confirmation dispatched the plan twice');

    const receipt = (turnId, output) => sendFrame({ type: 'result', commandId: command.commandId, turnId, status: 'completed', output });
    receipt('wrong-synthetic-turn', 'WRONG_TURN_RESULT');
    await delay(TICK_OBSERVATION_MS);
    assert.equal((await controller.request(commandPath)).body.status, 'accepted', 'Wrong turn completed a command');
    assert.equal((await pending()).length, 0, 'Wrong turn generated a notification');
    receipt('synthetic-turn-' + command.commandId, FINAL);
    await waitFor(async () => {
      healthy();
      return (await pending()).length === 1;
    }, 'Exact completion creates one durable notification');
    const complete = await controller.request(commandPath);
    assert.equal(complete.body.status, 'completed');
    assert.equal(complete.body.output, FINAL, 'Completed command lost its exact result body');
    const notification = (await pending())[0];
    assert.equal(notification.kind, 'completed');
    assert(notification.text.includes('17 条记录'), 'Persisted notification omitted the actual result');
    assert(!notification.text.includes(PROGRESS), 'Notification substituted accepted progress for the completed result');
    const summary = await runGateway('--poll-once');
    assert.equal(summary.notifications.accepted, 1);
    assert.equal(notificationMessages().length, 1, 'Completion did not result in exactly one outbound notification');
    const outbound = notificationMessages()[0];
    const actual = outbound.item_list[0].text_item.text;
    assert.equal(actual, notification.text, 'Actual WeChat send changed persisted Markdown');
    assert(actual.includes(FINAL), 'Actual WeChat send omitted or corrupted the completed result: ' + actual);
    assert.equal(wireEvents[wireEvents.findIndex(event => event.message === outbound) - 1]?.kind, 'typing');
    assert(!actual.includes(PROGRESS), 'Actual WeChat notification contains progress instead of the result');
    evidence('exact-completion', { commandStatus: complete.body.status, daemonOutput: complete.body.output,
      notificationKind: notification.kind, actualWeChatText: actual, outboundCount: notificationMessages().length });

    receipt('synthetic-turn-' + command.commandId, FINAL);
    await delay(TICK_OBSERVATION_MS);
    await runGateway('--poll-once');
    await runGateway('--poll-once');
    assert.equal((await pending()).length, 0);
    assert.equal(notificationMessages().length, 1, 'Repeated receipt/poll resent the completion notification');
    assert.equal(deliveries.length, 1, 'Receipt/poll replay caused a second command');
    const persisted = await controller.request('/v1/notifications/' + notification.id);
    assert.equal(persisted.body.notification.status, 'accepted');

    const misroutedQuery = await input(MISROUTED_QUERY);
    assert(misroutedQuery.replies.length > 0, 'Rejected planner execution did not answer the query');
    assert.equal(modelCalls.filter(call => call.content === MISROUTED_QUERY).length, 1);
    assert.equal(authorizationCalls.filter(call => call.content === MISROUTED_QUERY).length, 1,
      'Planner execution on a query was not independently classified');
    await delay(TICK_OBSERVATION_MS);
    await runGateway('--poll-once');
    assert.equal(deliveries.length, 1, 'Planner execute_plan on a query dispatched a command');
    assert.equal((await pending()).length, 0, 'Rejected query execution created a completion notification');
    assert.equal(notificationMessages().length, 1);
    const misroutedReplay = await input(MISROUTED_QUERY, misroutedQuery.messageId);
    assert.equal(misroutedReplay.summary.processedCount, 0);
    assert.equal(misroutedReplay.replies.length, 0);
    assert.equal(authorizationCalls.filter(call => call.content === MISROUTED_QUERY).length, 1,
      'Rejected query replay requested authorization again');
    evidence('query-execution-rejected', { plannerTool: 'execute_plan', authorization: 'query',
      authorizationCalls: authorizationCalls.filter(call => call.content === MISROUTED_QUERY).length,
      daemonCommands: deliveries.length - 1, completionNotifications: notificationMessages().length - 1 });

    const directInputStart = inputs.length;
    const directConfirmationMessages = () => inputs.slice(directInputStart)
      .filter(message => CONFIRMATION_INPUT.test(message.text.trim())).length;
    const directInput = await input(DIRECT_TASK);
    await waitFor(() => {
      healthy();
      return deliveries.length === 2 && acknowledgements.some(item =>
        item.commandId === deliveries[1].commandId && item.status === 'accepted');
    }, 'Explicit task dispatches once in its original message without confirmation');
    const directCommand = deliveries[1];
    assert.notEqual(directCommand.commandId, command.commandId);
    assert.equal(directCommand.prompt, DIRECT_PROMPT);
    const directCommandPath = '/v1/commands/' + directCommand.commandId;
    const directAccepted = await controller.request(directCommandPath);
    assert.equal(directAccepted.body.status, 'accepted');
    assert.equal(directAccepted.body.output, PROGRESS);
    assert.equal((await pending()).length, 0, 'Direct accepted progress created a completion notification');
    const directModelCallCount = modelCalls.filter(call => call.content === DIRECT_TASK).length;
    assert.equal(directModelCallCount, 1, 'Direct task required another model turn');
    assert.equal(authorizationCalls.filter(call => call.content === DIRECT_TASK).length, 1,
      'Direct task was not independently authorized exactly once');
    assert(directInput.replies.length > 0, 'Direct task did not acknowledge its dispatch');
    const directReplyText = directInput.replies.map(message => message.item_list[0].text_item.text).join('\n');
    assert.doesNotMatch(directReplyText.replaceAll('无需再次确认', ''),
      /确认|尚未派发|(?:回复|发送|输入|等待)[^\n。；]*(?:执行|开始)/u,
      'Direct task reply asked for confirmation or reported an undispatched preview: ' + directReplyText);

    const directReplay = await input(DIRECT_TASK, directInput.messageId);
    assert.equal(directReplay.summary.processedCount, 0, 'Repeated direct input was processed twice');
    assert.equal(directReplay.replies.length, 0, 'Repeated direct input sent another reply');
    const directControllerReplay = await controller.request('/v1/messages', {
      chatId: CHAT, messageId: directInput.messageId, text: DIRECT_TASK,
    });
    assert.equal(directControllerReplay.status, 200);
    const directSentBeforePoll = sent.length;
    await runGateway('--poll-once');
    await runGateway('--poll-once');
    assert.equal(sent.length, directSentBeforePoll, 'Direct message replay or empty poll sent another message');
    assert.equal(deliveries.length, 2, 'Direct message replay or empty poll dispatched another command');
    assert.equal(modelCalls.filter(call => call.content === DIRECT_TASK).length, directModelCallCount,
      'Direct message replay called the model again');
    assert.equal(authorizationCalls.filter(call => call.content === DIRECT_TASK).length, 1,
      'Direct message replay requested authorization again');

    const directReceipt = () => sendFrame({ type: 'result', commandId: directCommand.commandId,
      turnId: 'synthetic-turn-' + directCommand.commandId, status: 'completed', output: DIRECT_FINAL });
    directReceipt();
    await waitFor(async () => { healthy(); return (await pending()).length === 1; },
      'Direct task completion creates its durable notification without a confirmation message');
    const directComplete = await controller.request(directCommandPath);
    assert.equal(directComplete.body.status, 'completed');
    assert.equal(directComplete.body.output, DIRECT_FINAL);
    const directNotification = (await pending())[0];
    assert.equal(directNotification.kind, 'completed');
    assert(directNotification.text.includes('23 条待办'), 'Direct task notification omitted the actual result');
    assert(!directNotification.text.includes(PROGRESS), 'Direct task notification contains accepted progress');
    const directSummary = await runGateway('--poll-once');
    assert.equal(directSummary.notifications.accepted, 1);
    assert.equal(notificationMessages().length, 2, 'Direct task did not send exactly one completion notification');
    const directActual = notificationMessages()[1].item_list[0].text_item.text;
    assert.equal(directActual, directNotification.text, 'Direct notification changed persisted Markdown');
    assert(directActual.includes(DIRECT_FINAL), 'Direct WeChat send omitted its result: ' + directActual);
    assert(!directActual.includes(PROGRESS), 'Direct notification sent accepted progress instead of the result');
    assert.equal(directConfirmationMessages(), 0, 'Direct task received a user confirmation before completion');
    evidence('direct-execution-completion', { commandStatus: directComplete.body.status,
      daemonOutput: directComplete.body.output, confirmationMessages: directConfirmationMessages(), daemonCommands: 1,
      notificationKind: directNotification.kind, actualWeChatText: directActual, completionNotifications: 1 });

    const directSentAfterCompletion = sent.length;
    directReceipt();
    await delay(TICK_OBSERVATION_MS);
    await runGateway('--poll-once');
    await runGateway('--poll-once');
    assert.equal((await pending()).length, 0);
    assert.equal(sent.length, directSentAfterCompletion, 'Repeated direct completion/poll sent another message');
    assert.equal(notificationMessages().length, 2, 'Repeated direct completion/poll resent its notification');
    assert.equal(deliveries.length, 2, 'Repeated direct completion/poll dispatched another command');
    const directPersisted = await controller.request('/v1/notifications/' + directNotification.id);
    assert.equal(directPersisted.body.notification.status, 'accepted');
    assert.equal(authorizationCalls.filter(call => call.content === DIRECT_TASK).length, 1,
      'Direct completion replay requested authorization again');
    const directAuthorizationCount = authorizationCalls.filter(call => call.content === DIRECT_TASK).length;
    const reliableDelivery = await verifyReliableDelivery({ controller, input, runGateway, pending, sent, incoming, deliveries,
      sendFrame, statePath, fault, wireEvents, evidence, healthy, chatId: CHAT, contextToken: CONTEXT,
      directTask: DIRECT_TASK, nodeId: NODE, sessionId: SESSION, clientId,
      restartController, setSessionStatus, databaseUrl, query: QUERY });
    healthy();
    evidence('PASS', { realControllerProcess: true, realGatewayCli: true, disposablePostgres: true,
      daemonCommands: deliveries.length, notificationWireParts: notificationMessages().length,
      reliableDelivery,
      confirmedPlan: { daemonCommands: 1, completionNotifications: 1 },
      directTask: { daemonCommands: 1, completionNotifications: 1, confirmationMessages: directConfirmationMessages(),
        authorizationCalls: directAuthorizationCount },
      rejectedQuery: { authorizationCalls: authorizationCalls.filter(call => call.content === MISROUTED_QUERY).length },
      probes: ['query/negative zero dispatch', 'cancellation clears pending', 'short confirmation after query',
        'duplicate confirmation and input', 'wrong turn ignored', 'accepted progress is not completion',
        'duplicate completion and poll', 'direct task executes in original message without confirmation',
        'direct messageId replay and empty polls do not dispatch or send', 'direct accepted-to-completed automatic notification',
        'duplicate direct completion and poll', 'authorization sees only current user text',
        'independent authorization rejects planner execute_plan on a query'] });
  }, [
    { label: 'gateway child', cleanup: () => stopTestProcess(gatewayChild) },
    { label: 'heartbeat', cleanup: () => { clearInterval(heartbeat); } },
    { label: 'synthetic Daemon', cleanup: () => closeTestWebSocket(socket) },
    { label: 'Controller', cleanup: () => controller?.stop() },
    { label: 'Controller proxy', cleanup: () => closeServer(proxy) },
    { label: 'WeChat HTTPS shim', cleanup: () => closeServer(wechat) },
    { label: 'model HTTP shim', cleanup: () => closeServer(model) },
    { label: 'disposable PostgreSQL', cleanup: () => postgres.stop() },
    { label: 'owned temporary fixture files', cleanup: () => rm(dir, { recursive: true, force: true }) },
  ]).catch(error => {
    if (logs.length) console.error('Controller diagnostic tail:\n' + logs.join('').slice(-6_000));
    throw error;
  });
}
