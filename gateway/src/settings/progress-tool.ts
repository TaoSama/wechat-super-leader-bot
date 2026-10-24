import { Script } from "node:vm";
import { MAX_PROGRESS_CHARS } from "../leader/progress.js";

export interface ProgressTextSchema {
  type: "string";
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  enum?: string[];
  description?: string;
}
export interface ProgressTool {
  name: "report_progress";
  description: string;
  inputSchema: {
    type: "object";
    properties: { text: ProgressTextSchema };
    required: ["text"];
    additionalProperties: false;
  };
}
const MAX_SCHEMA_CHARS = 16000;
const PATTERN_TIMEOUT_MS = 100;
const PATTERN_TEST = new Script("new RegExp(pattern, 'u').test(text)");
const COMPLEX_PATTERN_CHARACTERS = "\\()[]{}*+?|.";

export const DEFAULT_PROGRESS_TOOL: ProgressTool = parseProgressTool(JSON.stringify({
  name: "report_progress",
  description: "在处理耗时较长、已有值得告知的真实进展或需要说明等待原因时，向微信用户发送一条中间进度。简短、具体、有证据，不凑数、不把派发说成完成；每个根 query 最多3次，追加消息不重置额度。返回sent/status/used/remaining/limit；失败或未知不重发，继续完成工作并给最终回复。",
  inputSchema: { type: "object", properties: { text: { type: "string", minLength: 1, maxLength: MAX_PROGRESS_CHARS } },
    required: ["text"], additionalProperties: false },
}));

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Progress tool contains unsupported schema fields");
}
function length(value: unknown, name: string): number | undefined {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_PROGRESS_CHARS) {
    throw new Error(`Progress tool ${name} must be an integer from 1 to ${MAX_PROGRESS_CHARS}`);
  }
  return value as number;
}

/** Editable constraints apply to the actual MCP tool; identity and delivery caps stay fixed. */
export function parseProgressTool(content: string): ProgressTool {
  if (content.length > MAX_SCHEMA_CHARS) throw new Error("Progress tool schema is too large");
  const value: unknown = JSON.parse(content);
  if (!object(value)) throw new Error("Progress tool must be an object");
  fields(value, ["name", "description", "inputSchema"]);
  if (value.name !== "report_progress" || typeof value.description !== "string" || !value.description.trim()) {
    throw new Error("Progress tool requires its fixed name and a non-empty description");
  }
  const schema = value.inputSchema;
  if (!object(schema)) throw new Error("Progress tool requires inputSchema");
  fields(schema, ["type", "properties", "required", "additionalProperties"]);
  if (schema.type !== "object" || schema.additionalProperties !== false || !Array.isArray(schema.required) ||
      schema.required.length !== 1 || schema.required[0] !== "text" || !object(schema.properties)) {
    throw new Error("Progress tool must require text and reject additional properties");
  }
  fields(schema.properties, ["text"]);
  const text = schema.properties.text;
  if (!object(text) || text.type !== "string") throw new Error("Progress tool text must be a string schema");
  fields(text, ["type", "minLength", "maxLength", "pattern", "enum", "description"]);
  const minimum = length(text.minLength, "minLength") ?? 1;
  const maximum = length(text.maxLength, "maxLength") ?? MAX_PROGRESS_CHARS;
  if (minimum > maximum) throw new Error("Progress tool minLength cannot exceed maxLength");
  if (text.description !== undefined && typeof text.description !== "string") throw new Error("Progress text description must be a string");
  if (text.pattern !== undefined) {
    if (typeof text.pattern !== "string") throw new Error("Progress text pattern must be a string");
    // Compile before accepting a revision. Matching has a deadline to prevent a
    // user-authored expression from blocking the message polling event loop.
    new RegExp(text.pattern, "u");
  }
  if (text.enum !== undefined && (!Array.isArray(text.enum) || !text.enum.length ||
      text.enum.some(item => typeof item !== "string" || !item.trim()) || new Set(text.enum).size !== text.enum.length)) {
    throw new Error("Progress text enum must contain distinct, non-empty strings");
  }
  text.minLength = minimum;
  text.maxLength = maximum;
  const result = value as unknown as ProgressTool;
  if (result.inputSchema.properties.text.enum) {
    for (const item of result.inputSchema.properties.text.enum) {
      if (!validateProgressArguments(result, { text: item })) throw new Error("Progress text enum contradicts its schema");
    }
    Object.freeze(result.inputSchema.properties.text.enum);
  }
  Object.freeze(result.inputSchema.properties.text);
  Object.freeze(result.inputSchema.properties);
  Object.freeze(result.inputSchema.required);
  Object.freeze(result.inputSchema);
  return Object.freeze(result);
}

export function validateProgressArguments(tool: ProgressTool, args: unknown): args is { text: string } {
  if (!object(args) || Object.keys(args).length !== 1 || typeof args.text !== "string" ||
      !args.text.trim() || args.text.length > MAX_PROGRESS_CHARS) return false;
  const schema = tool.inputSchema.properties.text;
  const size = Array.from(args.text).length;
  if (size < (schema.minLength ?? 1) || size > (schema.maxLength ?? MAX_PROGRESS_CHARS) ||
      (schema.enum !== undefined && !schema.enum.includes(args.text))) return false;
  if (schema.pattern === undefined) return true;
  // Literal text with optional anchors cannot backtrack exponentially. Keep
  // this common case independent of VM wall-clock deadlines under CPU load.
  if (!Array.from(schema.pattern).some(character => COMPLEX_PATTERN_CHARACTERS.includes(character))) {
    return new RegExp(schema.pattern, "u").test(args.text);
  }
  try {
    return PATTERN_TEST.runInNewContext({ pattern: schema.pattern, text: args.text }, { timeout: PATTERN_TIMEOUT_MS }) === true;
  } catch {
    // Invalid or excessively costly patterns never authorize a delivery.
    return false;
  }
}
