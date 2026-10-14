import { responseMessage } from "./responses.js";
import type { ModelReply, ModelToolCall } from "./contracts.js";

const MAX_TOOL_CALLS_PER_REPLY = 32;
const MAX_TOOL_CALL_ID_LENGTH = 128;
const MAX_TOOL_NAME_LENGTH = 128;
const MAX_TOOL_ARGUMENTS_LENGTH = 32 * 1024;
const MAX_CONTENT_LENGTH = 64 * 1024;

export function parseAndValidateResponse(rawText: string): ModelReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (parseErr: unknown) {
    void parseErr;
    throw new Error("Invalid model response: body is not valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid model response: root is not an object");
  }

  const root = parsed as Record<string, unknown>;
  const messageObj = responseMessage(root);
  if (
    messageObj.content !== null &&
    messageObj.content !== undefined &&
    typeof messageObj.content !== "string"
  ) {
    throw new Error("Invalid model response: message content must be string or null");
  }

  const content = typeof messageObj.content === "string" ? messageObj.content : null;
  if (content !== null && content.length > MAX_CONTENT_LENGTH) {
    throw new Error(`Invalid model response: message content exceeds bound of ${MAX_CONTENT_LENGTH}`);
  }

  const rawToolCalls = messageObj.tool_calls;
  const toolCalls: ModelToolCall[] = [];
  const seenIds = new Set<string>();

  if (rawToolCalls !== undefined && rawToolCalls !== null) {
    if (!Array.isArray(rawToolCalls)) {
      throw new Error("Invalid model response: tool_calls must be an array");
    }
    if (rawToolCalls.length > MAX_TOOL_CALLS_PER_REPLY) {
      throw new Error(`Invalid model response: tool_calls count exceeds bound of ${MAX_TOOL_CALLS_PER_REPLY}`);
    }

    for (const call of rawToolCalls) {
      if (!call || typeof call !== "object" || Array.isArray(call)) {
        throw new Error("Invalid model response: tool_call must be an object");
      }
      const callObj = call as Record<string, unknown>;
      if (typeof callObj.id !== "string" || callObj.id.trim().length === 0) {
        throw new Error("Invalid model response: tool_call.id must be a non-empty string");
      }
      if (callObj.id.length > MAX_TOOL_CALL_ID_LENGTH) {
        throw new Error(`Invalid model response: tool_call.id length exceeds bound of ${MAX_TOOL_CALL_ID_LENGTH}`);
      }
      if (seenIds.has(callObj.id)) {
        throw new Error("Invalid model response: duplicate tool_call.id");
      }
      seenIds.add(callObj.id);

      if (callObj.type !== "function") {
        throw new Error("Invalid model response: tool_call.type must be function");
      }
      const fn = callObj.function;
      if (!fn || typeof fn !== "object" || Array.isArray(fn)) {
        throw new Error("Invalid model response: tool_call.function must be an object");
      }
      const fnObj = fn as Record<string, unknown>;
      if (typeof fnObj.name !== "string" || fnObj.name.trim().length === 0) {
        throw new Error("Invalid model response: tool_call.function.name must be a non-empty string");
      }
      if (fnObj.name.length > MAX_TOOL_NAME_LENGTH) {
        throw new Error(`Invalid model response: tool_call.function.name length exceeds bound of ${MAX_TOOL_NAME_LENGTH}`);
      }
      if (typeof fnObj.arguments !== "string") {
        throw new Error("Invalid model response: tool_call.function.arguments must be a string");
      }
      if (fnObj.arguments.length > MAX_TOOL_ARGUMENTS_LENGTH) {
        throw new Error(
          `Invalid model response: tool_call.function.arguments length exceeds bound of ${MAX_TOOL_ARGUMENTS_LENGTH}`
        );
      }

      toolCalls.push({
        id: callObj.id,
        type: "function",
        function: {
          name: fnObj.name,
          arguments: fnObj.arguments,
        },
      });
    }
  }

  if (content === null && toolCalls.length === 0) {
    throw new Error("Invalid model response: message has neither content nor tool_calls");
  }

  return {
    content,
    toolCalls,
    responseOutput: messageObj.responseOutput,
  };
}
