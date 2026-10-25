import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { waitFor } from '../../support/control-plane-fixture.mjs';
import { closeTestWebSocket, stopTestProcess, withTestCleanup } from '../../support/cleanup.mjs';
import { verificationEnvironment } from '../../../scripts/verify.mjs';

const CHAT = 'fixture-monitor-chat';
const NODES = ['fixture-monitor-mac-one', 'fixture-monitor-mac-two'];
const SOURCE = 'daily';
const HTTP_TIMEOUT_MS = 5_000;
const CHECK_INTERVAL_MS = 1_000;
const DEADLINE_MS = 60_000;
const { values } = parseArgs({ options: { run: { type: 'boolean' },
  'fixture-server': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
if (values['fixture-server']) await serveController();
else if (!values.run || values.help) console.log('Usage: node tests/integration/leader/background-monitoring.mjs --run\nRequires a built Controller. Starts an isolated actual Controller, two authenticated synthetic daemon connections and a controlled Codex CLI process. Uses no real desktop sessions, WeChat or model services.');
else await verifyBackgroundMonitoring().catch(error => { console.error(error); process.exitCode = 1; });

async function serveController() {
  if (!process.send) throw new Error('Fixture server requires private IPC');
  const OriginalDate = Date;
  let offset = 0;
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [OriginalDate.now() + offset])); }
    static now() { return OriginalDate.now() + offset; }
  };
  const { loadConfig } = await import('../../../controller/dist/runtime/config.js');
  const { ControllerServer } = await import('../../../controller/dist/http/server.js');
  const { MemoryStore } = await import('../../../controller/dist/store/memory.js');
  const app = new ControllerServer({ ...loadConfig(), port: 0 }, new MemoryStore());
  await app.start();
  process.on('message', message => {
    if (message?.type !== 'clock' || !Number.isSafeInteger(message.at)) return;
    offset = message.at - OriginalDate.now();
    process.send({ type: 'clock', id: message.id, now: Date.now() });
  });
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; await app.stop(); process.exit(0); };
  const terminate = () => { void stop().catch(error => { console.error(error); process.exit(1); }); };
  process.on('SIGTERM', terminate); process.on('SIGINT', terminate); process.on('disconnect', terminate);
  process.send({ type: 'ready', base: `http://127.0.0.1:${app.getHttpServer().address().port}`, now: Date.now() });
}

// Only model inference is controlled. HTTP, scheduler, leases, worker storage,
// executable spawning, Codex JSON events and result delivery run production code.
async function controlledCodex() {
  const { parseArgs } = await import('node:util');
  const { randomUUID } = await import('node:crypto');
  const { appendFile, readFile } = await import('node:fs/promises');
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    json: { type: 'boolean' }, 'ignore-user-config': { type: 'boolean' }, 'ignore-rules': { type: 'boolean' },
    'skip-git-repo-check': { type: 'boolean' }, model: { type: 'string' },
    'output-schema': { type: 'string' }, config: { type: 'string', multiple: true },
  } });
  if (positionals[0] !== 'exec' || values.model !== 'fixture-background-model' ||
      !values['ignore-user-config'] || !values['ignore-rules'] || process.env.CONTROLLER_TOKEN || process.env.NODE_TOKENS) {
    throw new Error('Worker process isolation/CLI arguments were not applied');
  }
  const schema = JSON.parse(await readFile(values['output-schema'], 'utf8'));
  if (!schema.properties?.status || process.env.HOME !== process.cwd() || process.env.CODEX_HOME === process.cwd()) {
    throw new Error('Worker workspace or output schema was not configured');
  }
  let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
  const match = prompt.match(/<observations>([\s\S]*)<\/observations>$/);
  if (!match) throw new Error('Missing actual background input');
  const input = JSON.parse(match[1]);
  const threadId = positionals.includes('resume') ? positionals[positionals.indexOf('resume') + 1] : randomUUID();
  const summary = JSON.stringify({ marker: 'controlled-cli-result', deadlineReached: input.deadlineReached ?? false,
    observations: input.observations.map(({ nodeId, automationId, status, turnId, text, reason }) =>
      ({ nodeId, automationId, status, turnId, text, reason })), missing: input.missing ?? [] });
  await appendFile('fixture-cli-receipts.jsonl', JSON.stringify({ threadId, positionals, input }) + '\n');
  for (const event of [{ type: 'thread.started', thread_id: threadId },
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({ status: 'completed', summary, nextCheckAt: null, attachments: [] }) } },
    { type: 'turn.completed' }]) process.stdout.write(JSON.stringify(event) + '\n');
}

