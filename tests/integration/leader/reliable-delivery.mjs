import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { waitFor } from '../../support/control-plane-fixture.mjs';

export const RAW_REPLY_TASK = '请输出完整合成 Markdown 报告以验证明确拒绝后的续传';
export const PROGRESS_TASK = '请直接执行四个合成进度任务并逐项报告真实进度';
export const RAW_REPLY = '# 原始报告 😀\n\n| 项目 | 数量 |\n| --- | --- |\n| 中文😀 | 17 |\n\n' +
  '```typescript\nconst 结果 = "中文😀";\n  console.log(结果);\n```\n\n' +
  Array.from({ length: 3_000 }, (_, index) => `第 ${index + 1} 行：中文😀，保留 **Markdown**、空格与换行。\n`).join('') + '\n完整报告终段。';
export const RESUMABLE_REPLY = RAW_REPLY.slice(0, RAW_REPLY.indexOf('\n', 4_100)).trim();
const OBSERVATION_MS = 2_200;
const TEXT_TYPE = 1;
const text = message => message.item_list[0].text_item.text;

export async function verifyReliableDelivery(harness) {
  const { controller, input, runGateway, pending, sent, incoming, deliveries, sendFrame, statePath,
    fault, wireEvents, evidence, healthy, chatId, contextToken, directTask, nodeId, sessionId, clientId,
    restartController, setSessionStatus } = harness;
  assert(Buffer.byteLength(RAW_REPLY, 'utf8') > 128 * 1_024, 'Large-result fixture must exceed 128KiB');
  const complete = (command, output = RAW_REPLY) => sendFrame({ type: 'result', commandId: command.commandId,
    turnId: 'synthetic-turn-' + command.commandId, status: 'completed', output });
  const launch = async () => {
    const count = deliveries.length;
    await input(directTask);
    await waitFor(() => { healthy(); return deliveries.length === count + 1; }, 'Large-result task accepted');
    const command = deliveries.at(-1);
    complete(command);
    await waitFor(async () => { healthy(); return (await pending()).some(item => item.kind === 'completed'); },
      'Large complete result becomes a durable notification');
    const notification = (await pending()).find(item => item.kind === 'completed');
    assert(notification.text.includes(RAW_REPLY), 'Notification changed the original Markdown result');
    return { command, notification };
  };

  const { notification } = await launch();
  const start = sent.length, eventStart = wireEvents.length;
  const result = await runGateway('--poll-once');
  assert.equal(result.notifications.accepted, 1);
  const parts = sent.slice(start);
  assert(parts.length > 2, 'Large Markdown report was not split');
  assert.equal(parts.map(text).join(''), notification.text, 'Parts did not reconstruct every original character');
  assert.equal(wireEvents[eventStart].kind, 'typing', 'Long notification did not begin with typing');
  assert(parts.every((part, index) => part.client_id === clientId('notification:' + notification.id, index)));
  assert(parts.every(part => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(text(part))), 'Split broke a Unicode surrogate pair');
  const sentAfter = sent.length;
  await runGateway('--poll-once');
  assert.equal(sent.length, sentAfter, 'Restart replayed confirmed notification parts');
  evidence('large-markdown-delivery', { originalBytes: Buffer.byteLength(RAW_REPLY), parts: parts.length,
    exactReconstruction: true, markdownTableAndCode: true, typingBeforeSend: true, restartResends: 0 });

  const rawMessageId = randomUUID(), rawKey = JSON.stringify(['synthetic-account', chatId, rawMessageId]);
  const enqueueRaw = () => incoming.push({ message_type: TEXT_TYPE, from_user_id: chatId, client_id: rawMessageId,
    context_token: contextToken, item_list: [{ type: TEXT_TYPE, text_item: { text: RAW_REPLY_TASK } }] });
  fault.remaining = 2; fault.mode = 'reject';
  enqueueRaw();
  const rawStart = sent.length;
  const rejected = await runGateway('--poll-once', { expectedExit: 1 });
  assert.match(rejected.stderr, /RejectedRet|ILinkSendReceiptError/);
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.reply_deliveries[rawKey].acknowledgedChunks, 1);
  assert.equal(state.reply_deliveries[rawKey].inFlight, false);
  const confirmedId = sent[rawStart].client_id, rejectedId = sent[rawStart + 1].client_id;
  fault.mode = null;
  enqueueRaw();
  await runGateway('--poll-once');
  const rawParts = sent.slice(rawStart);
  assert.equal(rawParts.filter(part => part.client_id === confirmedId).length, 1, 'Restart resent a confirmed part');
  assert.equal(rawParts.filter(part => part.client_id === rejectedId).length, 2, 'Explicitly rejected part was not resumed');
  assert.equal([rawParts[0], ...rawParts.slice(2)].map(text).join(''), RESUMABLE_REPLY,
    'Resumed reply lost or duplicated original Markdown');
  evidence('confirmed-part-restart', { acknowledgedBeforeRestart: 1, confirmedPartResends: 0,
    rejectedPartAttempts: 2, exactReconstruction: true });
  await verifyUnknownOrdinaryReply(harness);

  const uncertain = await launch();
  const uncertainStart = sent.length;
  fault.remaining = 2; fault.mode = 'disconnect';
  const disconnected = await runGateway('--poll-once');
  assert.equal(disconnected.notifications.uncertain, 1);
  assert.equal(sent.length - uncertainStart, 2, 'Unknown delivery continued to later parts');
  const uncertainState = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(uncertainState.reply_deliveries['notification:' + uncertain.notification.id].acknowledgedChunks, 1);
  assert.equal(uncertainState.reply_deliveries['notification:' + uncertain.notification.id].inFlight, true);
  fault.mode = null;
  const beforeRestart = sent.length;
  await restartController();
  await runGateway('--poll-once');
  await runGateway('--poll-once');
  assert.equal(sent.length, beforeRestart, 'Unknown second segment was resent after both processes restarted');
  const receipt = await controller.request('/v1/notifications/' + uncertain.notification.id);
  assert.equal(receipt.body.notification.status, 'uncertain');
  evidence('unknown-second-part', { attemptedParts: 2, confirmedParts: 1, inFlight: true,
    controllerAndGatewayRestarted: true, resendCount: 0, receipt: receipt.body.notification.status });

  await setSessionStatus('busy');
  const queueStart = deliveries.length;
  const submit = async prompt => {
    const response = await controller.request('/v1/commands', { nodeId, sessionId, action: 'send', prompt,
      requestId: randomUUID() });
    assert.equal(response.status, 202);
    assert.equal(response.body.status, 'queued');
    return response.body;
  };
  const first = await submit('合成 FIFO 第一项'), second = await submit('合成 FIFO 第二项');
  const cancelled = await submit('合成排队取消项');
  const cancel = await controller.request('/v1/commands/' + cancelled.commandId + '/cancel', {});
  assert.equal(cancel.status, 200); assert.equal(cancel.body.status, 'cancelled');
  await delay(OBSERVATION_MS);
  assert.equal(deliveries.length, queueStart, 'Busy target received queued work');
  await restartController();
  const offline = await submit('合成离线重启后第三项');
  await delay(OBSERVATION_MS);
  assert.equal(deliveries.length, queueStart, 'Offline target received queued work');
  await setSessionStatus('idle');
  for (const [index, expected] of [first, second, offline].entries()) {
    await waitFor(() => { healthy(); return deliveries.length === queueStart + index + 1; }, 'FIFO dispatch ' + index);
    assert.equal(deliveries.at(-1).commandId, expected.commandId, 'Queue changed order across process restart');
    await delay(OBSERVATION_MS);
    assert.equal(deliveries.length, queueStart + index + 1, 'Next-turn command bypassed an accepted active command');
    complete(deliveries.at(-1));
  }
  await delay(OBSERVATION_MS);
  assert.equal(deliveries.length, queueStart + 3, 'Cancelled queued command was dispatched');
  assert.equal((await controller.request('/v1/commands/' + cancelled.commandId)).body.status, 'cancelled');
  evidence('durable-command-queue', { busyQueued: 3, offlineQueued: 1, cancelled: 1,
    controllerRestarted: true, fifoDelivered: 3, cancelledDeliveries: 0, activeCommandBypass: 0 });
  const progress = await verifyProgressDelivery(harness, complete);
  return { largeMarkdownBytes: Buffer.byteLength(RAW_REPLY), multipartNotifications: { accepted: 1, uncertain: 1 },
    confirmedPartResends: 0, unknownPartResends: 0, fifoDelivered: 3, cancelledDeliveries: 0, progress };
}

