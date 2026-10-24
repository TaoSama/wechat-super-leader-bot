import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ strict: true, allowPositionals: false, options: {
  help: { type: 'boolean', short: 'h' }, run: { type: 'boolean' },
  'gateway-cli': { type: 'string' }, 'codex-path': { type: 'string' }, evidence: { type: 'string' },
  'tls-key': { type: 'string' }, 'tls-cert': { type: 'string' },
} });
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = resolve(values['gateway-cli'] || join(ROOT, 'gateway/dist/index.js'));
const EVIDENCE = resolve(values.evidence || join(ROOT, '.runtime/progress-steering'));
const TOKEN = 'synthetic-progress-steering-token', ACCOUNT = 'synthetic-progress-account';
const CHAT = 'synthetic-progress-chat', TIMEOUT_MS = 90_000, OUTPUT_LIMIT = 262_144;
const ROOT_TEXT = '请仔细整理一个普通聊天回答，并在核对过程中向我报告具体进展。';
const STEER_TEXT = `追加要求原文_${randomUUID()}：最终回答必须包含“雨后的青石路”。`;
const PROGRESS = ['已经核对了问题的第一部分，正在整理可以直接使用的建议。',
  '已经收到追加的表达要求，正在把它合并进同一份回答。', '建议与追加要求已核对完成，正在完成最后的表述。'];
const FINAL = '已综合本轮问题和追加要求，雨后的青石路；这是同一轮统一回复。';
const children = new Set();

if (!values.run || values.help) console.log(`Usage: node tests/integration/leader/progress-steering.mjs --run [--gateway-cli PATH] [--codex-path PATH] [--evidence PATH] [--tls-key PATH --tls-cert PATH]
Runs the built Gateway CLI and pinned real native Codex app-server with isolated storage.
Synthetic loopback WeChat/Controller HTTPS and Responses HTTP avoid real accounts and model APIs.
Proves model tool calls deliver progress immediately, budgets return 2/1/0 and reject a fourth update,
and a second WeChat poll steers its exact user text into the same native turn with one final reply.
Native JSON-RPC traffic and Responses inputs are retained as evidence. Requires openssl and a built Gateway.`);
else await main().catch(error => { console.error(`FAIL native progress steering: ${error.stack}`); process.exitCode = 1; });

