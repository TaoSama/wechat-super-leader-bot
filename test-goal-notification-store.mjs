import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withTestCleanup } from './scripts/test-cleanup.mjs';

const PREVIEW_MS = 60_000;
const PRIVATE_REASON = 'private-goal-reason-not-for-notification';

export async function verifyGoalNotificationStore({ stores, pool, reopenStore }) {
  const { createGoal } = await import('./controller/dist/leader/goal.js');
  const now = Date.now(), goals = [];
  let rejecting = false, reopened;
  const make = async () => {
    const chatId = 'goal-notice-' + randomUUID();
    const proposal = { id: randomUUID(), expiresAt: now + PREVIEW_MS, objective: PRIVATE_REASON,
      criteria: [PRIVATE_REASON], constraints: PRIVATE_REASON, maxActions: 1, maxDecisions: 2, durationMinutes: 1,
      shareResults: true, targets: [{ nodeId: 'fixture-node', sessionId: 'fixture-session', sendRoute: 'desktop-owner' }] };
    const goal = createGoal(chatId, proposal, now), messageId = randomUUID(), inputHash = randomUUID();
    assert(await stores[0].compareAndSetLeaderState(chatId, 0, { inflight: { messageId, inputHash, expiresAt: now + PREVIEW_MS, goal: proposal } }));
    assert.equal((await stores[0].confirmGoal(goal, { revision: 1, messageId, inputHash }, () => now)).created, true);
    goals.push(goal.id); return goal;
  };
  const next = (goal, status) => ({ ...goal, status, revision: goal.revision + 1, lease: undefined,
    ...(status === 'blocked' ? { blockedReason: PRIVATE_REASON } : {}) });
  await withTestCleanup(async () => {
    const atomic = await make();
    assert.equal(await stores[0].getNotification(atomic.id, now), null);
    assert.match(atomic.id, /^[a-f0-9-]{36}$/);
    await pool.query(`ALTER TABLE leader_notifications ADD CONSTRAINT goal_notice_reject CHECK (id <> '${atomic.id}')`);
    rejecting = true;
    await assert.rejects(stores[0].compareAndSetGoal(next(atomic, 'blocked'), atomic.revision, () => now));
    assert.deepEqual(await stores[1].getGoal(atomic.id), atomic, 'Goal committed without its outbox event');
    assert.equal(await stores[1].getNotification(atomic.id, now), null);
    await pool.query('ALTER TABLE leader_notifications DROP CONSTRAINT goal_notice_reject'); rejecting = false;
    const race = await Promise.all(stores.map(store => store.compareAndSetGoal(next(atomic, 'blocked'), atomic.revision, () => now)));
    assert.equal(race.filter(Boolean).length, 1);
    const notice = await stores[1].getNotification(atomic.id, now);
    assert.deepEqual(notice.source, { type: 'goal', id: atomic.id }); assert.equal(notice.kind, 'blocked');
    assert.equal(notice.status, 'pending'); assert(!JSON.stringify(notice).includes(PRIVATE_REASON));
    const row = (await pool.query('SELECT execution_id,goal_id FROM leader_notifications WHERE id=$1', [atomic.id])).rows[0];
    assert.deepEqual(row, { execution_id: null, goal_id: atomic.id });
    await assert.rejects(stores[0].claimNotification(atomic.id, randomUUID(), ['another-chat'], now));
    const claims = await Promise.allSettled(stores.map(store => store.claimNotification(atomic.id, randomUUID(), [atomic.chatId], now)));
    assert.equal(claims.filter(result => result.status === 'fulfilled' && result.value).length, 1);
    const claimed = await stores[0].getNotification(atomic.id, now);
    await stores[1].recordNotificationReceipt(atomic.id, claimed.attemptId, 'uncertain', now);
    const beforeExpiry = await stores[0].getNotification(atomic.id, now);
    const blocked = await stores[0].getGoal(atomic.id);
    assert(await stores[1].compareAndSetGoal(next(blocked, 'expired'), blocked.revision, () => atomic.expiresAt));
    assert.deepEqual(await stores[0].getNotification(atomic.id, atomic.expiresAt), beforeExpiry, 'Blocked expiry rewrote notification or attempt');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM leader_notifications WHERE goal_id=$1', [atomic.id])).rows[0].count, 1);
    await assert.rejects(stores[0].claimNotification(atomic.id, randomUUID(), [atomic.chatId], atomic.expiresAt));

    const cancelled = await make();
    assert(await stores[0].compareAndSetGoal(next(cancelled, 'cancelled'), cancelled.revision, () => now));
    assert.equal(await stores[1].getNotification(cancelled.id, now), null);
    const expired = await make();
    assert(await stores[0].compareAndSetGoal(next(expired, 'expired'), expired.revision, () => expired.expiresAt));
    assert.equal((await stores[1].getNotification(expired.id, expired.expiresAt)).kind, 'expired');
    assert.equal((await stores[0].listPendingNotifications([expired.chatId], expired.expiresAt)).length, 1);
    assert.equal((await stores[0].listPendingNotifications(['another-chat'], expired.expiresAt)).length, 0);
    reopened = reopenStore();
    assert.deepEqual(await reopened.getNotification(atomic.id, atomic.expiresAt), beforeExpiry);
    await assert.rejects(reopened.claimNotification(atomic.id, randomUUID(), [atomic.chatId], atomic.expiresAt));
    console.log('PASS real PG goals: outbox failure rolls back CAS, concurrent transition and claim single-winner, blocked→expired preserves unknown attempt, cancel silent, explicit expiry and chat isolation');
  }, [
    { label: 'goal notification rejecting constraint', cleanup: async () => { if (rejecting) await pool.query('ALTER TABLE leader_notifications DROP CONSTRAINT goal_notice_reject'); } },
    { label: 'goal notification store fixtures', cleanup: async () => {
      for (const id of goals) {
        const goal = await stores[0].getGoal(id);
        if (['active', 'blocked'].includes(goal.status)) assert(await stores[0].compareAndSetGoal(next(goal, 'cancelled'), goal.revision, () => now));
      }
    } },
    { label: 'goal notification reopened store', cleanup: () => reopened?.close() },
  ]);
}
