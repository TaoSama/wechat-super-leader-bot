import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { waitFor } from '../../support/control-plane-fixture.mjs';
import { RAW_REPLY } from './reliable-delivery.mjs';

const SEND_BUDGET = 10;
const ORDINARY_REPLY_PARTS = 1;
const NOTIFICATION_WINDOW_PARTS = SEND_BUDGET - ORDINARY_REPLY_PARTS;
const EMPTY_RESTART_POLLS = 2;
const text = message => message.item_list[0].text_item.text;

/** Requires a drained, real PostgreSQL/Controller/Gateway fixture using the default ten-send budget. */
export async function verifyBudgetNotifications(harness) {
  const { controller, runGateway, pending, sent, deliveries, sendFrame, statePath, evidence, healthy,
    chatId, directTask, clientId, refreshContext } = harness;
  const state = async () => JSON.parse(await readFile(statePath, 'utf8'));
  const notificationRecord = async id => {
    const response = await controller.request('/v1/notifications/' + id);
    assert.equal(response.status, 200);
    return response.body.notification;
  };
  assert.equal((await pending()).length, 0, 'Budget notification fixture starts with pending notifications');
  assert.equal(Object.keys((await state()).delivery_outbox).length, 0,
    'Budget notification fixture starts with unfinished ordinary replies or notifications');

  const commandStart = deliveries.length, ordinaryStart = sent.length;
  const ordinary = await refreshContext(directTask);
  await waitFor(() => { healthy(); return deliveries.length === commandStart + 1; },
    'Budget notification task reaches the exact native session');
  assert.equal(ordinary.summary.processedCount, 1);
  assert.equal(ordinary.replies.length, ORDINARY_REPLY_PARTS);
  assert.equal(sent.length - ordinaryStart, ORDINARY_REPLY_PARTS,
    'Task acknowledgement must consume exactly one send from the new window');
  assert.equal((await state()).context_budgets[chatId].remaining, NOTIFICATION_WINDOW_PARTS);

  const command = deliveries.at(-1);
  sendFrame({ type: 'result', commandId: command.commandId,
    turnId: 'synthetic-turn-' + command.commandId, status: 'completed', output: RAW_REPLY });
  let notification;
  await waitFor(async () => {
    healthy();
    notification = (await pending()).find(item => item.kind === 'completed' && item.text.includes(RAW_REPLY));
    return Boolean(notification);
  }, 'Full Markdown completion becomes a durable budget-limited notification');
  assert.equal(notification.part?.total ?? 1, 1,
    'Fixture must exercise Gateway chunks of one Controller notification, not Controller multipart records');
  const key = 'notification:' + notification.id, notificationStart = sent.length;
  const first = await runGateway('--poll-once');
  assert.equal(first.notifications.accepted, 0);
  assert.equal(first.notifications.uncertain, 0, 'Local budget exhaustion fabricated an unknown delivery');
  let durable = await state(), delivery = durable.reply_deliveries[key];
  assert.equal(durable.delivery_outbox[key].splitMaxChars, 3_800, 'Default CLI notification split budget changed');
  assert(delivery.totalChunks > NOTIFICATION_WINDOW_PARTS, 'Notification must require another inbound window');
  const totalChunks = delivery.totalChunks, digest = delivery.digest;
  const ids = Array.from({ length: totalChunks }, (_, index) => clientId(key, index));
  const idSet = new Set(ids);
  const notificationParts = () => sent.slice(notificationStart).filter(message => idSet.has(message.client_id));
  const assertParts = acknowledged => {
    const parts = notificationParts();
    assert.equal(parts.length, acknowledged, 'Confirmed notification chunks were duplicated or lost');
    assert.deepEqual(parts.map(part => part.client_id), ids.slice(0, acknowledged),
      'Notification restart changed chunk identity or replayed an acknowledged chunk');
    assert.equal(new Set(parts.map(part => part.client_id)).size, parts.length);
    assert(notification.text.startsWith(parts.map(text).join('')), 'Continuation changed the original Markdown prefix');
    assert(parts.every(part => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(text(part))),
      'A notification chunk split a Unicode surrogate pair');
  };
  const assertDeferred = async acknowledged => {
    const receipt = await notificationRecord(notification.id), current = await state();
    assert.equal(receipt.status, 'pending', 'Exhausted local budget must defer, not claim or quarantine');
    assert.equal(receipt.lastDeferReason, 'budget_exhausted');
    assert.equal(typeof receipt.lastDeferredAttemptId, 'string');
    assert.equal(receipt.attemptId, undefined);
    assert.equal(receipt.attemptedAt, undefined);
    assert.equal(receipt.attemptExpiresAt, undefined);
    assert.equal(receipt.text, notification.text);
    assert.deepEqual(receipt.source, notification.source);
    assert.deepEqual(current.reply_deliveries[key], { digest, totalChunks,
      acknowledgedChunks: acknowledged, inFlight: false });
    assert.equal(current.delivery_outbox[key].status, 'pending');
    assert.equal(current.delivery_outbox[key].attemptId, undefined);
    assert.equal(current.context_budgets[chatId].remaining, 0);
    assertParts(acknowledged);
    return { receipt, current };
  };

  assert.equal(sent.length - notificationStart, NOTIFICATION_WINDOW_PARTS,
    'The first notification window exceeded the nine sends left by its ordinary reply');
  let deferred = await assertDeferred(NOTIFICATION_WINDOW_PARTS);
  const firstDeferAttempt = deferred.receipt.lastDeferredAttemptId;
  const stoppedAt = sent.length, beforeRestart = deferred.current;
  for (let index = 0; index < EMPTY_RESTART_POLLS; index++) {
    const restarted = await runGateway('--poll-once');
    assert.equal(restarted.processedCount, 0);
    assert.equal(restarted.notifications.accepted, 0);
    assert.equal(restarted.notifications.uncertain, 0);
    assert.equal(sent.length, stoppedAt, 'Gateway CLI restart replenished budget or resent an acknowledged chunk');
    deferred = await assertDeferred(NOTIFICATION_WINDOW_PARTS);
    assert.equal(deferred.receipt.lastDeferredAttemptId, firstDeferAttempt,
      'No-context restart opened a new notification delivery attempt');
    assert.deepEqual(deferred.current.context_budgets[chatId], beforeRestart.context_budgets[chatId]);
  }

  let acknowledged = NOTIFICATION_WINDOW_PARTS, refreshes = 0;
  const maximumRefreshes = Math.ceil((totalChunks - acknowledged) / NOTIFICATION_WINDOW_PARTS);
  while (acknowledged < totalChunks) {
    assert(refreshes < maximumRefreshes, 'Notification made no bounded progress after fresh inbound contexts');
    const roundStart = sent.length, previousBudget = (await state()).context_budgets[chatId];
    const refreshed = await refreshContext();
    refreshes++;
    healthy();
    const expected = Math.min(NOTIFICATION_WINDOW_PARTS, totalChunks - acknowledged);
    const roundParts = sent.slice(roundStart).filter(message => idSet.has(message.client_id));
    assert.equal(refreshed.summary.processedCount, 1);
    assert.equal(refreshed.replies.length, ORDINARY_REPLY_PARTS);
    assert.equal(roundParts.length, expected, 'Fresh context did not resume only the remaining notification chunks');
    assert.equal(sent.length - roundStart, ORDINARY_REPLY_PARTS + expected,
      'Refreshed window did not share its ten-send budget with the ordinary reply');
    assert.deepEqual(roundParts.map(part => part.client_id), ids.slice(acknowledged, acknowledged + expected));
    acknowledged += expected;
    durable = await state();
    delivery = durable.reply_deliveries[key];
    assert.notEqual(durable.context_budgets[chatId].lastInboundKey, previousBudget.lastInboundKey,
      'Continuation did not use a genuinely new inbound context');
    assert(roundParts.every(part => part.context_token === durable.context_tokens[chatId]),
      'Continuation used an obsolete WeChat context token');
    assert.equal(delivery.digest, digest, 'Context refresh changed the frozen chunk plan');
    assert.equal(delivery.totalChunks, totalChunks);
    assert.equal(delivery.acknowledgedChunks, acknowledged);
    assert.equal(delivery.inFlight, false);
    assert.equal(durable.context_budgets[chatId].remaining, SEND_BUDGET - ORDINARY_REPLY_PARTS - expected);
    assert.equal(refreshed.summary.notifications.uncertain, 0);
    assert.equal(refreshed.summary.notifications.accepted, acknowledged === totalChunks ? 1 : 0);
    assertParts(acknowledged);
    if (acknowledged < totalChunks) {
      const next = await assertDeferred(acknowledged);
      assert.notEqual(next.receipt.lastDeferredAttemptId, deferred.receipt.lastDeferredAttemptId,
        'Fresh notification attempt reused its previous deferred attempt identity');
      deferred = next;
    }
  }

  const accepted = await notificationRecord(notification.id);
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.text, notification.text);
  assert.equal(durable.delivery_outbox[key], undefined);
  assert.equal(notificationParts().map(text).join(''), notification.text,
    'Budget-limited completion did not reconstruct the exact persisted Markdown');
  const finalSent = sent.length;
  assert.equal((await runGateway('--poll-once')).notifications.uncertain, 0);
  assert.equal(sent.length, finalSent, 'Gateway restart replayed an accepted notification');
  assert.equal((await pending()).length, 0);
  assert.equal(deliveries.length, commandStart + 1, 'Context-only queries redispatched the native task');
  const defers = harness.controllerRequests.filter(request => request.method === 'POST' &&
    request.path === `/v1/notifications/${notification.id}/defer`);
  assert(defers.length >= 1, 'Local pause did not use the actual Controller defer endpoint');
  assert(defers.every(request => request.status === 200 && request.body.reason === 'budget_exhausted'));
  assert.equal(harness.controllerRequests.filter(request => request.method === 'POST' &&
    request.path === `/v1/notifications/${notification.id}/receipt` && request.body.status === 'uncertain').length, 0);
  evidence('budget-notification-resume', { sendBudget: SEND_BUDGET, firstOrdinaryReplyParts: ORDINARY_REPLY_PARTS,
    defaultMaxChars: 3_800, deferEndpoint: 'POST /v1/notifications/:id/defer', deferHttpStatus: 200,
    deferRequests: defers.length, unknownReceipts: 0,
    firstNotificationParts: NOTIFICATION_WINDOW_PARTS, firstAcknowledgedChunks: NOTIFICATION_WINDOW_PARTS,
    firstInFlight: false, deferredStatus: 'pending', deferReason: 'budget_exhausted',
    noContextRestartPolls: EMPTY_RESTART_POLLS, noContextResends: 0, refreshes, totalChunks,
    originalBytes: Buffer.byteLength(notification.text, 'utf8'), exactReconstruction: true,
    acknowledgedChunkResends: 0, finalStatus: accepted.status });
  return { sendBudget: SEND_BUDGET, firstNotificationParts: NOTIFICATION_WINDOW_PARTS,
    noContextRestartPolls: EMPTY_RESTART_POLLS, refreshes, totalChunks, acknowledgedChunkResends: 0,
    exactReconstruction: true, finalStatus: accepted.status };
}