export async function verifyBackgroundMonitoring() {
  const require = createRequire(new URL('../../../controller/package.json', import.meta.url));
  const { WebSocket } = require('ws');
  const token = randomBytes(24).toString('hex');
  const nodeTokens = Object.fromEntries(NODES.map(node => [node, randomBytes(24).toString('hex')]));
  const directory = await mkdtemp(path.join(tmpdir(), 'leader-monitor-e2e-'));
  const workerRoot = path.join(directory, 'background', 'workers');
  const fakeCodex = path.join(directory, 'fixture-codex.mjs');
  let child, base, clockNow, clockReal, heartbeatTimer;
  const sockets = new Map(), states = new Map(NODES.map(node => [node, 'running']));
  const frames = [], errors = [], logs = [];
  const virtualNow = () => clockNow + Date.now() - clockReal;
  const write = (node, message) => {
    const socket = sockets.get(node);
    if (socket?.readyState !== WebSocket.OPEN) throw new Error(`Fixture daemon unavailable: ${node}`);
    socket.send(JSON.stringify(message), error => { if (error) errors.push(error); });
  };
  const heartbeat = node => write(node, { type: 'heartbeat', sessions: [], skills: [] });
  await withTestCleanup(async () => {
    await writeFile(fakeCodex, `#!${process.execPath}\n(${controlledCodex.toString()})().catch(error => { console.error(error); process.exitCode = 1; });\n`, { mode: 0o700 });
    child = fork(fileURLToPath(import.meta.url), ['--fixture-server'], {
      env: { ...verificationEnvironment(), PERSISTENCE_MODE: 'memory', CONTROLLER_TOKEN: token,
        NODE_TOKENS: JSON.stringify(Object.fromEntries(NODES.map(node => [node, nodeTokens[node]]))),
        ALLOWED_CHAT_IDS: CHAT, LEADER_MODE: 'rules', TASK_NOTIFICATION_TICK_MS: '100',
        CONTROLLER_DATA_ROOT: directory,
        BACKGROUND_WORKER_ROOT: workerRoot,
        BACKGROUND_ARTIFACT_ROOT: path.join(directory, 'background', 'artifacts'),
        BACKGROUND_CODEX_PATH: fakeCodex, BACKGROUND_MODEL_NAME: 'fixture-background-model',
        BACKGROUND_MODEL_BASE_URL: 'https://fixture.invalid/v1', BACKGROUND_MODEL_API_KEY: 'synthetic-provider-key',
        BACKGROUND_TURN_TIMEOUT_MS: '10000' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.on('error', error => errors.push(error));
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
      let text = bytes.toString(); for (const secret of [token, ...Object.values(nodeTokens)]) text = text.replaceAll(secret, '[redacted]');
      logs.push(text); if (logs.length > 100) logs.shift();
    });
    child.on('message', message => { if (message?.type === 'ready') { base = message.base; clockNow = message.now; clockReal = Date.now(); } });
    await waitFor(async () => { if (errors.length) throw errors[0]; if (child.exitCode !== null) throw new Error(logs.join('')); return Boolean(base); }, 'Background Controller readiness');
    const request = async (route, body, idempotencyKey) => {
      if (errors.length) throw errors[0];
      const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      const result = await response.json(); assert(response.ok, `${route}: HTTP ${response.status} ${JSON.stringify(result)}`); return result;
    };
    const connect = async node => {
      const socket = new WebSocket(base.replace('http:', 'ws:') + '/v1/daemon', { headers: { authorization: `Bearer ${nodeTokens[node]}` } });
      socket.on('error', error => errors.push(error)); sockets.set(node, socket); await once(socket, 'open');
      socket.on('message', raw => {
        try {
          const frame = JSON.parse(raw.toString()); frames.push({ node, ...frame });
          if (frame.type === 'command') throw new Error(`Monitoring sent a source-session command: ${frame.action}`);
          if (frame.type === 'list_automations') write(node, { type: 'automation_response', requestId: frame.requestId,
            automations: [{ id: SOURCE, name: 'Synthetic native daily', kind: 'heartbeat', status: 'ACTIVE', prompt: 'private source prompt', rrule: 'FREQ=DAILY', targetSessionId: `source-${node}` }] });
          if (frame.type === 'inspect_automation') {
            assert.equal(frame.nodeId, node); assert.equal(frame.automationId, SOURCE);
            const status = states.get(node);
            write(node, { type: 'automation_response', requestId: frame.requestId, inspection: {
              automationId: frame.automationId, expectedAt: frame.expectedAt, notAfter: frame.notAfter,
              status, observedAt: virtualNow(), sources: [`synthetic:${node}:native-run`],
              sessionId: `source-${node}`, turnId: `exact-turn-${node}-${frame.expectedAt}`,
              ...(status === 'completed' ? { text: `exact-result:${node}` } : {}),
              ...(status === 'failed' ? { reason: 'synthetic_source_failed' } : {}),
            } });
          }
        } catch (error) { errors.push(error); }
      });
      write(node, { type: 'hello', version: 1, nodeId: node, sessions: [], skills: [] });
      await waitFor(async () => (await request('/v1/status')).nodes.some(item => item.nodeId === node && item.connected), `${node} authenticated inventory`);
    };
    await Promise.all(NODES.map(connect));
    heartbeatTimer = setInterval(() => { for (const node of NODES) if (sockets.get(node)?.readyState === WebSocket.OPEN) { try { heartbeat(node); } catch (error) { errors.push(error); } } }, 200);
    const advance = async at => {
      const id = randomUUID();
      const acknowledged = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.off('message', receive); reject(new Error('Clock acknowledgement timed out')); }, HTTP_TIMEOUT_MS);
        const receive = message => { if (message?.type !== 'clock' || message.id !== id) return;
          clearTimeout(timer); child.off('message', receive); clockNow = message.now; clockReal = Date.now(); resolve(); };
        child.on('message', receive);
      });
      child.send({ type: 'clock', id, at }); await acknowledged;
    };
    const runs = async schedule => (await request(`/v1/automations/${schedule.id}/runs?chatId=${CHAT}`)).items;
    const task = async run => (await request(`/v1/background-tasks/${run.id}?chatId=${CHAT}`)).task;
    const deliveries = async schedule => (await request('/v1/deliveries')).items.filter(item => item.source.type === 'automation' && item.source.id === schedule.id);
    const create = async title => {
      const input = { kind: 'background', title, timing: { type: 'at', at: new Date(virtualNow() + 2000).toISOString() },
        timezone: 'UTC', retention: 'retain', background: { prompt: title, deadlineMs: DEADLINE_MS,
          checkIntervalsMs: [CHECK_INTERVAL_MS], sources: NODES.map(nodeId => ({ nodeId, automationId: SOURCE, windowMs: DEADLINE_MS })) } };
      const key = randomUUID(), payload = { chatId: CHAT, input };
      const schedule = (await request('/v1/automations', payload, key)).schedule;
      assert.equal((await request('/v1/automations', payload, key)).schedule.id, schedule.id);
      return schedule;
    };
    const observe = async schedule => {
      let run; await waitFor(async () => { run = (await runs(schedule))[0]; return !!run && (await task(run)).checkCount > 0; }, 'Monitor first observations'); return run;
    };
    const finalResult = async schedule => {
      let run; await waitFor(async () => { run = (await runs(schedule))[0]; return run?.status === 'completed'; }, 'Background CLI completion');
      await waitFor(async () => (await deliveries(schedule)).some(item => item.kind === 'completed'), 'Background result delivered to original result queue');
      return { run, task: await task(run), summary: JSON.parse(run.result.text) };
    };

    const sources = await Promise.all(NODES.map(node => request(`/v1/source-automations?nodeId=${node}`)));
    assert(sources.every(result => result.items.length === 1 && !('prompt' in result.items[0])));
    const probeStart = Math.floor(virtualNow());
    for (const node of NODES) {
      const { observation } = await request(`/v1/source-automations/${SOURCE}?nodeId=${node}&expectedAt=${probeStart}&notAfter=${probeStart + DEADLINE_MS}`);
      assert.equal(observation.status, 'running'); assert.equal(observation.expectedAt, probeStart);
    }
    states.set(NODES[0], 'running'); states.set(NODES[1], 'failed');
    const first = await create('Compare both machine daily results after late completion'); await advance(first.nextAt + 1);
    const firstRun = await observe(first);
    await waitFor(async () => (await deliveries(first)).filter(item => item.kind === 'failed').length === 1, 'One source failure alert');
    let current = await task(firstRun); assert.equal(current.phase, 'observing'); assert.equal(current.executing, false);
    assert.deepEqual(current.observations.map(item => item.status), ['running', 'failed']);
    assert.equal((await runs(first))[0].status, 'running');
    console.log('PASS HTTP schedule → authenticated dual-node observations; one source running and one failed emits a single alert and continues observing');

    await closeTestWebSocket(sockets.get(NODES[0]));
    await waitFor(async () => !(await request('/v1/status')).nodes.some(node => node.nodeId === NODES[0] && node.connected), 'Source machine disconnect observed');
    await advance(current.nextCheckAt + 1);
    await waitFor(async () => (await task(firstRun)).observations[0]?.reason === 'node_offline', 'Disconnected source becomes unknown');
    current = await task(firstRun); assert.equal(current.observations[0].status, 'unknown'); assert.equal(current.phase, 'observing');
    assert.equal((await deliveries(first)).filter(item => item.kind === 'failed').length, 1, 'Unchanged source failure was repeatedly notified');
    console.log('PASS source disconnection is unknown with node_offline evidence; waiting and repeated failure do not dispatch source commands or repeat alerts');

    states.set(NODES[0], 'completed'); states.set(NODES[1], 'completed'); await connect(NODES[0]);
    await advance(current.nextCheckAt + 1);
    const merged = await finalResult(first);
    assert.equal(merged.summary.marker, 'controlled-cli-result'); assert.equal(merged.summary.deadlineReached, false);
    assert.equal(merged.summary.missing.length, 0); assert.equal(merged.task.phase, 'completed');
    assert(merged.summary.observations.every(item => item.status === 'completed' && item.turnId && item.text === `exact-result:${item.nodeId}`));
    assert.equal((await runs(first)).length, 1);
    console.log('PASS recovered sources produce exact same-occurrence receipts → isolated CLI process → merged result in the original chat result queue');

    states.set(NODES[0], 'completed'); states.set(NODES[1], 'running');
    const partial = await create('Report partial results at deadline'); await advance(partial.nextAt + 1); const partialRun = await observe(partial);
    const partialTask = await task(partialRun); assert.equal(partialTask.phase, 'observing');
    await advance(partialTask.deadlineAt + 1); const deadline = await finalResult(partial);
    assert.equal(deadline.summary.deadlineReached, true); assert.equal(deadline.summary.missing.length, 1);
    assert.equal(deadline.summary.missing[0].nodeId, NODES[1]); assert.equal(deadline.summary.missing[0].status, 'running');
    assert.equal(deadline.summary.observations[0].text, `exact-result:${NODES[0]}`);
    assert.equal(deadline.summary.observations[0].turnId, `exact-turn-${NODES[0]}-${partial.nextAt}`, 'Previous occurrence completion was reused for a new scheduled run');
    console.log('PASS deadline invokes isolated analysis with available exact result plus explicit missing source; incomplete source is never presented as success');

    const workerIds = (await readdir(path.join(workerRoot, 'workers'), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name);
    let cliCount = 0; const cliThreads = new Set();
    for (const id of workerIds) {
      const receiptPath = path.join(workerRoot, 'workers', id, 'workspace', 'fixture-cli-receipts.jsonl');
      let text; try { text = await readFile(receiptPath, 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      for (const line of text.trim().split('\n')) { const receipt = JSON.parse(line); cliCount++; cliThreads.add(receipt.threadId); }
    }
    assert.equal(cliCount, 2, 'Observations unexpectedly launched or repeated model execution'); assert.equal(cliThreads.size, 2, 'Separate tasks reused a conversation');
    assert.equal(frames.filter(frame => frame.type === 'command').length, 0, 'Monitor sent into a source session');
    const listed = (await request(`/v1/background-tasks?chatId=${CHAT}`)).tasks; assert.equal(listed.length, 2);
    assert(listed.every(item => item.expiresAt - item.createdAt === 24 * 60 * 60_000));
    if (errors.length) throw errors[0];
    console.log(`PASS actual Controller background monitoring runtime: ${NODES.length} hosts, ${frames.filter(frame => frame.type === 'inspect_automation').length} read-only inspections, ${cliCount} isolated CLI runs, zero source send commands`);
  }, [
    { label: 'synthetic heartbeat timer', cleanup: () => clearInterval(heartbeatTimer) },
    { label: 'authenticated synthetic daemons', cleanup: async () => { for (const socket of sockets.values()) await closeTestWebSocket(socket); } },
    { label: 'isolated Controller process', cleanup: () => stopTestProcess(child) },
    { label: 'owned fixture workspaces and executable', cleanup: () => rm(directory, { recursive: true, force: true }) },
  ]).catch(error => { throw new Error(`Background monitoring E2E failed\n${logs.join('')}`, { cause: error }); });
}
