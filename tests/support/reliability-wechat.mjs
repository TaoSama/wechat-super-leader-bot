import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PROJECT_ROOT, verificationEnvironment } from '../../scripts/verify.mjs';
import { stopTestProcess } from './cleanup.mjs';

const REQUEST_LIMIT_BYTES = 64 * 1024;
const PROCESS_TIMEOUT_MS = 30_000;
const OPENSSL_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
const DEFAULT_POLL_TIMEOUT_MS = 100;
const WECHAT_TOKEN = 'synthetic-reliability-wechat-token';
const DEFAULT_CHAT = 'synthetic-reliability-chat';
const CURSOR_PREFIX = 'synthetic-cursor-';

async function body(request) {
  const chunks = []; let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    assert(bytes <= REQUEST_LIMIT_BYTES, 'iLink fixture request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function json(response, value) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}
async function deadline(promise, label, timeoutMs = PROCESS_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

// This endpoint retains the source log until its caller commits the returned
// cursor. Repeating an old cursor therefore really redelivers the same inbound.
export async function createWechatFixture({ dir, env = verificationEnvironment(), evidence = [] }) {
  await mkdir(dir, { recursive: true });
  const certificate = join(dir, 'wechat-cert.pem'), key = join(dir, 'wechat-key.pem');
  const config = join(dir, 'wechat-openssl.cnf');
  const accountPath = join(dir, 'wechat-account.json'), statePath = join(dir, 'wechat-state.json');
  const healthPath = join(dir, 'wechat-health.json');
  const incoming = [], sent = [], polls = [], errors = [], processes = [], faults = [], held = new Set();
  let active, lastOptions, offline = false;
  const record = value => {
    const item = { at: new Date().toISOString(), ...value };
    if (typeof evidence === 'function') evidence(item); else evidence.push(item);
  };
  const healthy = () => { if (errors.length) throw new AggregateError(errors, 'WeChat fixture handler failed'); };
  const cleanEnv = verificationEnvironment(env);
  await writeFile(config, '[req]\ndistinguished_name=dn\n[dn]\n[v3]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n', { mode: 0o600 });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-sha256',
    '-subj', '/CN=127.0.0.1', '-config', config, '-extensions', 'v3', '-keyout', key, '-out', certificate],
  { env: cleanEnv, timeout: OPENSSL_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  const server = createServer({ key: await readFile(key), cert: await readFile(certificate) }, (request, response) => {
    void (async () => {
      if (offline) { response.destroy(); return; }
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.authorization, `Bearer ${WECHAT_TOKEN}`);
      assert.equal(request.headers.authorizationtype, 'ilink_bot_token');
      const input = await body(request);
      if (request.url === '/ilink/bot/getupdates') {
        const cursor = input.get_updates_buf || `${CURSOR_PREFIX}0`;
        assert.match(cursor, /^synthetic-cursor-\d+$/);
        const offset = Number(cursor.slice(CURSOR_PREFIX.length));
        assert(offset <= incoming.length, 'cursor exceeds retained iLink log');
        const messages = incoming.slice(offset);
        polls.push({ cursor, count: messages.length });
        record({ event: 'wechat.poll', cursor, count: messages.length });
        json(response, { ret: 0, get_updates_buf: `${CURSOR_PREFIX}${incoming.length}`, msgs: messages });
        return;
      }
      if (request.url === '/ilink/bot/getconfig') { json(response, { ret: 0, typing_ticket: 'synthetic-reliability-ticket' }); return; }
      if (request.url === '/ilink/bot/sendtyping') { json(response, { ret: 0 }); return; }
      assert.equal(request.url, '/ilink/bot/sendmessage');
      assert.equal(input.msg.message_type, 2); assert.equal(input.msg.message_state, 2);
      sent.push(input.msg);
      record({ event: 'wechat.send', index: sent.length - 1, clientId: input.msg.client_id,
        chatId: input.msg.to_user_id, text: input.msg.item_list?.[0]?.text_item?.text });
      const fault = faults.shift();
      if (fault) {
        fault.enter(input.msg);
        if (fault.type === 'drop') { response.destroy(); return; }
        if (fault.type === 'reject') { json(response, { ret: -1, errcode: -1 }); return; }
        held.add(response);
        response.once('close', () => held.delete(response));
        fault.response = response;
        return;
      }
      json(response, { ret: 0 });
    })().catch(error => {
      errors.push(error);
      if (!response.destroyed && !response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  const url = `https://127.0.0.1:${server.address().port}`;
  await writeFile(accountPath, JSON.stringify({ token: WECHAT_TOKEN, accountId: 'synthetic-reliability-account', baseUrl: url }), { mode: 0o600 });

  function start(options = {}) {
    healthy();
    assert(!active || active.child.exitCode !== null || active.child.signalCode !== null, 'Gateway fixture already running');
    lastOptions = { ...options };
    const { controllerUrl = 'http://127.0.0.1:1', controllerToken = env.CONTROLLER_TOKEN || 'synthetic-reliability-controller-token',
      notifications = false, mode = '--run', pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
      pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS, sendBudget, contextWindowMs, maxChars, extraArgs = [] } = options;
    const args = ['gateway/dist/index.js', mode, '--leader-mode', 'controller', '--controller-url', controllerUrl,
      '--credentials-path', accountPath, '--state-path', statePath, '--health-path', healthPath,
      '--wechat-base-url', url, '--poll-interval-ms', String(pollIntervalMs), '--poll-timeout-ms', String(pollTimeoutMs)];
    if (notifications) args.push('--notifications');
    for (const [flag, value] of [['--send-budget', sendBudget], ['--context-window-ms', contextWindowMs], ['--max-chars', maxChars]]) {
      if (value !== undefined) args.push(flag, String(value));
    }
    args.push(...extraArgs);
    const child = spawn(process.execPath, args, { cwd: PROJECT_ROOT,
      env: { ...cleanEnv, CONTROLLER_TOKEN: controllerToken, NODE_EXTRA_CA_CERTS: certificate }, stdio: ['ignore', 'pipe', 'pipe'] });
    const running = { child, stdout: '', stderr: '' };
    child.stdout.setEncoding('utf8').on('data', chunk => { running.stdout += chunk; record({ event: 'gateway.output', stream: 'stdout', text: chunk }); });
    child.stderr.setEncoding('utf8').on('data', chunk => { running.stderr += chunk; record({ event: 'gateway.output', stream: 'stderr', text: chunk }); });
    running.done = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        record({ event: 'gateway.exit', pid: child.pid, mode, code, signal });
        resolve({ code, signal, stdout: running.stdout, stderr: running.stderr });
      });
    });
    // A spawn failure must remain visible even if the caller is waiting on a shim event.
    running.done.catch(error => { errors.push(error); });
    active = running; processes.push(running);
    record({ event: 'gateway.spawn', pid: child.pid, mode });
    return running;
  }
  async function stop(running = active) {
    if (!running) return;
    await stopTestProcess(running.child);
    await deadline(running.done, 'Gateway stop');
  }
  async function kill(running = active) {
    if (!running) return;
    if (running.child.exitCode === null && running.child.signalCode === null) assert(running.child.kill('SIGKILL'));
    return deadline(running.done, 'Gateway crash');
  }
  async function runOnce(options = {}) {
    const running = start({ ...options, mode: '--poll-once' });
    try { return await deadline(running.done, 'Gateway poll once', options.timeoutMs); }
    finally { await stop(running); healthy(); }
  }
  async function close() {
    const failures = [];
    for (const running of processes) { try { await stop(running); } catch (error) { failures.push(error); } }
    for (const response of held) response.destroy();
    if (server.listening) {
      try {
        await deadline(new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          server.closeAllConnections();
        }), 'WeChat HTTPS close');
      } catch (error) { failures.push(error); }
    }
    if (failures.length) throw new AggregateError(failures, 'WeChat fixture cleanup failed');
    healthy();
  }
  function nextSendFault(type = 'hold') {
    assert(['hold', 'drop', 'reject'].includes(type));
    let enter;
    const entered = new Promise(resolve => { enter = resolve; });
    const fault = { type, enter, entered,
      release(value = { ret: 0 }) { assert(fault.response, 'send has not entered hold'); json(fault.response, value); },
      drop() { assert(fault.response, 'send has not entered hold'); fault.response.destroy(); } };
    faults.push(fault);
    return fault;
  }
  try {
    const baseline = start({ mode: '--establish-baseline' });
    const result = await deadline(baseline.done, 'Gateway baseline');
    assert.equal(result.code, 0, result.stderr);
    healthy();
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'WeChat fixture initialization failed'); }
    throw error;
  }
  return { url, accountPath, statePath, healthPath, certificate, incoming, sent, polls, errors, processes, start, runOnce, stop, kill, close, nextSendFault,
    healthy, readState: async () => JSON.parse(await readFile(statePath, 'utf8')),
    setOffline(value) { offline = Boolean(value); record({ event: 'wechat.offline', value: offline }); },
    async restart(options = lastOptions) { await stop(); return start(options); },
    async waitFor(condition, label, timeoutMs = PROCESS_TIMEOUT_MS) {
      const end = Date.now() + timeoutMs;
      while (!await condition()) {
        healthy();
        if (Date.now() >= end) throw new Error(`Timed out: ${label}`);
        await delay(DEFAULT_POLL_INTERVAL_MS);
      }
      healthy();
    },
    enqueue(text, { id = randomUUID(), chatId = DEFAULT_CHAT, createdAtMs = Date.now(), contextToken = `synthetic-context:${chatId}` } = {}) {
      const message = { message_type: 1, from_user_id: chatId, client_id: id, context_token: contextToken,
        create_time_ms: createdAtMs, item_list: [{ type: 1, text_item: { text } }] };
      incoming.push(message);
      record({ event: 'wechat.enqueue', id, chatId });
      return message;
    } };
}
