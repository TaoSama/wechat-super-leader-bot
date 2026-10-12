import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withTestCleanup } from './scripts/test-cleanup.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const CLAIM_MS = 60_000;

// Called only against the disposable integration database, before Controller startup.
export async function verifyNotificationMigration({ databaseUrl, Pool, PostgresStore, pool }) {
  const { createExecution } = await import('./controller/dist/leader/execution.js');
  const { createGoal } = await import('./controller/dist/leader/goal.js');
  const schema = 'notification_migration_' + randomUUID().replaceAll('-', '');
  assert.match(schema, /^notification_migration_[a-f0-9]{32}$/);
  const scoped = new URL(databaseUrl);
  scoped.searchParams.set('options', '-c search_path=' + schema);
  const store = new PostgresStore(scoped.href), fixture = new Pool({ connectionString: scoped.href });
  let created = false;
  await withTestCleanup(async () => {
    await pool.query(`CREATE SCHEMA ${schema}`); created = true;
    await store.init();
    assert.equal((await fixture.query('SELECT current_schema() AS name')).rows[0].name, schema);
    await fixture.query('DROP TABLE leader_notifications');
    await fixture.query(`CREATE TABLE leader_notifications (
      id VARCHAR(36) COLLATE "C" PRIMARY KEY,
      execution_id VARCHAR(36) COLLATE "C" NOT NULL UNIQUE REFERENCES leader_executions(id),
      chat_id VARCHAR(64) NOT NULL,
      kind VARCHAR(16) NOT NULL CHECK (kind IN ('completed','failed','expired')),
      status VARCHAR(16) NOT NULL CHECK (status IN ('pending','claimed','accepted','uncertain')),
      created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, data JSONB NOT NULL,
      CHECK (id=execution_id))`);
    const now = Date.now(), expected = [];
    for (const status of ['pending', 'claimed', 'accepted', 'uncertain']) {
      const plan = createExecution('migration-' + status, { id: randomUUID(), expiresAt: now + CLAIM_MS,
        actions: [{ nodeId: 'synthetic', sessionId: 'synthetic', prompt: 'not-delivered', sendRoute: 'control-socket', dependsOn: [] }] }, now);
      const terminal = { ...plan, status: 'failed', revision: 2 };
      await fixture.query('INSERT INTO leader_executions(id,chat_id,revision,status,data,created_at) VALUES($1,$2,2,$3,$4::jsonb,$5)',
        [plan.id, plan.chatId, terminal.status, JSON.stringify(terminal), now]);
      const notification = { id: plan.id, executionId: plan.id, chatId: plan.chatId, kind: 'failed',
        text: `计划 ${plan.id}（共 1 步）：计划失败，已停止后续派发；这不表示已运行的原会话任务停止，可查询计划进度核对。`,
        createdAt: now, expiresAt: now + DAY_MS, status,
        ...(status === 'pending' ? {} : { attemptId: randomUUID(), attemptedAt: now + 1, attemptExpiresAt: now + 1 + CLAIM_MS }) };
      expected.push(notification);
      await fixture.query('INSERT INTO leader_notifications(id,execution_id,chat_id,kind,status,created_at,expires_at,data) VALUES($1,$1,$2,$3,$4,$5,$6,$7::jsonb)',
        [plan.id, plan.chatId, notification.kind, status, now, now + DAY_MS, JSON.stringify(notification)]);
    }
    const goal = { ...createGoal('migration-old-goal', { id: randomUUID(), expiresAt: now + CLAIM_MS,
      objective: 'old terminal goal must not notify', criteria: ['synthetic'], constraints: 'none',
      targets: [{ nodeId: 'synthetic', sessionId: 'synthetic', sendRoute: 'control-socket' }],
      maxActions: 1, maxDecisions: 1, durationMinutes: 1, shareResults: true }, now), status: 'expired', revision: 2 };
    await fixture.query('INSERT INTO leader_goals(id,chat_id,revision,status,created_at,data) VALUES($1,$2,2,$3,$4,$5::jsonb)',
      [goal.id, goal.chatId, goal.status, now, JSON.stringify(goal)]);
    const rows = () => fixture.query('SELECT to_jsonb(t) AS value FROM leader_notifications t ORDER BY id').then(result => result.rows.map(row => row.value));
    const columns = () => fixture.query("SELECT column_name,is_nullable FROM information_schema.columns WHERE table_schema=$1 AND table_name='leader_notifications' ORDER BY ordinal_position", [schema]).then(result => result.rows);
    const legacyRows = await rows();
    // The bad row sorts last, so rollback must undo preceding successful conversions too.
    const badOriginal = expected.find(item => item.id === legacyRows.at(-1).id);
    const corrupt = { ...badOriginal, unexpected: 'must-reject-not-discard' };
    await fixture.query('UPDATE leader_notifications SET data=$2::jsonb WHERE id=$1', [corrupt.id, JSON.stringify(corrupt)]);
    const invalidRows = await rows(), oldColumns = await columns();
    await assert.rejects(store.init(), undefined, 'Unknown legacy data silently accepted');
    assert.deepEqual(await rows(), invalidRows, 'Failed migration partially rewrote data');
    assert.deepEqual(await columns(), oldColumns, 'Failed migration partially changed DDL');
    await fixture.query('UPDATE leader_notifications SET data=$2::jsonb WHERE id=$1', [badOriginal.id, JSON.stringify(badOriginal)]);
    await store.init();
    const migrated = await rows();
    assert.equal(migrated.length, expected.length, 'Migration backfilled or lost events');
    for (const before of expected) {
      const { executionId, ...unchanged } = before;
      const after = migrated.find(row => row.id === before.id);
      assert.deepEqual(after.data, { ...unchanged, source: { type: 'plan', id: executionId } });
      assert.deepEqual(after, { ...legacyRows.find(row => row.id === before.id), goal_id: null, data: after.data });
      assert.equal(after.execution_id, executionId); assert.equal(after.goal_id, null);
      assert.equal(after.status, before.status); assert.equal(Number(after.created_at), now); assert.equal(Number(after.expires_at), now + DAY_MS);
      const persisted = await store.getNotification(before.id, now + 2);
      assert.deepEqual(persisted, after.data);
      if (before.status !== 'pending') await assert.rejects(store.claimNotification(before.id, randomUUID(), [before.chatId], now + 2));
    }
    assert.equal(await store.getNotification(goal.id, now + 2), null, 'Old terminal goal was backfilled');
    await store.init();
    assert.deepEqual(await rows(), migrated, 'Re-initialization changed migrated events');
    // Relation integrity is enforced by PG, not only by the JSON validator.
    await assert.rejects(fixture.query('UPDATE leader_notifications SET goal_id=$2 WHERE id=$1', [expected[0].id, goal.id]), { code: '23514' });
    await assert.rejects(fixture.query('UPDATE leader_notifications SET execution_id=NULL WHERE id=$1', [expected[0].id]), { code: '23514' });
    await assert.rejects(fixture.query('UPDATE leader_notifications SET execution_id=$2 WHERE id=$1', [expected[0].id, expected[1].id]), { code: '23514' });
    await assert.rejects(fixture.query("UPDATE leader_notifications SET kind='blocked' WHERE id=$1", [expected[0].id]), { code: '23514' });
    // This satisfies XOR/id/kind, isolating the orphan goal FK violation.
    await assert.rejects(fixture.query("UPDATE leader_notifications SET execution_id=NULL,goal_id=id,kind='completed' WHERE id=$1", [expected[0].id]), { code: '23503' });
    await assert.rejects(fixture.query(`INSERT INTO leader_notifications(id,goal_id,chat_id,kind,status,created_at,expires_at,data)
      VALUES($1,$1,$2,'failed','pending',$3,$4,'{}'::jsonb)`, [goal.id, goal.chatId, now, now + DAY_MS]), { code: '23514' });
    assert.deepEqual(await rows(), migrated);
    console.log('PASS real PG legacy notification migration: all four statuses/attempts preserved, invalid data rolls back DDL+data, idempotent init, no goal backfill and FK/source identity enforced');
  }, [
    { label: 'migration store', cleanup: () => store.close() },
    { label: 'migration pool', cleanup: () => fixture.end() },
    { label: 'migration schema', cleanup: async () => { if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`); } },
  ]);
}
