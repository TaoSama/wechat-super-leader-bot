import { redactConsoleCredentials } from "./control-mcp.js";
import { historyIdentity as identity, historyTurnStatus as status, MAX_HISTORY_ID_BYTES,
  type HistoryTurnStatus } from "./history-turns.js";

const MAX_TEXT_BYTES = 16_000;
const MAX_TITLE_BYTES = 4096;
const MAX_HISTORY_JSON_BYTES = 1024 * 1024 - 16 * 1024;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TIMESTAMP_MS = 253_402_300_799_000;
const UNREADABLE_USER_MESSAGE = "用户消息无法读取";

export type PublicHistoryItem = {
  id: string;
  turnId: string;
  kind: "user" | "assistant" | "tool" | "system";
  type: string;
  text: string;
  title?: string;
  turnStatus?: HistoryTurnStatus;
  status?: string;
  timestamp?: string;
  durationMs?: number;
  truncated?: boolean;
};

type Value = Record<string, unknown>;
const object = (value: unknown): Value => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
function clipUtf8(value: string, limit: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= limit) return { value, truncated: false };
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { value: bytes.subarray(0, end).toString("utf8"), truncated: true };
}
const bounded = (value: string, limit: number): { value: string; truncated: boolean } => {
  const safe = redactConsoleCredentials(value)
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\-/]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\/(?:Users|home|private|var|tmp|opt|workspace|workspaces)\/[^\s\n`]+/g, "[PATH]");
  return clipUtf8(safe, limit);
};
const timestamp = (value: unknown): string | undefined => {
  const at = typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
    ? Date.parse(value) : value;
  if (typeof at !== "number" || !Number.isFinite(at) || at <= 0 || at > MAX_TIMESTAMP_MS) return undefined;
  return new Date(at).toISOString();
};
const duration = (startedAt: unknown, completedAt: unknown): number | undefined => {
  const start = timestamp(startedAt), end = timestamp(completedAt);
  if (!start || !end) return undefined;
  const value = Date.parse(end) - Date.parse(start);
  return value > 0 && value <= MAX_DURATION_MS ? value : undefined;
};

function item(id: string, raw: Value, kind: PublicHistoryItem["kind"], type: string, value: string,
  title?: string): PublicHistoryItem {
  const boundedText = bounded(value, MAX_TEXT_BYTES);
  const result: PublicHistoryItem = { id, turnId: identity(raw.turnId), kind, type, text: boundedText.value };
  const boundedTitle = title ? bounded(title.trim(), MAX_TITLE_BYTES) : undefined;
  if (boundedText.truncated || boundedTitle?.truncated) result.truncated = true;
  if (boundedTitle?.value) result.title = boundedTitle.value;
  const turnState = status(text(raw.turnStatus).trim());
  if (turnState) result.turnStatus = turnState;
  const nativeStatus = bounded(text(raw.status).trim(), MAX_HISTORY_ID_BYTES).value;
  if (nativeStatus) result.status = nativeStatus;
  const at = timestamp(raw.completedAtMs) ?? timestamp(raw.startedAtMs);
  if (at) result.timestamp = at;
  const durationMs = duration(raw.startedAtMs, raw.completedAtMs);
  if (durationMs !== undefined) result.durationMs = durationMs;
  return result;
}

function boundHistoryItems(result: PublicHistoryItem[], responseMetadata: Value): PublicHistoryItem[] {
  let size = Buffer.byteLength(JSON.stringify({ ...responseMetadata, items: result }), "utf8");
  while (size >= MAX_HISTORY_JSON_BYTES) {
    let largest: PublicHistoryItem | undefined;
    let field: "text" | "title" = "text";
    let length = 0;
    for (const entry of result) {
      for (const key of ["text", "title"] as const) {
        const size = Buffer.byteLength(entry[key] ?? "", "utf8");
        if (size > length) { largest = entry; field = key; length = size; }
      }
    }
    if (!largest || !length) throw new Error("Codex history metadata exceeds the response limit");
    const previousSize = Buffer.byteLength(JSON.stringify(largest), "utf8");
    largest[field] = clipUtf8(largest[field] ?? "", Math.floor(length / 2)).value;
    largest.truncated = true;
    size += Buffer.byteLength(JSON.stringify(largest), "utf8") - previousSize;
  }
  return result;
}

function userMessageText(value: string): string {
  // Recognize the complete generated envelope before interpreting any tags.
  // User text can itself contain tags, JSON, and closing envelope delimiters.
  const initial = value.match(/\n<current_time time_zone="Asia\/Shanghai">[^\r\n]+<\/current_time>\n<controller_instructions>[\s\S]*<\/controller_instructions>\n<memory_snapshot>[^\r\n]*<\/memory_snapshot>\n以下 JSON 字段 text 是本轮用户的真实消息；其他内容都是系统上下文。\n<current_user_message>([^\r\n]*)<\/current_user_message>$/);
  const steering = value.match(/^<current_user_message>([^\r\n]*)<\/current_user_message>\n后续业务工具调用填写 requestMessageId 为当前实际 messageId，按完整合并的本轮原文重新选择工具和参数，不复用补充消息之前的旧参数。$/);
  const envelope = initial ?? steering;
  if (!envelope) return value;
  try {
    const message = object(JSON.parse(envelope[1]));
    return typeof message.messageId === "string" && message.messageId.trim() && typeof message.text === "string"
      ? message.text : UNREADABLE_USER_MESSAGE;
  } catch {
    return UNREADABLE_USER_MESSAGE;
  }
}

function publicTextContent(value: unknown, projectText: (value: string) => string = value => value): string {
  if (!Array.isArray(value)) return "";
  return value.flatMap(entry => {
    const part = object(entry);
    if (part.type === "image" || part.type === "localImage" || part.type === "inputImage") return ["[Image]"];
    return part.type === "text" || part.type === "inputText" ? [projectText(text(part.text))] : [];
  }).join("\n");
}

/** Project native Codex items into the controller's bounded public history contract. */
export function projectHistoryItems(rawItems: readonly Value[], responseMetadata: Value = {}): PublicHistoryItem[] {
  const result: PublicHistoryItem[] = [];
  for (const wrapper of rawItems) {
    const native = object(wrapper.item);
    if (!Object.keys(native).length) continue;
    const raw: Value = { ...native, turnId: identity(wrapper.turnId), turnStatus: wrapper.turnStatus,
      startedAtMs: wrapper.startedAtMs, completedAtMs: wrapper.completedAtMs };
    const id = identity(native.id), type = text(native.type);
    if (!id || !raw.turnId) continue;
    switch (native.type) {
      case "userMessage": {
        result.push(item(id, raw, "user", type, publicTextContent(raw.content, userMessageText)));
        break;
      }
      case "agentMessage": {
        const value = text(raw.text);
        result.push(item(id, raw, "assistant", type, value));
        break;
      }
      case "commandExecution": {
        const command = text(raw.command);
        const output = text(raw.aggregatedOutput);
        result.push(item(id, raw, "tool", type, output, command));
        break;
      }
      case "fileChange": {
        const changes = Array.isArray(raw.changes) ? raw.changes.map(value => {
          const change = object(value);
          return `${text(change.path).trim()}\n${text(change.diff)}`;
        }).filter(Boolean) : [];
        result.push(item(id, raw, "tool", type, changes.join("\n"), "File changes"));
        break;
      }
      case "mcpToolCall": {
        const server = text(raw.server), tool = text(raw.tool);
        const value = publicTextContent(object(raw.result).content);
        result.push(item(id, raw, "tool", type, value, `${server.trim()} / ${tool.trim()}`));
        break;
      }
      case "dynamicToolCall":
      case "functionCallOutput": {
        const name = raw.type === "dynamicToolCall" ? text(raw.tool) : "Tool result";
        const value = raw.type === "dynamicToolCall" ? publicTextContent(raw.contentItems) : text(raw.output);
        result.push(item(id, raw, "tool", type, value, name));
        break;
      }
      case "webSearch": {
        const action = object(raw.action);
        const query = text(action.query).trim() || text(action.url).trim();
        result.push(item(id, raw, "tool", type, query, "Web search"));
        break;
      }
      case "enteredReviewMode":
      case "exitedReviewMode":
      case "contextCompaction": {
        result.push(item(id, raw, "system", type, raw.type === "contextCompaction" ? "Context compacted" : text(raw.review)));
        break;
      }
      default:
        // Reasoning, plans, and unknown native items are private implementation details.
        break;
    }
  }
  return boundHistoryItems(result, responseMetadata);
}
