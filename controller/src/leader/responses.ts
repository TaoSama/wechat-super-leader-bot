import type { ModelMessage, ModelTool } from './model.js';

export function responsePayload(model: string, messages: ModelMessage[], tools: ModelTool[]) {
  const input: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.responseOutput) {
      input.push(...message.responseOutput);
    } else if (message.role === 'tool') {
      if (!message.tool_call_id) throw new Error('Tool output requires a call ID');
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: message.content ?? '' });
    } else {
      if (message.content !== null) input.push({ role: message.role, content: message.content });
      for (const call of message.tool_calls ?? []) {
        input.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    }
  }
  return { model, input, store: false, include: ['reasoning.encrypted_content'],
    tools: tools.map(tool => ({ type: 'function', ...tool.function, strict: false })) };
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid model response item');
  return value as Record<string, unknown>;
}

/** Preserve native output items (including encrypted reasoning) within this tool loop only. */
export function responseMessage(root: Record<string, unknown>) {
  if (root.status !== 'completed' || root.error != null || root.incomplete_details != null) {
    throw new Error('Invalid model response: response is not completed');
  }
  if (!Array.isArray(root.output) || root.output.length > 128) throw new Error('Invalid model response: output array required');
  const output: Record<string, unknown>[] = [];
  const texts: string[] = [];
  const calls: Record<string, unknown>[] = [];
  for (const value of root.output) {
    const item = object(value);
    if (item.type === 'function_call') {
      if (item.status !== undefined && item.status !== 'completed') throw new Error('Invalid model response: incomplete function call');
      calls.push({ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } });
    } else if (item.type === 'message') {
      if (item.role !== 'assistant' || item.status !== 'completed' || !Array.isArray(item.content)) {
        throw new Error('Invalid model response: incomplete assistant message');
      }
      for (const block of item.content) {
        const content = object(block);
        if (content.type !== 'output_text' || typeof content.text !== 'string') {
          throw new Error('Invalid model response: unsupported or refused content');
        }
        texts.push(content.text);
      }
    } else if (item.type === 'reasoning') {
      if (!Array.isArray(item.summary) || (item.encrypted_content !== undefined && typeof item.encrypted_content !== 'string')) {
        throw new Error('Invalid model response: malformed reasoning item');
      }
    } else {
      throw new Error('Invalid model response: unsupported output type');
    }
    output.push(item);
  }
  return { content: texts.length ? texts.join('\n') : null, tool_calls: calls, responseOutput: output };
}