function stop(child, signal = 'SIGKILL') {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
function launch(command, args, env, label) {
  const child = spawn(command, args, { env, cwd: dirname(CLI), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-OUTPUT_LIMIT); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-OUTPUT_LIMIT); });
  child.once('error', error => { stderr += error.stack; });
  const done = once(child, 'close').then(async ([code, signal]) => {
    children.delete(child);
    const result = { code, signal, stdout, stderr };
    await writeFile(join(EVIDENCE, `${label}.log`), JSON.stringify(result, null, 2));
    return result;
  });
  return { child, done };
}
async function execute(command, args, env, label) {
  const job = launch(command, args, env, label), timer = setTimeout(() => stop(job.child), TIMEOUT_MS);
  try { const result = await job.done; assert.equal(result.code, 0, `${label} failed; see ${label}.log`); return result.stdout; }
  finally { clearTimeout(timer); stop(job.child); }
}
async function waitUntil(predicate, label, duration = TIMEOUT_MS) {
  const deadline = Date.now() + duration;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(done => setTimeout(done, 40)); }
  throw new Error(`Timed out waiting for ${label}`);
}
async function nativeFrames(path) {
  let raw;
  try { raw = await readFile(path, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const streams = new Map(), frames = [];
  for (const line of raw.trim().split('\n').filter(Boolean)) {
    const entry = JSON.parse(line);
    if (!['stdin', 'stdout'].includes(entry.direction)) continue;
    const key = `${entry.pid}:${entry.direction}`, text = (streams.get(key) || '') + entry.text;
    const parts = text.split('\n'); streams.set(key, parts.pop());
    for (const part of parts.filter(Boolean)) frames.push({ pid: entry.pid, direction: entry.direction, at: entry.at, frame: JSON.parse(part) });
  }
  return frames;
}
function response(res, item) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const id = `resp_${randomUUID()}`;
  emit('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } });
  emit('response.output_item.done', { output_index: 0, item });
  emit('response.completed', { response: { id, object: 'response', status: 'completed', output: [item],
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } });
  res.end();
}
function call(number, texts) {
  return { id: `ctc_${number}`, type: 'custom_tool_call', call_id: `progress_call_${number}`, name: 'exec', namespace: 'functions',
    input: texts.map(text => `text(await tools.mcp__wechat_control__report_progress({text:${JSON.stringify(text)}}));`).join('\n') };
}
async function main() {
  await readFile(CLI); await mkdir(EVIDENCE, { recursive: true });
  const requireSdk = createRequire(await realpath(join(dirname(CLI), '../node_modules/@openai/codex-sdk/package.json')));
  const requireCodex = createRequire(requireSdk.resolve('@openai/codex/package.json'));
  const platform = process.platform === 'android' ? 'linux' : process.platform;
  const nativePackage = requireCodex.resolve(`@openai/codex-${platform}-${process.arch}/package.json`);
  const triple = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`;
  const codex = values['codex-path'] ? resolve(values['codex-path']) : join(dirname(nativePackage), 'vendor', triple, 'bin', 'codex');
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'super-leader-progress-steering-')));
  const leaderRoot = join(directory, 'leader'), statePath = join(directory, 'state.json');
  const workspace = join(leaderRoot, createHash('sha256').update(JSON.stringify([ACCOUNT, CHAT])).digest('hex'));
  const protocol = join(EVIDENCE, 'native-protocol.ndjson');
  const evidence = { status: 'running', gatewayCli: CLI, codex, checks: [], requests: [], replies: [] };
  const queue = [], errors = [], pollBatches = [];
  let server, provider, gateway, requests = 0, rootQueued = false, secondQueued = false;
  const check = (name, condition) => { evidence.checks.push({ name, passed: Boolean(condition) }); assert(condition, name); };
  const message = text => ({ message_type: 1, from_user_id: CHAT, client_id: randomUUID(),
    create_time_ms: String(Date.now()), context_token: `synthetic-context-${randomUUID()}`,
    item_list: [{ type: 1, text_item: { text } }] });
  try {
    await writeFile(protocol, '');
    evidence.version = (await execute(codex, ['--version'], { PATH: process.env.PATH, HOME: directory }, 'version')).trim();
    assert.equal(evidence.version, 'codex-cli 0.163.0');
    assert(Boolean(values['tls-key']) === Boolean(values['tls-cert']), 'Supply both TLS paths');
    const key = values['tls-key'] ? resolve(values['tls-key']) : join(directory, 'tls-key.pem');
    const cert = values['tls-cert'] ? resolve(values['tls-cert']) : join(directory, 'tls-cert.pem');
    if (!values['tls-key']) await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert],
    { PATH: process.env.PATH, HOME: directory }, 'tls-generation');
    const serve = async (req, res) => {
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      let raw = ''; for await (const chunk of req) { raw += chunk; assert(raw.length <= 8 * 1024 * 1024); }
      const body = JSON.parse(raw || '{}');
      const send = data => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.url === '/v1/responses') {
        const number = ++requests;
        evidence.requests.push({ number, at: Date.now(), body });
        await writeFile(join(EVIDENCE, `responses-${number}.json`), JSON.stringify(body, null, 2));
        assert.equal(number <= 4, true, 'Unexpected additional native model request');
        if (number === 1) return response(res, call(1, [PROGRESS[0]]));
        if (number === 2) {
          check('first progress delivered before final model output', evidence.replies.length === 1 && evidence.replies[0].text === PROGRESS[0]);
          return response(res, call(2, [...PROGRESS.slice(1), '这一条超过本轮额度，不应发送给用户。']));
        }
        const hasSteerText = JSON.stringify(body.input).includes(STEER_TEXT);
        const hasProgressOutput = (body.input || []).some(item => item.type === 'custom_tool_call_output' && item.call_id === 'progress_call_2');
        const hasLimitResult = JSON.stringify(body.input).includes('limit_reached');
        if (hasProgressOutput && hasLimitResult && !secondQueued) {
          queue.push(message(STEER_TEXT)); secondQueued = true;
        }
        if (!hasProgressOutput || !hasLimitResult) {
          return response(res, call(2, [...PROGRESS.slice(1), '这一条超过本轮额度，不应发送给用户。']));
        }
        if (!hasSteerText) await new Promise(done => setTimeout(done, 200));
        if (!hasSteerText) {
          return response(res, { id: `msg_${randomUUID()}`, type: 'message', status: 'completed', role: 'assistant',
            content: [{ type: 'output_text', annotations: [], text: FINAL }] });
        }
        check('exact follow-up user text reached native model input', hasSteerText);
        return response(res, { id: `msg_${randomUUID()}`, type: 'message', status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', annotations: [], text: FINAL }] });
      }
      switch (req.url) {
        case '/ilink/bot/getupdates': {
          if (!rootQueued && gateway) { queue.push(message(ROOT_TEXT)); rootQueued = true; }
          const msgs = queue.splice(0); pollBatches.push({ at: Date.now(), texts: msgs.map(item => item.item_list[0].text_item.text) });
          if (!msgs.length) await new Promise(done => setTimeout(done, 40));
          return send({ ret: 0, errcode: 0, get_updates_buf: randomUUID(), msgs });
        }
        case '/ilink/bot/getconfig': return send({ ret: 0, typing_ticket: 'synthetic-typing' });
        case '/ilink/bot/sendtyping': return send({ ret: 0 });
        case '/ilink/bot/sendmessage':
          assert.equal(body.msg?.to_user_id, CHAT);
          evidence.replies.push({ at: Date.now(), text: body.msg.item_list.map(item => item.text_item.text).join(''), body });
          return send({ ret: 0, errcode: 0 });
        case '/v1/chats/authorize': assert.deepEqual(body, { chatId: CHAT }); return send({ allowed: true });
        case '/v1/chats/notification-interest': return send({ chatIds: [], interested: [] });
        case '/v1/deliveries/resume':
          assert.equal(body.chatId, CHAT);
          assert.equal(typeof body.generation, 'string');
          return send({ resumed: 0 });
        case '/v1/tools/list':
          assert.equal(req.method, 'POST');
          assert.deepEqual(Object.keys(body).sort(), ['chatId', 'messageId', 'text']);
          assert.equal(body.chatId, CHAT);
          assert.equal(typeof body.messageId, 'string');
          assert(body.messageId.trim());
          assert.equal(body.text, ROOT_TEXT);
          return send({ tools: [], instructions: '本轮为普通聊天与进度汇报；业务工具不可用。',
            context: { history: [], memories: {} } });
        default: throw new Error(`Unexpected route ${req.method} ${req.url}`);
      }
    };
    const handler = (req, res) => { void serve(req, res).catch(error => {
      errors.push({ route: req.url, message: error.stack }); if (!res.headersSent) res.writeHead(500); res.end();
    }); };
    server = httpsServer({ key: await readFile(key), cert: await readFile(cert) }, handler);
    provider = httpServer(handler);
    server.listen(0, '127.0.0.1'); provider.listen(0, '127.0.0.1');
    await Promise.all([once(server, 'listening'), once(provider, 'listening')]);
    const url = `https://127.0.0.1:${server.address().port}`, credentials = join(directory, 'credentials.json');
    await writeFile(credentials, JSON.stringify({ accountId: ACCOUNT, token: TOKEN, baseUrl: url, savedAt: new Date().toISOString() }), { mode: 0o600 });
    const observer = join(directory, 'observe-native.mjs');
    await writeFile(observer, `import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {appendFileSync} from 'node:fs';
const original=childProcess.spawn;
childProcess.spawn=function(command,args,options){
 const child=original.call(this,command,args,options);
 if(command===${JSON.stringify(codex)}){
  const save=(direction,data)=>appendFileSync(${JSON.stringify(protocol)},JSON.stringify({pid:child.pid,at:Date.now(),direction,text:String(data)})+'\\n');
  save('spawn',JSON.stringify(args));
  child.stdout?.on('data',data=>save('stdout',data));
  child.stderr?.on('data',data=>save('stderr',data));
  const write=child.stdin.write;
  child.stdin.write=function(data,...rest){save('stdin',data);return write.call(this,data,...rest)};
 }
 return child;
};syncBuiltinESMExports();`);
    const env = { PATH: process.env.PATH, HOME: directory, LANG: 'en_US.UTF-8', NODE_EXTRA_CA_CERTS: cert,
      CONTROLLER_TOKEN: TOKEN, GATEWAY_LEADER_API_KEY: TOKEN, GATEWAY_CODEX_PATH: codex,
      GATEWAY_LEADER_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1` };
    const args = ['--import', observer, CLI, '--controller-url', url, '--wechat-base-url', url, '--credentials-path', credentials,
      '--state-path', statePath, '--leader-mode', 'codex', '--leader-root', leaderRoot, '--poll-interval-ms', '20'];
    const baseline = JSON.parse(await execute(process.execPath, [...args, '--establish-baseline'], env, 'baseline'));
    assert.equal(baseline.ok, true);
    gateway = launch(process.execPath, [...args, '--run'], env, 'gateway');
    await waitUntil(() => errors.length || evidence.replies.some(reply => reply.text === FINAL) || gateway.child.exitCode !== null, 'unified final WeChat delivery');
    assert.deepEqual(errors, []);
    check('second user message was received on a later poll', secondQueued && pollBatches.findIndex(batch => batch.texts.includes(STEER_TEXT)) > pollBatches.findIndex(batch => batch.texts.includes(ROOT_TEXT)));
    check('three exact progress messages and one final reply delivered', JSON.stringify(evidence.replies.map(reply => reply.text)) === JSON.stringify([...PROGRESS, FINAL]));
    const frames = await nativeFrames(protocol), starts = frames.filter(entry => entry.direction === 'stdin' && entry.frame.method === 'turn/start');
    const steers = frames.filter(entry => entry.direction === 'stdin' && entry.frame.method === 'turn/steer');
    check('one real native process and one turn/start own the whole query', new Set(frames.map(entry => entry.pid)).size === 1 && starts.length === 1);
    check('one native steer contains exact follow-up text', steers.length === 1 && steers[0].frame.params.input[0].text.includes(STEER_TEXT));
    const startReceipt = frames.find(entry => entry.direction === 'stdout' && entry.frame.id === starts[0].frame.id)?.frame.result;
    const steerReceipt = frames.find(entry => entry.direction === 'stdout' && entry.frame.id === steers[0].frame.id)?.frame.result;
    check('steer acknowledgement belongs to original native turn', startReceipt?.turn?.id && startReceipt.turn.id === steerReceipt?.turnId && steers[0].frame.params.expectedTurnId === startReceipt.turn.id);
    const outputs = (evidence.requests.at(-1).body.input || []).filter(item => item.type === 'custom_tool_call_output');
    const resultTexts = outputs.flatMap(item => Array.isArray(item.output) ? item.output.filter(part => part.type === 'input_text').map(part => part.text) : []);
    const results = resultTexts.filter(text => text.startsWith('{')).map(text => JSON.parse(text));
    const progressResults = results.flatMap(result => result.content || []).filter(item => item.type === 'text').map(item => {
      try { return JSON.parse(item.text); } catch (error) { throw new Error(`Invalid native MCP tool result: ${error.message}`); }
    });
    check('native tool received exact remaining budgets 2/1/0', JSON.stringify(progressResults.filter(result => result.sent).map(result => result.remaining)) === JSON.stringify([2, 1, 0]));
    check('fourth tool call refused at the same query allowance', progressResults.some(result => result.status === 'limit_reached' && result.remaining === 0 && result.used === 3 && result.sent === false));
    evidence.progressResults = progressResults;
    evidence.nativeTurnId = startReceipt.turn.id;
    evidence.nativeThreadId = starts[0].frame.params.threadId;
    stop(gateway.child, 'SIGTERM');
    const terminal = await gateway.done;
    check('gateway shuts down cleanly after all work settles', terminal.code === 0);
    evidence.status = 'passed';
    console.log(JSON.stringify({ status: 'PASS', version: evidence.version, checks: evidence.checks, evidence: join(EVIDENCE, 'result.json') }));
  } catch (error) { evidence.status = 'failed'; evidence.error = error.stack; throw error; }
  finally {
    for (const child of children) stop(child);
    if (gateway) await gateway.done;
    evidence.errors = errors; evidence.pollBatches = pollBatches;
    try {
      await writeFile(join(EVIDENCE, 'result.json'), JSON.stringify(evidence, null, 2));
      for (const file of await allFiles(workspace)) if (file.endsWith('.jsonl') || file.endsWith('.thread.json') || file.endsWith('.replies.json')) {
        await writeFile(join(EVIDENCE, `native-${file.split('/').at(-1)}`), await readFile(file));
      }
    } finally {
      for (const fixture of [provider, server].filter(Boolean)) { fixture.closeAllConnections(); await new Promise(done => fixture.close(done)); }
      await rm(directory, { recursive: true, force: true });
    }
  }
}
async function allFiles(directory) {
  let entries; try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? allFiles(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
}
