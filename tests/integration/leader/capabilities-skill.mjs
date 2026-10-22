import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import { createServer as httpsServer } from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ strict: true, allowPositionals: false, options: {
  help: { type: 'boolean', short: 'h' }, run: { type: 'boolean' }, live: { type: 'boolean' },
  'tls-key': { type: 'string' }, 'tls-cert': { type: 'string' },
  'system-skill': { type: 'boolean' }, 'gateway-cli': { type: 'string' }, evidence: { type: 'string' }, 'max-chars': { type: 'string' },
} });
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = resolve(values['gateway-cli'] || join(ROOT, 'gateway/dist/index.js'));
const EVIDENCE = resolve(values.evidence || join(ROOT, `.runtime/capabilities-${values.live ? 'live' : 'native'}`));
const SKILL = join(ROOT, 'deploy/skills/super-leader-capabilities');
const TOKEN = 'synthetic-capabilities-token', ACCOUNT = 'synthetic-capabilities-account', CHAT = 'synthetic-capabilities-chat';
const TIMEOUT_MS = 300_000, MAX_OUTPUT = 262_144, MAX_BODY = 8 * 1024 * 1024;
const children = new Set();
const QUESTIONS = ['你能做什么？请给出全部功能，使用默认功能说明格式，每项举一个简短微信场景。',
  'Plan 和 Goal 有什么区别？请给出功能表和两个完整微信场景。'];

if (values.help || !values.run) console.log(`Usage: node tests/integration/leader/capabilities-skill.mjs --run [--live] [--system-skill] [--gateway-cli PATH] [--evidence PATH] [--max-chars COUNT] [--tls-key PATH --tls-cert PATH]
Runs real Gateway CLI and pinned Codex 0.163.0 with isolated chat, HOME and native thread.
Synthetic loopback WeChat/Controller never contact real accounts. Default Responses is scripted.
--live forwards model requests using LIVE_MODEL_BASE_URL and LIVE_MODEL_API_KEY from environment.
--system-skill uses the image-installed /etc/codex/skills; default copies the shipped skill into the isolated workspace.
Captures fresh/resumed native discovery, skill reads, four-column order, scenarios and zero control actions.`);
else await main().catch(error => { console.error(`FAIL capabilities skill: ${error.stack}`); process.exitCode = 1; });

