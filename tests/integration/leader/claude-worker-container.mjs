import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { run: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  image: { type: 'string', default: 'super-leader-controller:claude-verify' },
  'memory-mib': { type: 'string', default: '1536' },
  'container-fixture': { type: 'boolean' }, 'expect-refused': { type: 'boolean' },
  // Docker Desktop and other engines without AppArmor; never evidence for the production host.
  'skip-apparmor': { type: 'boolean' } } });
const FIXTURE_TIMEOUT_MS = 240_000;
const WORKER_TIMEOUT_MS = 120_000;
const RUNTIME_ROOT = '/var/lib/super-leader-runtime';
const WORKER_ROOT = `${RUNTIME_ROOT}/background/workers`;
const ARTIFACT_ROOT = `${RUNTIME_ROOT}/background/artifacts`;
const SETTINGS_ROOT = `${RUNTIME_ROOT}/settings`;
const KEY_PREFIX = 'sk-ant-synthetic-probe-';
const PEER_TEMP = '/tmp/slc-peer-probe';
const LOCAL_MARKER = 'LOCAL_LISTENER_REACHED';
// Rules that exist only for the Claude Code sandbox; removing them must make startup refuse Claude.
const CLAUDE_ONLY_RULES = new Set([0x30020011, 0x70020011, 0x20020000]);
let probeStage = 'bootstrap';

if (values['container-fixture']) {
  await fixture().catch(error => {
    console.log(JSON.stringify({ pass: false, probe: probeStage, error: String(error?.message ?? error).slice(0, 500) }));
    process.exitCode = 1;
  });
} else if (!values.run || values.help) {
  console.log('Usage: node tests/integration/leader/claude-worker-container.mjs --run [--image NAME] [--memory-mib 1536] [--skip-apparmor]\n' +
    'Runs the real Claude Code CLI inside a locally built Controller image with the production hardening (read-only root, ' +
    'cap-drop ALL, no-new-privileges, the repository seccomp policy, the super-leader-codex AppArmor profile, systempaths=unconfined, UID 1000). ' +
    'A synthetic Anthropic API server inside the container drives real tool calls; no credential or network provider is used. ' +
    'It also proves the controller refuses BACKGROUND_EXECUTOR=claude when the sandbox cannot start. Temporary containers and volumes are removed. ' +
    '--skip-apparmor runs on engines without AppArmor (Docker Desktop); production evidence still needs the profile loaded.');
} else {
  await verifyContainers().catch(error => { console.error(`FAIL Claude worker container verification: ${error.message}`); process.exitCode = 1; });
}