async function verifyUnknownOrdinaryReply(harness) {
  const { incoming, chatId, contextToken, query, runGateway, sent, statePath, fault, wireEvents, evidence } = harness;
  const messageId = randomUUID(), key = JSON.stringify(['synthetic-account', chatId, messageId]);
  const message = (text, clientId) => ({ message_type: TEXT_TYPE, from_user_id: chatId, client_id: clientId,
    context_token: contextToken, item_list: [{ type: TEXT_TYPE, text_item: { text } }] });
  const previous = JSON.parse(await readFile(statePath, 'utf8'));
  const start = sent.length;
  fault.remaining = 2; fault.mode = 'disconnect';
  incoming.push(message(RAW_REPLY_TASK, messageId), message(query, randomUUID()));
  const result = await runGateway('--poll-once');
  assert.equal(result.skippedCount, 1, 'Ambiguous ordinary reply was not isolated');
  assert.equal(result.processedCount, 1, 'Unknown delivery blocked the next message in the batch');
  assert.equal(sent.length - start, 3, 'Unknown delivery retried or blocked the later reply');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.reply_deliveries[key].acknowledgedChunks, 1);
  assert.equal(state.reply_deliveries[key].inFlight, true);
  assert(state.processed_message_keys.includes(key));
  assert.notEqual(state.sync_buf, previous.sync_buf, 'Isolated unknown delivery blocked cursor advancement');
  const modelCalls = wireEvents.filter(event => event.kind === 'model').length, sentAfter = sent.length;
  fault.mode = null;
  incoming.push(message(RAW_REPLY_TASK, messageId));
  assert.equal((await runGateway('--poll-once')).processedCount, 0);
  assert.equal(sent.length, sentAfter, 'Restart resent an ambiguous ordinary reply');
  assert.equal(wireEvents.filter(event => event.kind === 'model').length, modelCalls, 'Restart forwarded an isolated message again');
  evidence('ordinary-unknown-isolated', { confirmedParts: 1, inFlight: true, isolated: 1,
    laterBatchMessageProcessed: 1, cursorAdvanced: true, restartResends: 0, repeatedModelCalls: 0 });
}

