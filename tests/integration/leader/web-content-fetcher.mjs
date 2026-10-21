import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ strict: true, allowPositionals: false, options: {
  help: { type: 'boolean', short: 'h' }, run: { type: 'boolean' },
  'gateway-cli': { type: 'string' }, 'codex-path': { type: 'string' }, evidence: { type: 'string' },
  'tls-key': { type: 'string' }, 'tls-cert': { type: 'string' },
  'article-url': { type: 'string' },
} });
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = resolve(values['gateway-cli'] || join(ROOT, 'gateway/dist/index.js'));
const EVIDENCE = resolve(values.evidence || join(ROOT, '.runtime/web-fetcher/native'));
const TOKEN = 'synthetic-web-content-fetcher-fixture-token';
const ACCOUNT = 'synthetic-web-content-fetcher-account';
const CHAT = 'synthetic-web-content-fetcher-chat';
const TIMEOUT_MS = 90_000;
const CHILD_OUTPUT_LIMIT = 262_144;
const SKILL = '/etc/codex/skills/web-content-fetcher';
const FIXTURE_TITLE = '原生 Python 抓取验收';
const FIXTURE_BODY = '这是由实际 Linux 沙箱中的 Python 脚本提取的公开文章内容。'.repeat(15);
const REQUEST_LIMIT = 8 * 1024 * 1024;
const EXPECTED_VERSION = 'codex-cli 0.163.0';
const children = new Set();

if (!values.run || values.help) console.log(`Usage: node tests/integration/leader/web-content-fetcher.mjs --run [--gateway-cli PATH] [--codex-path PATH] [--evidence PATH] [--tls-key PATH --tls-cert PATH] [--article-url URL]
Starts actual Gateway CLI and pinned native Codex with isolated HOME; inference, WeChat and Controller are loopback fixtures.
Two fresh/resumed rounds discover and read /etc/codex/skills/web-content-fetcher, run its Python script against HTTP HTML,
and require private CODEX_HOME denial and absent browser/computer tools. No real model or WeChat messages are sent.
--article-url additionally fetches a public URL and records its actual extraction; a challenge is not counted as article success.
Run in the candidate production-policy Linux container with the read-only packaged skill and Python dependencies.`);
else await main().catch(error => { console.error(`FAIL native web-content-fetcher: ${error.message}`); process.exitCode = 1; });

function stop(child) {
  if (!child.pid) return;
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

async function execute(command, args, env, label) {
  const child = spawn(command, args, { env, cwd: dirname(CLI), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  let stdout = '', stderr = '', timedOut = false;
  child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-CHILD_OUTPUT_LIMIT); });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-CHILD_OUTPUT_LIMIT); });
  const timer = setTimeout(() => { timedOut = true; stop(child); }, TIMEOUT_MS);
  try {
    const [code] = await once(child, 'close');
    await writeFile(join(EVIDENCE, `${label}.log`), JSON.stringify({ code, timedOut, stdout, stderr }, null, 2));
    assert(!timedOut, `${label} timed out`);
    assert.equal(code, 0, `${label} exited ${code}; see evidence log`);
    return stdout;
  } finally { clearTimeout(timer); stop(child); children.delete(child); }
}