function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function execute(command, args, env, label) {
  const child = spawn(command, args, { env, cwd: dirname(CLI), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child); let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-MAX_OUTPUT); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-MAX_OUTPUT); });
  const timer = setTimeout(() => stop(child), TIMEOUT_MS);
  try {
    const [code, signal] = await once(child, 'close');
    await writeFile(join(EVIDENCE, `${label}.log`), JSON.stringify({ code, signal, stdout, stderr }, null, 2));
    assert.equal(code, 0, `${label} failed; see evidence`); return stdout;
  } finally { clearTimeout(timer); stop(child); children.delete(child); }
}
function syntheticResponse(res, item) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const id = `resp_${randomUUID()}`;
  emit('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } });
  emit('response.output_item.done', { output_index: 0, item });
  emit('response.completed', { response: { id, object: 'response', status: 'completed', output: [item],
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } }); res.end();
}
function textInput(body) { return JSON.stringify(body.input || []); }
function normalize(text) { return text.replaceAll('**', '').replaceAll(/\s+/g, ''); }
function verifyHelp(text, reference, all, quoted = true) {
  const rows = text.split('\n').filter(line => /^\s*\|/.test(line));
  assert(rows.some(row => normalize(row) === '|分组|功能|你交代什么|机器人负责什么|'), 'Four-column header missing');
  const expectedRows = reference.split('\n').filter(line => /^\| (基础功能|任务执行|多会话协作|定时与后台) \|/.test(line));
  const expected = all ? expectedRows : expectedRows.filter(line => /Plan：固定计划|Goal：持续目标/.test(line));
  const data = rows.filter(line => /基础功能|任务执行|多会话协作|定时与后台/.test(line));
  assert.equal(data.length, expected.length, 'Wrong capability row count');
  const names = expected.map(line => line.split('|')[2].trim().replaceAll('**', ''));
  for (const [i, row] of data.entries()) {
    assert.equal(row.split('|').length, 6, 'Each row must contain four cells');
    assert(normalize(row).includes(normalize(names[i])), `Wrong row order: ${names[i]}`);
    assert(normalize(row).includes(normalize(expected[i].split('|')[1])), 'Wrong capability group');
  }
  let previous = -1;
  for (const name of names) {
    const heading = normalize(`用${name.split('：')[0]}`);
    const index = normalize(text).indexOf(heading, previous + 1);
    assert(index > previous, `Missing or reordered scenario: ${heading}`); previous = index;
  }
  if (quoted) assert((text.match(/^\s*>/gm) || []).length >= names.length, 'Missing copyable WeChat scenarios');
  return { columns: 4, capabilities: names.length, scenarios: names.length, ordered: true };
}
async function main() {
  await readFile(CLI); await mkdir(EVIDENCE, { recursive: true });
  const requireSdk = createRequire(await realpath(join(dirname(CLI), '../node_modules/@openai/codex-sdk/package.json')));
  const requireCodex = createRequire(requireSdk.resolve('@openai/codex/package.json'));
  const platform = process.platform === 'android' ? 'linux' : process.platform;
  const pkg = requireCodex.resolve(`@openai/codex-${platform}-${process.arch}/package.json`);
  const triple = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`;
  const codex = join(dirname(pkg), 'vendor', triple, 'bin', 'codex');
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'super-leader-capabilities-')));
  const leaderRoot = join(directory, 'leader');
  const workspace = join(leaderRoot, createHash('sha256').update(JSON.stringify([ACCOUNT, CHAT])).digest('hex'));
  const sourceReference = await readFile(join(SKILL, 'references/capabilities.md'), 'utf8');
  const skillRoot = values['system-skill'] ? '/etc/codex/skills/super-leader-capabilities' : join(workspace, '.agents/skills/super-leader-capabilities');
  const requests = [], errors = [], replies = [], queue = [], routes = [], discoveries = [], originalRequests = new Map();
  const evidence = { status: 'running', liveModel: Boolean(values.live), systemSkill: Boolean(values['system-skill']), rounds: [] };
  let server, provider, round = 0;
  try {
    if (!values['system-skill']) { await mkdir(dirname(skillRoot), { recursive: true }); await cp(SKILL, skillRoot, { recursive: true }); }
    assert.equal(await readFile(join(skillRoot, 'references/capabilities.md'), 'utf8'), sourceReference);
    evidence.version = (await execute(codex, ['--version'], { PATH: process.env.PATH, HOME: directory }, 'version')).trim();
    assert.equal(evidence.version, 'codex-cli 0.163.0');
    let endpoint;
    if (values.live) {
      assert(process.env.LIVE_MODEL_API_KEY?.trim(), 'LIVE_MODEL_API_KEY required'); endpoint = new URL(process.env.LIVE_MODEL_BASE_URL || '');
      assert(endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
      endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + '/responses';
    }
    assert(Boolean(values['tls-key']) === Boolean(values['tls-cert']), 'Supply both TLS paths');
    const key = values['tls-key'] ? resolve(values['tls-key']) : join(directory, 'key.pem');
    const cert = values['tls-cert'] ? resolve(values['tls-cert']) : join(directory, 'cert.pem');
    if (!values['tls-key']) await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { PATH: process.env.PATH }, 'tls');
    const handler = (req, res) => { void serve(req, res).catch(error => {
      errors.push({ path: req.url, error: error.message }); if (!res.headersSent) res.writeHead(500); res.end();
    }); };
    async function serve(req, res) {
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      const chunks = []; let bodyBytes = 0;
      for await (const chunk of req) {
        bodyBytes += chunk.length; assert(bodyBytes <= MAX_BODY); chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks, bodyBytes).toString('utf8');
      const body = JSON.parse(raw || '{}');
      const send = data => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.url === '/v1/responses') {
        requests.push({ round, body }); await writeFile(join(EVIDENCE, `responses-${requests.length}.json`), JSON.stringify({ round, body }, null, 2));
        if (values.live) {
          const upstream = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: {
            'content-type': 'application/json', authorization: `Bearer ${process.env.LIVE_MODEL_API_KEY}` },
            body: raw, signal: AbortSignal.timeout(TIMEOUT_MS) });
          assert(upstream.ok, `Upstream HTTP ${upstream.status}`);
          res.writeHead(200, { 'content-type': upstream.headers.get('content-type') || 'text/event-stream' });
          for await (const chunk of upstream.body) res.write(chunk); res.end(); return;
        }
        const prior = requests.filter(item => item.round === round).length > 1;
        const item = prior ? { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', status: 'completed', content: [{
          type: 'output_text', text: sourceReference, annotations: [] }] } : {
          id: `ctc_${randomUUID()}`, type: 'custom_tool_call', call_id: `read_${round}`, name: 'exec', namespace: 'functions',
          input: `text(await tools.exec_command({cmd:${JSON.stringify(`cat '${skillRoot}/SKILL.md' '${skillRoot}/references/capabilities.md'`)},login:false,max_output_tokens:12000}));` };
        syntheticResponse(res, item); return;
      }
      routes.push(req.url);
      switch (req.url) {
        case '/ilink/bot/getupdates': return send({ ret: 0, errcode: 0, get_updates_buf: randomUUID(), msgs: queue.splice(0) });
        case '/ilink/bot/getconfig': return send({ ret: 0, typing_ticket: 'synthetic-typing' });
        case '/ilink/bot/sendtyping': return send({ ret: 0 });
        case '/ilink/bot/sendmessage':
          assert.equal(body.msg?.to_user_id, CHAT); assert(body.msg.item_list.every(item => item.type === 1));
          replies.push({ round, text: body.msg.item_list.map(item => item.text_item.text).join('') }); return send({ ret: 0, errcode: 0 });
        case '/v1/chats/authorize': assert.deepEqual(body, { chatId: CHAT }); return send({ allowed: true });
        case '/v1/tools/list':
          assert.equal(req.method, 'POST');
          assert.deepEqual(body, originalRequests.get(round), 'Tool discovery must preserve the current user request');
          discoveries.push({ round, request: body });
          return send({ context: { history: [], memories: {} }, tools: [{ name: 'list_sessions',
            description: 'Synthetic read-only session inventory; capability help does not require a business call.',
            inputSchema: { type: 'object', properties: { arguments: { type: 'object', properties: {}, additionalProperties: false } },
              required: ['arguments'], additionalProperties: false }, annotations: { readOnlyHint: true } }],
          instructions: 'Explain capabilities by reading the installed skill. This help request authorizes no business mutation.' });
        case '/v1/chats/notification-interest': return send({ chatIds: [], interested: [] });
        case '/v1/deliveries/resume': assert.equal(body.chatId, CHAT); return send({ resumed: 0 });
        default: throw new Error(`Unexpected route ${req.method} ${req.url}`);
      }
    }
    server = httpsServer({ key: await readFile(key), cert: await readFile(cert) }, handler); provider = httpServer(handler);
    server.listen(0, '127.0.0.1'); provider.listen(0, '127.0.0.1');
    await Promise.all([once(server, 'listening'), once(provider, 'listening')]);
    const url = `https://127.0.0.1:${server.address().port}`, credentials = join(directory, 'credentials.json');
    await writeFile(credentials, JSON.stringify({ accountId: ACCOUNT, token: TOKEN, baseUrl: url, savedAt: new Date().toISOString() }), { mode: 0o600 });
    const env = { PATH: process.env.PATH, HOME: directory, LANG: 'en_US.UTF-8', NODE_EXTRA_CA_CERTS: cert,
      CONTROLLER_TOKEN: TOKEN, GATEWAY_LEADER_API_KEY: TOKEN, GATEWAY_CODEX_PATH: codex,
      GATEWAY_LEADER_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1` };
    const args = [CLI, '--controller-url', url, '--wechat-base-url', url, '--credentials-path', credentials,
      '--state-path', join(directory, 'state.json'), '--leader-mode', 'codex', '--leader-root', leaderRoot,
      ...(values['max-chars'] ? ['--max-chars', values['max-chars']] : [])];
    assert.equal(JSON.parse(await execute(process.execPath, [...args, '--establish-baseline'], env, 'baseline')).ok, true);
    let threadId;
    for (round = 1; round <= 2; round++) {
      const messageId = randomUUID();
      originalRequests.set(round, { chatId: CHAT, messageId, text: QUESTIONS[round - 1] });
      queue.push({ message_type: 1, from_user_id: CHAT, client_id: messageId, create_time_ms: String(Date.now()),
        context_token: 'synthetic-context', item_list: [{ type: 1, text_item: { text: QUESTIONS[round - 1] } }] });
      const summary = JSON.parse(await execute(process.execPath, [...args, '--poll-once'], env, `round-${round}`));
      assert.equal(summary.processedCount, 1);
      const state = JSON.parse(await readFile(join(workspace, '.thread.json'), 'utf8'));
      if (threadId) assert.equal(state.threadId, threadId, 'Expected resumed native thread'); threadId = state.threadId;
      const observed = requests.filter(item => item.round === round);
      const toolNames = (observed[0].body.tools || []).flatMap(tool => tool.type === 'namespace'
        ? tool.tools.map(nested => nested.name) : [tool.name]);
      assert(toolNames.some(name => name === 'list_sessions' || name?.endsWith('__list_sessions')), 'Direct business tool discovery missing');
      const catalog = (observed[0].body.input || []).filter(item => item.role === 'developer').flatMap(item => item.content || []).map(item => item.text || '').join('\n');
      const roots = new Map([...catalog.matchAll(/^- `(r\d+)` = `([^`]+)`$/gm)].map(match => [match[1], match[2]]));
      const alias = catalog.match(/^- super-leader-capabilities:[^\n]*\(file: (r\d+)\/super-leader-capabilities\/SKILL\.md\)/m)?.[1];
      assert.equal(roots.get(alias), dirname(skillRoot), 'Native skill catalog must expose the installed skill path');
      assert(observed.some(item => textInput(item.body).includes('帮助用户了解功能')), 'Skill content is missing from model context');
      assert(observed.some(item => textInput(item.body).includes('后台追问与延期')), 'Reference content is missing from model context');
      const calls = observed.flatMap(item => item.body.input || []).filter(item => /(?:tool_call|function_call)$/.test(item.type || ''));
      const mutations = /\b(?:control_current_request|create_goal|execute_plan|execute_goal|propose_plan|propose_goal|confirm_pending|cancel_plan|cancel_goal|remember|forget|send_session_images|get_console_link|create_automation|update_automation|follow_up_background_task|extend_background_task)\b/;
      assert(!calls.some(item => mutations.test(item.name || '') || mutations.test(item.input || item.arguments || '')), 'Help executed a control action');
      const journal = JSON.parse(await readFile(join(workspace, '.replies.json'), 'utf8'));
      const answer = Object.values(journal).filter(item => item.reply).at(-1).reply.text;
      const checks = verifyHelp(answer, sourceReference, !values.live || round === 1);
      const delivered = replies.filter(item => item.round === round).map(item => item.text);
      verifyHelp(delivered.join('\n'), sourceReference, !values.live || round === 1, false);
      if (answer.length > Number(values['max-chars'] || 3800)) assert(delivered.length > 1, 'WeChat delivery must split long help');
      await writeFile(join(EVIDENCE, `answer-${round}.md`), answer);
      evidence.rounds.push({ round, threadId, requests: observed.length, discovery: true, skillRead: true, referenceRead: true, deliveryChunks: delivered.length, ...checks });
    }
    assert.deepEqual(errors, []); assert(!routes.some(route => route.startsWith('/v1/messages')), 'Unexpected Controller execution');
    assert(!routes.includes('/v1/tools/call'), 'Capability help must not invoke a Controller business action');
    assert.deepEqual(discoveries.map(item => item.round), [1, 2], 'Each fresh or resumed help turn must discover its bound tools');
    evidence.status = 'passed'; evidence.controlActions = 0;
    console.log(JSON.stringify({ status: 'PASS', evidence: join(EVIDENCE, 'result.json'), ...evidence }));
  } catch (error) { evidence.status = 'failed'; evidence.error = error.message; throw error; } finally {
    evidence.errors = errors; evidence.routes = routes; evidence.replies = replies; evidence.discoveries = discoveries;
    await writeFile(join(EVIDENCE, 'result.json'), JSON.stringify(evidence, null, 2));
    for (const child of children) stop(child);
    for (const fixture of [provider, server].filter(Boolean)) { fixture.closeAllConnections(); await new Promise(done => fixture.close(done)); }
    await rm(directory, { recursive: true, force: true });
  }
}
