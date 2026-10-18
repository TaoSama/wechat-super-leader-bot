import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { createPostgresFixture } from '../support/control-plane-fixture.mjs';
import { withTestCleanup } from '../support/cleanup.mjs';

const { values } = parseArgs({ options: {
  run: { type: 'boolean', short: 'r' }, help: { type: 'boolean', short: 'h' },
}, allowPositionals: false });
const PREVIEW_MS = 60_000;
const RETAINED_COMMAND_STATES = ['queued', 'pending', 'accepted', 'uncertain', 'input-written'];
const HIDEABLE_COMMAND_STATES = ['completed', 'failed', 'cancelled', 'expired'];

if (values.help || !values.run) {
  console.log(`Usage: node tests/integration/console-visibility.mjs [--run] [--help]
  --run, -r   Verify console visibility in an isolated temporary PostgreSQL container.
  --help, -h  Show help. Requires built controller/dist and local Docker.
Retains command deduplication, goal evidence, notifications and authorization records.
No production database, credentials, model, daemon or messaging service is used.`);
} else {
  await main().catch(error => {
    console.error('Console visibility verification failed:', error);
    process.exitCode = 1;
  });
}

async function main() {
  const require = createRequire(new URL('../../controller/package.json', import.meta.url));
  const { Pool } = require('pg');
  const { PostgresStore } = await import('../../controller/dist/store/postgres.js');
  const { createGoal, goalRequestId } = await import('../../controller/dist/leader/goals/goal.js');
  const { GoalScheduler } = await import('../../controller/dist/leader/goals/scheduler.js');
  const { readGoalView } = await import('../../controller/dist/leader/goals/view.js');
  const fixture = createPostgresFixture();
  let pool, store, reopened;
  const now = Date.now();
  const stamp = ms => new Date(ms).toISOString();
  const command = (status, createdAt = now) => ({ commandId: randomUUID(), requestId: randomUUID(),
    nodeId: 'visibility-node', sessionId: 'visibility-session', action: 'send', prompt: 'precisely selected fixture',
    status, sendRoute: 'control-socket', authority: { type: 'chat', chatId: 'visibility-chat' },
    ...(['accepted', 'completed'].includes(status) ? { turnId: randomUUID() } : {}),
    ...(status === 'completed' ? { output: 'retained exact result' } : {}),
    createdAt: stamp(createdAt), updatedAt: stamp(createdAt), expiresAt: stamp(now + PREVIEW_MS) });
  await withTestCleanup(async () => {
    const url = await fixture.start();
    pool = new Pool({ connectionString: url });
    store = new PostgresStore(url);
    await store.init();

    const makeGoal = async (label, createdAt = now) => {
      const proposal = { id: randomUUID(), expiresAt: now + PREVIEW_MS, objective: label,
        criteria: ['Exact recorded task output'], constraints: 'temporary fixture only', maxActions: 1,
        maxDecisions: 2, durationMinutes: 1, shareResults: true,
        targets: [{ nodeId: 'visibility-node', sessionId: 'visibility-session', sendRoute: 'control-socket' }] };
      const goal = createGoal('visibility-' + randomUUID(), proposal, createdAt);
      const authority = { revision: 1, messageId: randomUUID(), inputHash: randomUUID() };
      assert(await store.compareAndSetLeaderState(goal.chatId, 0, { inflight: { ...authority,
        expiresAt: now + PREVIEW_MS, goal: proposal } }));
      assert.equal((await store.confirmGoal(goal, authority, () => now)).created, true);
      return { goal, authority };
    };
    const completeGoal = async initial => {
      const errors = [];
      const scheduler = new GoalScheduler(store, { submit: async (input, _retries, gate, route) => {
        await gate();
        const pending = { ...command('pending'), ...input, sendRoute: route };
        assert.equal((await store.createCommandIfAbsent(pending)).created, true);
        const turnId = randomUUID();
        await store.updateCommandStatus(pending.commandId, 'accepted', undefined, undefined, turnId);
        await store.updateCommandStatus(pending.commandId, 'completed', 'durable completed goal evidence', undefined, turnId);
      } }, async input => input.actions.length
        ? { type: 'complete', criteria: [{ criterion: 1, actions: [1] }], reason: 'Exact evidence present' }
        : { type: 'next', target: 1, prompt: 'Record evidence', sourceActions: [], reason: 'Verify fixture' },
      { now: () => now, onError: error => errors.push(error) });
      for (let index = 0; index < 3; index++) await scheduler.advance(initial.goal.id);
      assert.deepEqual(errors, []);
      const result = await store.getGoal(initial.goal.id);
      assert.equal(result.status, 'completed');
      return result;
    };

    // The hidden item is newer so LIMIT 1 must still return the older real item.
    const visible = command('completed', now + 1);
    const hidden = command('completed', now + 2);
    await store.createCommandIfAbsent(visible);
    await store.createCommandIfAbsent(hidden);
    const hiddenRecord = await store.getCommand(hidden.commandId);
    const realGoal = await completeGoal(await makeGoal('retained real goal', now - 1));
    const hiddenInitial = await makeGoal('explicitly selected completed goal');
    const hiddenGoal = await completeGoal(hiddenInitial);
    const sourceCommand = await store.findCommandByRequestId(goalRequestId(hiddenGoal, 0));
    const attemptId = randomUUID();
    await store.claimNotification(hiddenGoal.id, attemptId, [hiddenGoal.chatId], now);
    await store.recordNotificationReceipt(hiddenGoal.id, attemptId, 'uncertain', now);
    await store.recordMessage({ chatId: hiddenGoal.chatId, messageId: randomUUID(), text: 'original request',
      replyText: 'original response', commandId: sourceCommand.commandId, createdAt: stamp(now) });

    const snapshot = async () => {
      const result = {};
      for (const table of ['commands', 'leader_goals', 'messages', 'leader_states', 'leader_notifications']) {
        const { rows } = await pool.query(`SELECT to_jsonb(t)-'console_hidden_at' AS data FROM ${table} t ORDER BY to_jsonb(t)::text`);
        result[table] = rows.map(row => row.data).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      }
      return result;
    };
    const before = await snapshot();
    const notification = await store.getNotification(hiddenGoal.id, now);
    const pendingNotifications = await store.listPendingNotifications([realGoal.chatId, hiddenGoal.chatId], now);
    const goalView = await readGoalView(store, hiddenGoal, now);
    // Recreate the preceding schema to prove additive upgrade on existing records.
    await pool.query('ALTER TABLE commands DROP COLUMN console_hidden_at');
    await pool.query('ALTER TABLE leader_goals DROP COLUMN console_hidden_at');
    await store.init();
    const columns = await pool.query(`SELECT table_name,is_nullable,column_default,data_type FROM information_schema.columns
      WHERE table_schema='public' AND column_name='console_hidden_at' ORDER BY table_name`);
    assert.deepEqual(columns.rows, ['commands', 'leader_goals'].map(table_name => ({ table_name,
      is_nullable: 'YES', column_default: null, data_type: 'timestamp with time zone' })));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE commands SET console_hidden_at=NOW() WHERE command_id=ANY($1::text[])',
        [[hidden.commandId, sourceCommand.commandId]]);
      await client.query('UPDATE leader_goals SET console_hidden_at=NOW() WHERE id=$1', [hiddenGoal.id]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    assert.deepEqual(await snapshot(), before, 'Visibility markers rewrote the durable audit ledger');
    assert.deepEqual((await store.listRecentCommandSummaries(1)).map(item => item.commandId), [visible.commandId]);
    assert.deepEqual((await store.listRecentGoals([hiddenGoal.chatId, realGoal.chatId], 1)).map(item => item.id), [realGoal.id]);
    assert.deepEqual(await store.getCommand(hidden.commandId), hiddenRecord);
    assert.deepEqual(await store.findCommandByRequestId(hidden.requestId), hiddenRecord);
    assert.equal((await store.findCommandMetadataByRequestId(hidden.requestId)).commandId, hidden.commandId);
    assert.equal((await store.createCommandIfAbsent({ ...hidden, commandId: randomUUID() })).created, false);
    await assert.rejects(store.createCommandIfAbsent({ ...hidden, commandId: randomUUID(), prompt: 'changed' }), { name: 'ConflictError' });
    assert.deepEqual(await store.getLatestGoal(hiddenGoal.chatId), hiddenGoal);
    assert.deepEqual(await readGoalView(store, await store.getGoal(hiddenGoal.id), now), goalView);
    assert.deepEqual(await store.getNotification(hiddenGoal.id, now), notification);
    assert.deepEqual(await store.listPendingNotifications([realGoal.chatId, hiddenGoal.chatId], now), pendingNotifications);
    assert.equal(notification.status, 'uncertain');
    assert.equal((await store.confirmGoal(hiddenInitial.goal, hiddenInitial.authority, () => now)).created, false);
    await assert.rejects(store.claimNotification(hiddenGoal.id, randomUUID(), [hiddenGoal.chatId], now), { name: 'ConflictError' });
    console.log('PASS console visibility: additive nullable migration; filter before LIMIT; exact dedup, goal proofs and uncertain notification attempt retained');

    const retained = [];
    for (const status of [...RETAINED_COMMAND_STATES, ...HIDEABLE_COMMAND_STATES]) {
      const record = command(status);
      if (status === 'input-written') {
        record.sessionId = 'terminal:' + 'x'.repeat(43); record.sendRoute = 'terminal-pane';
        record.inputReceipt = { kind: 'terminal-input-written', sessionId: record.sessionId,
          requestId: randomUUID(), promptSHA256: createHash('sha256').update(record.prompt).digest('hex'),
          responseRevision: 1, observedRevision: 1 };
      }
      await store.createCommandIfAbsent(record);
      await pool.query('UPDATE commands SET console_hidden_at=NOW() WHERE command_id=$1', [record.commandId]);
      if (RETAINED_COMMAND_STATES.includes(status)) retained.push(record.commandId);
    }
    const openGoals = [], markedGoalChats = [];
    for (const status of ['active', 'blocked', 'cancelled', 'expired']) {
      const initial = await makeGoal('goal status ' + status);
      const goal = status === 'active' ? initial.goal : await store.compareAndSetGoal({ ...initial.goal,
        revision: 2, status, ...(status === 'blocked' ? { blockedReason: 'Needs human attention' } : {}) }, 1,
      () => status === 'expired' ? initial.goal.expiresAt : now);
      await pool.query('UPDATE leader_goals SET console_hidden_at=NOW() WHERE id=$1', [goal.id]);
      markedGoalChats.push(goal.chatId);
      if (['active', 'blocked'].includes(status)) openGoals.push(goal);
    }
    const visibleCommands = (await store.listRecentCommandSummaries(64)).map(item => item.commandId);
    assert.deepEqual(new Set(visibleCommands), new Set([visible.commandId,
      (await store.findCommandByRequestId(goalRequestId(realGoal, 0))).commandId, ...retained]));
    assert.deepEqual(new Set((await store.listRecentGoals(markedGoalChats, 64)).map(goal => goal.id)),
      new Set(openGoals.map(goal => goal.id)));
    assert.deepEqual(new Set((await store.listRunnableGoals(64)).map(goal => goal.id)), new Set(openGoals.map(goal => goal.id)));
    reopened = new PostgresStore(url);
    assert.equal((await reopened.getCommand(hidden.commandId)).requestId, hidden.requestId);
    assert.deepEqual(await reopened.getNotification(hiddenGoal.id, now), notification);
    assert(!(await reopened.listRecentGoals([hiddenGoal.chatId], 64)).length);
    assert.equal((await reopened.createCommandIfAbsent(hidden)).created, false);
    console.log('PASS safety: marked queued/pending/accepted/uncertain/input-written commands and active/blocked goals remain visible and schedulable; reconnect preserves deduplication');
  }, [
    { label: 'reopened visibility store', cleanup: () => reopened?.close() },
    { label: 'visibility store', cleanup: () => store?.close() },
    { label: 'visibility SQL pool', cleanup: () => pool?.end() },
    { label: 'temporary visibility PostgreSQL', cleanup: () => fixture.stop() },
  ]);
}
