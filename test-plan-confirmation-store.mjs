import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const CHAT_PREFIX = 'confirmation-store-fixture-';
const LOCK_QUERY_PATTERN = '%FROM leader_states WHERE chat_id=$1 FOR UPDATE%';
const INSERT_QUERY_PATTERN = '%INSERT INTO leader_executions%';
const CONFLICT_NAME = 'ConflictError';

// Caller owns stores/pool and initializes once before Controller startup.
// No init, no Controller, no pool/store close, and no connection-string output.
export async function verifyPlanConfirmationStore({ stores, pool, waitFor }) {
  assert.equal(stores.length, 2, 'Two independent PostgreSQL stores are required');
  const { createExecution } = await import('./controller/dist/leader/execution.js');
  const { CLAIM_TTL_MS, PLAN_TTL_MS } = await import('./controller/dist/leader/contracts.js');
  const executions = new Map(), outstanding = [];
  const tag = randomUUID().slice(0, 8);
  let fixtureIndex = 0, failure;
  const make = async () => {
    let clock = Date.now();
    const chatId = `${CHAT_PREFIX}${tag}-${++fixtureIndex}`, id = randomUUID();
    const record = createExecution(chatId, { id, expiresAt: clock + PLAN_TTL_MS,
      actions: [{ nodeId: 'confirmation-fixture-node', sessionId: 'fixture-pane', prompt: 'fixture-only-no-dispatch',
        sendRoute: 'control-socket', dependsOn: [] }] }, clock);
    const authority = { revision: 1, messageId: `confirmation-${fixtureIndex}`, inputHash: randomUUID() };
    const data = { inflight: { messageId: authority.messageId, inputHash: authority.inputHash,
      expiresAt: clock + CLAIM_TTL_MS, plan: structuredClone(record.plan) } };
    assert(await stores[0].compareAndSetLeaderState(chatId, 0, data));
    executions.set(id, record);
    return { record, authority, data, now: () => clock, tick: ms => { clock += ms; } };
  };
  const beginConfirmation = fixture => {
    const outcome = stores[1].confirmExecution(fixture.record, fixture.authority, fixture.now)
      .then(result => ({ result }), error => ({ error }));
    outstanding.push(outcome);
    return outcome;
  };
  const assertNoExecution = async id => {
    assert.equal(await stores[0].getExecution(id), null, 'Rejected confirmation published an execution');
    const persisted = await pool.query('SELECT count(*)::int AS count FROM leader_executions WHERE id=$1', [id]);
    assert.equal(persisted.rows[0].count, 0, 'Independent SQL found an unauthorized execution');
  };
  const blockedBy = async (pid, queryPattern, label) => {
    await waitFor(async () => {
      const result = await pool.query(`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>pg_backend_pid()
          AND $1::int=ANY(pg_blocking_pids(pid)) AND query LIKE $2
      ) AS blocked`, [pid, queryPattern]);
      return result.rows[0].blocked === true;
    }, label);
  };
  const withBlocker = async run => {
    const client = await pool.connect();
    let open = false;
    try {
      await client.query('BEGIN');
      open = true;
      const result = await client.query('SELECT pg_backend_pid() AS pid');
      const finish = async command => {
        assert(['COMMIT', 'ROLLBACK'].includes(command));
        await client.query(command);
        open = false;
      };
      return await run(client, result.rows[0].pid, finish);
    } finally {
      try { if (open) await client.query('ROLLBACK'); }
      finally { client.release(); }
    }
  };

  try {
    const shared = await make();
    const confirmations = stores.map(store => store.confirmExecution(shared.record, shared.authority, shared.now)
      .then(result => ({ result }), error => ({ error })));
    outstanding.push(...confirmations);
    const results = (await Promise.all(confirmations)).map(outcome => {
      if (outcome.error) throw outcome.error;
      return outcome.result;
    });
    assert.equal(results.filter(result => result.created).length, 1, 'Concurrent atomic confirmation must have one winner');
    for (const result of results) assert.deepEqual(result.execution, shared.record);
    console.log('PASS real PostgreSQL two-store atomic confirmation: one creation winner');

    for (const ttl of ['claim', 'plan']) {
      const fixture = await make();
      if (ttl === 'plan') {
        // Keep claim valid so this independently exercises the plan-confirmation TTL.
        fixture.data.inflight.expiresAt = fixture.record.plan.expiresAt + CLAIM_TTL_MS;
        const state = await stores[0].compareAndSetLeaderState(fixture.record.chatId, 1, fixture.data);
        assert(state);
        fixture.authority.revision = state.revision;
      }
      await withBlocker(async (client, pid, finish) => {
        await client.query('SELECT chat_id FROM leader_states WHERE chat_id=$1 FOR UPDATE', [fixture.record.chatId]);
        const outcome = beginConfirmation(fixture);
        await blockedBy(pid, LOCK_QUERY_PATTERN, `atomic confirmation blocked on ${ttl} fixture chat row`);
        fixture.tick(ttl === 'claim' ? CLAIM_TTL_MS : PLAN_TTL_MS);
        await finish('COMMIT');
        const result = await outcome;
        assert.equal(result.error?.name, CONFLICT_NAME, `${ttl} TTL expired during a real row-lock wait but confirmation succeeded`);
        await assertNoExecution(fixture.record.id);
      });
    }
    console.log('PASS real PostgreSQL pg_blocking_pids proves row-lock waits; claim and plan TTL revalidated after acquiring lock');

    for (const action of ['cancel', 'replace']) {
      const fixture = await make();
      await withBlocker(async (client, pid, finish) => {
        await client.query('SELECT chat_id FROM leader_states WHERE chat_id=$1 FOR UPDATE', [fixture.record.chatId]);
        const outcome = beginConfirmation(fixture);
        await blockedBy(pid, LOCK_QUERY_PATTERN, `atomic confirmation blocked before ${action} authorization`);
        const nextData = action === 'cancel' ? {} : { inflight: { ...fixture.data.inflight, messageId: 'new-confirmation-owner' } };
        const updated = await client.query(`UPDATE leader_states SET revision=revision+1,data=$2::jsonb,updated_at=NOW()
          WHERE chat_id=$1 RETURNING revision`, [fixture.record.chatId, JSON.stringify(nextData)]);
        assert.equal(updated.rows[0].revision, fixture.authority.revision + 1);
        await finish('COMMIT');
        const result = await outcome;
        assert.equal(result.error?.name, CONFLICT_NAME, `Late confirmation bypassed ${action} authorization`);
        await assertNoExecution(fixture.record.id);
      });
    }
    console.log('PASS real PostgreSQL cancellation/replacement committed during lock wait rejects stale confirmation without publishing');

    const insertion = await make();
    await withBlocker(async (client, pid, finish) => {
      const record = insertion.record;
      await client.query(`INSERT INTO leader_executions (id,chat_id,revision,status,data,created_at)
        VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [record.id, record.chatId, record.revision, record.status, JSON.stringify(record), record.createdAt]);
      const outcome = beginConfirmation(insertion);
      await blockedBy(pid, INSERT_QUERY_PATTERN, 'atomic confirmation blocked on uncommitted execution ID INSERT');
      await assertNoExecution(record.id);
      insertion.tick(CLAIM_TTL_MS);
      // The original INSERT resumes after the conflict disappears, so only the
      // post-INSERT TTL check can reject it and keep the newly inserted row invisible.
      await finish('ROLLBACK');
      const result = await outcome;
      assert.equal(result.error?.name, CONFLICT_NAME, 'Post-lock INSERT waiting bypassed claim expiry');
      await assertNoExecution(record.id);
    });
    console.log('PASS real PostgreSQL pg_blocking_pids proves INSERT conflict wait; expired resumed INSERT rolls back with zero visible rows');
  } catch (error) { failure = error; }

  // Failed assertions still release blockers first, then join all confirmations
  // before cleaning fixtures; no delayed INSERT is allowed to escape cleanup.
  await Promise.all(outstanding);
  const cleanupErrors = [], persistedIds = [];
  for (const id of executions.keys()) {
    try {
      const current = await stores[0].getExecution(id);
      if (!current) continue;
      persistedIds.push(id);
      if (current.status === 'active') {
        assert(await stores[0].compareAndSetExecution({ ...current, status: 'cancelled', revision: current.revision + 1 }, current.revision),
          'Fixture CAS cleanup lost ownership; this helper must run before scheduler startup');
      }
    } catch (error) { cleanupErrors.push(error); }
  }
  if (failure || cleanupErrors.length) {
    throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors],
      `Real PostgreSQL confirmation verification failed: ${(failure ?? cleanupErrors[0]).message}`);
  }
  return { executionIds: persistedIds, chatPrefix: `${CHAT_PREFIX}${tag}` };
}
