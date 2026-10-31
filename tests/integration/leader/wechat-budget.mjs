import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { verifyBudgetNotifications } from './wechat-budget-notifications.mjs';

export const BUDGET_REPLY_TASK = '请输出完整合成预算报告以验证默认十片后只读恢复';
const BUDGET_BODY = '甲'.repeat(4_100);
export const BUDGET_REPLY = '# 合成预算报告\n\n**' + BUDGET_BODY + '**\n\n终段完整。';
const BUDGET_DISPLAY_REPLY = '合成预算报告\n\n' + BUDGET_BODY + '\n\n终段完整。';
const DEFAULT_SEND_BUDGET = 10;
// Ordinary model answers are bounded to 4500 chars; small explicit chunks exercise ten-send
// exhaustion without changing that Controller contract. Notification tests use default 3800.
const REPLY_CHUNK_CHARS = 400;
const TEXT_TYPE = 1;
const text = message => message.item_list[0].text_item.text;

export async function verifyWechatBudget(harness) {
  const { input, runGateway, sent, statePath, incoming, evidence, chatId, contextToken, controllerRequests,
    validContexts, restartController, query, wireEvents } = harness;
  const state = async () => JSON.parse(await readFile(statePath, 'utf8'));
  assert(BUDGET_REPLY.length <= 4_500, 'Budget response exceeded the ordinary Controller response contract');
  assert(BUDGET_DISPLAY_REPLY.length > DEFAULT_SEND_BUDGET * REPLY_CHUNK_CHARS,
    'Formatted response must require a genuine eleventh send');
  const messageId = randomUUID(), key = JSON.stringify(['synthetic-account', chatId, messageId]);
  const start = sent.length;
  await input(BUDGET_REPLY_TASK, messageId, contextToken, { gatewayEnv: { GATEWAY_MAX_CHARS: String(REPLY_CHUNK_CHARS) } });
  const frozen = await state();
  assert.equal(sent.length - start, DEFAULT_SEND_BUDGET, 'Default CLI did not stop at exactly ten sends');
  assert.equal(frozen.account_send_budget.remaining, 0);
  assert.equal(frozen.delivery_outbox[key].status, 'pending');
  assert.equal(frozen.delivery_outbox[key].splitMaxChars, REPLY_CHUNK_CHARS);
  assert.equal(frozen.reply_deliveries[key].acknowledgedChunks, DEFAULT_SEND_BUDGET);
  assert.equal(frozen.reply_deliveries[key].inFlight, false);
  assert(frozen.processed_message_keys.includes(key), 'Deferred reply did not checkpoint inbound identity');
  assert(sent.slice(start).every(part => text(part).length <= REPLY_CHUNK_CHARS));
  const nativeCommands = harness.deliveries.length;
  const initialModels = wireEvents.filter(event => event.kind === 'model' && event.text === BUDGET_REPLY_TASK).length;
  assert.equal(initialModels, 1);
  const postCount = () => controllerRequests.filter(request => request.method === 'POST' &&
    request.path === '/v1/messages' && request.body.messageId === messageId).length;
  assert.equal(postCount(), 1);

  // Every --poll-once is a fresh CLI process reloading the same durable file.
  await restartController();
  const noContext = await runGateway('--poll-once');
  assert.equal(noContext.processedCount, 0);
  assert.equal(sent.length - start, DEFAULT_SEND_BUDGET, 'Restart reset the exhausted budget');
  assert.notEqual((await state()).sync_buf, frozen.sync_buf, 'Deferred delivery stalled getupdates cursor');
  incoming.push({ message_type: TEXT_TYPE, from_user_id: chatId, client_id: messageId,
    create_time_ms: frozen.context_windows[chatId].refreshedAt, context_token: contextToken,
    item_list: [{ type: TEXT_TYPE, text_item: { text: BUDGET_REPLY_TASK } }] });
  await runGateway('--poll-once');
  assert.equal(sent.length - start, DEFAULT_SEND_BUDGET, 'Duplicate inbound replenished send quota');
  assert.equal(postCount(), 1, 'Restart replayed the original mutation');

  const nextContext = 'synthetic-budget-refresh-' + randomUUID();
  validContexts.add(nextContext);
  const beforeRefresh = sent.length;
  const resumed = await input(query, randomUUID(), nextContext, { gatewayEnv: { GATEWAY_MAX_CHARS: '200' } });
  assert.equal(resumed.summary.processedCount, 1);
  const recovered = await state();
  assert.equal(recovered.delivery_outbox[key], undefined, 'New context did not drain the frozen outbox');
  // Stable per-index IDs separate the original reply from the refresh message reply.
  const total = frozen.reply_deliveries[key].totalChunks;
  const replyParts = Array.from({ length: total }, (_, index) => {
    const matches = sent.slice(start).filter(part => part.client_id === harness.clientId(key, index));
    assert.equal(matches.length, 1, 'Confirmed original reply part resent or missing at index ' + index);
    return matches[0];
  });
  assert.equal(replyParts.map(text).join(''), BUDGET_DISPLAY_REPLY,
    'GET recovery changed or truncated the frozen formatted reply');
  assert(!replyParts.map(text).join('').includes('**'), 'Ordinary reply leaked Markdown emphasis');
  assert(replyParts.slice(DEFAULT_SEND_BUDGET).every(part => part.context_token === nextContext));
  assert(replyParts.slice(DEFAULT_SEND_BUDGET).some(part => text(part).length > 200),
    'Restart applied new CLI split config to an existing frozen reply');
  assert.equal(postCount(), 1, 'GET recovery POSTed the old message again');
  const reads = controllerRequests.filter(request => request.method === 'GET' &&
    request.path === `/v1/messages/${encodeURIComponent(messageId)}/reply?chatId=${encodeURIComponent(chatId)}`);
  assert(reads.length >= 1, 'Frozen reply recovery did not read the real message GET route');
  assert(reads.every(request => request.status === 200));
  assert.equal(wireEvents.filter(event => event.kind === 'model' && event.text === BUDGET_REPLY_TASK).length, initialModels);
  assert.equal(harness.deliveries.length, nativeCommands, 'Read-only recovery dispatched a native task');
  const after = sent.length;
  await runGateway('--poll-once');
  assert.equal(sent.length, after, 'Completed outbox replayed on another CLI restart');
  evidence('default-ten-reply-budget', { defaultBudget: DEFAULT_SEND_BUDGET, explicitReplyMaxChars: REPLY_CHUNK_CHARS,
    firstWindowParts: DEFAULT_SEND_BUDGET, originalReplyParts: total, pausedWithoutUnknown: true,
    cursorAdvancesWhilePaused: true, controllerAndGatewayRestarted: true, duplicateQuotaRefreshes: 0,
    newContextSends: after - beforeRefresh, messagePosts: postCount(), recoveryGets: reads.length,
    postEndpoint: 'POST /v1/messages', recoveryEndpoint: 'GET /v1/messages/:messageId/reply?chatId', recoveryHttpStatus: 200,
    originalModelCalls: initialModels, confirmedPartResends: 0, frozenSplitSurvivesConfigChange: true,
    exactReconstruction: true });

  const refreshContext = (message = query, token = 'synthetic-notification-context-' + randomUUID(), options) =>
    input(message, randomUUID(), token, options);
  await harness.setSessionStatus('idle');
  await verifyBudgetNotifications({ ...harness, refreshContext });
  evidence('PASS-default-budget', { realControllerProcess: true, realGatewayCli: true,
    disposablePostgres: true, actualWeChatHttps: true, noProductionRequests: true });
}
