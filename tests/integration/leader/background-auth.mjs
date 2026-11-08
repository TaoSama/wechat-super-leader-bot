import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { waitFor } from '../../support/control-plane-fixture.mjs';
import { closeTestWebSocket, stopTestProcess, withTestCleanup } from '../../support/cleanup.mjs';
import { verificationEnvironment } from '../../../scripts/verify.mjs';

const CHAT = 'auth-fixture-chat', NODE = 'auth-fixture-node', SOURCE = 'auth-fixture-source';
const SECRET = 'synthetic-auth-secret-canary';
const { values } = parseArgs({ options: { run: { type: 'boolean' },
  'fixture-server': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
if (values['fixture-server']) await serve();
else if (!values.run || values.help) console.log('Usage: node tests/integration/leader/background-auth.mjs --run\nRuns the built Controller HTTP/scheduler/result flow with controlled Codex and Claude executables, task-scoped selection and a native authentication-error fixture. No real providers, daemon sessions or WeChat. Compose peer DNS and sandbox posture are simulated; this is not a sandbox security test.');
else await verify().catch(error => { console.error(error); process.exitCode = 1; });

async function serve() {
  if (!process.send) throw new Error('Private fixture IPC required');
  const { loadConfig } = await import('../../../controller/dist/runtime/config.js');
  const { ControllerServer } = await import('../../../controller/dist/http/server.js');
  const { MemoryStore } = await import('../../../controller/dist/store/memory.js');
  const { CLAUDE_PEER_HOSTS } = await import('../../../controller/dist/background/worker/claude-network.js');
  const { default: dns } = await import('node:dns/promises');
  const { syncBuiltinESMExports } = await import('node:module');
  // This fixture has no Compose peers; external DNS must not determine whether the CLI starts.
  dns.lookup = async host => {
    if (!CLAUDE_PEER_HOSTS.includes(host)) throw new Error('Unexpected fixture DNS lookup');
    process.send({ type: 'peer-dns' });
    throw Object.assign(new Error('Synthetic absent Compose peer'), { code: 'ENOTFOUND' });
  };
  syncBuiltinESMExports();
  const app = new ControllerServer({ ...loadConfig(), port: 0 }, new MemoryStore());
  await app.start();
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    void app.stop().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop); process.on('disconnect', stop);
  process.send({ type: 'ready', base: `http://127.0.0.1:${app.getHttpServer().address().port}` });
}

async function controlledClaude(native, preparationMarker) {
  const fs = await import('node:fs');
  const { parseArgs } = await import('node:util');
  const { randomUUID } = await import('node:crypto');
  const { positionals } = parseArgs({ allowPositionals: true, strict: false, options: {
    settings: { type: 'string' }, 'setting-sources': { type: 'string' },
  } });
  if (positionals.includes('sandbox') && positionals.includes('status')) {
    if (!fs.existsSync(preparationMarker)) {
      fs.writeFileSync(preparationMarker, 'first preparation refused');
      console.log(JSON.stringify({ enabled: false, strictMode: true, unavailableReason: 'synthetic temporary failure' })); return;
    }
    console.log(JSON.stringify({ enabled: true, strictMode: true })); return;
  }
  if (process.env.CONTROLLER_TOKEN || process.env.NODE_TOKENS) throw new Error('Controller credentials reached worker');
  let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
  const mode = prompt.match(/CASE=([a-z-]+)/)?.[1];
  if (!mode) throw new Error('Missing fixture mode');
  fs.writeFileSync('observed-executor.json', JSON.stringify({ mode, executor: 'claude' }));
  const count = fs.existsSync('launch-count.txt') ? Number(fs.readFileSync('launch-count.txt', 'utf8')) : 0;
  fs.writeFileSync('launch-count.txt', String(count + 1));
  const session_id = randomUUID(), emit = event => console.log(JSON.stringify({ session_id, ...event }));
  emit({ type: 'system', subtype: 'init' });
  const output = { status: 'completed', summary: 'synthetic completed report', nextCheckAt: null, attachments: [] };
  const success = { type: 'result', subtype: 'success', is_error: false, structured_output: output };
  if (mode === 'after-tool') {
    fs.writeFileSync('side-effect.txt', 'preserved');
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool1', name: 'Write', input: { private: process.env.ANTHROPIC_API_KEY } }] } });
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool1', content: process.env.ANTHROPIC_API_KEY }] } });
  }
  if (mode !== 'ordinary-failure' && mode !== 'success') {
    native.assistant.message.content[0].text += ' ' + process.env.ANTHROPIC_API_KEY;
    native.result.result += ' ' + process.env.ANTHROPIC_API_KEY;
    emit(native.assistant);
  }
  if (mode === 'recovered' || mode === 'success') { emit(success); return; }
  if (mode === 'ordinary-failure') emit({ ...native.result, terminal_reason: 'unknown', result: process.env.ANTHROPIC_API_KEY });
  else emit(native.result);
  process.exitCode = 1;
}

async function controlledCodex() {
  const fs = await import('node:fs');
  const { randomUUID } = await import('node:crypto');
  if (process.env.CONTROLLER_TOKEN || process.env.NODE_TOKENS) throw new Error('Controller credentials reached worker');
  let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
  const mode = prompt.match(/CASE=([a-z-]+)/)?.[1];
  if (mode !== 'default-codex') throw new Error('An explicit Claude task reached Codex');
  fs.writeFileSync('observed-executor.json', JSON.stringify({ mode, executor: 'codex' }));
  fs.writeFileSync('launch-count.txt', '1');
  const emit = event => console.log(JSON.stringify(event));
  emit({ type: 'thread.started', thread_id: randomUUID() });
  emit({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({
    status: 'completed', summary: 'synthetic completed report', nextCheckAt: null, attachments: [],
  }) } });
  emit({ type: 'turn.completed' });
}

async function verify() {
  const require = createRequire(new URL('../../../controller/package.json', import.meta.url));
  const { WebSocket } = require('ws');
  const directory = await mkdtemp(path.join(tmpdir(), 'leader-auth-http-'));
  const workerRoot = path.join(directory, 'background', 'workers');
  const token = randomUUID(), nodeToken = randomUUID();
  const native = JSON.parse(await readFile(new URL('../../../controller/tests/background/worker/fixtures/claude-authentication-failed.json', import.meta.url), 'utf8'));
  const executable = path.join(directory, 'controlled-claude.mjs');
  const codexExecutable = path.join(directory, 'controlled-codex.mjs');
  let child, socket, base, heartbeat, preflightWorkerId, peerDnsLookups = 0;
  const logs = [], frames = [], errors = [], observations = [], outcomes = [];
  const send = frame => socket.send(JSON.stringify(frame), error => { if (error) errors.push(error); });
  await withTestCleanup(async () => {
    await writeFile(executable, `#!${process.execPath}\n(${controlledClaude.toString()})(${JSON.stringify(native)}, ${JSON.stringify(path.join(directory, 'preparation-marker'))}).catch(error => { console.error(error); process.exitCode = 1; });\n`, { mode: 0o700 });
    await writeFile(codexExecutable, `#!${process.execPath}\n(${controlledCodex.toString()})().catch(error => { console.error(error); process.exitCode = 1; });\n`, { mode: 0o700 });
    child = fork(fileURLToPath(import.meta.url), ['--fixture-server'], { env: {
      ...verificationEnvironment(), PERSISTENCE_MODE: 'memory', CONTROLLER_TOKEN: token,
      NODE_TOKENS: JSON.stringify({ [NODE]: nodeToken }), ALLOWED_CHAT_IDS: CHAT,
      LEADER_MODE: 'rules', CONTROLLER_DATA_ROOT: directory, TASK_NOTIFICATION_TICK_MS: '100',
      BACKGROUND_WORKER_ROOT: workerRoot,
      BACKGROUND_MODEL_NAME: 'synthetic-unused-codex', BACKGROUND_MODEL_BASE_URL: 'https://codex.fixture.invalid/v1',
      BACKGROUND_MODEL_API_KEY: 'synthetic-unused-codex-key', BACKGROUND_CLAUDE_PATH: executable,
      BACKGROUND_CODEX_PATH: codexExecutable, BACKGROUND_EXECUTOR: 'claude',
      BACKGROUND_CLAUDE_API_KEY: SECRET, BACKGROUND_CLAUDE_BASE_URL: 'https://fixture.invalid',
      BACKGROUND_TURN_TIMEOUT_MS: '10000',
    }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.on('error', error => errors.push(error));
    for (const stream of [child.stdout, child.stderr]) stream.on('data', data => logs.push(data.toString()));
    child.on('message', message => {
      if (message?.type === 'ready') base = message.base;
      if (message?.type === 'peer-dns') peerDnsLookups++;
    });
    await waitFor(() => {
      if (errors.length) throw errors[0];
      if (child.exitCode !== null) throw new Error('Controller exited before readiness');
      return !!base;
    }, 'auth Controller readiness');
    const request = async (route, body) => {
      if (errors.length) throw errors[0];
      const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5_000) });
      const bodyText = await response.text();
      assert(response.ok, `${route}: HTTP ${response.status}: ${bodyText}`); return JSON.parse(bodyText);
    };
    socket = new WebSocket(base.replace('http:', 'ws:') + '/v1/daemon', { headers: { authorization: `Bearer ${nodeToken}` } });
    socket.on('error', error => errors.push(error)); await once(socket, 'open');
    socket.on('message', raw => {
      try {
        const frame = JSON.parse(raw.toString()); frames.push(frame.type);
        if (frame.type === 'command') throw new Error('Monitoring dispatched into a source session');
        if (frame.type === 'list_automations') send({ type: 'automation_response', requestId: frame.requestId,
          automations: [{ id: SOURCE, name: 'synthetic daily', kind: 'heartbeat', status: 'ACTIVE', prompt: '', rrule: '' }] });
        if (frame.type === 'inspect_automation') {
          const observation = { automationId: SOURCE, expectedAt: frame.expectedAt, notAfter: frame.notAfter,
            status: 'completed', text: 'synthetic completed report', sessionId: 'synthetic-source', turnId: 'exact-source-turn',
            observedAt: Date.now(), sources: ['synthetic-native-receipt'] };
          observations.push(observation); send({ type: 'automation_response', requestId: frame.requestId, inspection: observation });
        }
      } catch (error) { errors.push(error); }
    });
    send({ type: 'hello', version: 1, nodeId: NODE, sessions: [], skills: [] });
    heartbeat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) send({ type: 'heartbeat', sessions: [], skills: [] }); }, 250);
    await waitFor(async () => (await request(`/v1/source-automations?nodeId=${NODE}`)).items.length === 1, 'source discovery');
    for (const mode of ['preparation-failure', 'default-codex', 'authentication', 'after-tool', 'ordinary-failure', 'recovered', 'success']) {
      const preflight = mode === 'preparation-failure';
      const success = mode === 'default-codex' || mode === 'recovered' || mode === 'success';
      const executor = mode === 'default-codex' ? 'codex' : 'claude';
      const { schedule } = await request('/v1/automations', { chatId: CHAT, input: { kind: 'background', title: `CASE=${mode}`,
        timing: { type: 'at', at: new Date().toISOString() }, timezone: 'Asia/Shanghai', retention: 'retain',
        background: { ...(executor === 'claude' ? { executor } : {}), prompt: `CASE=${mode}`,
          sources: [{ nodeId: NODE, automationId: SOURCE }] } } });
      let run;
      await waitFor(async () => {
        run = (await request(`/v1/automations/${schedule.id}/runs?chatId=${CHAT}`)).items[0];
        return run?.status === (success ? 'completed' : 'failed');
      }, `${mode} terminal outcome`);
      const { task } = await request(`/v1/background-tasks/${run.id}?chatId=${CHAT}`);
      assert.equal(task.executor, executor);
      assert.equal(task.observations[0].status, 'completed'); assert.equal(task.observations[0].text, 'synthetic completed report');
      const auth = mode === 'authentication' || mode === 'after-tool';
      if (preflight) assert.equal(run.result.error, 'worker_executor_unavailable');
      else if (auth) assert.equal(run.result.error, 'worker_authentication_failed');
      else if (!success) assert.equal(run.result.error, 'worker_execution_unverified');
      else assert.equal(run.result.text, 'synthetic completed report');
      let delivery;
      await waitFor(async () => {
        delivery = (await request('/v1/deliveries')).items.find(item => item.source.id === schedule.id);
        return !!delivery;
      }, `${mode} result queued`);
      assert.equal(delivery.kind, success ? 'completed' : 'failed');
      const findDiagnostic = () => logs.join('').split('\n').slice(0, -1)
        .filter(line => line.startsWith('{')).map(line => JSON.parse(line))
        .find(event => event.event === 'background_worker_failed' && event.runId === run.id);
      if (!success) await waitFor(findDiagnostic, `${mode} correlated diagnostic`);
      const diagnostic = findDiagnostic();
      if (success) assert.equal(diagnostic, undefined);
      else {
        assert.ok(diagnostic?.workerId && diagnostic.invocationId);
        assert.equal(diagnostic.category, preflight ? 'not_started' : auth ? 'authentication_failed' : 'execution_unverified');
        assert.equal(diagnostic.executionEvidence, preflight ? 'not_started' : mode === 'after-tool' ? 'tool_activity_observed' : 'unverified');
        if (preflight) preflightWorkerId = diagnostic.workerId;
        const workspace = path.join(workerRoot, 'workers', diagnostic.workerId, 'workspace');
        if (preflight) await assert.rejects(readFile(path.join(workspace, 'launch-count.txt'), 'utf8'), { code: 'ENOENT' });
        if (mode === 'after-tool') assert.equal(await readFile(path.join(workspace, 'side-effect.txt'), 'utf8'), 'preserved');
      }
      for (let repeat = 0; repeat < 3; repeat++) await request(`/v1/background-tasks/${run.id}?chatId=${CHAT}`);
      if (diagnostic && !preflight) {
        const workspace = path.join(workerRoot, 'workers', diagnostic.workerId, 'workspace');
        assert.equal(await readFile(path.join(workspace, 'launch-count.txt'), 'utf8'), '1');
      }
      const cliExecutions = await Promise.all((await readdir(path.join(workerRoot, 'workers'))).filter(workerId => workerId !== preflightWorkerId).map(async workerId => {
        const workspace = path.join(workerRoot, 'workers', workerId, 'workspace');
        return JSON.parse(await readFile(path.join(workspace, 'observed-executor.json'), 'utf8'));
      }));
      assert.deepEqual(cliExecutions.filter(item => item.mode === mode), preflight ? [] : [{ mode, executor }]);
      const serialized = JSON.stringify({ task, run, delivery, diagnostic, logs });
      for (const secret of [SECRET, token, nodeToken, 'synthetic-auth-error-canary']) assert(!serialized.includes(secret), 'Secret/provider text escaped');
      outcomes.push({ mode, status: run.status, category: diagnostic?.category, executionEvidence: diagnostic?.executionEvidence,
        sourceStatus: task.observations[0].status, deliveryKind: delivery.kind, actualCli: preflight ? null : executor, queueOnly: true });
    }
    assert.equal(observations.length, 7); assert(!frames.includes('command')); assert.equal(errors.length, 0);
    assert.equal(peerDnsLookups, 30, 'Only the five Claude CLI runs resolve their six absent peers locally');
    console.log(JSON.stringify({ pass: true, surface: 'actual Controller HTTP/scheduler/CLI/results', outcomes,
      legacyGlobalExecutor: 'claude', defaultTaskExecutor: 'codex',
      sourceCommands: 0, realProviders: 0, realWeChat: 0, peerDnsLookups, securityBoundaryVerified: false }));
  }, [
    { label: 'heartbeat', cleanup: () => clearInterval(heartbeat) },
    { label: 'synthetic WebSocket', cleanup: () => closeTestWebSocket(socket) },
    { label: 'Controller', cleanup: () => stopTestProcess(child) },
    { label: 'isolated files', cleanup: () => rm(directory, { recursive: true, force: true }) },
  ]);
}
