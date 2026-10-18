import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HELP = `Usage: node tests/live/agent-memory.mjs --run [--evidence PATH] [--tls-key PATH --tls-cert PATH] [--gateway-cli PATH]
Runs the real built Gateway CLI and Codex model in fresh child processes.
Requires GATEWAY_LEADER_API_KEY; optional GATEWAY_LEADER_BASE_URL, GATEWAY_LEADER_MODEL,
GATEWAY_CODEX_PATH. Build gateway first. No existing WeChat credentials are read.
WeChat and Controller are synthetic loopback HTTPS services, never real dispatch targets.
Default TLS certificate is generated with openssl; supplied certificates must cover 127.0.0.1.
Evidence contains only synthetic markers, check results and bounded reply summaries.
Without --run, prints this help without calling a model.`;
const { values } = parseArgs({ strict: true, allowPositionals: false, options: {
  help: { type: 'boolean', short: 'h' }, run: { type: 'boolean' },
  evidence: { type: 'string' }, 'tls-key': { type: 'string' }, 'tls-cert': { type: 'string' },
  'gateway-cli': { type: 'string' },
} });
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const GATEWAY_CLI = values['gateway-cli'] ? resolve(values['gateway-cli']) : join(ROOT, 'gateway/dist/index.js');
const CHILD_TIMEOUT_MS = 360000;
const FIXTURE_TOKEN = 'synthetic-memory-verification-token';
const CHAT = 'synthetic-agent-memory';
const ACCOUNT = 'synthetic-agent-memory-account';
const children = new Set();
const childDiagnostics = [];

if (values.help || !values.run) console.log(HELP);
else await main().catch(error => {
  // Never print provider output, request headers or the inherited environment.
  console.error(`Agent memory verification failed: ${error.message}`);
  process.exitCode = 1;
});

async function execute(command, args, env, label) {
  const child = spawn(command, args, { cwd: ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-65536); });
  // Drain stderr without printing potentially sensitive SDK/provider diagnostics.
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65536); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; terminate(child); }, CHILD_TIMEOUT_MS);
  try {
    const [code] = await once(child, 'close');
    assert(!timedOut, `${label} timed out; no retry was attempted`);
    const classification = stderr.match(/\[gateway\] fatal: ([A-Za-z]+)(?:\r?\n|$)/)?.[1] || 'diagnostic-withheld';
    childDiagnostics.push({ label, exitCode: code, classification, hints: diagnosticKinds(stderr) });
    assert.equal(code, 0, `${label} failed (exit ${code}; ${classification}); provider output withheld`);
    return stdout;
  } finally {
    clearTimeout(timer);
    terminate(child);
    children.delete(child);
  }
}

function terminate(child) {
  if (!child.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw new Error('Unable to stop verification process group'); }
}

