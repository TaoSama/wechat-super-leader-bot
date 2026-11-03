import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { createControllerFixture, createPostgresFixture, waitFor } from '../../support/control-plane-fixture.mjs';
import { withTestCleanup } from '../../support/cleanup.mjs';
import { verificationEnvironment } from '../../../scripts/verify.mjs';

const CHAT = 'fixture-prompt-chat';
const MODEL = 'fixture-prompt-model';
const ORIGINAL = 'Original daily report format';
const FIRST_EDIT = 'Revised daily report: include positions and risks';
const SECOND_EDIT = 'Future daily report: include positions, risks and next actions';
const HTTP_TIMEOUT_MS = 5_000;
const WORKER_TIMEOUT_MS = 15_000;
const MINUTE_MS = 60_000;

const { values } = parseArgs({ options: {
  run: { type: 'boolean' }, postgres: { type: 'boolean' },
  'database-url': { type: 'string' }, help: { type: 'boolean', short: 'h' },
} });
if (!values.run || values.help) {
  console.log('Usage: node tests/integration/leader/automation-prompt.mjs --run (--postgres | --database-url URL)\nRequires built Controller. Runs its actual CLI, isolated PostgreSQL schema and a controlled Codex executable. --postgres owns and removes a local Docker PostgreSQL container; --database-url accepts an existing disposable loopback database. Only the fixture Controller clock is advanced. No real model, WeChat or desktop sessions.');
} else {
  await verifyAutomationPrompt({ postgres: values.postgres, databaseUrl: values['database-url'] })
    .catch(error => { console.error(error); process.exitCode = 1; });
}

async function controlledCodex(directory, gatedTask, model) {
  const assert = (await import('node:assert/strict')).default;
  const { randomUUID } = await import('node:crypto');
  const { appendFile, access, readFile } = await import('node:fs/promises');
  const { setTimeout: delay } = await import('node:timers/promises');
  const { parseArgs } = await import('node:util');
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    json: { type: 'boolean' }, 'ignore-user-config': { type: 'boolean' }, 'ignore-rules': { type: 'boolean' },
    'skip-git-repo-check': { type: 'boolean' }, model: { type: 'string' },
    'output-schema': { type: 'string' }, config: { type: 'string', multiple: true },
  } });
  assert.equal(positionals[0], 'exec'); assert.equal(values.model, model);
  assert(values['ignore-user-config'] && values['ignore-rules']);
  for (const key of ['CONTROLLER_TOKEN', 'NODE_TOKENS', 'DATABASE_URL', 'NODE_OPTIONS']) assert.equal(process.env[key], undefined, key);
  assert.equal(process.env.HOME, process.cwd()); assert.notEqual(process.env.CODEX_HOME, process.cwd());
  assert(JSON.parse(await readFile(values['output-schema'], 'utf8')).properties.status);
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const match = input.match(/<task>([^]*?)<\/task>/);
  assert(match, 'Worker did not receive a task');
  const task = JSON.parse(match[1]);
  const threadId = randomUUID();
  await appendFile(`${directory}/cli-receipts.jsonl`, JSON.stringify({ task, threadId, pid: process.pid }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\n');
  if (task === gatedTask) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try { await access(`${directory}/release-first`); break; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert(Date.now() < deadline, 'Fixture did not release the active worker');
      await delay(25);
    }
  }
  for (const event of [
    { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify({
      status: 'completed', summary: `Completed: ${task}`, nextCheckAt: null, attachments: [],
    }) } }, { type: 'turn.completed' },
  ]) process.stdout.write(JSON.stringify(event) + '\n');
}

