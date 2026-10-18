import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { createPostgresFixture, waitFor } from '../../support/control-plane-fixture.mjs';
import { closeTestWebSocket, stopTestProcess, withTestCleanup } from '../../support/cleanup.mjs';
import { verificationEnvironment } from '../../../scripts/verify.mjs';

const NODE = 'synthetic-schedule-node';
const CHAT = 'synthetic-schedule-chat';
const SESSION = 'synthetic-schedule-session';
const HTTP_TIMEOUT_MS = 5_000;
const SETTLE_MS = 1_300;
const MINUTE_MS = 60_000;
const { values } = parseArgs({ options: {
  run: { type: 'boolean' }, postgres: { type: 'boolean' }, 'fixture-server': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} });
if (values['fixture-server']) {
  await serveFixture();
} else if (!values.run || values.help) {
  console.log('Usage: node tests/integration/leader/scheduled-sessions.mjs --run [--postgres]\nRequires built Controller. Starts an isolated Controller, synthetic WS daemon and controllable fixture clock. --postgres creates and removes one local Docker PostgreSQL container. No real desktop, WeChat or model endpoints are used.');
} else {
  await verifyScheduledSessions({ postgres: values.postgres }).catch(error => { console.error(error); process.exitCode = 1; });
}

// This is an application bootstrap, not a direct call into scheduler functions.
// The clock is controlled only over the private parent/child IPC channel; every
// business action still enters the running Controller through HTTP or daemon WS.
async function serveFixture() {
  if (!process.send) throw new Error('Fixture server requires its private IPC channel');
  const OriginalDate = Date;
  let offset = 0;
  globalThis.Date = class extends OriginalDate {
    constructor(...args) { super(...(args.length ? args : [OriginalDate.now() + offset])); }
    static now() { return OriginalDate.now() + offset; }
  };
  const { loadConfig } = await import('../../../controller/dist/runtime/config.js');
  const { ControllerServer } = await import('../../../controller/dist/http/server.js');
  const config = { ...loadConfig(), port: 0 };
  const store = config.persistenceMode === 'postgres'
    ? new (await import('../../../controller/dist/store/postgres.js')).PostgresStore(config.databaseUrl)
    : new (await import('../../../controller/dist/store/memory.js')).MemoryStore();
  const app = new ControllerServer(config, store);
  await app.start();
  process.on('message', message => {
    if (message?.type !== 'clock' || !Number.isSafeInteger(message.at)) return;
    offset = message.at - OriginalDate.now();
    process.send({ type: 'clock', id: message.id, now: Date.now() });
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => { void stop().catch(error => { console.error(error); process.exit(1); }); });
  process.on('SIGINT', () => { void stop().catch(error => { console.error(error); process.exit(1); }); });
  process.on('disconnect', () => { void stop().catch(error => { console.error(error); process.exit(1); }); });
  process.send({ type: 'ready', base: `http://127.0.0.1:${app.getHttpServer().address().port}`, now: Date.now() });
}

export async function verifyScheduledSessions({ postgres = false } = {}) {
  const require = createRequire(new URL('../../../controller/package.json', import.meta.url));
  const { WebSocket } = require('ws');
  const database = postgres ? createPostgresFixture({ env: verificationEnvironment() }) : undefined;
  const token = randomBytes(24).toString('hex'), nodeToken = randomBytes(24).toString('hex');
  let child, socket, timer, base, clockNow, clockReal, pool, gate;
  const logs = [], errors = [], frames = [], acks = [];
  let sessionStatus = 'idle';
  const virtualNow = () => clockNow + Date.now() - clockReal;
  const write = message => {
    if (socket?.readyState !== WebSocket.OPEN) throw new Error('Synthetic daemon is disconnected');
    socket.send(JSON.stringify(message), error => { if (error) errors.push(error); });
  };
  const heartbeat = () => write({ type: 'heartbeat', sessions: [{ id: SESSION, provider: 'codex-app',
    title: `synthetic-${sessionStatus}`, cwd: '/synthetic', status: sessionStatus, loaded: true,
    capabilities: ['read', 'send'], observedAt: new Date(virtualNow()).toISOString() }], skills: [] });
  await withTestCleanup(async () => {
    const databaseUrl = database ? await database.start() : undefined;
    if (database) { const pg = require('pg'); pool = new pg.Pool({ connectionString: databaseUrl }); }
    child = fork(fileURLToPath(import.meta.url), ['--fixture-server'], {
      env: { ...verificationEnvironment(), PERSISTENCE_MODE: database ? 'postgres' : 'memory', DATABASE_URL: databaseUrl,
        CONTROLLER_TOKEN: token, NODE_TOKENS: JSON.stringify({ [NODE]: nodeToken }), ALLOWED_CHAT_IDS: CHAT,
        COMMAND_TTL_SECONDS: '86400', TASK_NOTIFICATION_TICK_MS: '100', LEADER_MODE: 'rules' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    child.on('error', error => errors.push(error));
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => {
      logs.push(bytes.toString().replaceAll(token, '[redacted]').replaceAll(nodeToken, '[redacted]'));
      if (logs.length > 100) logs.shift();
    });
    child.on('message', message => {
      if (message?.type === 'ready') { base = message.base; clockNow = message.now; clockReal = Date.now(); }
    });
    await waitFor(async () => {
      if (errors.length) throw errors[0];
      if (child.exitCode !== null) throw new Error(logs.join(''));
      return Boolean(base);
    }, 'Clock-controlled Controller readiness').catch(error => { throw new Error(logs.join(''), { cause: error }); });
    const request = async (path, body, key) => {
      if (errors.length) throw errors[0];
      const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
      const result = await response.json();
      assert(response.ok, `${path}: HTTP ${response.status} ${JSON.stringify(result)}`);
      return result;
    };
    const runs = async schedule => (await request(`/v1/automations/${schedule.id}/runs?chatId=${CHAT}`)).items;
    const results = async schedule => (await request('/v1/deliveries')).items.filter(item => item.source.type === 'automation' && item.source.id === schedule.id);
    const setStatus = async (schedule, status) => request(`/v1/automations/${schedule.id}/status`, { chatId: CHAT, status });
    const command = id => request(`/v1/commands/${id}`);
    const advanceTo = async at => {
      const id = randomUUID();
      const observed = new Promise((resolve, reject) => {
        const deadline = setTimeout(() => { child.off('message', receive); reject(new Error('Fixture clock acknowledgement timed out')); }, HTTP_TIMEOUT_MS);
        const receive = message => {
          if (message?.type !== 'clock' || message.id !== id) return;
          clearTimeout(deadline); child.off('message', receive);
          clockNow = message.now; clockReal = Date.now(); resolve();
        };
        child.on('message', receive);
      });
      child.send({ type: 'clock', id, at });
      await observed;
      heartbeat();
    };
    const publishStatus = async status => {
      sessionStatus = status; heartbeat();
      await waitFor(async () => (await request('/v1/status')).sessions.some(item => item.nodeId === NODE && item.id === SESSION && item.status === status), `Daemon ${status} observation`);
    };
    socket = new WebSocket(base.replace('http:', 'ws:') + '/v1/daemon', { headers: { authorization: `Bearer ${nodeToken}` } });
    socket.on('error', error => errors.push(error));
    await once(socket, 'open');
    socket.on('message', raw => {
      try {
        const frame = JSON.parse(raw.toString());
        if (frame.type === 'command') {
          assert.equal(frame.nodeId, NODE); assert.equal(frame.sessionId, SESSION); assert.equal(frame.action, 'send');
          assert.equal(frame.sendRoute, 'control-socket');
          frames.push(frame);
          write({ type: 'result', commandId: frame.commandId, status: 'accepted', turnId: `turn-${frame.commandId}`, output: 'synthetic input accepted' });
        } else if (frame.type === 'result_ack') acks.push(frame);
      } catch (error) { errors.push(error); }
    });
    write({ type: 'hello', version: 1, nodeId: NODE, sessions: [], skills: [] });
    await publishStatus('idle');
    timer = setInterval(() => { try { heartbeat(); } catch (error) { errors.push(error); } }, 200);

    const create = async (prompt, options = {}) => {
      const input = { kind: 'session', title: prompt, prompt, nodeId: NODE, sessionId: SESSION,
        timing: { type: 'at', at: new Date(virtualNow() + 2_000).toISOString() }, timezone: 'UTC',
        monitor: false, retention: 'retain', ...options };
      const key = randomUUID();
      const payload = { chatId: CHAT, input };
      const { schedule } = await request('/v1/automations', payload, key);
      assert.equal((await request('/v1/automations', payload, key)).schedule.id, schedule.id, 'Create replay scheduled duplicate task');
      assert.equal(schedule.target.sendRoute, 'control-socket');
      assert.equal((await results(schedule)).length, 0, 'Schedule emitted a start notification');
      return schedule;
    };
    const awaitCommand = async (schedule, expectedStatus = 'accepted') => {
      let run;
      await waitFor(async () => {
        run = (await runs(schedule))[0];
        return run?.commandId && (await command(run.commandId)).status === expectedStatus;
      }, `${schedule.title} command ${expectedStatus}`);
      return { run, frame: frames.find(item => item.commandId === run.commandId) };
    };
    const complete = async (schedule, status = 'completed', output = 'full scheduled result') => {
      const { run, frame } = await awaitCommand(schedule);
      assert(frame, 'Accepted task had no actual daemon WS delivery');
      write({ type: 'result', commandId: frame.commandId, turnId: `turn-${frame.commandId}`, status,
        ...(status === 'failed' ? { error: output } : { output }) });
      await waitFor(async () => (await runs(schedule)).find(item => item.id === run.id)?.status === status, `${schedule.title} exact completion observed`);
      assert.equal(frames.filter(item => item.commandId === frame.commandId).length, 1, 'Task was dispatched repeatedly');
      return run;
    };
    const waitResults = async (schedule, count) => waitFor(async () => (await results(schedule)).length === count, `${schedule.title} has ${count} result(s)`);

    const single = await create('single exact task');
    await advanceTo(single.nextAt + 1);
    await awaitCommand(single);
    assert.equal((await results(single)).length, 0, 'Input acceptance was announced as task completion');
    await complete(single);
    await waitResults(single, 1);
    assert.equal((await results(single))[0].messages.join(''), 'full scheduled result');
    assert.equal((await runs(single)).length, 1);
    console.log('PASS real HTTP schedule → daemon WS accepted → exact turn completed → full persisted result; repeated create/ticks do not redispatch');

    const paused = await create('paused queued task');
    await publishStatus('busy'); await advanceTo(paused.nextAt + 1);
    const queued = (await awaitCommand(paused, 'queued')).run;
    await setStatus(paused, 'paused'); await publishStatus('idle'); await delay(SETTLE_MS);
    assert.equal((await command(queued.commandId)).status, 'queued');
    assert.equal(frames.some(frame => frame.commandId === queued.commandId), false, 'Paused queued task was dispatched');
    await setStatus(paused, 'active');
    await complete(paused, 'completed', 'resumed task result'); await waitResults(paused, 1);
    assert.equal((await runs(paused)).length, 1);
    console.log('PASS due task queued behind busy session; pause blocks queue dispatch and resume executes the same durable command exactly once');

    const cancelled = await create('cancelled queued task');
    await publishStatus('busy'); await advanceTo(cancelled.nextAt + 1);
    const cancelledRun = (await awaitCommand(cancelled, 'queued')).run;
    await setStatus(cancelled, 'cancelled'); await publishStatus('idle');
    await waitFor(async () => (await command(cancelledRun.commandId)).status === 'cancelled', 'Cancelled schedule queued command revoked');
    await delay(SETTLE_MS);
    assert.equal(frames.some(frame => frame.commandId === cancelledRun.commandId), false);
    assert.equal((await results(cancelled)).length, 0, 'Cancelled task produced proactive noise');
    console.log('PASS cancelling a queued schedule revokes its saved dispatch authority; idle recovery sends neither command nor notification');

    const overlap = await create('single active cron task', { timing: { type: 'cron', expression: '* * * * *' } });
    await advanceTo(overlap.nextAt + 1); await awaitCommand(overlap);
    await advanceTo(overlap.nextAt + 3 * MINUTE_MS + 1); await delay(SETTLE_MS);
    assert.equal((await runs(overlap)).length, 1, 'Cron overlapped its unfinished run');
    assert.equal(frames.filter(frame => frame.prompt === overlap.prompt).length, 1);
    await setStatus(overlap, 'cancelled'); await complete(overlap);
    assert.equal((await results(overlap)).length, 0);
    console.log('PASS advancing three cron occurrences while one turn remains active never overlaps or duplicates execution');

    const monitor = await create('change-only cron monitor', { timing: { type: 'cron', expression: '* * * * *' }, monitor: true });
    const outcomes = [
      ['completed', 'state A', 1], ['completed', 'state A', 1], ['completed', 'state B', 2],
      ['failed', 'synthetic check failed', 3], ['failed', 'synthetic check failed', 3], ['completed', 'state B', 4],
    ];
    for (const [index, [status, text, expectedResults]] of outcomes.entries()) {
      const schedule = (await request(`/v1/automations/${monitor.id}?chatId=${CHAT}`)).schedule;
      await advanceTo(schedule.nextAt + 1); await awaitCommand(monitor); await complete(monitor, status, text);
      await waitResults(monitor, expectedResults);
      await delay(200);
      assert.equal((await results(monitor)).length, expectedResults);
      assert.equal((await runs(monitor)).length, index + 1, 'Cron replayed an occurrence');
    }
    const monitorPlans = await results(monitor);
    assert.deepEqual(monitorPlans.sort((a, b) => a.createdAt - b.createdAt).map(item => item.kind), ['completed', 'completed', 'failed', 'recovered']);
    await setStatus(monitor, 'cancelled');
    console.log('PASS actual cron + daemon outcomes: initial A notifies, unchanged A silent, changed B notifies, new failure notifies, repeated failure silent, recovery notifies');

    if (pool) {
      const raced = await create('pg-requeue');
      await publishStatus('busy'); await advanceTo(raced.nextAt + 1);
      const raceRun = (await awaitCommand(raced, 'queued')).run;
      const lockKey = randomInt(1, 2_000_000_000);
      gate = await pool.connect();
      await gate.query('SELECT pg_advisory_lock($1)', [lockKey]);
      await pool.query(`CREATE TABLE fixture_requeue_events (command_id text, old_status text, new_status text);
        CREATE FUNCTION fixture_block_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
          IF OLD.status='queued' AND NEW.status='pending' AND NEW.prompt='pg-requeue' THEN
            PERFORM pg_advisory_xact_lock(${lockKey});
          END IF;
          INSERT INTO fixture_requeue_events VALUES(NEW.command_id,OLD.status,NEW.status);
          RETURN NEW;
        END $$;
        CREATE TRIGGER fixture_block_claim BEFORE UPDATE ON commands FOR EACH ROW EXECUTE FUNCTION fixture_block_claim()`);
      await publishStatus('idle');
      await waitFor(async () => (await pool.query('SELECT 1 FROM pg_locks WHERE locktype=\'advisory\' AND objid=$1 AND NOT granted', [lockKey])).rows.length > 0,
        'PostgreSQL command claim blocked at fixture gate');
      await setStatus(raced, 'paused');
      await gate.query('SELECT pg_advisory_unlock($1)', [lockKey]); gate.release(); gate = undefined;
      await waitFor(async () => (await pool.query("SELECT 1 FROM fixture_requeue_events WHERE command_id=$1 AND old_status='pending' AND new_status='queued'", [raceRun.commandId])).rows.length === 1,
        'PostgreSQL atomic claimed-command requeue after concurrent pause');
      assert.equal((await command(raceRun.commandId)).status, 'queued');
      assert.equal(frames.some(frame => frame.commandId === raceRun.commandId), false, 'Pause race sent a command before requeue');
      await pool.query('DROP TRIGGER fixture_block_claim ON commands; DROP FUNCTION fixture_block_claim(); DROP TABLE fixture_requeue_events');
      await setStatus(raced, 'active'); await complete(raced, 'completed', 'postgres requeue result'); await waitResults(raced, 1);
      assert.equal((await runs(raced)).length, 1);
      console.log('PASS real PostgreSQL claim/pause race → pending-to-queued atomic release, no WS send while paused, resume sends original command once');
    }
    if (errors.length) throw errors[0];
    console.log(`PASS scheduled session runtime (${database ? 'PostgreSQL' : 'memory'}); ${frames.length} exact synthetic daemon sends and ${acks.length} native result acknowledgements`);
  }, [
    { label: 'synthetic daemon heartbeat', cleanup: () => clearInterval(timer) },
    { label: 'fixture PostgreSQL claim gate', cleanup: async () => { if (gate) { await gate.query('SELECT pg_advisory_unlock_all()'); gate.release(); } } },
    { label: 'synthetic daemon WebSocket', cleanup: () => closeTestWebSocket(socket) },
    { label: 'clock-controlled Controller process', cleanup: () => stopTestProcess(child) },
    { label: 'fixture PostgreSQL pool', cleanup: () => pool?.end() },
    { label: 'fixture PostgreSQL container', cleanup: () => database?.stop() },
  ]);
}
