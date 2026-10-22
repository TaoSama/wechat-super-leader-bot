import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { closeLocal, listenLocal } from './reliability-control.mjs';

export const TASK = '请在合成会话执行可靠性任务并通知本聊天';
export const TASK_PROMPT = '合成可靠性任务：核对17条记录并返回唯一结果';
export const TASK_RESULT = 'RELIABILITY_FINAL：核对17条记录，唯一结果归属本轮。';
export const CHAT = 'reliability-chat';
export const OTHER_CHAT = 'reliability-other-chat';
export const NODE = 'reliability-node';
export const SESSION = '11111111-2222-4333-8444-555555555555';

export async function createModelFixture({ evidence }) {
  const calls = [], errors = [];
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.url, '/v1/responses');
      let raw = '';
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw), last = body.input.at(-1);
      calls.push(body);
      let output;
      if (body.tools?.length === 1 && body.tools[0].name === 'classify_user_authorization') {
        assert.equal(last.content, TASK);
        output = [{ type: 'function_call', call_id: `auth-${calls.length}`, name: 'classify_user_authorization',
          arguments: JSON.stringify({ intent: 'task' }) }];
      } else if (body.input[0]?.content?.startsWith('你负责根据刚刚核查的真实执行记录')) {
        const observed = JSON.parse(last.content);
        assert.equal(observed.targets[0].nodeId, NODE);
        assert.equal(observed.targets[0].sessionId, SESSION);
        output = message('合成任务已保存；请以本轮持久回执核对进度。');
      } else if (last.role === 'user' && last.content === TASK) {
        assert(body.tools.some(tool => tool.name === 'execute_plan'));
        output = [{ type: 'function_call', call_id: `execute-${calls.length}`, name: 'execute_plan',
          arguments: JSON.stringify({ actions: [{ nodeId: NODE, sessionId: SESSION, prompt: TASK_PROMPT, dependsOn: [] }] }) }];
      } else {
        output = message('合成查询回复：已读取本聊天。');
      }
      evidence('model-http', { ordinal: calls.length, lastType: last.type ?? last.role,
        tool: output.find(item => item.type === 'function_call')?.name });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'completed', output }));
    })().catch(error => {
      errors.push(error);
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: error.message }));
    });
  });
  return { url: `http://127.0.0.1:${await listenLocal(server)}/v1`, calls,
    healthy() { if (errors.length) throw new AggregateError(errors, 'Model fixture failed'); },
    stop: () => closeLocal(server) };
}

function message(text) {
  return [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }];
}
