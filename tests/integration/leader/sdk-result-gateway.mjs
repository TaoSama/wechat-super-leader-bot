import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { verificationEnvironment } from '../../../scripts/verify.mjs';
import { stopTestProcess, withTestCleanup } from '../../support/cleanup.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ACCOUNT = 'synthetic-sdk-account';
const CHAT = 'synthetic-sdk-chat';
const CONTEXT = 'synthetic-sdk-context';
const CONTROLLER_ACK = '[synthetic-sdk-node] 原始会话标题\n\n**Controller 真实回复，保留原题与核查结果。**' +
  '已核查的持久会话信息甲乙丙丁戊己庚辛壬癸。'.repeat(18);
const FINAL_TEXT = '**SDK 最终原文，保留换行与标点。**\n' + '原始完整成果甲乙丙丁戊己庚辛壬癸。'.repeat(18);
const DISPLAY_TEXT = 'SDK 最终原文，保留换行与标点。\n' + '原始完整成果甲乙丙丁戊己庚辛壬癸。'.repeat(18);
const RENEW_TEXT = 'renew-sdk-fixture';
const RENEW_REPLY = 'SDK 已收到续期消息。';
const CHUNK_CHARS = 64;
const HTTP_MS = 5_000;
const PROCESS_MS = 30_000;
const hash = text => createHash('sha256').update(text).digest('hex');
const { values } = parseArgs({ options: { run: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
if (!values.run || values.help) {
  console.log('Usage: node tests/integration/leader/sdk-result-gateway.mjs --run\nRequires built Gateway with the Codex reply/getReply/ackReply contract. Runs the actual Gateway CLI and app-server transport against a generated protocol fixture, synthetic Controller HTTP tools, HTTPS iLink and private temporary workspaces. Never uses real model credentials, native Codex or production sessions.');
} else {
  await verifySdkResultGateway().catch(error => { console.error(error); process.exitCode = 1; });
}

async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
async function closeServer(server) {
  if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function jsonBody(request) {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function respond(response, body) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); }

// App-server subprocess fixture: parse the transport CLI arguments using the
// standard parser and speak its JSON-RPC protocol. All execution counts and tool
// evidence are written by the subprocess itself, not injected into the engine.
function fakeCodexSource() {
  return `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const readline = require('node:readline');
const { parseArgs } = require('node:util');
const { values, positionals } = parseArgs({ strict: true, allowPositionals: true, options: {
  config: { type: 'string', multiple: true, short: 'c' }, listen: { type: 'string' },
} });
const settings = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixture.json'), 'utf8'));
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
const THREAD_ID = 'synthetic-sdk-thread', TURN_ID = 'synthetic-sdk-turn-' + process.pid;
const methods = [];
let resumed = false;
assert.deepEqual(positionals, ['app-server']); assert.equal(values.listen, 'stdio://');
const notify = (method, params) => emit({ method, params: { threadId: THREAD_ID, turnId: TURN_ID, ...params } });
async function handle(request) {
  methods.push(request.method);
  if (request.method === 'initialize') {
    assert.equal(request.params.capabilities.experimentalApi, true);
    emit({ id: request.id, result: {} }); return;
  }
  if (request.method === 'initialized') { assert.equal(request.id, undefined); return; }
  if (['thread/start', 'thread/resume'].includes(request.method)) {
    assert.equal(request.params.cwd, process.env.HOME);
    assert.equal(process.env.CODEX_HOME, path.join(request.params.cwd, '.codex'));
    assert.equal(request.params.approvalPolicy, 'never');
    resumed = request.method === 'thread/resume';
    if (resumed) assert.equal(request.params.threadId, THREAD_ID);
    emit({ id: request.id, result: { thread: { id: THREAD_ID } } }); return;
  }
  assert.equal(request.method, 'turn/start');
  assert.equal(request.params.threadId, THREAD_ID);
  assert.equal(request.params.input.length, 1); assert.equal(request.params.input[0].type, 'text');
  const prompt = request.params.input[0].text;
  const match = prompt.match(/<current_user_message>(.+)<\\/current_user_message>/);
  assert(match); const input = JSON.parse(match[1]).text;
  fs.appendFileSync(settings.nativeLog, JSON.stringify({ input, pid: process.pid, resumed, methods }) + '\\n');
  emit({ id: request.id, result: { turn: { id: TURN_ID } } });
  if (settings.tool && input !== settings.renewText) {
    const config = values.config.find(value => value.startsWith('mcp_servers='));
    assert(config);
    const servers = JSON.parse(config.slice(config.indexOf('=') + 1).replace(/("[^"]+")=/g, '$1:'));
    const url = servers.wechat_control.url;
    assert.equal(new URL(url).hostname, '127.0.0.1');
    const response = await fetch(url, { method: 'POST', headers: {
      Authorization: 'Bearer ' + process.env.LEADER_TURN_MCP_TOKEN,
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_sessions', arguments: { arguments: {} } } }) });
    assert.equal(response.status, 200); const body = await response.text();
    const result = JSON.parse(body).result;
    assert.equal(JSON.parse(result.content[0].text).reply.text, settings.controllerAck);
    fs.appendFileSync(settings.toolLog, JSON.stringify({ input, sawControllerAck: true }) + '\\n');
  }
  notify('item/completed', { item: { type: 'agentMessage', id: 'commentary', text: 'Synthetic commentary must not replace the final answer.', phase: 'commentary' } });
  notify('item/completed', { item: { type: 'agentMessage', id: 'final', phase: 'final_answer', text: input === settings.renewText ? settings.renewReply : settings.finalText } });
  notify('turn/completed', { turn: { id: TURN_ID, status: 'completed' } });
}
let pending = Promise.resolve();
readline.createInterface({ input: process.stdin }).on('line', line => {
  pending = pending.then(() => handle(JSON.parse(line))).catch(error => { console.error(error); process.exit(1); });
});
`;
}

export async function verifySdkResultGateway() {
  for (const tool of [false, true]) await verifyScenario(tool);
  console.log('PASS real Gateway CLI + app-server subprocess protocol + synthetic Controller tool server: pure chat preserves the final answer and tool-backed recovery preserves exact Controller reply, frozen chunks and execution identity');
}

async function verifyScenario(tool) {
  const originalReply = tool ? CONTROLLER_ACK : FINAL_TEXT;
  const displayedReply = tool ? CONTROLLER_ACK.replaceAll('**', '') : DISPLAY_TEXT;
  const headerEnd = displayedReply.lastIndexOf('\n', CHUNK_CHARS - 1) + 1;
  const expectedChunks = [displayedReply.slice(0, headerEnd),
    ...Array.from({ length: Math.ceil((displayedReply.length - headerEnd) / CHUNK_CHARS) }, (_, index) =>
      displayedReply.slice(headerEnd + index * CHUNK_CHARS, headerEnd + (index + 1) * CHUNK_CHARS))];
  const env = verificationEnvironment(), token = randomUUID();
  const directory = await mkdtemp(join(await realpath(tmpdir()), `super-leader-sdk-${tool ? 'tool' : 'chat'}-`));
  const accountPath = join(directory, 'account.json'), statePath = join(directory, 'state.json');
  const leaderRoot = join(directory, 'leader'), nativeLog = join(directory, 'native.jsonl'), toolLog = join(directory, 'tools.jsonl');
  const certPath = join(directory, 'localhost-cert.pem'), keyPath = join(directory, 'localhost-key.pem');
  const executable = join(directory, 'codex.cjs'), preload = join(directory, 'fetch-audit.mjs'), fetchLog = join(directory, 'fetch.jsonl');
  const initialId = randomUUID(), initialText = tool ? 'synthetic tool-backed initial request' : 'synthetic pure-chat initial request';
  const deliveryKey = JSON.stringify([ACCOUNT, CHAT, initialId]);
  const workspace = join(leaderRoot, hash(JSON.stringify([ACCOUNT, CHAT])));
  const journalPath = join(workspace, '.replies.json');
  const incoming = [], sent = [], errors = [], logs = [], unexpectedCalls = [];
  let controller, model, wechat, child, cursor = 0;
  const healthy = () => { if (errors.length) throw errors[0]; };
  const readLines = async path => (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  await withTestCleanup(async () => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-sha256',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', certPath],
    { env, timeout: HTTP_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    await writeFile(executable, fakeCodexSource(), { mode: 0o700 });
    await writeFile(join(directory, 'fixture.json'), JSON.stringify({ tool, nativeLog, toolLog,
      finalText: FINAL_TEXT, controllerAck: CONTROLLER_ACK, renewText: RENEW_TEXT, renewReply: RENEW_REPLY }), { mode: 0o600 });
    model = createServer(async (request, response) => {
      try {
        assert.equal(request.headers.authorization, `Bearer ${token}`);
        if (request.url === '/v1/chats/notification-interest') {
          assert.equal(request.method, 'GET');
          respond(response, { chatIds: [CHAT], interested: [] }); return;
        }
        assert.equal(request.method, 'POST');
        const body = await jsonBody(request);
        if (['/v1/notifications/pending', '/v1/deliveries/pending'].includes(request.url)) {
          assert.deepEqual(body, { chatIds: [CHAT] });
          respond(response, { items: [] }); return;
        }
        if (request.url === '/v1/deliveries/resume') {
          assert.equal(body.chatId, CHAT);
          assert(Object.keys(body).every(key => ['chatId', 'generation'].includes(key)));
          assert(body.generation === undefined || typeof body.generation === 'string' && body.generation.length > 0 && body.generation.length <= 512);
          respond(response, { resumed: 0 }); return;
        }
        if (request.url === '/v1/deliveries/blocked') {
          assert.deepEqual(Object.keys(body).sort(), ['chatId', 'reason']);
          assert.equal(body.chatId, CHAT);
          assert(typeof body.reason === 'string' && body.reason.length > 0 && body.reason.length <= 128);
          respond(response, { blocked: 0 }); return;
        }
        assert.equal(body.chatId, CHAT);
        if (request.url === '/v1/chats/authorize') { respond(response, { allowed: true }); return; }
        if (request.url === '/v1/tools/list') {
          respond(response, { context: { history: [], memories: {} }, tools: [{ name: 'list_sessions', description: 'Synthetic read-only inventory.',
            inputSchema: { type: 'object', properties: { arguments: { type: 'object', properties: {}, additionalProperties: false } },
              required: ['arguments'], additionalProperties: false }, annotations: { readOnlyHint: true } }], instructions: 'Read-only fixture.' });
          return;
        }
        if (request.url === '/v1/tools/call') {
          assert.equal(body.messageId, initialId); assert.equal(body.text, initialText);
          assert.equal(body.name, 'list_sessions'); assert.deepEqual(body.arguments, {});
          assert.match(body.callId, /^[a-f0-9]{64}$/);
          respond(response, { result: { sessions: [] }, reply: { text: CONTROLLER_ACK } }); return;
        }
        unexpectedCalls.push(body);
        throw new Error('Unexpected Controller route or inner model request');
      } catch (error) { errors.push(error); response.writeHead(500); response.end(); }
    });
    const modelPort = await listen(model);
    controller = { base: `http://127.0.0.1:${modelPort}` };
    wechat = createHttpsServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, async (request, response) => {
      try {
        const body = await jsonBody(request);
        assert.equal(request.headers.authorization, 'Bearer synthetic-sdk-token');
        if (request.url === '/ilink/bot/getupdates') {
          respond(response, { ret: 0, get_updates_buf: `sdk-cursor-${++cursor}`, msgs: incoming.splice(0) }); return;
        }
        if (request.url === '/ilink/bot/getconfig') { respond(response, { ret: 0, typing_ticket: 'synthetic-sdk-ticket' }); return; }
        if (request.url === '/ilink/bot/sendtyping') { respond(response, { ret: 0 }); return; }
        assert.equal(request.url, '/ilink/bot/sendmessage');
        assert.equal(body.msg.to_user_id, CHAT); assert.equal(body.msg.context_token, CONTEXT);
        assert.equal(body.msg.item_list[0].type, 1); sent.push(body.msg);
        respond(response, { ret: 0, errcode: 0 });
      } catch (error) { errors.push(error); response.writeHead(500); response.end(); }
    });
    const ilinkOrigin = `https://127.0.0.1:${await listen(wechat)}`;
    await writeFile(accountPath, JSON.stringify({ accountId: ACCOUNT, token: 'synthetic-sdk-token', baseUrl: ilinkOrigin }), { mode: 0o600 });
    await writeFile(preload, `import { appendFileSync } from 'node:fs';
const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(String(input));
  if (![${JSON.stringify(controller.base)}, ${JSON.stringify(ilinkOrigin)}].includes(url.origin)) throw new Error('Fixture blocked external fetch');
  appendFileSync(${JSON.stringify(fetchLog)}, JSON.stringify({ method: init?.method ?? 'GET', path: url.pathname }) + '\\n');
  return original(input, init);
};\n`, { mode: 0o600 });
    const run = async (mode = '--poll-once', { budget = 1, maxChars = CHUNK_CHARS } = {}) => {
      healthy(); let output = '', stderr = '';
      child = spawn(process.execPath, ['--import', preload, 'gateway/dist/index.js', mode,
        '--controller-url', controller.base, '--credentials-path', accountPath, '--state-path', statePath,
        '--max-chars', String(maxChars), '--leader-mode', 'codex', '--leader-root', leaderRoot, '--leader-model', 'synthetic-sdk-model'], {
        cwd: ROOT, env: { ...env, CONTROLLER_TOKEN: token, NODE_EXTRA_CA_CERTS: certPath,
          GATEWAY_SEND_BUDGET: String(budget), GATEWAY_CODEX_PATH: executable,
          GATEWAY_LEADER_API_KEY: 'synthetic-sdk-key', GATEWAY_LEADER_BASE_URL: `http://127.0.0.1:${modelPort}/v1` },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
      const timeout = setTimeout(() => { errors.push(new Error('SDK Gateway CLI timeout')); child.kill('SIGTERM'); }, PROCESS_MS);
      let exit; try { [exit] = await once(child, 'exit'); } finally { clearTimeout(timeout); }
      child = undefined; healthy();
      if (exit !== 0) {
        for (const [label, path] of [['state', statePath], ['journal', journalPath], ['native', nativeLog], ['fetch', fetchLog]]) {
          try { console.error('Synthetic SDK diagnostic', label, await readFile(path, 'utf8')); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      assert.equal(exit, 0, `SDK Gateway CLI ${mode} failed: ${stderr}${output}`);
    };
    const inbound = (text, clientId) => ({ message_type: 1, from_user_id: CHAT, client_id: clientId,
      create_time_ms: Date.now(), context_token: CONTEXT, item_list: [{ type: 1, text_item: { text } }] });
    const state = async () => JSON.parse(await readFile(statePath, 'utf8'));
    const journal = async () => JSON.parse(await readFile(journalPath, 'utf8'));
    const textOf = message => message.item_list[0].text_item.text;
    await run('--establish-baseline');
    const original = inbound(initialText, initialId); incoming.push(original); await run();
    const initialState = await state(), initialJournal = (await journal())[hash(initialId)];
    assert.equal(initialState.delivery_outbox[deliveryKey].source, 'engine');
    assert.equal(initialState.delivery_outbox[deliveryKey].status, 'pending');
    assert.equal(initialState.reply_deliveries[deliveryKey].acknowledgedChunks, 1);
    assert.equal(initialState.account_send_budget.remaining, 0);
    assert.equal(initialJournal.stage, 'completed'); assert.equal(initialJournal.delivery, 'pending');
    assert.equal(initialJournal.reply.text, originalReply);
    assert.equal(sent.length, 1); assert.equal(textOf(sent[0]), expectedChunks[0]);
    assert.equal((await readLines(nativeLog)).length, 1);
    assert.equal(unexpectedCalls.length, 0, 'Synthetic tool server received an unexpected route');
    assert.equal((await readFile(statePath, 'utf8')).includes(originalReply), false, 'Gateway reference state copied full engine response');

    // Both calls start a fresh Gateway process. A different chunk option and a
    // higher configured ceiling cannot reset an already exhausted user grant.
    await run('--poll-once', { budget: 100, maxChars: 7 });
    incoming.push(original); await run('--poll-once', { budget: 100, maxChars: 7 });
    assert.equal(sent.length, 1, 'Restart or replay bypassed exhausted grant');
    assert.equal((await readLines(nativeLog)).length, 1, 'Recovery reran original native turn');
    assert.equal((await state()).delivery_outbox[deliveryKey].source, 'engine');

    incoming.push(inbound(RENEW_TEXT, randomUUID()));
    await run('--poll-once', { budget: 100, maxChars: 1000 });
    const originalChunks = sent.map(textOf).filter(text => text !== RENEW_REPLY);
    assert.equal(originalChunks.join(''), displayedReply, 'Restart changed the authoritative original reply');
    assert.deepEqual(originalChunks, expectedChunks, 'Recovery changed frozen chunk boundaries');
    if (tool) assert.equal(originalChunks.join('').includes('SDK 最终原文'), false,
      'Native SDK text rewrote the authoritative Controller reply');
    assert.equal(sent.some(message => textOf(message) === RENEW_REPLY), true);
    assert.equal((await state()).delivery_outbox[deliveryKey], undefined);
    assert.equal((await journal())[hash(initialId)].delivery, 'accepted');
    const executions = await readLines(nativeLog);
    assert.equal(executions.filter(item => item.input === initialText).length, 1);
    assert.equal(executions.filter(item => item.input === RENEW_TEXT).length, 1);
    assert.equal(executions[1].resumed, true, 'New inbound abandoned saved SDK thread');
    assert.deepEqual(executions[0].methods, ['initialize', 'initialized', 'thread/start', 'turn/start']);
    assert.deepEqual(executions[1].methods, ['initialize', 'initialized', 'thread/resume', 'turn/start']);
    const fetches = await readLines(fetchLog);
    assert.equal(fetches.filter(item => item.path === '/v1/messages' && item.method === 'POST').length, 0);
    assert.equal(fetches.filter(item => item.path === '/v1/tools/call' && item.method === 'POST').length, tool ? 1 : 0);
    assert.equal(fetches.filter(item => item.path.startsWith('/v1/messages/') && item.method === 'GET').length, 0, 'Engine source incorrectly recovered through Controller GET');
    assert.equal(unexpectedCalls.length, 0, 'Synthetic tool server received an unexpected route');
    if (tool) assert.deepEqual(await readLines(toolLog), [{ input: initialText, sawControllerAck: true }]);
    const sentBeforeFinalRestart = sent.length; await run('--poll-once', { budget: 100 });
    assert.equal(sent.length, sentBeforeFinalRestart); assert.equal((await readLines(nativeLog)).length, 2);
    console.log(`PASS ${tool ? 'tool-backed exact Controller reply' : 'pure-chat final'} app-server transport: engine source, one original execution, exhausted-budget restart and replay blocked, true inbound resumes full rendered reply SHA ${hash(displayedReply)}, raw Markdown journal retained, accepted, zero Controller GET fallback`);
  }, [
    { label: 'synthetic SDK Gateway CLI', cleanup: () => stopTestProcess(child) },
    { label: 'synthetic HTTPS iLink', cleanup: () => closeServer(wechat) },
    { label: 'synthetic Controller HTTP tools', cleanup: () => closeServer(model) },
    { label: 'private SDK fixture files', cleanup: () => rm(directory, { recursive: true, force: true }) },
  ]).catch(error => { console.error('Controller diagnostic tail:', logs.join('').slice(-4000)); throw error; });
}