async function verifyContainers() {
  const { localDockerEnvironment, verificationEnvironment } = await import('../../../scripts/verify.mjs');
  const env = localDockerEnvironment(verificationEnvironment());
  const policy = fileURLToPath(new URL('../../../deploy/security/codex-seccomp.json', import.meta.url));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-worker-policy-'));
  try {
    const legacy = JSON.parse(fs.readFileSync(policy, 'utf8'));
    legacy.syscalls = legacy.syscalls.filter(rule => !CLAUDE_ONLY_RULES.has(rule.args?.[0]?.value));
    const legacyPolicy = path.join(scratch, 'seccomp-without-claude-rules.json');
    fs.writeFileSync(legacyPolicy, JSON.stringify(legacy));
    await runFixture(env, { policy, systemPaths: true });
    await runFixture(env, { policy, systemPaths: false, refused: true });
    await runFixture(env, { policy: legacyPolicy, systemPaths: true, refused: true });
    console.log(JSON.stringify({ pass: true, probe: 'claude-worker-container' }));
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}

async function runFixture(env, { policy, systemPaths, refused = false }) {
  const name = `claude-worker-probe-${randomUUID()}`;
  const runtime = `${name}-runtime`;
  const script = fileURLToPath(import.meta.url);
  const memoryMiB = Number(values['memory-mib']);
  assert.ok(Number.isInteger(memoryMiB) && memoryMiB >= 256 && memoryMiB <= 8192, 'Invalid memory budget');
  try {
    const child = spawn('docker', ['run', '--rm', '--init', '--name', name, '--read-only', '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges:true', '--security-opt', `seccomp=${policy}`,
      ...(values['skip-apparmor'] ? [] : ['--security-opt', 'apparmor=super-leader-codex']), ...(systemPaths ? ['--security-opt', 'systempaths=unconfined'] : []),
      '--user', '1000:1000', '--memory', `${memoryMiB}m`, '--memory-swap', `${memoryMiB}m`, '--cpus', '2',
      '--pids-limit', '512', '--tmpfs', '/tmp:size=64m,mode=1777',
      '--mount', `type=volume,src=${runtime},dst=${RUNTIME_ROOT}`,
      '--mount', `type=bind,src=${script},dst=/probe/claude-worker-container.mjs,readonly`,
      '--entrypoint', 'node', values.image, '/probe/claude-worker-container.mjs', '--container-fixture',
      ...(refused ? ['--expect-refused'] : []), ...(values['skip-apparmor'] ? ['--skip-apparmor'] : [])], { env, stdio: ['ignore', 'inherit', 'pipe'] });
    child.stderr.on('data', () => { /* Fixture diagnostics stay inside the container. */ });
    const timer = setTimeout(() => child.kill('SIGTERM'), FIXTURE_TIMEOUT_MS);
    try {
      const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
      assert.equal(exitCode, 0, `fixture failed (systempaths=${systemPaths}, refused=${refused})`);
    } finally { clearTimeout(timer); }
  } finally {
    // Only names generated for this invocation are eligible for removal.
    const cleanup = (args, absent) => {
      try { execFileSync('docker', args, { env, stdio: 'pipe', timeout: 15_000 }); }
      catch (error) { if (!absent || !String(error.stderr).includes(absent)) throw new Error('Fixture cleanup failed'); }
    };
    cleanup(['rm', '-f', name], 'No such container');
    cleanup(['volume', 'rm', runtime]);
  }
}

/** Minimal Anthropic Messages API that replays scripted tool calls for the current round. */
function anthropicFixture() {
  const state = { steps: [], output: undefined, results: new Map(), requests: [] };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { /* count_tokens and probes */ }
    if (!req.url.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: 1 })); return;
    }
    const tools = (body.tools ?? []).map(tool => tool.name);
    const results = (body.messages ?? []).flatMap(message => Array.isArray(message.content)
      ? message.content.filter(item => item.type === 'tool_result') : []);
    for (const result of results) state.results.set(result.tool_use_id, result);
    if (tools.includes('Bash')) state.requests.push({ messages: body.messages?.length ?? 0 });
    const next = state.steps.find(step => !state.results.has(step.id));
    let block, stop = 'tool_use';
    if (!tools.includes('Bash')) { block = { type: 'text', text: 'ok' }; stop = 'end_turn'; }
    else if (next) block = { type: 'tool_use', id: next.id, name: next.name, input: next.input };
    else if (tools.includes('StructuredOutput') && state.output && !state.results.has(state.output.id)) {
      block = { type: 'tool_use', id: state.output.id, name: 'StructuredOutput', input: state.output.input };
    } else { block = { type: 'text', text: 'done' }; stop = 'end_turn'; }
    const message = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: body.model ?? 'synthetic', content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ...message, content: [block], stop_reason: stop })); return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit('message_start', { message });
    if (block.type === 'tool_use') {
      emit('content_block_start', { index: 0, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
      emit('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    } else {
      emit('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      emit('content_block_delta', { index: 0, delta: { type: 'text_delta', text: block.text } });
    }
    emit('content_block_stop', { index: 0 });
    emit('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } });
    emit('message_stop', {});
    res.end();
  });
  return { state, server };
}

function resultText(result) { return typeof result?.content === 'string' ? result.content : JSON.stringify(result?.content ?? ''); }
function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

async function fixture() {
  probeStage = 'container-security';
  const { CodexWorkerRuntime, ClaudeCliExecutor, verifyClaudeSandbox } = await import('/app/dist/background/worker/index.js');
  const rootStatus = fs.readFileSync('/proc/self/status', 'utf8');
  assert.match(rootStatus, /CapEff:\s+0+\n/);
  assert.match(rootStatus, /NoNewPrivs:\s+1\n/);
  if (!values['skip-apparmor']) assert.match(fs.readFileSync('/proc/self/attr/current', 'utf8'), /super-leader-codex/);
  const check = { artifactRoot: ARTIFACT_ROOT, privateRoots: [RUNTIME_ROOT] };
  probeStage = 'startup-check';
  if (values['expect-refused']) {
    await assert.rejects(verifyClaudeSandbox(check), /BACKGROUND_EXECUTOR=claude refused/);
    console.log(JSON.stringify({ pass: true, probe: 'claude-startup-refused-without-sandbox' }));
    return;
  }
  await verifyClaudeSandbox(check);
  console.log(JSON.stringify({ pass: true, probe: 'claude-startup-check' }));

  const key = `${KEY_PREFIX}${randomUUID()}`;
  const { state, server } = anthropicFixture();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  // Stands in for the controller API, which listens on every address of the container.
  const local = http.createServer((_req, res) => res.end(LOCAL_MARKER));
  await new Promise(resolve => local.listen(0, '0.0.0.0', resolve));
  const localPort = local.address().port;
  const ownAddress = Object.values(os.networkInterfaces()).flat().find(item => item && !item.internal && item.family === 'IPv4')?.address;
  assert.ok(ownAddress, 'container has a non-loopback address');
  // Encoded so the command text names no host; a command naming denied hosts was not auto-approved in testing.
  const localHosts = Buffer.from(JSON.stringify(['127.0.0.1', 'localhost', '0.0.0.0', ownAddress, 'super-leader-gateway'])).toString('base64');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const runtime = new CodexWorkerRuntime({ root: WORKER_ROOT, artifactRoot: ARTIFACT_ROOT, model: 'claude-cli-default',
    timeoutMs: WORKER_TIMEOUT_MS, maxConcurrent: 1, onError: () => {},
    executor: new ClaudeCliExecutor({ artifactRoot: ARTIFACT_ROOT, privateRoots: [RUNTIME_ROOT], apiKey: key, baseUrl }) });
  const wait = async (workerId, invocationId) => {
    const until = Date.now() + WORKER_TIMEOUT_MS + 5_000;
    while (Date.now() < until) {
      const status = await runtime.inspect(workerId, invocationId);
      if (!['queued', 'running'].includes(status.status)) return status;
      await delay(100);
    }
    throw new Error('Worker timeout');
  };
  try {
    const workerId = randomUUID(), marker = randomUUID();
    const workerDir = path.join(WORKER_ROOT, 'workers', workerId);
    const home = path.join(workerDir, 'home');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'secret-probe'), 'non-secret home fixture');
    const sibling = path.join(WORKER_ROOT, 'workers', randomUUID(), 'workspace');
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'secret-probe'), 'non-secret sibling fixture');
    fs.writeFileSync(path.join(ARTIFACT_ROOT, 'outside.txt'), 'non-secret artifact fixture');
    fs.writeFileSync(path.join(SETTINGS_ROOT, 'secret-probe.json'), '{"fixture":"non-secret settings"}');
    // Another worker's live temp directory in the controller's shared /tmp.
    fs.mkdirSync(PEER_TEMP, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(PEER_TEMP, 'secret-probe'), 'non-secret peer temp fixture');
    fs.writeFileSync(`${PEER_TEMP}-file`, 'non-secret peer temp file');
    const denied = `const denied=p=>{try{fs.readFileSync(p);return false}catch{return true}};`;
    const round1 = `const fs=require('node:fs'),cp=require('node:child_process');${denied}
const environs=fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)).filter(p=>{try{return fs.readFileSync('/proc/'+p+'/environ','utf8').includes('${KEY_PREFIX}')}catch{return false}});
const wrote=p=>{try{fs.writeFileSync(p,'x');return true}catch{return false}};
const report={marker:${JSON.stringify(marker)},round:1,keyHidden:!Object.values(process.env).some(v=>String(v).includes('${KEY_PREFIX}')),
 procKeyHidden:environs.length===0,siblingHidden:denied('${sibling}/secret-probe'),homeHidden:denied('${home}/secret-probe'),
 artifactHidden:denied('${ARTIFACT_ROOT}/outside.txt'),peerTempHidden:denied('${PEER_TEMP}/secret-probe'),settingsHidden:denied('${SETTINGS_ROOT}/secret-probe.json'),
 userNamespaceDenied:cp.spawnSync('unshare',['-U','true']).status!==0,settingsWriteDenied:!wrote('${SETTINGS_ROOT}/sandbox-write'),
 tmpOverwriteDenied:!wrote('${PEER_TEMP}-file'),tempPrivate:String(process.env.TMPDIR).startsWith('/tmp/slc-')&&wrote(process.env.TMPDIR+'/probe'),proxied:!!process.env.HTTPS_PROXY,
 composeServiceDenied:cp.spawnSync('curl',['-s','-o','/dev/null','-w','%{http_code}','-m','5','http://postgres:5432/']).stdout.toString()==='403',
 localDenied:JSON.parse(Buffer.from('${localHosts}','base64').toString()).every(h=>{const r=cp.spawnSync('curl',['-s','-m','5','-w','\\n%{http_code}','--noproxy','','-x',process.env.HTTP_PROXY,'http://'+h+':${localPort}/']).stdout.toString();return r.endsWith('\\n403')&&!r.includes('${LOCAL_MARKER}')}),
 directLocalDenied:!cp.spawnSync('curl',['-s','-m','5','http://'+JSON.parse(Buffer.from('${localHosts}','base64').toString())[2]+':${localPort}/']).stdout.toString().includes('${LOCAL_MARKER}'),
 kernelInfoHidden:${values['skip-apparmor'] ? 'true' : "['/proc/interrupts','/proc/latency_stats','/proc/timer_list','/proc/keys'].every(denied)"}};
fs.writeFileSync('seed.txt',report.marker);fs.writeFileSync('report.json',JSON.stringify(report));`;
    const round2 = `const fs=require('node:fs');const report=JSON.parse(fs.readFileSync('report.json','utf8'));if(fs.readFileSync('seed.txt','utf8')!==report.marker)throw Error('seed mismatch');report.round=2;report.resumed=true;fs.writeFileSync('report.json',JSON.stringify(report));`;
    const output = { status: 'completed', summary: 'Claude Linux probe completed', nextCheckAt: null, attachments: ['report.json'] };
    let threadId;
    for (const [round, js] of [[1, round1], [2, round2]]) {
      probeStage = `worker-round-${round}`;
      const prefix = `toolu_r${round}_`;
      state.steps = [{ id: `${prefix}bash`, name: 'Bash', input: { command: `node -e ${shellQuote(js.replaceAll('\n', ''))}`, description: 'probe' } },
        ...(round === 1 ? [
          { id: `${prefix}read_sibling`, name: 'Read', input: { file_path: `${sibling}/secret-probe` } },
          { id: `${prefix}read_settings`, name: 'Read', input: { file_path: `${SETTINGS_ROOT}/secret-probe.json` } },
          { id: `${prefix}fetch_local`, name: 'WebFetch', input: { url: `http://127.0.0.1:${localPort}/`, prompt: 'Return the page' } },
          { id: `${prefix}write_settings`, name: 'Write', input: { file_path: `${SETTINGS_ROOT}/tool-write`, content: 'x' } },
        ] : [])];
      state.output = { id: `${prefix}output`, input: output };
      const requestsBefore = state.requests.length;
      const invocationId = randomUUID();
      await runtime.start({ workerId, invocationId, task: 'Run the scripted probe', input: { round } });
      const status = await wait(workerId, invocationId);
      if (status.status !== 'completed') {
        console.log(JSON.stringify({ pass: false, probe: probeStage, status: status.status, error: status.error,
          tools: [...state.results.values()].map(result => resultText(result).slice(0, 300)) }));
      }
      assert.equal(status.status, 'completed');
      assert.ok(status.threadId);
      if (threadId) assert.equal(status.threadId, threadId, 'resumed Claude session keeps its ID');
      threadId = status.threadId;
      const bash = resultText(state.results.get(`${prefix}bash`));
      assert.equal(state.results.get(`${prefix}bash`)?.is_error ?? false, false, `Bash failed: ${bash.slice(0, 300)}`);
      if (round === 1) {
        const fetched = resultText(state.results.get(`${prefix}fetch_local`));
        assert.doesNotMatch(fetched, new RegExp(LOCAL_MARKER), `fetch_local: ${fetched.slice(0, 300)}`);
        assert.match(fetched, /denied|not allowed|blocked|refuse/i, `fetch_local: ${fetched.slice(0, 300)}`);
        for (const id of ['read_sibling', 'read_settings', 'write_settings']) {
          const text = resultText(state.results.get(`${prefix}${id}`));
          assert.match(text, /denied|refuse|outside/i, `${id}: ${text.slice(0, 300)}`);
          assert.doesNotMatch(text, /non-secret/, id);
        }
        assert.equal(fs.existsSync(`${SETTINGS_ROOT}/tool-write`), false);
      } else {
        // The resumed turn sent the first turn's transcript back to the API.
        assert.ok(state.requests[requestsBefore].messages > 1, 'second turn resumed the stored session');
      }
      const artifacts = await runtime.exportArtifacts(workerId, invocationId);
      const report = JSON.parse(fs.readFileSync(artifacts.find(item => item.name === 'report.json').path, 'utf8'));
      assert.equal(report.marker, marker); assert.equal(report.round, round);
      for (const name of ['keyHidden', 'procKeyHidden', 'siblingHidden', 'homeHidden', 'artifactHidden', 'peerTempHidden', 'tmpOverwriteDenied', 'settingsHidden',
        'userNamespaceDenied', 'settingsWriteDenied', 'tempPrivate', 'proxied', 'composeServiceDenied',
        'localDenied', 'directLocalDenied', 'kernelInfoHidden']) {
        assert.equal(report[name], true, name);
      }
      assert.equal(fs.readFileSync(`${PEER_TEMP}-file`, 'utf8'), 'non-secret peer temp file', 'sandboxed Bash overwrote shared temp');
      // The per-worker temp root is removed with the turn.
      assert.deepEqual(fs.readdirSync('/tmp').filter(name => name.startsWith('slc-') && !`/tmp/${name}`.startsWith(PEER_TEMP)), []);
      if (round === 2) assert.equal(report.resumed, true);
      assert.equal(fs.existsSync(`${SETTINGS_ROOT}/sandbox-write`), false);
      console.log(JSON.stringify({ pass: true, probe: 'claude-sandbox-isolation-resume', round }));
    }
    await runtime.cleanup(workerId);
    assert.equal(fs.existsSync(workerDir), false);
    const peakBytes = Number(fs.readFileSync('/sys/fs/cgroup/memory.peak', 'utf8'));
    console.log(JSON.stringify({ pass: true, probe: 'claude-worker-cleanup', memoryPeakMiB: Math.round(peakBytes / 1048576) }));
  } finally {
    await runtime.shutdown();
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => local.close(resolve));
  }
}