async function verifyProgressDelivery(harness, complete) {
  const { input, runGateway, pending, sent, deliveries, wireEvents, healthy, evidence, databaseUrl, chatId, directTask } = harness;
  const require = createRequire(new URL('../../../controller/package.json', import.meta.url));
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: databaseUrl });
  const { NOTIFICATION_TTL_MS } = await import('../../../controller/dist/notifications/contracts.js');
  try {
    await verifyPostgresAuthorityAndInspection(databaseUrl, pool, evidence);
    const activeSource = async () => {
      const result = await pool.query("SELECT id FROM leader_executions WHERE chat_id=$1 AND status='active'", [chatId]);
      assert.equal(result.rows.length, 1);
      return result.rows[0].id;
    };
    // Move only synthetic persisted timestamps. Production 30s/60s policy is unchanged and is
    // boundary-tested independently by the real PostgreSQL notification-progress fixture.
    const ageSource = id => pool.query(`UPDATE leader_executions SET revision=revision+1,created_at=$2,
      data=jsonb_set(jsonb_set(jsonb_set(data,'{createdAt}',to_jsonb($2::bigint)),
        '{expiresAt}',to_jsonb($3::bigint)),'{revision}',to_jsonb(revision+1)) WHERE id=$1`,
      [id, Date.now() - 31_000, Date.now() + 600_000]);
    const ageProgress = id => {
      const createdAt = Date.now() - 61_000;
      return pool.query(`UPDATE leader_notifications SET created_at=$2,expires_at=$3,
        data=jsonb_set(jsonb_set(data,'{createdAt}',to_jsonb($2::bigint)),'{expiresAt}',to_jsonb($3::bigint))
        WHERE execution_id=$1 AND kind='progress'`, [id, createdAt, createdAt + NOTIFICATION_TTL_MS]);
    };
    const progressRows = async id => (await pool.query("SELECT data FROM leader_notifications WHERE execution_id=$1 AND kind='progress'", [id])).rows;
    const waitNotification = async (kind, sequence) => {
      let match;
      await waitFor(async () => { healthy(); match = (await pending()).find(item => item.kind === kind &&
        (sequence === undefined || item.progress.sequence === sequence)); return !!match; }, `${kind} notification ${sequence ?? ''}`);
      return match;
    };
    const deliver = async notification => {
      const start = sent.length, eventStart = wireEvents.length;
      assert.equal((await runGateway('--poll-once')).notifications.accepted, 1);
      assert.equal(sent.slice(start).map(text).join(''), notification.text);
      assert.equal(wireEvents[eventStart].kind, 'typing', 'Progress/final send did not begin with typing');
      return sent.length - start;
    };
    const start = deliveries.length;
    await input(PROGRESS_TASK);
    await waitFor(() => { healthy(); return deliveries.length === start + 1; }, 'First progress action accepted');
    const source = await activeSource();
    await ageSource(source);
    await deliver(await waitNotification('progress', 1));
    await ageProgress(source);
    const unchanged = sent.length;
    await delay(OBSERVATION_MS);
    await runGateway('--poll-once');
    assert.equal(sent.length, unchanged, 'Unchanged exact receipt caused repetitive progress');
    assert.equal((await progressRows(source)).length, 1);
    for (let sequence = 2; sequence <= 3; sequence++) {
      complete(deliveries.at(-1), `**精确步骤结果 ${sequence - 1}**`);
      await waitFor(() => { healthy(); return deliveries.length === start + sequence; }, 'Next progress action accepted');
      await deliver(await waitNotification('progress', sequence));
      await ageProgress(source);
    }
    complete(deliveries.at(-1), '**精确步骤结果 3**');
    await waitFor(() => { healthy(); return deliveries.length === start + 4; }, 'Fourth progress fact accepted');
    await delay(OBSERVATION_MS);
    assert.equal((await progressRows(source)).length, 3, 'A fourth progress slot was created');
    assert.equal((await pending()).length, 0, 'Progress limit failed after a new receipt');
    complete(deliveries.at(-1), '**精确步骤结果 4**');
    const terminal = await waitNotification('completed');
    for (let index = 1; index <= 4; index++) assert(terminal.text.includes(`**精确步骤结果 ${index}**`));
    await deliver(terminal);

    // Leave a genuine progress notification pending, then finish before Gateway polls it.
    const terminalStart = deliveries.length;
    await input(directTask);
    await waitFor(() => deliveries.length === terminalStart + 1, 'Terminal-priority task accepted');
    const racingSource = await activeSource();
    await ageSource(racingSource);
    const stale = await waitNotification('progress', 1);
    complete(deliveries.at(-1), '**终态必须优先**');
    const preferred = await waitNotification('completed');
    assert.deepEqual((await pending()).map(item => item.id), [preferred.id]);
    const beforeTerminal = sent.length;
    await deliver(preferred);
    assert(!sent.slice(beforeTerminal).some(message => text(message) === stale.text), 'Stale progress preceded terminal result');
    evidence('real-process-progress', { progressNotifications: 3, unchangedFactNotifications: 0,
      fourthFactNotifications: 0, exactFinalResults: 4, typingBeforeEveryNotification: true,
      pendingProgressSuppressedByTerminal: true, acceleratedSyntheticPersistedTimes: true });
    return { delivered: 3, unchangedFactNotifications: 0, fourthFactNotifications: 0, terminalPriority: true };
  } finally { await pool.end(); }
}

