import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createControllerFixture, waitFor } from '../../support/control-plane-fixture.mjs';
import { closeTestWebSocket, stopTestProcess, withTestCleanup } from '../../support/cleanup.mjs';
import { verificationEnvironment } from '../../../scripts/verify.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CHAT = 'fixture-native-error-chat';
const NODE = 'fixture-native-error-node';
const MODEL = 'fixture-native-error-model';
const HTTP_TIMEOUT_MS = 5_000;
const CHECK_INTERVAL_MS = 1_000;
const DEADLINE_MS = 60_000;
const { values } = parseArgs({ options: { run: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
if (!values.run || values.help) {
  console.log('Usage: node tests/integration/leader/native-source-failure.mjs --run\nRequires a built Controller, Go and Node >=24. Starts actual Controller/daemon CLIs with private native SQLite/rollout fixtures and a controlled model CLI. No production sessions, WeChat, real model or service reload.');
} else await verifyNativeSourceFailure().catch(error => { console.error(error); process.exitCode = 1; });

async function controlledCodex(receiptPath, model) {
  const { appendFile } = await import('node:fs/promises');
  const { randomUUID } = await import('node:crypto');
  const { parseArgs } = await import('node:util');
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    json: { type: 'boolean' }, 'ignore-user-config': { type: 'boolean' }, 'ignore-rules': { type: 'boolean' },
    'skip-git-repo-check': { type: 'boolean' }, model: { type: 'string' },
    'output-schema': { type: 'string' }, config: { type: 'string', multiple: true },
  } });
  if (positionals[0] !== 'exec' || values.model !== model || !values['ignore-user-config'] ||
      !values['ignore-rules'] || process.env.CONTROLLER_TOKEN || process.env.NODE_TOKEN) throw new Error('Unisolated model fixture');
  let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
  const match = prompt.match(/<observations>([\s\S]*)<\/observations>$/);
  if (!match) throw new Error('Missing native observations');
  const input = JSON.parse(match[1]);
  await appendFile(receiptPath, JSON.stringify(input) + '\n');
  for (const event of [{ type: 'thread.started', thread_id: randomUUID() },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ status: 'completed',
      summary: JSON.stringify(input), nextCheckAt: null, attachments: [] }) } }, { type: 'turn.completed' }]) {
    process.stdout.write(JSON.stringify(event) + '\n');
  }
}

function nativeStart(automationId, turnId, at) {
  return [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turnId,
      turn_attribution: { turn_trigger: 'automation_heartbeat_scheduled' } } },
    { type: 'response_item', payload: { type: 'message', role: 'user',
      content: [{ text: `<heartbeat><automation_id>${automationId}</automation_id><current_time_iso>${new Date(at).toISOString()}</current_time_iso></heartbeat>` }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId } } },
  ].map(record => JSON.stringify(record) + '\n').join('');
}

function nativeFinal(turnId, text) {
  return JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer',
    content: [{ text }], internal_chat_message_metadata_passthrough: { turn_id: turnId } } }) + '\n';
}

