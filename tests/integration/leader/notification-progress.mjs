import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function verifyNotificationProgress({ stores, pool, reopenStore }) {
  const { createExecution, executionRequestId } = await import('../../../controller/dist/leader/plans/execution.js');
  const { NOTIFICATION_PROGRESS_INITIAL_DELAY_MS, NOTIFICATION_PROGRESS_INTERVAL_MS } = await import('../../../controller/dist/notifications/progress.js');
  const now = Date.now(), chatId = 'progress-' + randomUUID();
  const initial = createExecution(chatId, { id: randomUUID(), expiresAt: now + 60_000,
    actions: Array.from({ length: 4 }, (_, index) => ({ nodeId: 'progress-node', sessionId: `progress-${index}`,
      prompt: `progress action ${index + 1}`, sendRoute: 'desktop-owner', dependsOn: [] })) }, now);
  await stores[0].createExecutionIfAbsent(initial);
  const record = await stores[0].compareAndSetExecution({ ...initial, revision: 2,
    attempts: initial.plan.actions.map(() => ({ token: randomUUID(), startedAt: now, expiresAt: now + 15_000 })) }, 1, now);
  assert(record);
  const source = { type: 'plan', id: record.id }, commandIds = [];
  const firstTime = now + NOTIFICATION_PROGRESS_INITIAL_DELAY_MS;
  let reopened;
  try {
    for (let index = 0; index < 4; index++) {
      const action = record.plan.actions[index], commandId = randomUUID(), turnId = 'exact-' + commandId;
      const stamp = new Date(now).toISOString(); commandIds.push({ commandId, turnId });
      await stores[0].createCommandIfAbsent({ commandId, requestId: executionRequestId(record, index), nodeId: action.nodeId,
        sessionId: action.sessionId, prompt: action.prompt, sendRoute: action.sendRoute, action: 'send', status: 'pending',
        createdAt: stamp, updatedAt: stamp, expiresAt: new Date(now + 60 * 60_000).toISOString() });
      await stores[0].updateCommandStatus(commandId, 'accepted', undefined, undefined, turnId);
      const time = firstTime + index * NOTIFICATION_PROGRESS_INTERVAL_MS;
      assert.equal(await stores[0].enqueueProgressNotification(source, time - 1), null, 'Progress arrived before delay/interval gate');
      const racers = await Promise.all(stores.map(store => store.enqueueProgressNotification(source, time)));
      const created = racers.filter(Boolean);
      assert.equal(created.length, index < 3 ? 1 : 0, 'Concurrent enqueues consumed more than one progress slot');
      if (index < 3) {
        const notification = created[0];
        assert.equal(notification.kind, 'progress'); assert.equal(notification.progress.sequence, index + 1);
        assert.notEqual(notification.id, record.id);
        const claims = await Promise.allSettled(stores.map(store => store.claimNotification(notification.id, randomUUID(), [chatId], time)));
        assert.equal(claims.filter(result => result.status === 'fulfilled').length, 1);
        const claimed = await stores[0].getNotification(notification.id, time);
        await stores[0].recordNotificationReceipt(notification.id, claimed.attemptId, index === 0 ? 'uncertain' : 'accepted', time);
      }
    }
    reopened = reopenStore();
    assert.equal(await reopened.enqueueProgressNotification(source, firstTime + 4 * NOTIFICATION_PROGRESS_INTERVAL_MS), null,
      'Reopening refilled an uncertain progress slot');
    const rows = (await pool.query("SELECT data FROM leader_notifications WHERE execution_id=$1 AND kind='progress' ORDER BY data->'progress'->>'sequence'", [record.id])).rows;
    assert.equal(rows.length, 3); assert.deepEqual(rows.map(r => r.data.progress.sequence), [1, 2, 3]);
    assert.equal(rows[0].data.status, 'uncertain');
    // A fourth sequence is rejected by the database even outside the scheduler.
    const fourth = { ...rows[0].data, id: randomUUID(), status: 'pending', progress: { sequence: 4, eventKey: 'forbidden-fourth' } };
    delete fourth.attemptId; delete fourth.attemptedAt; delete fourth.attemptExpiresAt;
    await assert.rejects(pool.query(`INSERT INTO leader_notifications(id,execution_id,chat_id,kind,status,created_at,expires_at,data)
      VALUES($1,$2,$3,'progress','pending',$4,$5,$6::jsonb)`, [fourth.id, record.id, chatId, fourth.createdAt, fourth.expiresAt, JSON.stringify(fourth)]), { code: '23514' });
    const fullOutput = `# 完整报告\n\n${'中文😀 Markdown\n'.repeat(12_000)}\n终段证据`;
    assert(Buffer.byteLength(fullOutput, 'utf8') > 128 * 1024);
    for (const [index, command] of commandIds.entries()) await stores[0].updateCommandStatus(command.commandId, 'completed',
      index === 0 ? fullOutput : `完整结果 ${index + 1}`, undefined, command.turnId);
    const terminalTime = firstTime + 5 * NOTIFICATION_PROGRESS_INTERVAL_MS;
    assert(await stores[0].compareAndSetExecution({ ...record, status: 'completed', revision: 3 }, 2, terminalTime));
    const pending = await stores[1].listPendingNotifications([chatId], terminalTime);
    assert.equal(pending.length, 1); assert.equal(pending[0].kind, 'completed'); assert(pending[0].text.includes(fullOutput));
    for (let index = 2; index <= 4; index++) assert(pending[0].text.includes(`完整结果 ${index}`));

    // A pending progress from a stale list becomes unclaimable as soon as terminal publication wins.
    const racingChat = 'progress-terminal-race-' + randomUUID();
    const racing = createExecution(racingChat, { ...initial.plan, id: randomUUID() }, now);
    await stores[0].createExecutionIfAbsent(racing);
    const claimedRace = await stores[0].compareAndSetExecution({ ...racing, revision: 2,
      attempts: [{ token: randomUUID(), startedAt: now, expiresAt: now + 15_000 }, null, null, null] }, 1, now);
    const raceCommand = randomUUID(), raceStamp = new Date(now).toISOString();
    await stores[0].createCommandIfAbsent({ commandId: raceCommand, requestId: executionRequestId(racing, 0), nodeId: 'progress-node',
      sessionId: 'progress-0', prompt: initial.plan.actions[0].prompt, sendRoute: 'desktop-owner', action: 'send', status: 'pending',
      createdAt: raceStamp, updatedAt: raceStamp, expiresAt: new Date(now + 60_000).toISOString() });
    await stores[0].updateCommandStatus(raceCommand, 'accepted', undefined, undefined, 'race-' + raceCommand);
    const stale = await stores[0].enqueueProgressNotification({ type: 'plan', id: racing.id }, firstTime);
    assert(stale); assert.equal((await stores[1].listPendingNotifications([racingChat], firstTime))[0].id, stale.id);
    assert(await stores[0].compareAndSetExecution({ ...claimedRace, revision: 3, status: 'failed' }, 2, firstTime + 1));
    await assert.rejects(stores[1].claimNotification(stale.id, randomUUID(), [racingChat], firstTime + 1));
    assert.deepEqual((await stores[1].listPendingNotifications([racingChat], firstTime + 1)).map(n => n.id), [racing.id]);
    assert.equal(await reopened.enqueueProgressNotification({ type: 'plan', id: racing.id }, firstTime + 60_000), null);
    await verifyTerminalParts({ stores, pool });
    console.log('PASS real PG progress: exact receipts, 30s/60s gates, concurrent permanent three-slot budget, uncertain+reopen dedup, terminal claim race, all Markdown beyond 128KiB');
  } finally {
    await reopened?.close();
  }
}

