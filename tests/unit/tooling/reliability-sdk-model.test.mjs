import assert from 'node:assert/strict';
import test from 'node:test';
import { createSdkModelFixture, SDK_API_KEY, SDK_MODEL, SDK_REPLY } from '../../support/reliability-sdk-model.mjs';
import { NODE, SESSION, TASK, TASK_PROMPT } from '../../support/reliability-model.mjs';

const authorization = intent => ({ intent, automationOperations: [], backgroundOperations: [], memoryOperations: [], sendImages: false });
const user = text => ({ type: 'message', role: 'user', content: [{ type: 'input_text',
  text: `<current_user_message>${JSON.stringify({ text })}</current_user_message>` }] });
const tools = [{ type: 'namespace', name: 'mcp__wechat_control', tools: [
  { type: 'function', name: 'list_sessions' }, { type: 'function', name: 'execute_plan' },
] }];
const request = (input, exposed = tools) => ({ model: SDK_MODEL, stream: true, input, tools: exposed });
const output = (call, payload) => ({ type: 'function_call_output', call_id: call.call_id,
  output: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(payload) }] }) });
const discovery = { result: { sessions: [{ nodeId: NODE, id: SESSION, title: 'Synthetic reliability session' }] } };

async function post(fixture, body) {
  const response = await fetch(fixture.url + '/responses', { method: 'POST', headers: {
    authorization: `Bearer ${SDK_API_KEY}`, 'content-type': 'application/json',
  }, body: JSON.stringify(body) });
  const text = await response.text();
  if (response.status !== 200) return { status: response.status, text };
  const events = text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
  const completed = events.find(event => event.type === 'response.completed');
  assert(completed, 'Synthetic model must emit a completed Responses SSE envelope');
  return { status: response.status, output: completed.response.output };
}

async function withFixture(options, run) {
  const fixture = await createSdkModelFixture(options);
  try { await run(fixture); }
  finally { await fixture.stop(); }
}

test('task discovers its target before dispatch and preserves the authoritative receipt', async () => {
  await withFixture({ control: true }, async fixture => {
    const input = [user(TASK)];
    const first = await post(fixture, request(input));
    const list = first.output[0];
    assert.equal(list.name, 'list_sessions'); assert.equal(list.namespace, 'mcp__wechat_control');
    assert.deepEqual(JSON.parse(list.arguments), { arguments: {}, authorization: authorization('query') });
    input.push(list, output(list, discovery));
    const second = await post(fixture, request(input));
    const dispatch = second.output[0];
    assert.equal(dispatch.name, 'execute_plan');
    assert.deepEqual(JSON.parse(dispatch.arguments), { arguments: { actions: [
      { nodeId: NODE, sessionId: SESSION, prompt: TASK_PROMPT, dependsOn: [] },
    ] }, authorization: authorization('task') });
    const receipt = '计划：自动推进中\n1. 合成会话：已接收，等待完成\n已接收不代表工作完成。';
    input.push(dispatch, output(dispatch, { result: { text: receipt }, reply: { text: receipt, commandId: 'synthetic-command' } }));
    const final = await post(fixture, request(input));
    assert.equal(final.output[0].type, 'message');
    assert.equal(final.output[0].content[0].text, receipt);
    assert.equal(fixture.calls.length, 3); fixture.healthy();
  });
});

test('flat native MCP names and array text outputs retain the direct protocol wrapper', async () => {
  await withFixture({ control: true }, async fixture => {
    const exposed = ['list_sessions', 'execute_plan'].map(name => ({ type: 'function', name: `mcp__wechat_control__${name}` }));
    const input = [user(TASK)];
    const first = (await post(fixture, request(input, exposed))).output[0];
    assert.equal(first.name, 'mcp__wechat_control__list_sessions');
    input.push(first, { type: 'custom_tool_call_output', call_id: first.call_id,
      output: [{ type: 'input_text', text: JSON.stringify(discovery) }] });
    const second = (await post(fixture, request(input, exposed))).output[0];
    assert.equal(second.name, 'mcp__wechat_control__execute_plan');
    assert.equal(JSON.parse(second.arguments).authorization.intent, 'task');
    fixture.healthy();
  });
});

test('a dispatch MCP failure returns uncertainty without a replacement execution', async () => {
  await withFixture({ control: true }, async fixture => {
    const input = [user(TASK)];
    const list = (await post(fixture, request(input))).output[0];
    input.push(list, output(list, discovery));
    const dispatch = (await post(fixture, request(input))).output[0];
    input.push(dispatch, { type: 'function_call_output', call_id: dispatch.call_id,
      output: JSON.stringify({ isError: true, content: [{ type: 'text', text: '执行结果待核实' }] }) });
    const final = (await post(fixture, request(input))).output[0];
    assert.equal(final.type, 'message'); assert.match(final.content[0].text, /待核实/);
    assert.doesNotMatch(final.content[0].text, /已完成/); fixture.healthy();
  });
});

test('missing discovered target fails instead of dispatching an invented target', async () => {
  await withFixture({ control: true }, async fixture => {
    const input = [user(TASK)];
    const list = (await post(fixture, request(input))).output[0];
    input.push(list, output(list, { result: { sessions: [] } }));
    const failed = await post(fixture, request(input));
    assert.equal(failed.status, 500); assert.match(failed.text, /uniquely discovered/);
    assert.throws(() => fixture.healthy(), AggregateError);
  });
});

test('legacy opaque control tool cannot silently replace a business tool', async () => {
  await withFixture({ control: true }, async fixture => {
    const failed = await post(fixture, request([user(TASK)], [{ type: 'function', name: 'control_current_request' }]));
    assert.equal(failed.status, 500); assert.match(failed.text, /bound list_sessions MCP tool/);
    assert.throws(() => fixture.healthy(), AggregateError);
  });
});

test('previous-turn tools do not skip discovery for the current task', async () => {
  await withFixture({ control: true }, async fixture => {
    const input = [user('旧消息'), { type: 'function_call_output', call_id: 'previous-call', output: '{}' }, user(TASK)];
    const result = await post(fixture, request(input));
    assert.equal(result.output[0].name, 'list_sessions'); fixture.healthy();
  });
});

test('pure conversation remains a single model response without Controller tools', async () => {
  await withFixture({}, async fixture => {
    const result = await post(fixture, request([user('合成聊天')], []));
    assert.equal(result.output[0].type, 'message'); assert.equal(result.output[0].content[0].text, SDK_REPLY);
    assert.equal(fixture.calls.length, 1); fixture.healthy();
  });
});
