import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { verificationEnvironment } from '../../../scripts/verify.mjs';
import { createControllerFixture, waitFor } from '../../support/control-plane-fixture.mjs';
import { closeTestWebSocket, stopTestProcess, withTestCleanup } from '../../support/cleanup.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ACCOUNT = 'synthetic-latency-account';
const CHAT = 'latency-private-chat';
const NODE = 'fixture-machine';
const CONTEXT = 'latency-private-context';
const MODEL_KEY = 'latency-private-model-secret';
const ILINK_KEY = 'latency-private-ilink-secret';
const FINAL = 'latency-private-model-final-must-be-replaced';
const HTTP_MS = 5_000;
const PROCESS_MS = 30_000;
const MODEL_DELAY_MS = 80;
const CHUNK_CHARS = 72;
const MAX_DIAGNOSTIC_CHARS = 160;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const { values } = parseArgs({ options: { run: { type: 'boolean' }, 'direct-directory': { type: 'boolean' }, 'direct-console': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' } } });
const DIRECT_DIRECTORY = values['direct-directory'] ?? false;
const DIRECT_CONSOLE = values['direct-console'] ?? false;
assert(!(DIRECT_DIRECTORY && DIRECT_CONSOLE), 'Choose only one direct mode');
const DIRECT = DIRECT_DIRECTORY || DIRECT_CONSOLE;
const QUERIES = DIRECT_CONSOLE ? ['给我控制端链接', '控制台链接'] : DIRECT_DIRECTORY ? ['看一下我当前有哪些会话', '会话列表']
  : ['列出所有会话 latency-private-first-query', '再列出全部会话 latency-private-second-query'];
if (!values.run || values.help) {
  console.log('Usage: node tests/integration/leader/message-latency.mjs --run [--direct-directory | --direct-console]\n--direct-console verifies one-time console login issuance and durable delivery without SDK or model HTTP calls.\n--direct-directory uses the actual Codex reply engine and verifies plain session lists bypass both SDK and model HTTP calls.\nRequires built Controller/Gateway, installed controller dependencies, Node >=24 and OpenSSL. Runs actual CLI processes with a loopback synthetic Responses model, HTTPS iLink, authenticated WSS daemon inventory and private temporary state. Verifies two-message batch timing, cross-service trace linkage, Project/status sorting, API-accepted chunk receipts and log privacy. No production endpoints, credentials or native sessions are used.');
} else {
  await verifyMessageLatency().catch(error => { console.error(error); process.exitCode = 1; });
}

async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port;
}
async function closeServer(server) {
  if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function jsonBody(request) {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function respond(response, body) {
  response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(body));
}
function latencyEvents(output) {
  return output.split('\n').filter(line => line.startsWith('{"schema":1,'))
    .map(line => {
      try { return JSON.parse(line); }
      catch (cause) { throw new Error(`Malformed latency event: ${line.slice(0, MAX_DIAGNOSTIC_CHARS)}`, { cause }); }
    }).filter(event => event.event === 'message_latency');
}

export async function verifyMessageLatency() {
  const require = createRequire(new URL('../../../controller/package.json', import.meta.url));
  const { WebSocket } = require('ws');
  const env = verificationEnvironment(), token = randomUUID(), nodeToken = randomUUID();
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'super-leader-latency-'));
  const accountPath = join(directory, 'account.json'), statePath = join(directory, 'state.json');
  const certPath = join(directory, 'cert.pem'), keyPath = join(directory, 'key.pem'), preloadPath = join(directory, 'local-fetch.mjs');
  const errors = [], incoming = [], sent = [], requests = [], tunnels = new Set();
  const messageIds = [randomUUID(), randomUUID()];
  let controller, model, wechat, socket, gatewayChild, cursor = 0, controllerOutput = '', gatewayOutput = '';
  const healthy = () => { if (errors.length) throw errors[0]; };
  // Keep full evidence while the shared fixture retains its bounded diagnostic tail.
  class Logs extends Array {
    push(...chunks) { controllerOutput += chunks.join(''); return super.push(...chunks); }
  }
  await withTestCleanup(async () => {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-sha256',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', keyPath, '-out', certPath],
    { env, timeout: HTTP_MS, stdio: ['ignore', 'pipe', 'pipe'] });
    const cert = await readFile(certPath);
    model = createServer(async (request, response) => {
      try {
        assert.equal(request.url, '/v1/responses');
        assert.equal(request.headers.authorization, `Bearer ${MODEL_KEY}`);
        const body = await jsonBody(request);
        const latest = body.input.at(-1);
        const final = latest.type === 'function_call_output';
        requests.push({ final });
        if (final) {
          const listing = JSON.parse(latest.output);
          assert.equal(listing.sessions.length, 3, 'list_sessions dropped an observed session');
          assert.equal(listing.nextOffset, null, 'Small inventory unexpectedly requires pagination');
          respond(response, { status: 'completed', output: [{ type: 'message', role: 'assistant', status: 'completed',
            content: [{ type: 'output_text', text: FINAL }] }] });
        } else {
          assert.equal(latest.role, 'user'); assert(QUERIES.includes(latest.content));
          await delay(MODEL_DELAY_MS);
          respond(response, { status: 'completed', output: [{ type: 'function_call', status: 'completed',
            call_id: randomUUID(), name: 'list_sessions', arguments: '{}' }] });
        }
      } catch (error) { errors.push(error); response.writeHead(500); response.end(); }
    });
    const modelOrigin = `http://127.0.0.1:${await listen(model)}`;
    const cleared = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
    controller = await createControllerFixture({ logs: new Logs(), env: { ...cleared, ...env,
      PERSISTENCE_MODE: 'memory', CONTROLLER_TOKEN: token, NODE_TOKENS: JSON.stringify({ [NODE]: nodeToken }),
      ALLOWED_CHAT_IDS: CHAT, LEADER_MODE: 'model', LEADER_MODEL_BASE_URL: `${modelOrigin}/v1`,
      LEADER_MODEL_API_KEY: MODEL_KEY, LEADER_MODEL_NAME: 'fixture-model',
    } });
    wechat = createHttpsServer({ key: await readFile(keyPath), cert }, async (request, response) => {
      try {
        assert.equal(request.headers.authorization, `Bearer ${ILINK_KEY}`);
        const body = await jsonBody(request);
        if (request.url === '/ilink/bot/getupdates') {
          respond(response, { ret: 0, get_updates_buf: `fixture-cursor-${++cursor}`, msgs: incoming.splice(0) }); return;
        }
        if (request.url === '/ilink/bot/getconfig') { respond(response, { ret: 0, typing_ticket: 'fixture-ticket' }); return; }
        if (request.url === '/ilink/bot/sendtyping') { respond(response, { ret: 0 }); return; }
        assert.equal(request.url, '/ilink/bot/sendmessage');
        assert.equal(body.msg.to_user_id, CHAT); assert.equal(body.msg.context_token, CONTEXT);
        assert.equal(body.msg.item_list[0].type, 1);
        sent.push(body.msg); respond(response, { ret: 0, errcode: 0 });
      } catch (error) { errors.push(error); response.writeHead(500); response.end(); }
    });
    // TLS is terminated only by this loopback fixture; upgrade bytes reach the actual Controller WS handler.
    wechat.on('upgrade', (request, downstream, head) => {
      if (request.url !== '/v1/daemon') { downstream.destroy(); errors.push(new Error('Unexpected fixture WS path')); return; }
      const upstream = connect(controller.port, '127.0.0.1');
      for (const connection of [upstream, downstream]) {
        tunnels.add(connection);
        connection.on('close', () => tunnels.delete(connection));
        connection.on('error', error => { errors.push(error); upstream.destroy(); downstream.destroy(); });
      }
      upstream.once('connect', () => {
        const headers = Object.entries(request.headers).flatMap(([name, value]) =>
          (Array.isArray(value) ? value : [value]).map(item => `${name}: ${item}`));
        upstream.write(`GET /v1/daemon HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`);
        if (head.length) upstream.write(head);
        upstream.pipe(downstream).pipe(upstream);
      });
    });
    const ilinkOrigin = `https://127.0.0.1:${await listen(wechat)}`;
    const allowedOrigins = [controller.base, ilinkOrigin, modelOrigin];
    await writeFile(preloadPath, `const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (!${JSON.stringify(allowedOrigins)}.includes(new URL(String(input)).origin)) throw new Error('Fixture blocked external fetch');
  return original(input, init);
};\n`, { mode: 0o600 });
    controller.env.NODE_OPTIONS = `--import=${JSON.stringify(preloadPath)}`;
    await controller.start();
    socket = new WebSocket(`${ilinkOrigin.replace('https:', 'wss:')}/v1/daemon`, {
      ca: cert, headers: { authorization: `Bearer ${nodeToken}` },
    });
    socket.on('error', error => errors.push(error)); await once(socket, 'open');
    const now = Date.now();
    const sessions = [
      { id: 'fixture-a', title: 'Alpha完整会话', cwd: '/fixture/project-alpha', status: 'idle', updatedAt: new Date(now - 2_000).toISOString() },
      { id: 'fixture-z-old', title: 'Zulu较早会话', cwd: '/fixture/project-zulu', status: 'active', updatedAt: new Date(now - 3_000).toISOString() },
      { id: 'fixture-z-new', title: 'Zulu最近会话', cwd: '/fixture/project-zulu', status: 'idle', updatedAt: new Date(now - 1_000).toISOString() },
    ].map(item => ({ ...item, provider: 'codex-app', capabilities: ['read'], loaded: true,
      observedAt: new Date(now).toISOString(), model: 'fixture-model' }));
    socket.send(JSON.stringify({ type: 'hello', version: 1, nodeId: NODE, sessions, skills: [] }));
    await waitFor(async () => {
      healthy(); return (await controller.request('/v1/status')).body.sessions?.length === 3;
    }, 'authenticated WSS inventory');
    await writeFile(accountPath, JSON.stringify({ accountId: ACCOUNT, token: ILINK_KEY, baseUrl: ilinkOrigin }), { mode: 0o600 });
    const runGateway = async mode => {
      healthy(); let output = '', stderr = '';
      gatewayChild = spawn(process.execPath, ['--import', preloadPath, 'gateway/dist/index.js', mode,
        '--controller-url', controller.base, '--credentials-path', accountPath, '--state-path', statePath,
        '--leader-mode', DIRECT ? 'codex' : 'controller',
        '--leader-root', join(directory, 'leader'), '--leader-model', 'fixture-model', '--max-chars', String(CHUNK_CHARS)], {
        cwd: ROOT, env: { ...env, CONTROLLER_TOKEN: token, NODE_EXTRA_CA_CERTS: certPath, GATEWAY_SEND_BUDGET: '100',
          GATEWAY_LEADER_API_KEY: MODEL_KEY, GATEWAY_LEADER_BASE_URL: `${modelOrigin}/v1`,
          ...(DIRECT ? { GATEWAY_CODEX_PATH: join(directory, 'native-cli-must-not-run') } : {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      gatewayChild.stdout.on('data', bytes => { output += bytes; });
      gatewayChild.stderr.on('data', bytes => { stderr += bytes; });
      const timeout = setTimeout(() => {
        errors.push(new Error('Latency Gateway CLI timeout')); gatewayChild.kill('SIGTERM');
      }, PROCESS_MS);
      let exit;
      try { [exit] = await once(gatewayChild, 'exit'); } finally { clearTimeout(timeout); }
      gatewayChild = undefined; gatewayOutput += output + stderr; healthy();
      assert.equal(exit, 0, `Actual Gateway CLI failed: ${stderr}${output}`);
      return latencyEvents(output + '\n' + stderr);
    };
    await runGateway('--establish-baseline');
    incoming.push(...QUERIES.map((text, index) => ({ message_type: 1, from_user_id: CHAT, client_id: messageIds[index],
      create_time_ms: Date.now() - 300 + index, context_token: CONTEXT, item_list: [{ type: 1, text_item: { text } }] })));
    const gatewayEvents = await runGateway('--poll-once');
    const controllerEvents = latencyEvents(controllerOutput);
    const expectedReply = `已观测会话：\n\nproject-zulu（${NODE}）\n1. [闲] Zulu最近会话\n` +
      `2. [忙] Zulu较早会话\n\nproject-alpha（${NODE}）\n3. [闲] Alpha完整会话\n\n仅展示在线节点已观测的会话。`;
    const delivered = sent.map(message => message.item_list[0].text_item.text).join('');
    const consoleTokens = [...delivered.matchAll(/#login=([A-Za-z0-9_.~%-]+)/gu)].map(match => match[1]);
    if (DIRECT_CONSOLE) {
      assert.equal(consoleTokens.length, 2, 'Both direct console messages need a real issued link');
      assert.notEqual(consoleTokens[0], consoleTokens[1]);
      assert(delivered.includes(`${controller.base}/#login=`));
      const journal = await readFile(join(directory, 'leader', hash([ACCOUNT, CHAT]), '.replies.json'), 'utf8');
      for (const token of consoleTokens) assert(!journal.includes(token), 'Console token persisted in native reply journal');
      assert(Object.values(JSON.parse(journal)).every(entry => entry.provenance === 'controller-console'));
    } else {
      assert.equal(delivered, expectedReply.repeat(2),
        'Actual WeChat content lost Project/status grouping, update ordering or an original title');
    }
    assert(sent.length > 2, 'Fixture did not exercise multipart API delivery');
    assert.equal(requests.length, DIRECT ? 0 : 4);
    assert.equal(requests.filter(request => request.final).length, DIRECT ? 0 : 2);
    const traceIds = messageIds.map(messageId => hash([CHAT, messageId]));
    const received = gatewayEvents.filter(event => event.stage === 'message.received');
    const processing = gatewayEvents.filter(event => event.stage === 'message.processing.start');
    assert.deepEqual(received.map(event => event.traceId), traceIds);
    assert.equal(received[0].batchId, received[1].batchId);
    assert.deepEqual(received.map(event => event.batchIndex), [0, 1]);
    assert(gatewayEvents.indexOf(received[1]) < gatewayEvents.indexOf(processing[0]), 'Second inbound was observed after first processing');
    assert(processing[1].batchWaitMs >= (DIRECT ? 0 : MODEL_DELAY_MS),
      'Second-message batch wait is missing or understated');
    for (const traceId of traceIds) {
      const gatewayTrace = gatewayEvents.filter(event => event.traceId === traceId);
      const controllerTrace = controllerEvents.filter(event => event.traceId === traceId);
      assert(controllerTrace.length, 'Controller trace cannot be correlated by stable hashed message identity');
      assert(controllerTrace.every(event => event.parentAttemptId === gatewayTrace[0].attemptId && event.attemptId !== event.parentAttemptId));
      const controllerStages = DIRECT
        ? ['controller.received', 'controller.tools.list.end', 'controller.tools.call.end', 'controller.response.finish']
        : ['controller.received', 'controller.dedupe.end', 'controller.leader.end', 'controller.persist.end',
          'controller.response.finish', 'model.complete.end', 'model.http.headers.end', 'model.http.body.end', 'model.http.parse.end'];
      for (const stage of controllerStages) {
        assert(controllerTrace.some(event => event.stage === stage), `Missing Controller stage: ${stage}`);
      }
      if (DIRECT) {
        assert(gatewayTrace.some(event => event.stage === (DIRECT_CONSOLE ? 'codex.console.controller.end' : 'codex.directory.controller.end') && event.outcome === 'ok'),
          'Plain directory did not reach Controller through the Codex reply engine fast path');
        assert(controllerTrace.some(event => event.stage === 'leader.tool.end' && event.tool === (DIRECT_CONSOLE ? 'get_console_link' : 'list_sessions') &&
          event.source === 'direct' && event.outcome === 'ok'), 'Controller did not use the direct inventory tool');
        assert(!controllerTrace.some(event => event.stage.startsWith('model.')), 'Plain directory invoked the Controller model');
        assert(!gatewayTrace.some(event => event.stage.startsWith('codex.stream.')), 'Plain directory invoked the native SDK stream');
      }
      assert(gatewayTrace.some(event => event.stage === 'wechat.chunk.accepted'));
      assert(gatewayTrace.some(event => event.stage === 'wechat.send.accepted'));
      assert(gatewayTrace.some(event => event.stage === 'delivery.end' && event.receiptStatus === 'wechat_api_accepted'));
      assert(gatewayTrace.some(event => event.stage === 'message.processing.end' && event.outcome === 'processed'));
    }
    const allLogs = controllerOutput + gatewayOutput;
    for (const privateValue of [CHAT, CONTEXT, token, nodeToken, MODEL_KEY, ILINK_KEY, FINAL, ...QUERIES, ...messageIds,
      ...sessions.map(session => session.title), ...consoleTokens]) assert(!allLogs.includes(privateValue), 'Synthetic content or secret leaked into CLI logs');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(Object.keys(state.delivery_outbox).length, 0);
    assert.equal(Object.values(state.reply_deliveries).filter(delivery => !delivery.inFlight && delivery.acknowledgedChunks === delivery.totalChunks).length, 2);
    healthy();
    console.log(JSON.stringify({ result: 'PASS', scenario: DIRECT_CONSOLE ? 'actual-cli-direct-console-latency' : DIRECT_DIRECTORY ? 'actual-cli-direct-directory-latency' : 'actual-cli-message-latency', messages: 2, projects: 2,
      transport: 'HTTPS iLink + authenticated WSS', modelHttpRequests: requests.length, direct: DIRECT, processingMs: traceIds.map(traceId => gatewayEvents.find(event => event.traceId === traceId && event.stage === 'message.processing.end').elapsedMs), sentChunks: sent.length,
      secondBatchWaitMs: processing[1].batchWaitMs, gatewayEvents: gatewayEvents.length,
      controllerEvents: controllerEvents.length, receivedBeforeProcessing: true, correlatedAttempts: 2,
      receipts: 'wechat_api_accepted', privacy: 'no input/output bodies, original IDs or secrets in CLI logs',
      coverage: 'loopback synthetic runtime; API acceptance does not measure phone receipt' }));
  }, [
    { label: 'latency Gateway CLI', cleanup: () => stopTestProcess(gatewayChild) },
    { label: 'authenticated WSS daemon', cleanup: () => closeTestWebSocket(socket) },
    { label: 'TLS upgrade tunnels', cleanup: () => { for (const tunnel of tunnels) tunnel.destroy(); } },
    { label: 'Controller CLI', cleanup: () => controller?.stop() },
    { label: 'HTTPS iLink fixture', cleanup: () => closeServer(wechat) },
    { label: 'synthetic Responses model', cleanup: () => closeServer(model) },
    { label: 'private latency fixture state', cleanup: () => rm(directory, { recursive: true, force: true }) },
  ]);
}