async function verifyPostgresAuthorityAndInspection(databaseUrl, pool, evidence) {
  const { PostgresStore } = await import('../../../controller/dist/store/postgres.js');
  const { CommandService } = await import('../../../controller/dist/commands/service.js');
  let store = new PostgresStore(databaseUrl);
  try {
    const now = new Date().toISOString(), expiresAt = new Date(Date.now() + 60_000).toISOString();
    const authority = { expiresAt, tokenHash: 'a'.repeat(64), type: 'console' };
    await pool.query('INSERT INTO console_sessions(token_hash,created_at,expires_at) VALUES($1,$2,$3)', [authority.tokenHash, now, expiresAt]);
    const request = { requestId: randomUUID(), nodeId: 'synthetic-authority-offline-node', sessionId: 'synthetic-authority-session',
      action: 'send', prompt: '合成权限跨 JSONB 重放验证', deliveryMode: 'next-turn' };
    const commandId = 'cmd_' + randomUUID();
    assert.equal((await store.createCommandIfAbsent({ ...request, commandId, status: 'queued',
      authority, createdAt: now, updatedAt: now, expiresAt })).created, true);
    await store.close();
    store = new PostgresStore(databaseUrl);
    const service = new CommandService(store, {}, 60);
    assert.equal((await service.submit(request, 0, undefined, undefined, authority)).commandId, commandId,
      'JSONB key order changed authority identity after reopening the store');
    assert.equal((await service.cancel(commandId, authority)).status, 'cancelled');
    assert.equal((await service.cancel(commandId, authority)).status, 'cancelled');
    const client = await pool.connect();
    let plan;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan=off');
      plan = await client.query(`EXPLAIN SELECT * FROM commands WHERE node_id=$1 AND command_id>$2
        AND action='send' AND status IN ('pending','accepted','uncertain') ORDER BY command_id LIMIT 100`, [request.nodeId, '']);
      assert.match(plan.rows.map(row => row['QUERY PLAN']).join('\n'), /commands_inspection_idx/);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    evidence('postgres-authority-and-inspection', { reopenedStoreReplay: true, reorderedJsonbAuthority: true,
      sameAuthorityCancel: 'cancelled', cancellationIdempotent: true, inspectionIndexInExplain: true });
  } finally { await store.close(); }
}