async function main() {
  assert(process.env.GATEWAY_LEADER_API_KEY?.trim(), 'GATEWAY_LEADER_API_KEY is required');
  assert(Boolean(values['tls-key']) === Boolean(values['tls-cert']), 'Supply both --tls-key and --tls-cert');
  await readFile(GATEWAY_CLI);
  // macOS /var is a symlink; the production workspace deliberately rejects symlink ancestors.
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'super-leader-agent-memory-')));
  const leaderRoot = join(directory, 'leader');
  const keyDigest = createHash('sha256').update(JSON.stringify([ACCOUNT, CHAT])).digest('hex');
  const workspace = join(leaderRoot, keyDigest);
  const credentials = join(directory, 'synthetic-account.json');
  const state = join(directory, 'gateway-state.json');
  const marker = randomUUID().replaceAll('-', '');
  const markers = { preference: `PREF_${marker}`, task: `TASK_${marker}`,
    memory: `FACT_${marker}`, controller: `CONTROL_${marker}` };
  const evidence = { outcome: 'RUNNING', markers, model: process.env.GATEWAY_LEADER_MODEL || 'gpt-6.1-sol', checks: [] };
  const queue = [];
  const replies = [];
  const forwarded = [];
  const unexpected = [];
  let server;
  try {
    let key = values['tls-key'] && resolve(values['tls-key']);
    let cert = values['tls-cert'] && resolve(values['tls-cert']);
    if (!key) {
      key = join(directory, 'tls-key.pem');
      cert = join(directory, 'tls-cert.pem');
      await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert],
      { PATH: process.env.PATH }, 'TLS fixture generation');
    }
    server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
      void serve(request, response).catch(() => {
        unexpected.push('fixture-handler-error');
        if (!response.headersSent) response.writeHead(500);
        response.end();
      });
    });
    async function serve(request, response) {
      assert.equal(request.headers.authorization, `Bearer ${FIXTURE_TOKEN}`, 'Unexpected fixture credential');
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        assert(raw.length <= 65536, 'Fixture request too large');
      }
      const body = JSON.parse(raw || '{}');
      const send = data => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); };
      assert.equal(request.method, 'POST', 'Unexpected fixture method');
      switch (request.url) {
        case '/ilink/bot/getupdates':
          return send({ ret: 0, errcode: 0, get_updates_buf: `cursor_${randomUUID()}`, msgs: queue.splice(0) });
        case '/ilink/bot/getconfig': return send({ ret: 0, typing_ticket: 'synthetic-typing' });
        case '/ilink/bot/sendtyping': return send({ ret: 0 });
        case '/ilink/bot/sendmessage':
          assert.equal(body.msg?.to_user_id, CHAT, 'Unexpected outbound chat');
          assert(body.msg.item_list.every(item => item.type === 1), 'Unexpected outbound media');
          replies.push(body.msg.item_list.map(item => item.text_item.text).join(''));
          return send({ ret: 0, errcode: 0 });
        case '/v1/chats/authorize':
          assert.deepEqual(body, { chatId: CHAT }, 'Unexpected authorization target');
          return send({ allowed: true });
        case '/v1/messages':
          forwarded.push(body);
          return send({ text: `合成项目的当前状态为 ${markers.controller}，这是本次查询得到的随机事实。` });
        default:
          unexpected.push('unexpected-fixture-route');
          response.writeHead(404); response.end();
      }
    }
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `https://127.0.0.1:${server.address().port}`;
    await writeFile(credentials, JSON.stringify({ accountId: ACCOUNT, token: FIXTURE_TOKEN,
      baseUrl: url, savedAt: new Date().toISOString() }), { mode: 0o600 });
    const env = { PATH: process.env.PATH, HOME: directory, LANG: 'en_US.UTF-8',
      NODE_EXTRA_CA_CERTS: cert, CONTROLLER_TOKEN: FIXTURE_TOKEN,
      GATEWAY_LEADER_API_KEY: process.env.GATEWAY_LEADER_API_KEY };
    for (const name of ['GATEWAY_LEADER_BASE_URL', 'GATEWAY_LEADER_MODEL', 'GATEWAY_CODEX_PATH', 'SSL_CERT_FILE', 'SSL_CERT_DIR']) {
      if (process.env[name]) env[name] = process.env[name];
    }
    const cliArgs = [GATEWAY_CLI, '--controller-url', url,
      '--wechat-base-url', url, '--credentials-path', credentials, '--state-path', state,
      '--leader-mode', 'codex', '--leader-root', leaderRoot];
    const runCli = async mode => {
      const output = await execute(process.execPath, [...cliArgs, mode], env, `Gateway ${mode}`);
      const summary = JSON.parse(output.trim());
      assert.equal(unexpected.length, 0, 'Unexpected fixture request');
      return summary;
    };
    const baseline = await runCli('--establish-baseline');
    assert.equal(baseline.ok, true);
    assert.equal(baseline.rawMessagesSkipped, 0);
    assert.equal(replies.length, 0);
    evidence.checks.push({ check: 'cli-baseline', passed: true });
    async function message(text, id = randomUUID()) {
      const inbound = { message_type: 1, from_user_id: CHAT, client_id: id,
        create_time_ms: String(Date.now()), context_token: 'synthetic-context',
        item_list: [{ type: 1, text_item: { text } }] };
      queue.push(inbound);
      const before = replies.length;
      const summary = await runCli('--poll-once');
      return { inbound, summary, text: replies.slice(before).join('\n') };
    }
    const first = await message(`请实际维护本目录三个记忆文件：preference.md 记录我的明确偏好“每次回答先给结论，偏好识别码 ${markers.preference}”；task.md 记录当前未完成任务“合成验收任务 ${markers.task}，下一步等待用户继续”；memory.md 记录长期事实“合成项目识别码 ${markers.memory}，来源是本轮用户明确提供”。这是本地记忆测试，无需查询控制外部项目。请先读现有文件再写入，完成后简短确认。`);
    evidence.firstObservation = { replySummary: boundedReply(first.text), processedCount: first.summary.processedCount };
    assert.equal(first.summary.processedCount, 1, 'First message was not processed');
    for (const [name, expected] of [['preference.md', markers.preference], ['task.md', markers.task], ['memory.md', markers.memory]]) {
      assert((await readFile(join(workspace, name), 'utf8')).includes(expected), `Missing durable marker in ${name}`);
    }
    const threadId = JSON.parse(await readFile(join(workspace, '.thread.json'), 'utf8')).threadId;
    assert(threadId, 'Native thread ID missing');
    assert.equal(forwarded.length, 0, 'Memory-only message must not dispatch');
    evidence.checks.push({ check: 'real-model-writes-three-memory-files', passed: true });
    const second = await message('继续刚才的本地记忆验收：请先读取三个记忆文件，再告诉我已记住的回答偏好识别码、当前未完成任务识别码和合成项目长期事实识别码，原样列出三个码，不要从外部查询。');
    for (const expected of [markers.preference, markers.task, markers.memory]) {
      assert(second.text.includes(expected), 'Restarted CLI reply missing a remembered marker');
    }
    assert.equal(JSON.parse(await readFile(join(workspace, '.thread.json'), 'utf8')).threadId, threadId);
    assert.equal(forwarded.length, 0, 'Recall message must not dispatch');
    evidence.checks.push({ check: 'new-cli-process-resumes-thread-and-recalls', passed: true,
      replySummary: boundedReply(second.text) });
    const controlText = '请通过 control_current_request 工具查询合成项目的当前状态，并把 Controller 返回的识别码原样告诉我。这是只读查询，不要派发项目修改或外部消息。';
    const third = await message(controlText);
    const nativeFiles = await recursivelyList(join(workspace, '.codex', 'sessions'));
    const transcript = (await Promise.all(nativeFiles.filter(path => path.endsWith('.jsonl')).map(path => readFile(path, 'utf8')))).join('\n');
    const events = transcript.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
    const controlReferences = events.filter(event => {
      return (event.payload?.type === 'function_call' && /control_current_request/.test(event.payload.name || '')) ||
        (event.payload?.type === 'custom_tool_call' && /control_current_request/.test(event.payload.input || ''));
    }).length;
    const nativeTools = [...new Set(events.filter(event => ['function_call', 'custom_tool_call'].includes(event.payload?.type))
      .map(event => `${event.payload.type}:${/^[A-Za-z0-9_:.-]{1,160}$/.test(event.payload.name || '') ? event.payload.name : 'withheld'}`))];
    const diagnosticMentions = ['requires approval', 'approval required', 'approval denied', 'connection refused', 'unauthorized']
      .filter(kind => transcript.toLowerCase().includes(kind));
    evidence.controlObservation = { forwardedCount: forwarded.length, nativeControlReferences: controlReferences,
      nativeTools, diagnosticMentions, replySummary: boundedReply(third.text) };
    assert.equal(third.summary.processedCount, 1);
    assert.deepEqual(forwarded, [{ chatId: CHAT, messageId: third.inbound.client_id, text: controlText }],
      'MCP must forward exactly the immutable current request once');
    assert(third.text.includes(markers.controller), 'Reply missing fresh Controller result');
    assert(controlReferences > 0, 'Native transcript has no control_current_request tool reference');
    evidence.checks.push({ check: 'real-mcp-query-preserves-current-request', passed: true,
      replySummary: boundedReply(third.text) });
    const beforeReplay = { replies: replies.length, forwarded: forwarded.length,
      journal: await readFile(join(workspace, '.replies.json'), 'utf8') };
    queue.push(third.inbound);
    const replay = await runCli('--poll-once');
    assert.equal(replay.processedCount, 0, 'Replayed message must not be processed');
    assert.equal(replies.length, beforeReplay.replies, 'Replay caused duplicate WeChat reply');
    assert.equal(forwarded.length, beforeReplay.forwarded, 'Replay caused duplicate Controller request');
    assert.equal(await readFile(join(workspace, '.replies.json'), 'utf8'), beforeReplay.journal, 'Replay changed model journal');
    assert.equal(JSON.parse(await readFile(join(workspace, '.thread.json'), 'utf8')).threadId, threadId);
    evidence.checks.push({ check: 'new-cli-process-replay-has-no-duplicate-effects', passed: true });
    evidence.outcome = 'PASS';
    evidence.threadId = threadId;
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    if (evidence.outcome !== 'PASS') evidence.outcome = 'FAIL';
    for (const child of children) terminate(child);
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
    }
    evidence.childDiagnostics = childDiagnostics;
    evidence.nativeDiagnostics = await diagnoseWorkspace(workspace, markers);
    await rm(directory, { recursive: true, force: true });
    if (values.evidence) await writeFile(resolve(values.evidence), `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  }
}

function boundedReply(text) {
  // The fixture only asks for synthetic values; still redact caller-supplied secrets defensively.
  for (const secret of [process.env.GATEWAY_LEADER_API_KEY, process.env.GATEWAY_LEADER_BASE_URL]) {
    if (secret) text = text.replaceAll(secret, '[REDACTED]');
  }
  return text.replace(/\b(?:sk-|sess-)[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]').slice(0, 1200);
}

function diagnosticKinds(text) {
  const lowered = text.toLowerCase();
  return ['certificate verify failed', 'certificate verification failed', 'unknown issuer', 'permission denied',
    'operation not permitted', 'no such file', 'cannot find module', 'module_not_found', 'eacces', 'enoent',
    'requires approval', 'approval required', 'approval denied', 'connection refused', 'network is unreachable',
    'error sending request', 'unauthorized', 'timed out', 'failed to initialize', 'sandbox']
    .filter(kind => lowered.includes(kind));
}

async function diagnoseWorkspace(workspace, markers) {
  const result = { threadRecorded: false, journalStages: [], memoryFiles: {}, eventTypes: {}, nativeTools: [], diagnosticKinds: [] };
  try {
    try { result.threadRecorded = Boolean(JSON.parse(await readFile(join(workspace, '.thread.json'), 'utf8')).threadId); }
    catch (error) { if (error.code !== 'ENOENT') result.threadReadError = safeCode(error); }
    try { result.journalStages = Object.values(JSON.parse(await readFile(join(workspace, '.replies.json'), 'utf8'))).map(item =>
      ['started', 'completed'].includes(item.stage) ? item.stage : 'unknown'); }
    catch (error) { if (error.code !== 'ENOENT') result.journalReadError = safeCode(error); }
    for (const [name, marker] of [['preference.md', markers.preference], ['task.md', markers.task], ['memory.md', markers.memory]]) {
      try { result.memoryFiles[name] = { exists: true, containsMarker: (await readFile(join(workspace, name), 'utf8')).includes(marker) }; }
      catch (error) { result.memoryFiles[name] = { exists: false, readError: safeCode(error) }; }
    }
    let files = [];
    try { files = await recursivelyList(join(workspace, '.codex', 'sessions')); }
    catch (error) { if (error.code !== 'ENOENT') result.sessionReadError = safeCode(error); }
    const tools = new Set();
    const kinds = new Set();
    for (const file of files.filter(path => path.endsWith('.jsonl'))) {
      for (const line of (await readFile(file, 'utf8')).split('\n').filter(Boolean)) {
        let event;
        try { event = JSON.parse(line); } catch { result.invalidEventLines = (result.invalidEventLines || 0) + 1; continue; }
        const type = `${event.type || 'unknown'}:${event.payload?.type || 'none'}`;
        const safeType = /^[A-Za-z0-9_:.-]{1,120}$/.test(type) ? type : 'withheld';
        result.eventTypes[safeType] = (result.eventTypes[safeType] || 0) + 1;
        if (['function_call', 'custom_tool_call'].includes(event.payload?.type)) {
          const name = event.payload.name || '';
          if (/^[A-Za-z0-9_:.-]{1,160}$/.test(name)) tools.add(name);
          for (const match of (event.payload.input || '').matchAll(/tools\.([A-Za-z0-9_]{1,160})/g)) tools.add(match[1]);
        }
        for (const kind of diagnosticKinds(line)) kinds.add(kind);
      }
    }
    result.nativeTools = [...tools].slice(0, 64);
    result.diagnosticKinds = [...kinds];
  } catch (error) { result.collectionError = safeCode(error); }
  return result;
}

function safeCode(error) {
  return ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(error.code) ? error.code : error instanceof SyntaxError ? 'InvalidJson' : 'DiagnosticUnavailable';
}

async function recursivelyList(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => entry.isDirectory()
    ? recursivelyList(join(directory, entry.name)) : [join(directory, entry.name)]));
  return nested.flat();
}
