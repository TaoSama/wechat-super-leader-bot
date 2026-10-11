import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1000;
const CLAIM_MS = 60_000;
const CONTENT_SENTINEL = 'must-not-appear-in-notification';

// Storage invariants only. Real completion and transport are verified separately.
// Supplied clients belong to the disposable integration database; never init them here.
export async function verifyNotificationStore({ stores, pool, reopenStore }) {
  const { createExecution } = await import('./controller/dist/leader/execution.js');
  const now = Date.now();
  const chat = 'notification-store-' + randomUUID();
  let reopened, rejectingConstraint = false;
  const make = async (chatId = chat) => {
    const record = createExecution(chatId, { id: randomUUID(), expiresAt: now + CLAIM_MS,
      actions: [{ nodeId: 'fixture-node', sessionId: 'fixture-session', prompt: CONTENT_SENTINEL,
        sendRoute: 'desktop-owner', dependsOn: [] }] }, now - CLAIM_MS);
    await stores[0].createExecutionIfAbsent(record);
    return record;
  };
  const terminate = (store, record, status, time = now) => store.compareAndSetExecution(
    { ...record, status, revision: record.revision + 1 }, record.revision, time);
  try {
    const cancelled = await make();
    await terminate(stores[0], cancelled, 'cancelled');
    assert.equal(await stores[0].getNotification(cancelled.id, now), null);

    const race = await make();
    assert.equal(await stores[0].getNotification(race.id, now), null, 'Active plan created a premature notification');
    const transitions = await Promise.all(stores.map(store => terminate(store, race, 'completed')));
    assert.equal(transitions.filter(Boolean).length, 1);
    const notification = await stores[0].getNotification(race.id, now);
    assert.equal(notification.id, race.id);
    assert.equal(notification.executionId, race.id);
    assert.equal(notification.kind, 'completed');
    assert.equal(notification.status, 'pending');
    assert.equal(notification.expiresAt - notification.createdAt, DAY_MS);
    assert(!JSON.stringify(notification).includes(CONTENT_SENTINEL), 'Task content leaked into status notification');
    assert.equal((await pool.query('SELECT count(*)::int AS total FROM leader_notifications WHERE id=$1', [race.id])).rows[0].total, 1);

    // Force the outbox INSERT to fail after the execution UPDATE; both must roll back.
    const atomic = await make();
    assert.match(atomic.id, /^[a-f0-9-]{36}$/);
    await pool.query(`ALTER TABLE leader_notifications ADD CONSTRAINT notification_fixture_reject CHECK (id <> '${atomic.id}')`);
    rejectingConstraint = true;
    await assert.rejects(terminate(stores[0], atomic, 'failed'));
    assert.deepEqual(await stores[1].getExecution(atomic.id), atomic, 'Outbox failure committed terminal execution');
    assert.equal(await stores[1].getNotification(atomic.id, now), null, 'Rollback left a partial notification');
    await pool.query('ALTER TABLE leader_notifications DROP CONSTRAINT notification_fixture_reject');
    rejectingConstraint = false;
    await terminate(stores[1], atomic, 'failed');
    assert.equal((await stores[0].getNotification(atomic.id, now)).kind, 'failed');

    const revokedAttempt = randomUUID();
    await assert.rejects(stores[0].claimNotification(race.id, revokedAttempt, [], now));
    assert.equal((await stores[1].getNotification(race.id, now)).status, 'pending');
    const attemptIds = [randomUUID(), randomUUID()];
    const claims = await Promise.allSettled(stores.map((store, index) =>
      store.claimNotification(race.id, attemptIds[index], [chat], now)));
    assert.equal(claims.filter(result => result.status === 'fulfilled' && result.value).length, 1);
    const claimed = await stores[0].getNotification(race.id, now);
    assert.equal(claimed.status, 'claimed');
    assert.equal(claimed.attemptExpiresAt, now + CLAIM_MS);
    await assert.rejects(stores[1].claimNotification(race.id, claimed.attemptId, [chat], now));
    await assert.rejects(stores[1].recordNotificationReceipt(race.id, randomUUID(), 'accepted', now));
    assert.equal((await stores[1].getNotification(race.id, now + CLAIM_MS)).status, 'uncertain');
    assert(!(await stores[1].listPendingNotifications([chat], now + CLAIM_MS)).some(item => item.id === race.id));
    await assert.rejects(stores[1].claimNotification(race.id, randomUUID(), [chat], now + CLAIM_MS));
    await stores[0].recordNotificationReceipt(race.id, claimed.attemptId, 'uncertain', now + CLAIM_MS);
    await stores[1].recordNotificationReceipt(race.id, claimed.attemptId, 'accepted', now + CLAIM_MS + 1);
    await stores[0].recordNotificationReceipt(race.id, claimed.attemptId, 'accepted', now + CLAIM_MS + 2);
    await stores[1].recordNotificationReceipt(race.id, claimed.attemptId, 'uncertain', now + CLAIM_MS + 3);
    assert.equal((await stores[0].getNotification(race.id, now + CLAIM_MS + 4)).status, 'accepted');

    const expired = await make();
    await terminate(stores[0], expired, 'expired');
    assert.equal((await stores[1].getNotification(expired.id, now + DAY_MS)).status, 'expired');
    await assert.rejects(stores[0].claimNotification(expired.id, randomUUID(), [chat], now + DAY_MS));
    assert(!(await stores[0].listPendingNotifications([chat], now + DAY_MS)).length);

    // Unauthorized older events must not consume the four available slots.
    const hidden = 'notification-hidden-' + randomUUID();
    for (let index = 0; index < 5; index++) {
      const record = await make(hidden);
      await terminate(stores[0], record, 'failed', now - 1);
    }
    const visible = 'notification-visible-' + randomUUID();
    const ordered = [];
    for (let index = 0; index < 5; index++) {
      const record = await make(visible);
      await terminate(stores[0], record, 'failed', now + (index < 3 ? 0 : index));
      ordered.push({ id: record.id, createdAt: now + (index < 3 ? 0 : index) });
    }
    ordered.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const list = await stores[1].listPendingNotifications([visible], now + 10);
    assert.deepEqual(list.map(item => item.id), ordered.slice(0, 4).map(item => item.id));
    assert.deepEqual(await stores[1].listPendingNotifications([], now), []);
    list[0].text = 'mutated caller copy';
    assert.notEqual((await stores[0].getNotification(list[0].id, now)).text, list[0].text);

    reopened = reopenStore();
    assert.equal((await reopened.getNotification(race.id, now)).status, 'accepted');
    assert.equal((await reopened.getNotification(race.id, now)).attemptId, claimed.attemptId);
    await assert.rejects(reopened.claimNotification(race.id, randomUUID(), [chat], now));
    console.log('PASS real PG terminal/outbox atomic rollback, one terminal event, concurrent permanent claim, late exact receipt, TTL, filtered bounded order and reopen without replay');
  } finally {
    if (rejectingConstraint) await pool.query('ALTER TABLE leader_notifications DROP CONSTRAINT notification_fixture_reject');
    if (reopened) await reopened.close();
  }
}
