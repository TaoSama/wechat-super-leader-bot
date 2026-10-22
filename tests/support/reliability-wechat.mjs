import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PROJECT_ROOT, verificationEnvironment } from '../../scripts/verify.mjs';
import { stopTestProcess, withTestCleanup } from './cleanup.mjs';

const REQUEST_LIMIT_BYTES = 64 * 1024;
const PROCESS_TIMEOUT_MS = 30_000;
const OPENSSL_TIMEOUT_MS = 10_000;
const PROCESS_GROUP_STOP_MS = 5_000;
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
  const sdkLogPath = join(dir, 'sdk-processes.jsonl'), sdkAuditPath = join(dir, 'sdk-spawn-audit.mjs');
  const incoming = [], sent = [], polls = [], errors = [], processes = [], faults = [], pollFaults = [], held = new Set();
  let active, lastOptions, offline = false;
  const record = value => {
    const item = { at: new Date().toISOString(), ...value };
    if (typeof evidence === 'function') evidence(item); else evidence.push(item);
  };
  const healthy = () => { if (errors.length) throw new AggregateError(errors, 'WeChat fixture handler failed'); };
  const cleanEnv = verificationEnvironment(env);
  // Observe the real Codex subprocess. Only auxiliary external MCP/telemetry are
  // disabled; the native executable, main model and bound control MCP stay real.
  await writeFile(sdkAuditPath, `import { createRequire, syncBuiltinESMExports } from 'node:module';
import { appendFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
const childProcess = createRequire(import.meta.url)('node:child_process');
const spawn = childProcess.spawn;
const record = item => appendFileSync(${JSON.stringify(sdkLogPath)}, JSON.stringify(item) + '\\n');
const MAX_RPC_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 1024;
function observeAppServer(child) {
  const pending = new Map();
  const decoders = { request: new StringDecoder('utf8'), response: new StringDecoder('utf8') };
  const buffers = { request: '', response: '' };
  const identity = params => Object.fromEntries(['threadId', 'expectedTurnId']
    .filter(key => typeof params?.[key] === 'string').map(key => [key, params[key]]));
  const auditError = reason => record({ event: 'rpc-audit-error', pid: child.pid, reason });
  function frame(direction, line) {
    let value;
    try { value = JSON.parse(line); }
    catch { auditError('Invalid JSON frame'); return; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { auditError('Invalid RPC object'); return; }
    if (direction === 'request' && typeof value.method === 'string') {
      if (value.id !== undefined) {
        if (pending.size >= MAX_PENDING_REQUESTS) { auditError('Pending request limit exceeded'); return; }
        pending.set(value.id, value.method);
      }
      record({ event: 'rpc-request', pid: child.pid, method: value.method, id: value.id,
        params: identity(value.params) });
    } else if (direction === 'response' && typeof value.method === 'string') {
      const params = value.params;
      record({ event: 'rpc-notification', pid: child.pid, method: value.method,
        threadId: params?.threadId ?? params?.thread?.id,
        turnId: params?.turnId ?? params?.turn?.id, status: params?.turn?.status ?? params?.status });
    } else if (direction === 'response' && value.id !== undefined) {
      const method = pending.get(value.id);
      pending.delete(value.id);
      record({ event: 'rpc-response', pid: child.pid, id: value.id, method,
        resultThreadId: value.result?.thread?.id,
        resultTurnId: value.result?.turn?.id ?? value.result?.turnId, errorCode: value.error?.code });
    }
  }
  function observe(direction, bytes, encoding) {
    const chunk = typeof bytes === 'string' ? Buffer.from(bytes, encoding) : bytes;
    buffers[direction] += decoders[direction].write(chunk);
    let newline;
    while ((newline = buffers[direction].indexOf('\\n')) >= 0) {
      const line = buffers[direction].slice(0, newline);
      buffers[direction] = buffers[direction].slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_RPC_FRAME_BYTES) auditError('RPC frame limit exceeded');
      else if (line.trim()) frame(direction, line);
    }
    if (Buffer.byteLength(buffers[direction]) > MAX_RPC_FRAME_BYTES) {
      auditError('RPC buffer limit exceeded'); buffers[direction] = '';
    }
  }
  const write = child.stdin.write;
  child.stdin.write = function(...args) {
    const result = write.apply(this, args);
    observe('request', args[0], typeof args[1] === 'string' ? args[1] : undefined);
    return result;
  };
  const onData = bytes => observe('response', bytes);
  child.stdout.on('data', onData);
  child.once('close', () => {
    child.stdin.write = write;
    child.stdout.removeListener('data', onData);
    pending.clear(); buffers.request = ''; buffers.response = '';
  });
}
childProcess.spawn = function(file, args, options) {
  const native = /(?:^|[/\\\\])codex(?:\\.exe)?$/.test(String(file));
  const [command, ...nativeArgs] = args;
  const forwarded = native ? [command, '--config', 'mcp_servers.openaiDeveloperDocs.enabled=false',
    '--config', 'analytics.enabled=false', '--config', 'feedback.enabled=false',
    '--config', 'check_for_update_on_startup=false', ...nativeArgs] : args;
  const child = spawn.call(this, file, forwarded, options);
  if (native) {
    record({ event: 'spawn', pid: child.pid, executable: String(file), cwd: options?.cwd, transport: command });
    if (command === 'app-server') observeAppServer(child);
    child.stderr.on('data', bytes => {
      let text = bytes.toString();
      for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'LEADER_TURN_MCP_TOKEN']) {
        if (options?.env?.[name]) text = text.replaceAll(options.env[name], '[synthetic-secret]');
      }
      record({ event: 'stderr', pid: child.pid, text });
    });
    child.once('exit', (code, signal) => record({ event: 'exit', pid: child.pid, code, signal }));
    child.once('error', error => record({ event: 'error', pid: child.pid, code: error.code, message: error.message }));
  }
  return child;
};
syncBuiltinESMExports();
`, { mode: 0o600 });
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
        const faultIndex = pollFaults.findIndex(fault => polls.length >= fault.afterPolls);
        if (faultIndex >= 0) {
          const [fault] = pollFaults.splice(faultIndex, 1);
          held.add(response); response.once('close', () => held.delete(response));
          fault.response = response;
          fault.value = { ret: 0, get_updates_buf: `${CURSOR_PREFIX}${incoming.length}`, msgs: messages };
          fault.enter({ cursor, count: messages.length });
          return;
        }
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
      mode = '--run', pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
      pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS, sendBudget, contextWindowMs, maxChars, extraArgs = [],
      leaderMode = 'controller', leaderRoot = join(dir, 'leader'), leaderModel,
      sdkBaseUrl, sdkApiKey } = options;
    const args = [...(leaderMode === 'codex' ? ['--import', sdkAuditPath] : []),
      'gateway/dist/index.js', mode, '--leader-mode', leaderMode, '--controller-url', controllerUrl,
      '--credentials-path', accountPath, '--state-path', statePath, '--health-path', healthPath,
      '--wechat-base-url', url, '--poll-interval-ms', String(pollIntervalMs), '--poll-timeout-ms', String(pollTimeoutMs)];
    if (leaderMode === 'codex') {
      assert(sdkBaseUrl?.startsWith('http://127.0.0.1:') && sdkApiKey, 'SDK fixture requires its own local model and synthetic key');
      args.push('--leader-root', leaderRoot, '--leader-model', leaderModel);
    }
    for (const [flag, value] of [['--send-budget', sendBudget], ['--context-window-ms', contextWindowMs], ['--max-chars', maxChars]]) {
      if (value !== undefined) args.push(flag, String(value));
    }
    args.push(...extraArgs);
    const processGroup = leaderMode === 'codex' && process.platform !== 'win32';
    const child = spawn(process.execPath, args, { cwd: PROJECT_ROOT, detached: processGroup,
      env: { ...cleanEnv, CONTROLLER_TOKEN: controllerToken, NODE_EXTRA_CA_CERTS: certificate,
        ...(leaderMode === 'codex' ? { GATEWAY_LEADER_API_KEY: sdkApiKey, GATEWAY_LEADER_BASE_URL: sdkBaseUrl } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'] });
    const running = { child, processGroup, stdout: '', stderr: '' };
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
  function groupAlive(running) {
    if (!running.processGroup || running.groupCleaned || !running.child.pid) return false;
    const output = execFileSync('ps', ['-axo', 'pid=,pgid=,stat='], { encoding: 'utf8', timeout: PROCESS_GROUP_STOP_MS });
    running.groupMembers = output.trim().split('\n').map(line => line.trim().split(/\s+/))
      .filter(([, group]) => Number(group) === running.child.pid)
      .map(([pid, , state]) => ({ pid: Number(pid), state }));
    if (running.groupMembers.length) return true;
    running.groupCleaned = true;
    return false;
  }
  function signalGroup(running, signal) {
    try { process.kill(-running.child.pid, signal); }
    catch (error) {
      if (error.code === 'ESRCH') { running.groupCleaned = true; return; }
      if (error.code === 'EPERM' && (!groupAlive(running) || running.groupMembers.every(item => item.state.startsWith('Z')))) {
        record({ event: 'sdk.process-group-reaping', groupId: running.child.pid, members: running.groupMembers });
        return;
      }
      throw error;
    }
  }
  async function stopGroup(running, signal = 'SIGTERM') {
    if (!groupAlive(running)) return;
    signalGroup(running, signal);
    for (const force of [false, true]) {
      const end = Date.now() + PROCESS_GROUP_STOP_MS;
      while (groupAlive(running) && Date.now() < end) await delay(DEFAULT_POLL_INTERVAL_MS);
      if (!groupAlive(running)) {
        record({ event: 'sdk.process-group-cleaned', groupId: running.child.pid });
        return;
      }
      if (!force) signalGroup(running, 'SIGKILL');
    }
    throw new Error('Owned SDK process group remained after forced cleanup');
  }
  async function stop(running = active) {
    if (!running) return;
    await withTestCleanup(() => stopTestProcess(running.child), [
      { label: 'owned SDK process group', cleanup: () => stopGroup(running) },
      { label: 'Gateway output pipes', cleanup: () => deadline(running.done, 'Gateway stop') },
    ]);
  }
  async function kill(running = active) {
    if (!running) return;
    if (running.child.exitCode === null && running.child.signalCode === null) {
      if (running.processGroup) signalGroup(running, 'SIGKILL');
      else assert(running.child.kill('SIGKILL'));
    }
    try { return await deadline(running.done, 'Gateway crash'); }
    finally { await stopGroup(running, 'SIGKILL'); }
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
  function holdPoll({ afterPolls = polls.length + 1 } = {}) {
    let enter;
    const entered = new Promise(resolve => { enter = resolve; });
    const fault = { afterPolls, enter, entered,
      release() { assert(fault.response); json(fault.response, fault.value); },
      drop() { assert(fault.response); fault.response.destroy(); } };
    pollFaults.push(fault);
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
  return { url, accountPath, statePath, healthPath, sdkLogPath, certificate, incoming, sent, polls, errors, processes, start, runOnce, stop, kill, close, nextSendFault, holdPoll,
    async readSdkProcesses() {
      try { return (await readFile(sdkLogPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    },
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