export async function verifyNativeSourceFailure() {
  const directory = await mkdtemp(path.join(tmpdir(), 'leader-native-error-'));
  const home = path.join(directory, 'codex');
  const env = verificationEnvironment();
  const token = randomBytes(24).toString('hex'), nodeToken = randomBytes(24).toString('hex');
  const initialAt = Math.floor(Date.now() / 60_000) * 60_000;
  const clockPath = path.join(directory, 'clock'), clockModule = path.join(directory, 'clock.mjs');
  const binary = path.join(directory, 'daemon'), fakeCodex = path.join(directory, 'model.mjs');
  const receiptPath = path.join(directory, 'model-inputs.jsonl');
  const frames = [], sockets = new Set(), errors = [], logs = [];
  let controller, daemon, proxy;
  const require = createRequire(new URL('../../../controller/package.json', import.meta.url));
  const { WebSocket, WebSocketServer } = require('ws');
  await withTestCleanup(async () => {
    await mkdir(path.join(home, 'sessions'), { recursive: true });
    await mkdir(path.join(home, 'sqlite'));
    await writeFile(clockPath, String(initialAt));
    await writeFile(receiptPath, '');
    await writeFile(clockModule, `import { readFileSync } from 'node:fs';\nconst RealDate = Date;\nconst now = () => Number(readFileSync(${JSON.stringify(clockPath)}, 'utf8'));\nglobalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [now()])); } static now() { return now(); } };\n`);
    await writeFile(fakeCodex, `#!${process.execPath}\n(${controlledCodex.toString()})(${JSON.stringify(receiptPath)}, ${JSON.stringify(MODEL)}).catch(error => { console.error(error); process.exitCode = 1; });\n`, { mode: 0o700 });
    execFileSync('go', ['build', '-o', binary, './cmd/super-leader-daemon'], {
      cwd: path.join(ROOT, 'daemon'), env, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const native = new DatabaseSync(path.join(home, 'sqlite', 'codex-dev.db'));
    const state = new DatabaseSync(path.join(home, 'state_5.sqlite'));
    try {
      native.exec('CREATE TABLE automations(id TEXT PRIMARY KEY,kind TEXT,target_thread_id TEXT,last_run_at INTEGER,next_run_at INTEGER)');
      state.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT)');
      for (const id of ['target', 'pending']) {
        await mkdir(path.join(home, 'automations', id), { recursive: true });
        await writeFile(path.join(home, 'automations', id, 'automation.toml'),
          `id='${id}'\nkind='heartbeat'\nname='Fixture'\nstatus='ACTIVE'\nprompt='Read fixture'\nrrule='FREQ=DAILY'\ntarget_thread_id='thread-${id}'\n`);
        native.prepare('INSERT INTO automations VALUES(?,?,?,?,?)').run(id, 'heartbeat', `thread-${id}`, initialAt, initialAt + 86_400_000);
        state.prepare('INSERT INTO threads VALUES(?,?)').run(`thread-${id}`, path.join(home, 'sessions', `${id}.jsonl`));
      }
    } finally { native.close(); state.close(); }
    const occurrence = initialAt + 2_000;
    const targetPath = path.join(home, 'sessions', 'target.jsonl');
    const fixture = await readFile(path.join(ROOT, 'daemon/pkg/automation/testdata/task-complete-error.jsonl'), 'utf8');
    await writeFile(targetPath, fixture.replaceAll('2026-10-18T04:02:31Z', new Date(occurrence).toISOString()));
    await writeFile(path.join(home, 'sessions', 'pending.jsonl'), nativeStart('pending', 'pending-turn', occurrence));
    controller = await createControllerFixture({ env: { ...env, PERSISTENCE_MODE: 'memory',
      CONTROLLER_TOKEN: token, NODE_TOKENS: JSON.stringify({ [NODE]: nodeToken }), ALLOWED_CHAT_IDS: CHAT,
      LEADER_MODE: 'rules', TASK_NOTIFICATION_TICK_MS: '100', CONTROLLER_DATA_ROOT: path.join(directory, 'controller'),
      BACKGROUND_WORKER_ROOT: path.join(directory, 'controller', 'workers'), BACKGROUND_ARTIFACT_ROOT: path.join(directory, 'controller', 'artifacts'),
      BACKGROUND_CODEX_PATH: fakeCodex, BACKGROUND_MODEL_NAME: MODEL,
      BACKGROUND_MODEL_BASE_URL: 'https://fixture.invalid/v1', BACKGROUND_MODEL_API_KEY: 'synthetic-key',
      BACKGROUND_TURN_TIMEOUT_MS: '10000', NODE_OPTIONS: `--import=${pathToFileURL(clockModule).href}`,
    }, secrets: [token, nodeToken], logs });
    await controller.start();
    // Audit actual Controller-to-daemon frames; a monitor must never dispatch a source command.
    proxy = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    proxy.on('error', error => errors.push(error));
    proxy.on('connection', (downstream, request) => {
      sockets.add(downstream);
      const upstream = new WebSocket(controller.base.replace('http:', 'ws:') + '/v1/daemon', {
        headers: { authorization: request.headers.authorization },
      });
      sockets.add(upstream);
      const queued = [];
      const send = (socket, raw) => socket.send(raw, { binary: false }, error => { if (error) errors.push(error); });
      downstream.on('message', raw => { if (upstream.readyState === WebSocket.OPEN) send(upstream, raw); else queued.push(raw); });
      upstream.on('open', () => { for (const raw of queued) send(upstream, raw); queued.length = 0; });
      upstream.on('message', raw => {
        try { const frame = JSON.parse(raw.toString()); frames.push(frame); assert.notEqual(frame.type, 'command', 'Monitor dispatched a source command'); }
        catch (error) { errors.push(error); return; }
        send(downstream, raw);
      });
      for (const socket of [upstream, downstream]) socket.on('error', error => errors.push(error));
    });
    await once(proxy, 'listening');
    daemon = spawn(binary, ['--node-id', NODE, '--controller-url', `ws://127.0.0.1:${proxy.address().port}`,
      '--codex-home', home, '--sock', path.join(directory, 'missing.sock'), '--state-dir', path.join(directory, 'journal'), '--heartbeat', '1'], {
      env: { ...env, HOME: directory, CODEX_HOME: home, NODE_TOKEN: nodeToken }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    daemon.on('error', error => errors.push(error));
    for (const stream of [daemon.stdout, daemon.stderr]) stream.on('data', bytes => { logs.push(bytes.toString()); if (logs.length > 100) logs.shift(); });
    const request = async (route, body, key) => {
      if (errors.length) throw errors[0];
      const response = await fetch(controller.base + route, { method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      return { status: response.status, data: await response.json() };
    };
    const ok = async (...args) => { const res = await request(...args); assert(res.status >= 200 && res.status < 300, JSON.stringify(res)); return res.data; };
    const inspect = async id => request(`/v1/source-automations/${id}?nodeId=${NODE}&expectedAt=${occurrence}&notAfter=${occurrence + DEADLINE_MS}`);
    await waitFor(async () => (await inspect('target')).data.observation?.status === 'failed', 'Actual daemon parses terminal error');
    const failed = (await inspect('target')).data.observation;
    assert.equal(failed.turnId, 'scheduled-turn'); assert.equal(failed.text, undefined);
    assert.equal(failed.reason, 'scheduled turn was aborted or failed');
    console.log('OBS actual HTTP source evidence', JSON.stringify(failed));
    console.log('PASS actual Controller HTTP → authenticated daemon CLI → native SQLite/rollout: exact scheduled turn failed; later manual final ignored');
    const schedule = (await ok('/v1/automations', { chatId: CHAT, input: { kind: 'background', title: 'Native source failure',
      timing: { type: 'at', at: new Date(occurrence).toISOString() }, timezone: 'UTC', retention: 'retain', background: {
        prompt: 'Summarize exact source observations; never claim failed sources succeeded', deadlineMs: DEADLINE_MS,
        checkIntervalsMs: [CHECK_INTERVAL_MS], sources: ['target', 'pending'].map(automationId => ({ nodeId: NODE, automationId, windowMs: DEADLINE_MS })),
      } } }, randomUUID())).schedule;
    const runs = async () => (await ok(`/v1/automations/${schedule.id}/runs?chatId=${CHAT}`)).items;
    const worker = async () => { const run = (await runs())[0]; return run && (await ok(`/v1/background-tasks/${run.id}?chatId=${CHAT}`)).task; };
    const deliveries = async () => (await ok('/v1/deliveries')).items.filter(item => item.source.type === 'automation' && item.source.id === schedule.id);
    const advance = async at => {
      await writeFile(`${clockPath}.next`, String(at));
      await rename(`${clockPath}.next`, clockPath);
    };
    await advance(occurrence + 1);
    await waitFor(async () => (await worker())?.checkCount >= 1 && (await deliveries()).filter(item => item.kind === 'failed').length === 1, 'Single failure alert');
    let current = await worker();
    assert.equal(current.phase, 'observing'); assert.deepEqual(current.observations.map(item => item.status), ['failed', 'running']);
    assert.equal(current.followups.length, 1); assert.equal(current.followups[0].status, 'failed');
    assert.equal(await readFile(receiptPath, 'utf8'), '', 'Observation must not start a model');
    for (let i = 0; i < 2; i++) {
      const turnId = `manual-later-${i}`;
      await appendFile(targetPath,
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', turn_id: turnId, turn_attribution: null } }) + '\n' +
        nativeFinal(turnId, 'Unrelated later report') +
        JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: turnId } }) + '\n');
      const checks = current.checkCount; await advance(current.nextCheckAt + 1);
      await waitFor(async () => (await worker()).checkCount > checks, 'Repeated source failure observation'); current = await worker();
      assert.equal(current.phase, 'observing'); assert.equal(current.observations[0].status, 'failed');
      assert.equal(current.observations[0].turnId, 'scheduled-turn'); assert.equal(current.followups.length, 1);
      assert.equal((await deliveries()).filter(item => item.kind === 'failed').length, 1);
      assert.equal(await readFile(receiptPath, 'utf8'), '', 'Rechecking must not start a model');
    }
    console.log('PASS failed+running remains observing; repeated exact failure and three manual continuations retain one failure notification, zero model launches');
    await appendFile(path.join(home, 'sessions', 'pending.jsonl'), nativeFinal('pending-turn', 'Exact normal result') +
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', turn_id: 'pending-turn', error: null } }) + '\n');
    await advance(current.nextCheckAt + 1);
    await waitFor(async () => (await runs())[0]?.status === 'completed', 'All sources settled without waiting for deadline');
    await waitFor(async () => (await deliveries()).some(item => item.kind === 'completed'), 'Summary queued');
    current = await worker();
    const inputs = (await readFile(receiptPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(inputs.length, 1); assert.equal(inputs[0].deadlineReached, false);
    assert.deepEqual(inputs[0].observations.map(item => item.status), ['failed', 'completed']);
    assert.equal(inputs[0].observations[0].turnId, 'scheduled-turn'); assert.equal(inputs[0].observations[0].text, undefined);
    assert.deepEqual(inputs[0].missing.map(item => item.status), ['failed']);
    console.log('OBS actual isolated model input', JSON.stringify(inputs[0]));
    assert.equal((await deliveries()).filter(item => item.kind === 'failed').length, 1);
    const checkCount = current.checkCount; await advance(current.deadlineAt + 1);
    assert.equal((await runs()).length, 1); assert.equal((await worker()).checkCount, checkCount);
    assert.equal(frames.filter(item => item.type === 'command').length, 0);
    assert(frames.some(item => item.type === 'inspect_automation'));
    if (errors.length) throw errors[0];
    console.log('PASS normal null-error completion settles remaining source; summary receives failed+missing evidence before deadline, one model run and zero source commands');
  }, [
    { label: 'isolated daemon CLI', cleanup: () => stopTestProcess(daemon) },
    { label: 'audited daemon connections', cleanup: async () => { for (const socket of sockets) await closeTestWebSocket(socket); } },
    { label: 'loopback websocket audit', cleanup: () => proxy && new Promise((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())) },
    { label: 'isolated Controller CLI', cleanup: () => controller?.stop() },
    { label: 'owned fixtures, binary and private journal', cleanup: () => rm(directory, { recursive: true, force: true }) },
  ]).catch(error => { throw new Error(`Native source failure E2E failed\n${logs.join('')}`, { cause: error }); });
  console.log('PASS cleanup: daemon, Controller, model, loopback sockets and all owned fixture data removed');
}