async function main() {
  await readFile(CLI);
  await mkdir(EVIDENCE, { recursive: true });
  const requireSdk = createRequire(await realpath(join(dirname(CLI), '../node_modules/@openai/codex-sdk/package.json')));
  const requireCodex = createRequire(requireSdk.resolve('@openai/codex/package.json'));
  const platform = process.platform === 'android' ? 'linux' : process.platform;
  const nativePackage = requireCodex.resolve(`@openai/codex-${platform}-${process.arch}/package.json`);
  const triple = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`;
  const codex = values['codex-path'] ? resolve(values['codex-path'])
    : join(dirname(nativePackage), 'vendor', triple, 'bin', 'codex');
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'super-leader-web-content-fetcher-')));
  const leaderRoot = join(directory, 'leader');
  const workspace = join(leaderRoot, createHash('sha256').update(JSON.stringify([ACCOUNT, CHAT])).digest('hex'));
  const deniedSentinel = `SYNTHETIC_DENIED_${randomUUID()}`;
  const evidence = { status: 'running', gatewayCli: CLI, codex, checks: [], rounds: [] };
  let server, providerServer, round = 0;
  const queue = [], replies = [], requests = [], unexpected = [];
  try {
    await writeFile(join(EVIDENCE, 'native-stderr.log'), '');
    await mkdir(join(workspace, '.codex'), { recursive: true, mode: 0o700 });
    await writeFile(join(workspace, '.codex/deny-probe.txt'), deniedSentinel);
    evidence.version = (await execute(codex, ['--version'], { PATH: process.env.PATH, HOME: directory }, 'version')).trim();
    assert.equal(evidence.version, EXPECTED_VERSION);
    assert(Boolean(values['tls-key']) === Boolean(values['tls-cert']), 'Supply both --tls-key and --tls-cert');
    const key = values['tls-key'] ? resolve(values['tls-key']) : join(directory, 'tls-key.pem');
    const cert = values['tls-cert'] ? resolve(values['tls-cert']) : join(directory, 'tls-cert.pem');
    if (!values['tls-key']) await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert],
    { PATH: process.env.PATH, HOME: directory }, 'tls-generation');
    server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (req, res) => {
      void serve(req, res).catch(error => {
        unexpected.push({ route: req.url, error: error.message });
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    async function serve(req, res) {
      if (req.url === '/article') {
        assert.equal(req.method, 'GET');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<html><head><title>${FIXTURE_TITLE}</title></head><body><nav>EXCLUDED_NAVIGATION</nav><article><h1>${FIXTURE_TITLE}</h1><p>${FIXTURE_BODY}</p></article><script>EXCLUDED_SCRIPT</script></body></html>`);
        return;
      }
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(req.method, 'POST');
      let raw = '';
      for await (const chunk of req) { raw += chunk; assert(raw.length <= REQUEST_LIMIT); }
      const body = JSON.parse(raw || '{}');
      const send = data => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); };
      if (req.url === '/v1/responses') {
        requests.push({ round, body });
        await writeFile(join(EVIDENCE, `responses-${requests.length}.json`), JSON.stringify({ round, body }, null, 2));
        const previous = requests.filter(request => request.round === round).length > 1;
        const item = previous ? { id: `msg_${randomUUID()}`, type: 'message', status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', annotations: [], text: `synthetic-native-tools-round-${round}` }] }
          : { id: `ctc_${randomUUID()}`, type: 'custom_tool_call', call_id: `call_${round}`, name: 'exec',
            namespace: 'functions', input: nativeProbe(`http://127.0.0.1:${providerServer.address().port}/article`) };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        const id = `resp_${randomUUID()}`;
        emit('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } });
        emit('response.output_item.done', { output_index: 0, item });
        emit('response.completed', { response: { id, object: 'response', status: 'completed', output: [item],
          usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } });
        res.end();
        return;
      }
      switch (req.url) {
        case '/ilink/bot/getupdates': return send({ ret: 0, errcode: 0, get_updates_buf: randomUUID(), msgs: queue.splice(0) });
        case '/ilink/bot/getconfig': return send({ ret: 0, typing_ticket: 'synthetic-typing' });
        case '/ilink/bot/sendtyping': return send({ ret: 0 });
        case '/ilink/bot/sendmessage':
          assert.equal(body.msg?.to_user_id, CHAT);
          assert(body.msg.item_list.every(item => item.type === 1));
          replies.push(body.msg.item_list.map(item => item.text_item.text).join(''));
          return send({ ret: 0, errcode: 0 });
        case '/v1/chats/authorize': assert.deepEqual(body, { chatId: CHAT }); return send({ allowed: true });
        default: throw new Error(`Unexpected synthetic fixture route ${req.url}`);
      }
    }
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    providerServer = createHttpServer((req, res) => {
      void serve(req, res).catch(error => {
        unexpected.push({ route: req.url, error: error.message });
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    providerServer.listen(0, '127.0.0.1');
    await once(providerServer, 'listening');
    const url = `https://127.0.0.1:${server.address().port}`;
    const credentials = join(directory, 'synthetic-account.json');
    await writeFile(credentials, JSON.stringify({ accountId: ACCOUNT, token: TOKEN, baseUrl: url,
      savedAt: new Date().toISOString() }), { mode: 0o600 });
    // Observe native stderr without changing the real SDK's arguments, environment or event handling.
    const observer = join(directory, 'observe-native.mjs');
    await writeFile(observer, `import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {appendFileSync} from 'node:fs';
const original = childProcess.spawn;
childProcess.spawn = function(command, args, options) {
  const child = original.call(this, command, args, options);
  if (command === ${JSON.stringify(codex)}) child.stderr?.on('data', chunk =>
    appendFileSync(${JSON.stringify(join(EVIDENCE, 'native-stderr.log'))}, chunk));
  return child;
};
syncBuiltinESMExports();`);
    const env = { PATH: process.env.PATH, HOME: directory, LANG: 'en_US.UTF-8',
      NODE_EXTRA_CA_CERTS: cert, CONTROLLER_TOKEN: TOKEN,
      GATEWAY_LEADER_API_KEY: TOKEN, GATEWAY_LEADER_BASE_URL: `http://127.0.0.1:${providerServer.address().port}/v1`,
      GATEWAY_CODEX_PATH: codex };
    const args = ['--import', observer, CLI, '--controller-url', url, '--wechat-base-url', url, '--credentials-path', credentials,
      '--state-path', join(directory, 'state.json'), '--leader-mode', 'codex', '--leader-root', leaderRoot];
    const baseline = JSON.parse(await execute(process.execPath, [...args, '--establish-baseline'], env, 'baseline'));
    assert.equal(baseline.ok, true);
    let threadId;
    for (round = 1; round <= 2; round++) {
      queue.push({ message_type: 1, from_user_id: CHAT, client_id: randomUUID(), create_time_ms: String(Date.now()),
        context_token: 'synthetic-context', item_list: [{ type: 1, text_item: { text: `合成原生工具验收第${round}轮，只需简短确认。` } }] });
      const summary = JSON.parse(await execute(process.execPath, [...args, '--poll-once'], env, `round-${round}`));
      assert.equal(summary.processedCount, 1);
      const state = JSON.parse(await readFile(join(workspace, '.thread.json'), 'utf8'));
      if (threadId) assert.equal(state.threadId, threadId, 'Native thread was not resumed');
      threadId = state.threadId;
      const observed = requests.filter(request => request.round === round);
      const metadata = observed.at(-1)?.body.input.find(item => item.type === 'custom_tool_call_output' && item.call_id === `call_${round}`);
      const nativeOutput = (metadata?.output || []).filter(item => item.type === 'input_text').map(item => item.text);
      const nativeResults = nativeOutput.filter(text => text.startsWith('{')).map(text => JSON.parse(text));
      const catalog = observed[0]?.body.input.filter(item => item.role === 'developer').flatMap(item => item.content || []).map(item => item.text || '').join('\n');
      const skillRoots = new Map([...catalog.matchAll(/^- `(r\d+)` = `([^`]+)`$/gm)].map(match => [match[1], match[2]]));
      const proofRoot = catalog.match(/^- web-content-fetcher:[^\n]*\(file: (r\d+)\/web-content-fetcher\/SKILL\.md\)/m)?.[1];
      assert.equal(skillRoots.get(proofRoot), '/etc/codex/skills', 'System skill not discovered');
      assert(!catalog.includes('.codex/skills/.system'), 'Inaccessible bundled skill path exposed');
      assert(nativeResults.some(item => item.exit_code === 0 && item.output?.includes('name: web-content-fetcher')), 'Native shell could not read packaged skill');
      assert(nativeResults.some(item => item.exit_code !== 0 && /deny-probe.txt: Permission denied/.test(item.output || '')), 'CODEX_HOME marker was not denied');
      assert(!JSON.stringify(observed).includes(deniedSentinel), 'Denied CODEX_HOME marker leaked to model');
      const artifact = JSON.parse(await readFile(join(workspace, 'fixture-fetch.json'), 'utf8'));
      assert.equal(artifact.status_code, 200);
      assert.equal(artifact.error, null);
      assert.equal(artifact.title, FIXTURE_TITLE);
      assert(artifact.content.includes(FIXTURE_BODY), 'Python extraction omitted fixture body');
      assert(!/EXCLUDED_NAVIGATION|EXCLUDED_SCRIPT/.test(artifact.content), 'Nonarticle content leaked into extraction');
      assert.equal(artifact.method, 'curl+readability', 'Installed BeautifulSoup extraction not used');
      assert(nativeResults.some(item => item.exit_code === 0 && item.output?.includes('PYTHON_FETCH_COMPLETE')), 'Native Python invocation did not complete');
      const runtimeNames = nativeOutput.filter(text => text.startsWith('[')).flatMap(text => JSON.parse(text));
      let article;
      if (values['article-url']) {
        article = JSON.parse(await readFile(join(workspace, 'public-fetch.json'), 'utf8'));
        await writeFile(join(EVIDENCE, `public-fetch-${round}.json`), JSON.stringify(article, null, 2));
        const challenge = /环境异常|访问过于频繁|安全验证|完成验证|captcha|verify\/|wappoc_appmsgcaptcha/i.test(`${article.final_url} ${article.title} ${article.content}`);
        article = { url: article.url, finalUrl: article.final_url, status: article.status_code,
          title: article.title, characters: article.content.length, error: article.error,
          articleSuccess: article.status_code === 200 && !article.error && !challenge && article.title.length > 0 && article.content.length >= 200,
          challenge };
      }
      evidence.rounds.push({ round, threadId, responsesRequests: observed.length,
        tools: observed.map(request => toolInventory(request.body)), runtimeNames, fixture: artifact, ...(article ? { article } : {}),
        skills: { discovered: true, nativeRead: true, bundledPathsAbsent: true, codexHomeDenied: true }, reply: replies.at(-1) });
      assert.equal(observed.length, 2, 'Expected native metadata call and final response per round');
      assert.equal(replies.at(-1), `synthetic-native-tools-round-${round}`, 'Gateway did not deliver real native output');
      for (const capture of observed) verifyTools(capture.body, evidence.checks, round);
      for (const name of ['exec_command', 'web__run', 'mcp__wechat_control__control_current_request']) {
        assert(runtimeNames.includes(name), `Native runtime registry missing ${name}`);
      }
      assert.equal(unexpected.length, 0);
    }
    evidence.status = 'passed';
    console.log(JSON.stringify({ core: 'PASS', version: evidence.version, evidence: join(EVIDENCE, 'result.json'),
      rounds: evidence.rounds.map(({ round, threadId, skills, article }) => ({ round, threadId, skills, article })) }));
  } catch (error) {
    evidence.status = 'failed'; evidence.error = error.message;
    throw error;
  } finally {
    try {
      evidence.unexpected = unexpected;
      if (await exists(workspace)) {
        for (const file of await files(workspace)) {
          if (file.endsWith('.jsonl')) await writeFile(join(EVIDENCE, `native-${file.split('/').at(-1)}`), await readFile(file));
        }
      }
      await writeFile(join(EVIDENCE, 'result.json'), JSON.stringify(evidence, null, 2));
    } finally {
      for (const child of children) stop(child);
      if (providerServer) { providerServer.closeAllConnections(); await new Promise(resolveClose => providerServer.close(resolveClose)); }
      if (server) { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); }
      await rm(directory, { recursive: true, force: true });
    }
  }
}

function nestedTools(tools = [], prefix = '') {
  return tools.flatMap(tool => [{ type: tool.type, name: `${prefix}${tool.name || ''}`,
    ...(tool.external_web_access !== undefined ? { external_web_access: tool.external_web_access } : {}) },
  ...nestedTools(tool.tools || [], `${prefix}${tool.name || ''}.`)]);
}

function toolInventory(body) {
  const tools = [...(body.tools || []), ...(body.input || []).filter(item => item.type === 'additional_tools').flatMap(item => item.tools || [])];
  const declared = tools.flatMap(tool => tool.tools || []).flatMap(tool =>
    [...(tool.description || '').matchAll(/^### `([^`]+)`\n[\s\S]*?declare const tools: \{ ([A-Za-z0-9_]+)\(/gm)]
      .filter(match => match[1] === match[2]).map(match => ({ type: 'code-mode declaration', name: match[1] })));
  const runtime = (body.input || []).filter(item => item.type === 'custom_tool_call_output')
    .flatMap(item => Array.isArray(item.output) ? item.output : []).flatMap(item => {
      if (item.type !== 'input_text' || !item.text?.startsWith('[')) return [];
      const names = JSON.parse(item.text);
      return Array.isArray(names) && names.every(name => typeof name === 'string')
        ? names.map(name => ({ type: 'native ALL_TOOLS result', name })) : [];
    });
  return [...nestedTools(tools), ...declared, ...runtime];
}

function verifyTools(body, checks, round) {
  const inventory = toolInventory(body), names = inventory.map(tool => tool.name);
  const check = (name, condition) => { checks.push({ round, check: name, passed: Boolean(condition) });
    assert(condition, name); };
  check('native unified shell tools exposed', names.some(name => /(^|[.:_])exec_command$/.test(name)));
  check('multi-agent V2 tools exposed', names.some(name => /spawn_agent$/.test(name)) && names.some(name => /followup_task$/.test(name)));
  check('goal tools exposed', ['create_goal', 'get_goal', 'update_goal'].every(suffix => names.some(name => name.endsWith(suffix))));
  check('live web search exposed', inventory.some(tool => tool.type === 'web_search' && tool.external_web_access !== false) || names.includes('web__run'));
  check('browser and computer tools absent', !inventory.some(tool => /browser|computer|cdp|desktop|local_automation/i.test(tool.name)));
}

async function exists(file) {
  try { await readFile(join(file, '.thread.json')); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
}

function shellQuote(value) { return "'" + value.replaceAll("'", "'\"'\"'") + "'"; }
function nativeProbe(url) {
  const commands = [
    `cat ${SKILL}/SKILL.md`,
    'cat .codex/deny-probe.txt',
    `python3 ${SKILL}/scripts/fetch_content.py ${shellQuote(url)} --format text --timeout 30 --output fixture-fetch.json && printf PYTHON_FETCH_COMPLETE`,
    ...(values['article-url'] ? [`python3 ${SKILL}/scripts/fetch_content.py ${shellQuote(values['article-url'])} --format text --timeout 30 --output public-fetch.json`] : []),
  ];
  return 'async function run(cmd) { let result = await tools.exec_command({cmd,login:false,max_output_tokens:2000,yield_time_ms:1000}); text(result); while(result.session_id) { result = await tools.write_stdin({session_id:result.session_id,chars:"",max_output_tokens:2000,yield_time_ms:1000}); text(result); } } ' +
    commands.map(cmd => `await run(${JSON.stringify(cmd)});`).join(' ') +
    ' text(ALL_TOOLS.map(({name}) => name));';
}
