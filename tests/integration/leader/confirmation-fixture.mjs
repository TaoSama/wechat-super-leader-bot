import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const HISTORY_TEXT_LIMIT = 16000;
const HISTORY_NODES = new Set(['test-node', 'plan-fixture-node', 'goal-fixture-node', 'result-source-node', 'result-destination-node']);

// Only completed receipts produced by this synthetic node become assistant history.
// Acceptance acknowledgements carry no evidence of execution activity.
export function fixtureHistory(request, session, commands, receipts) {
  assert.equal(request.type, 'read_history');
  assert.equal(request.sessionId, session.id);
  const items = receipts.filter(receipt => receipt.status === 'completed' && receipt.turnId && receipt.output && receipt.nodeId === request.nodeId &&
    commands.some(command => command.commandId === receipt.commandId && command.sessionId === session.id && command.nodeId === receipt.nodeId) &&
    receipts.some(binding => binding.status === 'accepted' && binding.commandId === receipt.commandId &&
      binding.nodeId === receipt.nodeId && binding.turnId === receipt.turnId))
    .map(receipt => ({ id: receipt.commandId, turnId: receipt.turnId, kind: 'assistant', type: 'message',
      text: receipt.output.slice(0, HISTORY_TEXT_LIMIT), truncated: receipt.output.length > HISTORY_TEXT_LIMIT }));
  return { type: 'history', requestId: request.requestId, sessionId: request.sessionId, history: {
    session, historyContext: request.historyContext ?? randomUUID(), source: 'control-socket',
    items: items.slice(-request.limit), nextCursor: null, fetchedAt: new Date().toISOString(), truncated: items.length > request.limit,
  } };
}

export function acknowledgementModelReply(request) {
  if (!request.input.some(item => item.role === 'system' && item.content?.startsWith('你负责根据刚刚核查的真实执行记录'))) return null;
  assert.deepEqual(request.tools, [], 'Confirmation model received mutation tools');
  const evidence = JSON.parse(request.input.at(-1).content);
  const observations = evidence.targets.map(target => {
    if (target.exactReceipt && HISTORY_NODES.has(target.nodeId)) {
      assert(Number.isFinite(Date.parse(target.historyFetchedAt)),
        `Confirmation omitted a fresh synthetic session history read: ${JSON.stringify({ nodeId: target.nodeId,
          sessionId: target.sessionId, receiptStatus: target.exactReceipt.status, historyError: target.historyError })}`);
      assert.equal(target.historyError, undefined);
      if (target.exactReceipt.status === 'accepted') assert.equal(target.exactTurnHistory.length, 0,
        'Acceptance without actual assistant output was promoted to execution progress');
    }
    for (const item of target.exactTurnHistory) {
      assert.equal(item.turnId, target.exactReceipt.turnId, 'Unrelated turn entered confirmation');
      assert(['assistant', 'tool'].includes(item.kind));
    }
    if (target.exactReceipt?.status === 'completed') return '本次指令已完成';
    if (target.exactReceipt?.status === 'accepted') return '本次指令已接收，执行尚未确认';
    if (target.exactReceipt?.status === 'input-written') return '输入已写入，执行尚未确认';
    return '任务已保存，等待接收或核查';
  });
  return { role: 'assistant', content: observations.join('；') || '目标已保存，等待后台调度。' };
}
