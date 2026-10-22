import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CHAT, OTHER_CHAT, TASK, TASK_RESULT, delay, OBSERVE_MS, waitFor } from './fixture.mjs';

const text = message => message.item_list?.[0]?.text_item?.text ?? '';
const outbox = h => readFile(h.wechat.statePath + '.results.json', 'utf8').then(JSON.parse);
const recordedInFlight = async h => Object.values((await h.wechat.readState()).reply_deliveries).some(item => item.inFlight);
const countTask = h => h.native.starts.filter(item => item.prompt.includes('合成可靠性任务')).length;

async function finishTask(h) {
  const task = await h.launchTask();
  await h.complete(task.id);
  const delivery = await h.waitResult();
  assert.equal(delivery.chatId, CHAT);
  assert.equal(delivery.kind, 'completed');
  assert(delivery.messages.join('').includes(TASK_RESULT));
  return { ...task, delivery };
}

export const gatewayScenarios = [
  ['gateway-offline-inbound-replay-result-ownership', async h => {
    await h.control.crash();
    const message = h.wechat.enqueue(TASK, { chatId: CHAT });
    const before = await h.wechat.readState();
    const failed = await h.poll();
    assert.notEqual(failed.code, 0, 'Disconnected Controller unexpectedly processed source input');
    assert.equal((await h.wechat.readState()).sync_buf, before.sync_buf, 'Offline failure advanced source cursor');
    assert.equal(h.native.starts.length, 0);
    await h.control.start(); await h.waitNode(true);
    assert.equal((await h.poll()).code, 0);
    await h.native.waitForStarts(1);
    const rows = await h.pool.query('SELECT command_id FROM commands WHERE action=$1', ['send']);
    assert.equal(rows.rowCount, 1);
    const firstSendCount = h.wechat.sent.length, modelCount = h.model.calls.length;
    h.wechat.enqueue(TASK, { chatId: CHAT, id: message.client_id });
    assert.equal((await h.poll()).code, 0);
    assert.equal(h.wechat.sent.length, firstSendCount, 'Duplicate inbound generated a second ordinary reply');
    assert.equal(h.model.calls.length, modelCount, 'Duplicate inbound reran model');
    await h.complete(rows.rows[0].command_id);
    const result = await h.waitResult();
    assert.equal(result.chatId, CHAT); assert(result.messages.join('').includes(TASK_RESULT));
    const frame = h.control.frames.findLast(item => item.direction === 'daemon-controller' && item.type === 'result' && item.status === 'completed');
    assert(frame); h.control.replayResult(frame); h.control.replayResult(frame);
    h.wechat.enqueue('查询合成聊天归属', { chatId: OTHER_CHAT });
    assert.equal((await h.poll()).code, 0);
    await h.control.restart(); await h.waitNode(true);
    assert.equal((await h.poll()).code, 0);
    const finalMessages = h.wechat.sent.filter(item => text(item).includes(TASK_RESULT));
    assert.equal(finalMessages.length, 1, 'Completed task result was lost or duplicated');
    assert.equal(finalMessages[0].to_user_id, CHAT, 'Task result crossed chat ownership');
    const accepted = await h.delivery(result.id);
    assert.equal(accepted.status, 'accepted');
    assert.equal((await outbox(h)).items.length, 0, 'Accepted notification left a replayable transition');
    const sends = h.wechat.sent.length;
    assert.equal((await h.poll()).code, 0);
    assert.equal(h.wechat.sent.length, sends);
    assert.equal(countTask(h), 1);
    const deliveries = await h.pool.query('SELECT chat_id, data FROM result_deliveries');
    assert.equal(deliveries.rowCount, 1); assert.equal(deliveries.rows[0].chat_id, CHAT);
    h.evidence('assertions', { sourceCursorRetainedOffline: true, taskStarts: 1, duplicateInputModelCalls: 0,
      duplicateCompletionFrames: 2, finalMessages: 1, correctChat: true, acceptedOutboxCleared: true });
  }],
  ['gateway-controller-commit-response-lost', async h => {
    const fault = h.control.failHttp(entry => entry.path === '/v1/messages' && entry.method === 'POST');
    h.wechat.enqueue(TASK, { chatId: CHAT });
    const running = h.wechat.start({ ...h.gatewayOptions, mode: '--poll-once' });
    const committed = await h.entered(fault.entered, 'Controller message commit');
    assert.equal(committed.status, 200);
    await h.wechat.kill(running);
    await h.control.restart(); await h.waitNode(true);
    const calls = h.model.calls.length;
    assert.equal((await h.poll()).code, 0);
    assert.equal(h.model.calls.length, calls, 'Lost HTTP reply retried original model/plan');
    assert.equal(h.native.starts.length, 1);
    const records = await h.pool.query('SELECT command_id FROM commands'); assert.equal(records.rowCount, 1);
    await h.complete(records.rows[0].command_id);
    h.evidence('assertions', { controllerReplyCommittedBeforeCrash: true, controllerAndGatewayCrash: true,
      commands: 1, nativeStarts: 1, modelCallsOnReplay: 0 });
  }],
  ['gateway-unknown-ordinary-send', async h => {
    const send = h.wechat.nextSendFault('hold');
    const message = h.wechat.enqueue('查询合成普通回复', { chatId: CHAT });
    const running = h.wechat.start({ ...h.gatewayOptions, mode: '--poll-once' });
    await h.entered(send.entered, 'ordinary send in flight');
    assert(await recordedInFlight(h), 'Gateway did not persist in-flight before native send');
    await h.wechat.kill(running);
    send.drop();
    await h.control.restart(); await h.waitNode(true);
    const calls = h.model.calls.length, sends = h.wechat.sent.length;
    h.wechat.enqueue('查询合成普通回复', { chatId: CHAT, id: message.client_id });
    assert.equal((await h.poll()).code, 0);
    assert.equal(h.wechat.sent.length, sends, 'Unknown ordinary send was blindly retried');
    assert.equal(h.model.calls.length, calls);
    assert(await recordedInFlight(h), 'Unknown send evidence was discarded');
    h.wechat.enqueue('查询另一合成聊天', { chatId: OTHER_CHAT });
    assert.equal((await h.poll()).code, 0);
    assert.equal(h.wechat.sent.length, sends + 1);
    assert.equal(h.wechat.sent.at(-1).to_user_id, OTHER_CHAT);
    h.evidence('assertions', { unknownSends: 1, resends: 0, evidencePreserved: true, otherChatProgresses: true,
      phoneReceiptProven: false });
  }],
  ['notification-claim-commit-response-lost', async h => {
    const { delivery } = await finishTask(h);
    const fault = h.control.failHttp(entry => entry.path === `/v1/deliveries/${delivery.id}/claim`);
    const running = h.wechat.start({ ...h.gatewayOptions, mode: '--poll-once' });
    const committed = await h.entered(fault.entered, 'notification claim commit');
    assert.equal(committed.status, 200);
    await h.wechat.kill(running);
    const persisted = (await outbox(h)).items.find(item => item.id === delivery.id);
    assert.equal(persisted.status, 'claiming');
    const attemptId = persisted.attemptId;
    await h.control.restart(); await h.waitNode(true);
    const before = h.wechat.sent.length;
    assert.equal((await h.poll()).code, 0);
    const accepted = await h.delivery(delivery.id);
    assert.equal(accepted.status, 'accepted'); assert.equal(accepted.attemptId, attemptId);
    assert.equal(h.wechat.sent.length, before + 1);
    assert.equal(h.control.requests.filter(item => item.path === `/v1/deliveries/${delivery.id}/claim`).length, 1,
      'Lost claim response created a new claim instead of recovering through GET');
    assert.equal((await outbox(h)).items.length, 0);
    h.evidence('assertions', { claimingIntentPersisted: true, attemptIdRecovered: true, claims: 1,
      notificationSends: 1, taskStarts: countTask(h), controllerAndGatewayCrash: true });
  }],
  ['notification-receipt-commit-response-lost', async h => {
    const { delivery } = await finishTask(h);
    const fault = h.control.failHttp(entry => entry.path === `/v1/deliveries/${delivery.id}/receipt`);
    const running = h.wechat.start({ ...h.gatewayOptions, mode: '--poll-once' });
    const committed = await h.entered(fault.entered, 'notification receipt commit');
    assert.equal(committed.status, 200);
    await h.wechat.kill(running);
    assert.equal((await outbox(h)).items.find(item => item.id === delivery.id).status, 'receipt');
    assert.equal((await h.delivery(delivery.id)).status, 'accepted');
    const before = h.wechat.sent.length;
    await h.control.restart(); await h.waitNode(true);
    assert.equal((await h.poll()).code, 0);
    assert.equal(h.wechat.sent.length, before, 'Lost receipt response repeated an accepted notification');
    assert.equal((await outbox(h)).items.length, 0);
    h.evidence('assertions', { receiptIntentPersisted: true, controllerReceipt: 'accepted', resends: 0,
      intentClearedByGet: true, taskStarts: countTask(h) });
  }],
  ['notification-send-unknown', async h => {
    const { delivery } = await finishTask(h);
    const send = h.wechat.nextSendFault('hold');
    const running = h.wechat.start({ ...h.gatewayOptions, mode: '--poll-once' });
    await h.entered(send.entered, 'notification send in flight');
    assert(await recordedInFlight(h));
    await h.wechat.kill(running); send.drop();
    await h.control.restart(); await h.waitNode(true);
    const before = h.wechat.sent.length;
    assert.equal((await h.poll()).code, 0);
    assert.equal((await h.delivery(delivery.id)).status, 'uncertain');
    assert.equal(h.wechat.sent.length, before, 'Unknown notification was blindly resent');
    assert.equal((await outbox(h)).items.length, 0);
    await delay(OBSERVE_MS);
    assert.equal((await h.poll()).code, 0);
    assert.equal(h.wechat.sent.length, before);
    assert.equal(countTask(h), 1);
    h.evidence('assertions', { notificationStatus: 'uncertain', resends: 0, taskStarts: 1, phoneReceiptProven: false });
  }],
];