export async function verifyAutomationPrompt({ postgres = false, databaseUrl } = {}) {
  if (Boolean(postgres) === Boolean(databaseUrl)) throw new Error('Choose exactly one of --postgres or --database-url');
  const directory = await mkdtemp(path.join(tmpdir(), 'leader-prompt-e2e-'));
  const token = randomBytes(24).toString('hex');
  const schema = `prompt_${randomUUID().replaceAll('-', '')}`;
  const database = postgres ? createPostgresFixture({ env: verificationEnvironment() }) : undefined;
  const clockPath = path.join(directory, 'clock-time');
  const initialAt = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
  const clockModule = path.join(directory, 'clock.mjs');
  const fakeCodex = path.join(directory, 'fixture-codex.mjs');
  const logs = [], databaseErrors = [];
  const stop = new AbortController();
  const interrupt = () => stop.abort(new Error('Prompt integration interrupted'));
  let controller, admin, pool, schemaCreated = false;
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  await withTestCleanup(async () => {
    databaseUrl ??= await database.start();
    const url = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      throw new Error('Prompt integration requires a disposable loopback PostgreSQL database');
    }
    const require = createRequire(new URL('../../../controller/package.json', import.meta.url));
    const { Pool } = require('pg');
    admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: HTTP_TIMEOUT_MS });
    admin.on('error', error => databaseErrors.push(error));
    await admin.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
    url.searchParams.set('options', `-csearch_path=${schema}`);
    pool = new Pool({ connectionString: url.href, connectionTimeoutMillis: HTTP_TIMEOUT_MS });
    pool.on('error', error => databaseErrors.push(error));
    await writeFile(clockPath, String(initialAt), { mode: 0o600 });
    // Freeze only the Controller's business clock, so CI wall time cannot claim the next minute early.
    // Node timers, HTTP deadlines, the parent waitFor and controlled CLI retain real elapsed time.
    await writeFile(clockModule, `import { readFileSync } from 'node:fs';
const OriginalDate = Date;
function now() { const at = Number(readFileSync(${JSON.stringify(clockPath)}, 'utf8')); if (!Number.isSafeInteger(at)) throw new Error('Invalid fixture clock'); return at; }
globalThis.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [now()])); } static now() { return now(); } };
`, { mode: 0o600 });
    await writeFile(fakeCodex, `#!${process.execPath}\n(${controlledCodex.toString()})(${JSON.stringify(directory)}, ${JSON.stringify(FIRST_EDIT)}, ${JSON.stringify(MODEL)}).catch(error => { console.error(error); process.exitCode = 1; });\n`, { mode: 0o700 });
    controller = await createControllerFixture({ env: {
      ...verificationEnvironment(), PERSISTENCE_MODE: 'postgres', DATABASE_URL: url.href,
      CONTROLLER_TOKEN: token, NODE_TOKENS: '{}', ALLOWED_CHAT_IDS: CHAT, LEADER_MODE: 'rules',
      TASK_NOTIFICATION_TICK_MS: '100', CONTROLLER_DATA_ROOT: directory,
      BACKGROUND_WORKER_ROOT: path.join(directory, 'background', 'workers'),
      BACKGROUND_ARTIFACT_ROOT: path.join(directory, 'background', 'artifacts'),
      BACKGROUND_CODEX_PATH: fakeCodex, BACKGROUND_MODEL_NAME: MODEL,
      BACKGROUND_MODEL_BASE_URL: 'https://fixture.invalid/v1', BACKGROUND_MODEL_API_KEY: 'synthetic-prompt-key',
      BACKGROUND_TURN_TIMEOUT_MS: String(WORKER_TIMEOUT_MS),
      NODE_OPTIONS: `--import=${pathToFileURL(clockModule).href}`,
    }, secrets: [token, url.href], logs });
    await controller.start();
    const request = async (route, body, key) => {
      stop.signal.throwIfAborted();
      if (databaseErrors.length) throw databaseErrors[0];
      const response = await fetch(controller.base + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      return { status: response.status, body: await response.json() };
    };
    const ok = async (...args) => {
      const response = await request(...args);
      assert(response.status >= 200 && response.status < 300, JSON.stringify(response)); return response.body;
    };
    const schedulePath = id => `/v1/automations/${id}`;
    const getSchedule = async id => (await ok(`${schedulePath(id)}?chatId=${CHAT}`)).schedule;
    const runs = async id => (await ok(`${schedulePath(id)}/runs?chatId=${CHAT}`)).items;
    const edit = (id, prompt, revision, key) => request(`${schedulePath(id)}/prompt`, { chatId: CHAT, prompt, expectedPromptRevision: revision }, key);
    const advance = async at => { await writeFile(`${clockPath}.next`, String(at), { mode: 0o600 }); await rename(`${clockPath}.next`, clockPath); };
    const receipts = async () => {
      try { return (await readFile(path.join(directory, 'cli-receipts.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    };
    const savedWorker = async runId => (await pool.query('SELECT data FROM background_workers WHERE run_id=$1', [runId])).rows[0]?.data;
    const frozen = worker => ({ spec: worker.spec, invocations: worker.invocations, initialOutcome: worker.initialOutcome });
    const awaitComplete = async (id, count) => {
      let completed;
      await waitFor(async () => { const list = await runs(id); completed = list.find(run => run.status === 'completed' && !seenRuns.has(run.id)); return list.length === count && Boolean(completed); }, `Occurrence ${count} completion`);
      seenRuns.add(completed.id); return completed;
    };
    const seenRuns = new Set();
    const createKey = randomUUID(), editKey = randomUUID();
    const payload = { chatId: CHAT, input: { kind: 'background', title: 'Synthetic editable daily report',
      timing: { type: 'cron', expression: '* * * * *' }, timezone: 'UTC', retention: 'retain',
      background: { prompt: ORIGINAL, sources: [], preferences: ['Use the requested report format'], deadlineMs: 60_000, checkIntervalsMs: [1_000] } } };
    const created = (await ok('/v1/automations', payload, createKey)).schedule;
    assert.equal(created.createdAt, initialAt);
    assert.equal(created.nextAt, initialAt + MINUTE_MS);
    console.log('OBS frozen Controller clock', JSON.stringify({ initialAt, nextAt: created.nextAt, onlyExplicitAdvance: true }));
    assert.equal(created.latestPromptUpdate?.revision ?? 0, 0);
    assert.equal((await runs(created.id)).length, 0);
    const updated = await edit(created.id, FIRST_EDIT, 0, editKey);
    assert.equal(updated.status, 200); assert.equal(updated.body.schedule.latestPromptUpdate.revision, 1);
    assert.equal(updated.body.schedule.background.prompt, FIRST_EDIT);
    for (const field of ['id', 'chatId', 'authorizedMessageId', 'createdAt', 'timing', 'timezone', 'nextAt', 'retention']) {
      assert.deepEqual(updated.body.schedule[field], created[field], `Prompt edit changed ${field}`);
    }
    assert.deepEqual(updated.body.schedule.background, { ...created.background, prompt: FIRST_EDIT });
    assert.deepEqual((await pool.query('SELECT data FROM automation_schedules WHERE id=$1', [created.id])).rows[0].data, updated.body.schedule);
    assert.deepEqual((await edit(created.id, FIRST_EDIT, 0, editKey)).body.schedule, updated.body.schedule);
    const stale = await edit(created.id, 'Stale edit', 0, randomUUID());
    const conflicting = await edit(created.id, 'Conflicting key reuse', 1, editKey);
    assert.equal(stale.status, 409); assert.equal(conflicting.status, 409);
    console.log('OBS prompt update', JSON.stringify({ scheduleId: created.id, priorRevision: 0,
      persistedRevision: updated.body.schedule.latestPromptUpdate.revision, persistedPrompt: updated.body.schedule.background.prompt,
      nextAt: updated.body.schedule.nextAt, stale, conflicting }));
    console.log('PASS real HTTP prompt edit → PostgreSQL; metadata preserved, CAS conflicts rejected and same-key retry is idempotent');

    await controller.stop(); await controller.start();
    assert.deepEqual(await getSchedule(created.id), updated.body.schedule);
    const replay = (await ok('/v1/automations', payload, createKey)).schedule;
    assert.equal(replay.id, created.id); assert.equal(replay.background.prompt, FIRST_EDIT);
    assert.equal(replay.latestPromptUpdate.revision, 1);
    assert.equal((await ok(`/v1/automations?chatId=${CHAT}`)).items.length, 1);
    console.log('OBS restart and creation replay', JSON.stringify({ scheduleId: replay.id,
      prompt: replay.background.prompt, revision: replay.latestPromptUpdate.revision, scheduleCount: 1 }));
    console.log('PASS actual Controller process restart reads persisted prompt; original creation-key replay preserves the edited schedule without duplication');

    await advance(replay.nextAt + 1);
    await waitFor(async () => (await receipts()).some(receipt => receipt.task === FIRST_EDIT), 'First edited prompt reaches isolated CLI');
    const active = await getSchedule(created.id); assert(active.activeRunId);
    const activeEdit = await edit(created.id, SECOND_EDIT, 1, randomUUID());
    assert.equal(activeEdit.status, 409);
    assert.equal((await getSchedule(created.id)).background.prompt, FIRST_EDIT);
    assert.equal((await edit(created.id, FIRST_EDIT, 0, editKey)).status, 200, 'Committed edit replay must remain safe after dispatch');
    await writeFile(path.join(directory, 'release-first'), 'release', { mode: 0o600 });
    const firstRun = await awaitComplete(created.id, 1);
    assert.equal(firstRun.result.text, `Completed: ${FIRST_EDIT}`);
    const oldWorker = await savedWorker(firstRun.id);
    assert.equal(oldWorker.spec.prompt, FIRST_EDIT);
    assert.equal(oldWorker.invocations[0].task, FIRST_EDIT);
    console.log('OBS first occurrence', JSON.stringify({ runId: firstRun.id, workerId: oldWorker.id,
      workerPrompt: oldWorker.spec.prompt, result: firstRun.result.text, activeEdit, cli: (await receipts())[0] }));
    console.log('PASS scheduler → isolated CLI receives persisted edited prompt; an active occurrence rejects new edits while allowing its committed receipt replay');

    const secondUpdate = await edit(created.id, SECOND_EDIT, 1, randomUUID());
    assert.equal(secondUpdate.status, 200); assert.equal(secondUpdate.body.schedule.latestPromptUpdate.revision, 2);
    assert.deepEqual(frozen(await savedWorker(firstRun.id)), frozen(oldWorker));
    await advance(secondUpdate.body.schedule.nextAt + 1);
    const secondRun = await awaitComplete(created.id, 2);
    assert.equal(secondRun.result.text, `Completed: ${SECOND_EDIT}`);
    const newWorker = await savedWorker(secondRun.id);
    assert.equal(newWorker.spec.prompt, SECOND_EDIT); assert.equal(newWorker.invocations[0].task, SECOND_EDIT);
    assert.notEqual(newWorker.id, oldWorker.id);
    assert.deepEqual(frozen(await savedWorker(firstRun.id)), frozen(oldWorker));
    const cliReceipts = await receipts();
    assert.deepEqual(cliReceipts.map(receipt => receipt.task), [FIRST_EDIT, SECOND_EDIT]);
    assert.equal(new Set(cliReceipts.map(receipt => receipt.threadId)).size, 2);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM background_workers')).rows[0].count, 2);
    assert.equal((await runs(created.id)).find(run => run.id === firstRun.id).result.text, `Completed: ${FIRST_EDIT}`);
    console.log('OBS future occurrence', JSON.stringify({ revision: secondUpdate.body.schedule.latestPromptUpdate.revision,
      runId: secondRun.id, workerId: newWorker.id, workerPrompt: newWorker.spec.prompt, result: secondRun.result.text,
      priorWorkerUnchanged: true, cli: cliReceipts[1], workerCount: 2 }));
    console.log('PASS next occurrence uses the newest prompt in a distinct worker; prior worker spec, invocations and result remain unchanged in PostgreSQL');
  }, [
    { label: 'fixture signal listeners', cleanup: () => { process.off('SIGINT', interrupt); process.off('SIGTERM', interrupt); } },
    { label: 'isolated Controller and worker processes', cleanup: () => controller?.stop() },
    { label: 'fixture PostgreSQL evidence pool', cleanup: () => pool?.end() },
    { label: 'owned PostgreSQL schema', cleanup: async () => {
      if (!schemaCreated) return;
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      assert.equal((await admin.query('SELECT count(*)::int AS count FROM pg_namespace WHERE nspname=$1', [schema])).rows[0].count, 0);
    } },
    { label: 'fixture PostgreSQL administration pool', cleanup: () => admin?.end() },
    { label: 'owned PostgreSQL container', cleanup: () => database?.stop() },
    { label: 'owned clock, executable and worker files', cleanup: () => rm(directory, { recursive: true, force: true }) },
  ]).catch(error => { throw new Error(`Automation prompt integration failed\n${logs.join('')}`, { cause: error }); });
  console.log('PASS cleanup: Controller/workers stopped, owned PostgreSQL schema removed, pools closed and fixture directory removed');
}
