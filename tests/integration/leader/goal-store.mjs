import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { withTestCleanup } from '../../support/cleanup.mjs';

const PREVIEW_MS = 600_000;
const CLAIM_MS = 120_000;
const CONFLICT = 'ConflictError';

// Caller initializes its temporary database once, before any Controller starts.
// Every ID/chat is unique; cleanup cancels only records made by this verifier.
export async function verifyGoalStore({ stores, pool, reopenStore, waitFor }) {
  assert.equal(stores.length, 2, 'Goal verification requires two independent PG stores');
  const { createGoal, GOAL_LEASE_MS, GOAL_SEND_CLAIM_MS, goalRequestId, renderGoalAction } = await import('../../../controller/dist/leader/goals/goal.js');
  const { createExecution } = await import('../../../controller/dist/leader/plans/execution.js');
  const { GoalScheduler } = await import('../../../controller/dist/leader/goals/scheduler.js');
  const records = new Map(), executionIds = [], outstanding = [];
  const tag = randomUUID().slice(0, 8);
  let sequence = 0, reopened;
  const next = (record, patch) => ({ ...structuredClone(record), ...patch, revision: record.revision + 1 });
  const make = async (suffix, options = {}) => {
    let clock = Date.now();
    const chatId = `goal-store-${tag}-${++sequence}-${suffix}`;
    const proposal = { id: randomUUID(), expiresAt: clock + PREVIEW_MS, objective: 'fixture-only continuous verification',
      criteria: ['Exact fixture evidence supports completion'], targets: [{ nodeId: 'goal-store-node', sessionId: 'fixture-session', sendRoute: 'control-socket' }],
      constraints: 'synthetic only', maxActions: 2, maxDecisions: 3, durationMinutes: 30, shareResults: true, ...options };
    const record = createGoal(chatId, proposal, clock);
    const authority = { revision: 1, messageId: `goal-confirm-${sequence}`, inputHash: randomUUID() };
    const data = { inflight: { messageId: authority.messageId, inputHash: authority.inputHash, expiresAt: clock + CLAIM_MS, goal: proposal } };
    assert(await stores[0].compareAndSetLeaderState(chatId, 0, data));
    records.set(record.id, record);
    return { record, authority, data, now: () => clock, tick: ms => { clock += ms; } };
  };
  const confirm = fixture => stores[0].confirmGoal(fixture.record, fixture.authority, fixture.now);
  const noGoal = async id => {
    assert.equal(await stores[0].getGoal(id), null);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM leader_goals WHERE id=$1', [id])).rows[0].count, 0);
  };
  const cancel = async id => {
    const goal = await stores[0].getGoal(id);
    if (goal && ['active', 'blocked'].includes(goal.status)) {
      assert(await stores[0].compareAndSetGoal(next(goal, { status: 'cancelled', lease: undefined }), goal.revision));
    }
  };
  await withTestCleanup(async () => {
    const shared = await make('duplicate');
    const confirmations = await Promise.all(stores.map(store => store.confirmGoal(shared.record, shared.authority, shared.now)));
    assert.equal(confirmations.filter(result => result.created).length, 1);
    confirmations.forEach(result => assert.deepEqual(result.goal, shared.record));
    assert.deepEqual((await confirm(shared)).goal, shared.record, 'Duplicate confirmation changed durable authorization');
    const invalid = structuredClone(shared.record);
    invalid.proposal.objective = 'altered authorization';
    await assert.rejects(stores[1].confirmGoal(invalid, shared.authority, shared.now), { name: CONFLICT });

    // The confirmed lease is a CAS budget claim, not a model call under a SQL transaction.
    const input = { authorization: shared.record.proposal, actions: [], decisions: [], availableTargets: [1], decisionAttempts: 1 };
    const claims = await Promise.all(Array.from({ length: 8 }, (_, index) => stores[index % 2].compareAndSetGoal(next(shared.record, {
      decisionAttempts: 1, lease: { token: randomUUID(), startedAt: shared.now(), expiresAt: shared.now() + GOAL_LEASE_MS, input },
    }), 1, shared.now)));
    assert.equal(claims.filter(Boolean).length, 1, 'Two PG stores consumed one decision lease twice');
    const leased = claims.find(Boolean);
    await assert.rejects(stores[1].compareAndSetGoal(next(leased, { proposal: { ...leased.proposal, maxActions: 12 } }), leased.revision, shared.now));
    await assert.rejects(stores[1].compareAndSetGoal(next(leased, { decisionAttempts: 2 }), leased.revision, shared.now));
    assert.deepEqual(await stores[0].getGoal(leased.id), leased, 'Rejected scope/budget mutation changed persisted goal');
    const decision = { type: 'next', target: 1, prompt: 'durable first task', sourceActions: [], reason: 'fixture decision' };
    const action = { index: 1, target: 1, prompt: decision.prompt, sourceActions: [], input: { prompt: renderGoalAction(leased.proposal, decision.prompt, []), sources: [] } };
    const committed = next(leased, { lease: undefined, actions: [action], decisions: [{ index: 1, decision,
      inputSHA256: createHash('sha256').update(JSON.stringify(input)).digest('hex'), evidence: [] }] });
    assert(await stores[0].compareAndSetGoal(committed, leased.revision, shared.now));
    const startedAt = shared.now();
    const attempt = { token: randomUUID(), startedAt, expiresAt: startedAt + GOAL_SEND_CLAIM_MS };
    const claimed = next(committed, { actions: [{ ...action, attempt }] });
    assert(await stores[1].compareAndSetGoal(claimed, committed.revision, shared.now));
    for (const replacement of [undefined, { ...attempt, token: randomUUID() }]) {
      await assert.rejects(stores[0].compareAndSetGoal(next(claimed, { actions: [{ ...action, attempt: replacement }] }), claimed.revision, shared.now), /replay/);
    }
    assert.equal(await stores[0].compareAndSetGoal(next(committed, {}), committed.revision, shared.now), null);
    assert.equal(await stores[0].findCommandByRequestId(goalRequestId(shared.record, 0)), null);
    shared.tick(GOAL_SEND_CLAIM_MS + 1);
    let replayed = 0;
    const uncertain = new GoalScheduler(stores[0], { submit: async () => { replayed++; } }, async () => { throw new Error('Missing send claim must not call model'); }, { now: shared.now });
    await uncertain.advance(shared.record.id);
    assert.equal((await stores[1].getGoal(shared.record.id)).status, 'blocked');
    await uncertain.advance(shared.record.id);
    assert.equal(replayed, 0, 'An expired permanent send claim was replayed');

    // An open blocked goal still owns the chat slot, including against fixed plans.
    const fixed = createExecution(shared.record.chatId, { id: randomUUID(), expiresAt: Date.now() + PREVIEW_MS,
      actions: [{ nodeId: 'goal-store-node', sessionId: 'fixture-session', prompt: 'fixed synthetic', sendRoute: 'control-socket', dependsOn: [] }] }, Date.now());
    executionIds.push(fixed.id);
    await assert.rejects(stores[1].createExecutionIfAbsent(fixed), { name: CONFLICT });
    await cancel(shared.record.id);
    assert.equal((await stores[1].createExecutionIfAbsent(fixed)).created, true);

    for (const order of ['goal-first', 'plan-first', 'concurrent']) {
      const fixture = await make(order);
      const plan = createExecution(fixture.record.chatId, { id: randomUUID(), expiresAt: fixture.now() + PREVIEW_MS,
        actions: [{ nodeId: 'goal-store-node', sessionId: 'fixture-session', prompt: 'fixed race', sendRoute: 'control-socket', dependsOn: [] }] }, fixture.now());
      executionIds.push(plan.id);
      const data = structuredClone(fixture.data);
      data.inflight.plan = plan.plan;
      const state = await stores[0].compareAndSetLeaderState(fixture.record.chatId, fixture.authority.revision, data);
      fixture.authority.revision = state.revision;
      const goalConfirm = () => stores[0].confirmGoal(fixture.record, fixture.authority, fixture.now);
      const planConfirm = () => stores[1].confirmExecution(plan, fixture.authority, fixture.now);
      if (order === 'concurrent') {
        const outcomes = await Promise.allSettled([goalConfirm(), planConfirm()]);
        assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1, 'Goal and fixed plan won the same chat');
        outcomes.filter(item => item.status === 'rejected').forEach(item => assert.equal(item.reason.name, CONFLICT));
      } else {
        await (order === 'goal-first' ? goalConfirm() : planConfirm());
        await assert.rejects(order === 'goal-first' ? planConfirm() : goalConfirm(), { name: CONFLICT });
      }
      const [goalRow, planRow] = await Promise.all([stores[0].getGoal(fixture.record.id), stores[1].getExecution(plan.id)]);
      assert.equal(Number(Boolean(goalRow)) + Number(Boolean(planRow)), 1);
    }

    // Prove expiry is rechecked after a real chat row-lock wait, and cancellation
    // committed while blocked cannot publish a schedulable goal.
    for (const mode of ['claim', 'proposal', 'cancel']) {
      const fixture = await make('lock-' + mode);
      if (mode === 'proposal') {
        fixture.data.inflight.expiresAt = fixture.record.proposal.expiresAt + CLAIM_MS;
        fixture.authority.revision = (await stores[0].compareAndSetLeaderState(fixture.record.chatId, 1, fixture.data)).revision;
      }
      const client = await pool.connect();
      let transaction = false;
      try {
        await client.query('BEGIN'); transaction = true;
        const { rows: [{ pid }] } = await client.query('SELECT pg_backend_pid() AS pid');
        await client.query('SELECT chat_id FROM leader_states WHERE chat_id=$1 FOR UPDATE', [fixture.record.chatId]);
        const pending = stores[1].confirmGoal(fixture.record, fixture.authority, fixture.now).then(result => ({ result }), error => ({ error }));
        outstanding.push(pending);
        await waitFor(async () => (await pool.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND $1::int=ANY(pg_blocking_pids(pid)) AND query LIKE '%FROM leader_states WHERE chat_id=$1 FOR UPDATE%') AS blocked`, [pid])).rows[0].blocked,
        'Goal confirmation is independently observed waiting on PostgreSQL row lock');
        if (mode === 'cancel') await client.query('UPDATE leader_states SET revision=revision+1,data=$2::jsonb WHERE chat_id=$1', [fixture.record.chatId, '{}']);
        else fixture.tick(mode === 'claim' ? CLAIM_MS : PREVIEW_MS);
        await client.query('COMMIT'); transaction = false;
        assert.equal((await pending).error?.name, CONFLICT);
        await noGoal(fixture.record.id);
      } finally {
        try { if (transaction) await client.query('ROLLBACK'); }
        finally { client.release(); }
      }
    }

    const expired = await make('expiry', { durationMinutes: 1 });
    await confirm(expired); expired.tick(60_000);
    const never = new GoalScheduler(stores[1], { submit: async () => { throw new Error('Expired goal dispatched'); } },
      async () => { throw new Error('Expired goal invoked model'); }, { now: expired.now });
    await never.advance(expired.record.id);
    assert.equal((await stores[0].getGoal(expired.record.id)).status, 'expired');

    for (const budget of ['actions', 'decisions']) {
      const fixture = await make('budget-' + budget, budget === 'actions' ? { maxActions: 1 } : { maxDecisions: 1 });
      await confirm(fixture);
      let calls = 0, sends = 0;
      const diagnostics = [];
      const scheduler = new GoalScheduler(stores[0], { submit: async (input, _retries, gate, route) => {
        await gate(); sends++;
        const stamp = new Date(fixture.now()).toISOString(), commandId = randomUUID(), turnId = 'turn-' + commandId;
        await stores[0].createCommandIfAbsent({ ...input, commandId, sendRoute: route, status: 'pending', createdAt: stamp, updatedAt: stamp,
          expiresAt: new Date(fixture.now() + PREVIEW_MS).toISOString() });
        await stores[0].updateCommandStatus(commandId, 'accepted', '', undefined, turnId);
        await stores[1].updateCommandStatus(commandId, 'completed', 'exact budget fixture', undefined, turnId);
      } }, async () => { calls++; return decision; }, { now: fixture.now, canDispatch: () => true, onError: error => diagnostics.push(error) });
      await scheduler.advance(fixture.record.id); await scheduler.advance(fixture.record.id); await scheduler.advance(fixture.record.id);
      const stopped = await stores[1].getGoal(fixture.record.id);
      assert.equal(stopped.status, 'blocked');
      assert.equal(sends, 1); assert.equal(calls, budget === 'actions' ? 2 : 1);
      assert.equal(stopped.decisionAttempts, budget === 'actions' ? 2 : 1);
      assert.equal(diagnostics.length, budget === 'actions' ? 1 : 0);
      await scheduler.advance(fixture.record.id);
      assert.equal(calls, budget === 'actions' ? 2 : 1, 'Blocked goal repeatedly called the model');
    }

    const allowed = await make('allowlist-single');
    await confirm(allowed);
    const excluded = await make('allowlist-newer');
    excluded.tick(1);
    excluded.record = createGoal(excluded.record.chatId, excluded.record.proposal, excluded.now());
    records.set(excluded.record.id, excluded.record);
    await confirm(excluded);
    assert(excluded.record.createdAt > allowed.record.createdAt, 'Excluded fixture must be newer');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM leader_goals WHERE id=$1 AND chat_id=$2',
      [excluded.record.id, excluded.record.chatId])).rows[0].count, 1, 'Independent SQL must prove excluded goal exists');
    assert.equal((await stores[0].listRecentGoals([allowed.record.chatId, excluded.record.chatId], 1))[0].id,
      excluded.record.id, 'Newer excluded goal must otherwise win LIMIT 1');
    assert.deepEqual(await stores[1].listRecentGoals([allowed.record.chatId], 1), [allowed.record],
      'Nonempty allowlist must filter out a newer other-chat goal before LIMIT');

    reopened = reopenStore();
    for (const id of records.keys()) assert.deepEqual(await reopened.getGoal(id), await stores[0].getGoal(id), 'Goal lost durable state on reconnect');
    assert.deepEqual(await reopened.listRecentGoals([], 13), []);
    const chats = [...records.values()].map(record => record.chatId);
    const visible = await stores[1].listRecentGoals(chats, 64);
    assert(visible.every(record => chats.includes(record.chatId)));
    for (const record of visible) {
      record.proposal.targets[0].sessionId = 'caller mutation';
      assert.notEqual((await stores[0].getGoal(record.id)).proposal.targets[0].sessionId, 'caller mutation');
    }
    console.log('PASS real PG goals: atomic confirmation, decision CAS and permanent send claim; unknown never replayed; immutable scope/budget; blocked owns chat');
    console.log('PASS real PG goal/fixed two-store races, post-row-lock TTL/cancel, expiry/action/decision budgets, reconnect and allowlist isolation');
  }, [
    { label: 'goal confirmation promises', cleanup: () => Promise.all(outstanding) },
    { label: 'goal fixtures', cleanup: async () => { for (const id of records.keys()) await cancel(id); } },
    { label: 'goal fixed-plan fixtures', cleanup: async () => {
      for (const id of executionIds) {
        const record = await stores[0].getExecution(id);
        if (record?.status === 'active') assert(await stores[0].compareAndSetExecution(next(record, { status: 'cancelled' }), record.revision));
      }
    } },
    { label: 'reopened goal store', cleanup: () => reopened?.close() },
  ]);
}