async function verifyTerminalParts({ stores, pool }) {
  const { createExecution, executionRequestId } = await import('../../../controller/dist/leader/plans/execution.js');
  const { NOTIFICATION_TEXT_BYTES } = await import('../../../controller/dist/notifications/contracts.js');
  const { NOTIFICATION_PART_TARGET_BYTES } = await import('../../../controller/dist/notifications/parts.js');
  const now = Date.now(), chatId = 'terminal-parts-' + randomUUID();
  const initial = createExecution(chatId, { id: randomUUID(), expiresAt: now + 60_000,
    actions: [{ nodeId: 'parts-node', sessionId: 'parts-session', prompt: '完整八 MiB 报告', sendRoute: 'desktop-owner', dependsOn: [] }] }, now);
  await stores[0].createExecutionIfAbsent(initial);
  const record = await stores[0].compareAndSetExecution({ ...initial, revision: 2,
    attempts: [{ token: randomUUID(), startedAt: now, expiresAt: now + 15_000 }] }, 1, now);
  const commandId = randomUUID(), stamp = new Date(now).toISOString(), turnId = 'part-' + commandId;
  await stores[0].createCommandIfAbsent({ commandId, requestId: executionRequestId(initial, 0), nodeId: 'parts-node',
    sessionId: 'parts-session', prompt: initial.plan.actions[0].prompt, sendRoute: 'desktop-owner', action: 'send', status: 'pending',
    createdAt: stamp, updatedAt: stamp, expiresAt: new Date(now + 60_000).toISOString() });
  await stores[0].updateCommandStatus(commandId, 'accepted', undefined, undefined, turnId);
  const output = 'x'.repeat(NOTIFICATION_TEXT_BYTES);
  await stores[0].updateCommandStatus(commandId, 'completed', output, undefined, turnId);
  let rejecting = false;
  try {
    assert.match(record.id, /^[a-f0-9-]{36}$/);
    await pool.query(`ALTER TABLE leader_notifications ADD CONSTRAINT notification_parts_reject
      CHECK (execution_id IS DISTINCT FROM '${record.id}' OR COALESCE((data->'part'->>'index')::int,1)<>2)`);
    rejecting = true;
    const terminal = { ...record, revision: 3, status: 'completed' };
    await assert.rejects(stores[0].compareAndSetExecution(terminal, 2, now));
    assert.equal((await stores[1].getExecution(record.id)).status, 'active');
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM leader_notifications WHERE execution_id=$1', [record.id])).rows[0].count, 0,
      'Second-part failure left the first part visible');
    await pool.query('ALTER TABLE leader_notifications DROP CONSTRAINT notification_parts_reject'); rejecting = false;
    assert(await stores[1].compareAndSetExecution(terminal, 2, now));
    assert.equal((await stores[0].getExecution(record.id)).status, 'completed', 'Exact eight-MiB output left its task active');
    const parts = (await pool.query("SELECT data FROM leader_notifications WHERE execution_id=$1 ORDER BY (data->'part'->>'index')::int", [record.id])).rows.map(row => row.data);
    assert.equal(parts.length, 1 + Math.ceil(NOTIFICATION_TEXT_BYTES / NOTIFICATION_PART_TARGET_BYTES));
    assert.equal(parts[0].id, record.id); assert.notEqual(parts[1].id, record.id);
    assert(parts.map(part => part.text).join('').includes(output));
    for (const part of parts) assert(Buffer.byteLength(part.text, 'utf8') <= NOTIFICATION_PART_TARGET_BYTES);
    assert.deepEqual((await stores[0].listPendingNotifications([chatId], now)).map(n => n.id), [parts[0].id]);
    await assert.rejects(stores[1].claimNotification(parts[1].id, randomUUID(), [chatId], now));
    const firstAttempt = randomUUID(); await stores[0].claimNotification(parts[0].id, firstAttempt, [chatId], now);
    await stores[0].recordNotificationReceipt(parts[0].id, firstAttempt, 'uncertain', now);
    assert.deepEqual(await stores[1].listPendingNotifications([chatId], now), []);
    await assert.rejects(stores[1].claimNotification(parts[1].id, randomUUID(), [chatId], now));
    // Only exact late acceptance can release the next part; uncertainty never implies success.
    await stores[1].recordNotificationReceipt(parts[0].id, firstAttempt, 'accepted', now);
    assert.deepEqual((await stores[0].listPendingNotifications([chatId], now)).map(n => n.id), [parts[1].id]);
    for (let index = 1; index < parts.length; index++) {
      assert.deepEqual((await stores[0].listPendingNotifications([chatId], now)).map(n => n.id), [parts[index].id]);
      const attempt = randomUUID(); await stores[1].claimNotification(parts[index].id, attempt, [chatId], now);
      await stores[1].recordNotificationReceipt(parts[index].id, attempt, 'accepted', now);
    }
    assert.deepEqual(await stores[0].listPendingNotifications([chatId], now), []);
    console.log('PASS real PG terminal parts: exact eight-MiB output+headers completes, second INSERT rolls back all parts+source, single-part listing, uncertain blocks later parts, exact late receipt unlocks order');
  } finally {
    if (rejecting) await pool.query('ALTER TABLE leader_notifications DROP CONSTRAINT notification_parts_reject');
  }
}
