import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const CHAT_ID = 'test-chat';
const READ_TEXT = '查询合成桌面会话的近期已记录历史';
const CALL_ID = 'mock-leader-session-history';
const HISTORY_LIMIT = 8;
const TEXT_CODE_POINT_LIMIT = 1000;
const TEXT_JSON_LIMIT = 3000;
const RESULT_JSON_LIMIT = 11000;

// Only the integration runner's model server calls this fixture. It never
// connects to an external model, existing App or user session.
export function createLeaderHistoryModelFixture(target) {
  const calls = [], outputs = [];
  return {
    calls, outputs,
    respond(last) {
      if (last.content === READ_TEXT) {
        calls.push(structuredClone(target));
        return { role: 'assistant', content: null, tool_calls: [{ id: CALL_ID, type: 'function',
          function: { name: 'read_session', arguments: JSON.stringify(target) } }] };
      }
      if (last.type === 'function_call_output' && last.call_id === CALL_ID) {
        const evidence = JSON.parse(last.output);
        outputs.push(evidence);
        return { role: 'assistant', content: `近期已记录历史，不是完整对话历史；任务完成尚未确认。\n${last.output}` };
      }
      return null;
    },
  };
}

// Reuses the caller's PostgreSQL, HTTP Controller, Go daemon and synthetic owner.
export async function verifyLeaderSessionHistory({ request, pool, model, target, expectedItems,
  starts, fullHistoryLoads, assertHealthy }) {
  const snapshot = async () => {
    const commands = await pool.query('SELECT command_id FROM commands ORDER BY command_id');
    const state = await pool.query('SELECT revision, data FROM leader_states WHERE chat_id = $1', [CHAT_ID]);
    assert.equal(state.rows.length, 1, 'Existing fixture chat state missing');
    return { commands: commands.rows, state: state.rows[0] };
  };
  const before = await snapshot();
  const initialCalls = model.calls.length, initialOutputs = model.outputs.length;
  const initialStarts = starts(), initialLoads = fullHistoryLoads();
  const message = { chatId: CHAT_ID, messageId: randomUUID(), text: READ_TEXT };
  const read = await request('/v1/messages', message);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.commandId, undefined, 'History query returned a durable command');
  assert.equal(model.calls.length, initialCalls + 1, 'Model did not issue exactly one history tool');
  assert.deepEqual(model.calls.at(-1), target, 'Model history tool selected the wrong target');
  assert.equal(model.outputs.length, initialOutputs + 1, 'History tool evidence missing');
  const evidence = model.outputs.at(-1);
  assert.equal(evidence.nodeId, target.nodeId);
  assert.equal(evidence.sessionId, target.sessionId);
  assert.equal(evidence.source, 'codex-desktop');
  assert.equal(evidence.scope, 'recent_recorded_history');
  assert.equal(evidence.completeHistory, false);
  assert.equal(evidence.hasOlder, true);
  assert.equal(evidence.omittedItems, 0);
  assert.equal(evidence.truncated, true, 'Long recorded text was not marked as clipped');
  assert(Number.isFinite(Date.parse(evidence.fetchedAt)), 'History retrieval timestamp missing');
  assert.equal(evidence.items.length, HISTORY_LIMIT);
  assert.deepEqual(evidence.items.map(item => item.id), expectedItems.map(item => item.id),
    'Latest bounded history lost original ordering');
  for (const [index, item] of evidence.items.entries()) {
    assert.equal(item.text, [...expectedItems[index].text].slice(0, TEXT_CODE_POINT_LIMIT).join(''));
    assert([...item.text].length <= TEXT_CODE_POINT_LIMIT);
    assert(JSON.stringify(item.text).length <= TEXT_JSON_LIMIT);
    assert.equal(item.turnId, expectedItems[index].turnId);
    assert.equal(item.kind, 'assistant');
  }
  assert(JSON.stringify(evidence).length <= RESULT_JSON_LIMIT);
  for (const field of ['commandId', 'status', 'historyContext', 'nextCursor', 'session', 'data']) {
    assert(!Object.hasOwn(evidence, field), `Private or execution field leaked: ${field}`);
  }
  assert(!JSON.stringify(evidence).includes('fixturePadding'), 'Raw owner state leaked');
  assert(read.body.text.includes('"source":"codex-desktop"'));
  assert(read.body.text.includes('"scope":"recent_recorded_history"'));
  assert(read.body.text.includes('"completeHistory":false'));
  assert(read.body.text.includes('任务完成尚未确认'));
  assert(!read.body.text.includes('本轮未向会话派发执行指令'), 'History query appended repetitive dispatch boilerplate');
  assert(read.body.text.includes('UNTRUSTED'), 'Untrusted recorded text was not carried as tool evidence');
  const after = await snapshot();
  assert.deepEqual(after.commands, before.commands, 'History query created a durable command');
  assert.deepEqual(after.state.data.commandIds, before.state.data.commandIds,
    'History query added chat command access');
  assert(after.state.data.receipts.some(receipt => receipt.messageId === message.messageId && !receipt.commandId));
  assert.equal(starts(), initialStarts, 'Recorded text triggered a native send');
  assert.equal(fullHistoryLoads(), initialLoads, 'History tool reloaded complete owner history');
  const repeated = await request('/v1/messages', message);
  assert.equal(repeated.status, 200, JSON.stringify(repeated.body));
  assert.deepEqual(repeated.body, read.body, 'Message replay did not reuse the saved reply');
  assert.equal(model.calls.length, initialCalls + 1, 'Message replay repeated the history tool');
  assert.equal(model.outputs.length, initialOutputs + 1, 'Message replay repeated a history read');
  assert.deepEqual(await snapshot(), after, 'Message replay mutated persisted command or chat state');
  assert.equal(starts(), initialStarts);
  assert.equal(fullHistoryLoads(), initialLoads);
  assertHealthy();
  console.log('PASS model tool → HTTP → real PostgreSQL/Go daemon → synthetic desktop history: latest 8 records, clipping/source/scope, no read commands or commandIds, untrusted text not sent; messageId replay reuses receipt with no new model/tool/read');
}
