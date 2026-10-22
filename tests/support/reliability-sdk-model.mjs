import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

const BODY_LIMIT_BYTES = 4 * 1024 * 1024;
export const SDK_MODEL = 'synthetic-native-sdk-model';
export const SDK_API_KEY = 'synthetic-native-sdk-api-key';
export const SDK_REPLY = '合成 SDK 原生进程回复：本轮处理完成。';

export function currentSdkUserText(body) {
  assert(Array.isArray(body.input), 'Native SDK Responses input must be an array');
  const message = body.input.findLast(item => item.type === 'message' && item.role === 'user');
  assert(message, 'Native SDK request has no current user message');
  assert(Array.isArray(message.content), 'Native SDK user message must contain content parts');
  const prompt = message.content.filter(part => part.type === 'input_text').map(part => {
    assert.equal(typeof part.text, 'string', 'Native SDK input_text must contain text');
    return part.text;
  }).join('');
  const match = prompt.match(/<current_user_message>([\s\S]*)<\/current_user_message>\s*$/);
  assert(match, 'Native SDK current user message lacks the Gateway JSON envelope');
  const value = JSON.parse(match[1]);
  assert(value && typeof value === 'object' && !Array.isArray(value) && typeof value.text === 'string',
    'Native SDK current user message envelope must contain string text');
  return value.text;
}

function sendEvents(response, output) {
  const id = `resp_${randomUUID()}`;
  let sequence = 0;
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const event = (type, value) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...value })}\n\n`);
  event('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } });
  output.forEach((item, outputIndex) => {
    event('response.output_item.added', { output_index: outputIndex, item: { ...item, status: 'in_progress',
      ...(item.type === 'message' ? { content: [] } : { arguments: '' }) } });
    if (item.type === 'message') {
      for (const [contentIndex, part] of item.content.entries()) {
        const position = { item_id: item.id, output_index: outputIndex, content_index: contentIndex };
        event('response.content_part.added', { ...position, part: { ...part, text: '' } });
        event('response.output_text.delta', { ...position, delta: part.text });
        event('response.output_text.done', { ...position, text: part.text });
        event('response.content_part.done', { ...position, part });
      }
    } else {
      event('response.function_call_arguments.delta', { item_id: item.id, output_index: outputIndex, delta: item.arguments });
      event('response.function_call_arguments.done', { item_id: item.id, output_index: outputIndex, arguments: item.arguments });
    }
    event('response.output_item.done', { output_index: outputIndex, item });
  });
  event('response.completed', { response: { id, object: 'response', status: 'completed', model: SDK_MODEL, output,
    usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } } });
  response.end();
}

// The real Codex executable owns the app-server protocol; this server only speaks
// its OpenAI-compatible upstream Responses SSE wire protocol.
export async function createSdkModelFixture({ evidence = () => {}, reply = SDK_REPLY, control = false, respond } = {}) {
  const calls = [], errors = [], responseHolds = [], ownedHolds = new Set();
  let stopping = false;
  function holdNextResponse() {
    assert(!stopping, 'SDK model fixture is stopping');
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    const hold = { entered, released, enter,
      release() { ownedHolds.delete(hold); release(); } };
    ownedHolds.add(hold);
    responseHolds.push(hold);
    return { entered, release: hold.release };
  }
  const server = createServer((request, response) => {
    void (async () => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, '/v1/responses');
      assert.equal(request.headers.authorization, `Bearer ${SDK_API_KEY}`);
      const chunks = []; let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        assert(bytes <= BODY_LIMIT_BYTES, 'SDK model request exceeds local fixture limit');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.stream, true);
      calls.push(body);
      const tools = (body.tools ?? []).flatMap(tool => tool.type === 'namespace'
        ? tool.tools.map(nested => ({ name: nested.name, namespace: tool.name })) : [{ name: tool.name }]).filter(tool => tool.name);
      const input = body.input ?? [];
      const currentUser = input.findLastIndex(item => item.type === 'message' && item.role === 'user');
      const outputs = input.slice(currentUser + 1).filter(item => ['function_call_output', 'custom_tool_call_output'].includes(item.type));
      evidence('sdk-model-request', { ordinal: calls.length, model: body.model, tools,
        text: currentSdkUserText(body), toolOutput: outputs.length > 0, toolOutputs: outputs.length });
      const hold = responseHolds.shift();
      if (hold) {
        response.once('close', hold.release);
        hold.enter(body);
        try { await hold.released; }
        finally { response.removeListener('close', hold.release); }
      }
      if (response.destroyed || stopping) return;
      let output;
      if (respond) output = await respond(body, calls.length);
      else if ((typeof control === 'function' ? control(body) : control) && !outputs.length) {
        const tool = tools.find(item => item.name.includes('control_current_request'));
        assert(tool, 'Native SDK did not expose bound control_current_request MCP tool');
        output = [{ type: 'function_call', id: `fc_${randomUUID()}`, call_id: `call_${randomUUID()}`,
          ...tool, arguments: '{}', status: 'completed' }];
      } else {
        const text = typeof reply === 'function' ? await reply(body) : reply;
        assert.equal(typeof text, 'string', 'SDK fixture reply must be a string');
        assert(text.trim(), 'SDK fixture reply must not be empty');
        output = [{ type: 'message', id: `msg_${randomUUID()}`, role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }] }];
      }
      if (!response.destroyed && !stopping) sendEvents(response, output);
    })().catch(error => {
      errors.push(error);
      if (response.destroyed || stopping) return;
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: error.message } }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
  });
  return { url: `http://127.0.0.1:${server.address().port}/v1`, calls, model: SDK_MODEL, apiKey: SDK_API_KEY,
    holdNextResponse,
    healthy() { if (errors.length) throw new AggregateError(errors, 'Native SDK local model fixture failed'); },
    async stop() {
      stopping = true;
      for (const hold of ownedHolds) hold.release();
      responseHolds.length = 0;
      if (!server.listening) return;
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    } };
}
