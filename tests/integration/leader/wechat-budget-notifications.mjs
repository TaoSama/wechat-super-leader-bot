import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { waitFor } from '../../support/control-plane-fixture.mjs';
import { RAW_REPLY } from './reliable-delivery.mjs';

const SEND_BUDGET = 10;
const PENDING_ACKNOWLEDGEMENT = '本次指令已保存，接收执行待后续核查。';
const ACKNOWLEDGEMENT_CHARS = 8;
const ACKNOWLEDGEMENT_PARTS = SEND_BUDGET - 1;
const EMPTY_RESTART_POLLS = 2;
const THREE_PART_OUTPUT = '预算正文 😀\n' + '甲'.repeat(8_000) + '\n**终段完整**';
const text = message => message.item_list[0].text_item?.text;

/** Real Controller/PG/Gateway; small confirmation chunks consume the actual default quota. */
export async function verifyBudgetNotifications(harness) {
  const { runGateway, pending, sent, deliveries, sendFrame, statePath, evidence, healthy,
    chatId, directTask, resultClientId, refreshContext, getDelivery, fullResult,
    elapseDispatchInterval, artifactText, waitForAccepted, sessionLabel } = harness;
  const state = async () => JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal((await pending()).length, 0, 'Budget fixture starts with pending results');
  assert.equal(Object.keys((await state()).delivery_outbox).length, 0,
    'Budget fixture starts with unfinished ordinary replies');

  const commandStart = deliveries.length, ordinaryStart = sent.length;
  const ordinary = await refreshContext(directTask, undefined,
    { gatewayEnv: { GATEWAY_MAX_CHARS: String(ACKNOWLEDGEMENT_CHARS) } });
  await waitFor(() => { healthy(); return deliveries.length === commandStart + 1; },
    'Budget result task reaches the exact native session');
  assert.equal(ordinary.summary.processedCount, 1);
  assert.equal(ordinary.replies.length, ACKNOWLEDGEMENT_PARTS);
  assert.equal(sessionLabel, '[synthetic-wechat-interaction-node] 合成统计会话');
  assert.equal(ordinary.replies.map(text).join(''), `${sessionLabel}\n\n${PENDING_ACKNOWLEDGEMENT}`,
    'Budget confirmation lost the exact original title or deterministic pending receipt body');
  assert.equal(sent.length - ordinaryStart, ACKNOWLEDGEMENT_PARTS,
    'Model confirmation did not consume the real shared send budget');
  assert.equal((await state()).context_budgets[chatId].remaining, SEND_BUDGET - ACKNOWLEDGEMENT_PARTS);
  const command = deliveries.at(-1);
  await waitForAccepted(command);
  sendFrame({ type: 'result', commandId: command.commandId,
    turnId: 'synthetic-turn-' + command.commandId, status: 'completed', output: THREE_PART_OUTPUT });
  let plan;
  await waitFor(async () => {
    healthy(); plan = (await pending()).find(item => item.kind === 'completed' && item.text.includes('预算正文 😀'));
    return Boolean(plan);
  }, 'Three-message completion becomes a durable result');
  assert.equal(plan.mode, 'text');
  assert.equal(plan.messages.length, 3, 'Fixture must exercise the maximum full-text result plan');
  const raw = await fullResult(plan.id);
  assert(raw.includes(THREE_PART_OUTPUT), 'Result artifact changed the exact recorded Markdown');
  const expectedDisplay = raw.replace(/^### /gm, '').replace('**任务**', '任务')
    .replace('**终段完整**', '终段完整').trim();
  assert.equal(plan.messages.join(''), expectedDisplay,
    'Result plan did not format the complete Markdown before its immutable split');
  const resultStart = sent.length;
  const first = await runGateway('--poll-once');
  assert.equal(first.notifications.accepted, 0);
  assert.equal(first.notifications.uncertain, 0, 'Local budget exhaustion fabricated an unknown result');
  assert.equal(sent.length, resultStart,
    'A three-message result must defer as a whole when only one shared send remains');
  let deferred = await getDelivery(plan.id);
  assert.equal(deferred.status, 'waiting_for_user');
  assert.equal(deferred.lastDeferReason, 'budget_exhausted');
  assert.equal(typeof deferred.lastDeferredAttemptId, 'string');
  assert.equal(deferred.submittedMessages, 0);
  assert.equal(deferred.attemptId, undefined);
  assert.equal(deferred.attemptedAt, undefined);
  assert.equal(deferred.attemptExpiresAt, undefined);
  assert.deepEqual(deferred.messages, plan.messages);
  assert.deepEqual(deferred.source, plan.source);
  const firstDeferAttempt = deferred.lastDeferredAttemptId;
  const frozenBudget = (await state()).context_budgets[chatId];
  assert.equal(frozenBudget.remaining, 1);
  for (let index = 0; index < EMPTY_RESTART_POLLS; index++) {
    const restarted = await runGateway('--poll-once');
    assert.equal(restarted.processedCount, 0);
    assert.equal(restarted.notifications.accepted, 0);
    assert.equal(restarted.notifications.uncertain, 0);
    assert.equal(sent.length, resultStart, 'CLI restart replenished budget or submitted a deferred result');
    deferred = await getDelivery(plan.id);
    assert.equal(deferred.status, 'waiting_for_user');
    assert.equal(deferred.lastDeferredAttemptId, firstDeferAttempt,
      'No-context restart opened a new result attempt');
    assert.deepEqual((await state()).context_budgets[chatId], frozenBudget);
  }

  await elapseDispatchInterval();
  const refreshStart = sent.length;
  const refreshed = await refreshContext();
  assert.equal(refreshed.summary.processedCount, 1);
  assert.equal(refreshed.replies.length, 1);
  assert.equal(refreshed.summary.notifications.accepted, 1);
  assert.equal(refreshed.summary.notifications.uncertain, 0);
  const ids = plan.messages.map((_message, index) => resultClientId(plan.id, index));
  const parts = sent.slice(refreshStart).filter(message => ids.includes(message.client_id));
  assert.equal(sent.length - refreshStart, 4, 'Fresh ten-send window did not share ordinary and result sends');
  assert.equal(sent[refreshStart].client_id, refreshed.replies[0].client_id,
    'Deferred result preceded the new inbound ordinary response');
  assert.deepEqual(parts.map(part => part.client_id), ids);
  assert.equal(parts.map(text).join(''), expectedDisplay, 'Deferred result lost or duplicated display text');
  assert(parts.every(part => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(text(part))),
    'Result split a Unicode surrogate pair');
  const current = await state();
  assert.notEqual(current.context_budgets[chatId].lastInboundKey, frozenBudget.lastInboundKey);
  assert.equal(current.context_budgets[chatId].remaining, SEND_BUDGET - 4);
  assert(parts.every(part => part.context_token === current.context_tokens[chatId]));
  for (let index = 0; index < parts.length; index++) {
    const receipt = current.reply_deliveries[`result:${plan.id}:step:${index}`];
    assert.equal(receipt.acknowledgedChunks, 1);
    assert.equal(receipt.totalChunks, 1);
    assert.equal(receipt.inFlight, false);
  }
  assert.equal((await getDelivery(plan.id)).status, 'accepted');
  assert.equal(await fullResult(plan.id), raw, 'Formatted delivery overwrote raw Markdown artifact');
  const acceptedCount = sent.length;
  await runGateway('--poll-once');
  assert.equal(sent.length, acceptedCount, 'Restart replayed accepted result steps');
  assert.equal((await pending()).length, 0);
  assert.equal(deliveries.length, commandStart + 1, 'Context-only query redispatched the native task');
  const defers = harness.controllerRequests.filter(request => request.method === 'POST' &&
    request.path === `/v1/deliveries/${plan.id}/defer`);
  assert.equal(defers.length, 1, 'Waiting result was claimed/deferred repeatedly without a new inbound');
  assert(defers.every(request => request.status === 200 && request.body.reason === 'budget_exhausted' &&
    request.body.submittedMessages === 0));
  assert.equal(harness.controllerRequests.filter(request => request.method === 'POST' &&
    request.path === `/v1/deliveries/${plan.id}/receipt` && request.body.status === 'uncertain').length, 0);

  // Long results occupy exactly one model summary and one raw attachment. Both use the
  // same default ledger as the task acknowledgement; no unlimited text splitting remains.
  const longCommandStart = deliveries.length;
  await refreshContext(directTask);
  assert.equal((await state()).context_budgets[chatId].remaining, SEND_BUDGET - 1);
  await waitFor(() => { healthy(); return deliveries.length === longCommandStart + 1; }, 'Long budget task accepted');
  const longCommand = deliveries.at(-1);
  await waitForAccepted(longCommand);
  sendFrame({ type: 'result', commandId: longCommand.commandId,
    turnId: 'synthetic-turn-' + longCommand.commandId, status: 'completed', output: RAW_REPLY });
  let attachment;
  await waitFor(async () => {
    healthy(); attachment = (await pending()).find(item => item.kind === 'completed' && item.mode === 'attachment');
    return Boolean(attachment);
  }, 'Long result model summary and attachment prepared');
  assert.equal(attachment.messages.length, 1);
  const longRaw = await fullResult(attachment.id);
  assert(longRaw.includes(RAW_REPLY), 'Long artifact lost raw Markdown');
  await elapseDispatchInterval();
  const fileStart = sent.length;
  assert.equal((await runGateway('--poll-once')).notifications.accepted, 1);
  const fileParts = sent.slice(fileStart);
  assert.equal(fileParts.length, 2, 'Long result exceeded summary plus attachment');
  assert.equal(fileParts[0].client_id, resultClientId(attachment.id, 0));
  assert.equal(text(fileParts[0]), attachment.messages[0]);
  assert.equal(fileParts[1].client_id, resultClientId(attachment.id, 1, 'file'));
  assert.equal(fileParts[1].item_list[0].type, 4);
  assert.equal(await artifactText(fileParts[1]), longRaw, 'AES attachment changed raw result bytes');
  assert.equal((await state()).context_budgets[chatId].remaining, SEND_BUDGET - 3,
    'File and text did not each consume one send from the shared quota');
  assert.equal((await getDelivery(attachment.id)).status, 'accepted');
  const finalSent = sent.length;
  await runGateway('--poll-once');
  assert.equal(sent.length, finalSent, 'Restart replayed accepted attachment result');
  assert.equal(deliveries.length, commandStart + 2, 'Read-only result recovery reran native work');
  evidence('budget-result-resume', { sendBudget: SEND_BUDGET, confirmationParts: ACKNOWLEDGEMENT_PARTS,
    remainingBeforeThreeMessageResult: 1, deferEndpoint: 'POST /v1/deliveries/:id/defer', deferRequests: defers.length,
    submittedBeforeRefresh: 0, unknownReceipts: 0, noContextRestartPolls: EMPTY_RESTART_POLLS,
    ordinaryReplyBeforeCatchup: true, resumedFullTextMessages: 3, rawMarkdownRetained: true,
    longResultSummaryMessages: 1, longResultAttachments: 1, sharedFileTextQuota: true, acceptedStepResends: 0 });
  return { sendBudget: SEND_BUDGET, deferredFullTextMessages: 3, noContextResends: 0,
    resumedFullTextMessages: 3, summaryMessages: 1, attachments: 1, exactRawAttachment: true };
}
