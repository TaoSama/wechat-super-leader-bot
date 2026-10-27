const MAX_TEXT = 16_000;
const MAX_TITLE = 512;

export type PublicHistoryItem = {
  id: string;
  turnId: string;
  kind: "user" | "assistant" | "tool" | "system";
  type: string;
  text: string;
  title?: string;
  turnStatus?: "inProgress" | "completed" | "failed" | "interrupted";
  status?: string;
  timestamp?: string;
  durationMs?: number;
  truncated?: boolean;
};

type Value = Record<string, unknown>;
const object = (value: unknown): Value => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Value : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const bounded = (value: string, limit: number): { value: string; truncated: boolean } => {
  const safe = value
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\-/]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\/(?:Users|home|private|var|tmp|opt|workspace|workspaces)\/[^\s\n`]+/g, "[PATH]");
  if (safe.length <= limit) return { value: safe, truncated: false };
  return { value: safe.slice(0, limit), truncated: true };
};
const status = (value: unknown): PublicHistoryItem["turnStatus"] => value === "inProgress" ? "inProgress" :
  value === "completed" ? "completed" : value === "failed" ? "failed" : value === "interrupted" ? "interrupted" : undefined;
const timestamp = (value: unknown): string | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 8.64e15) return undefined;
  return new Date(value).toISOString();
};
const duration = (startedAt: unknown, completedAt: unknown): number | undefined => {
  if (typeof startedAt !== "number" || typeof completedAt !== "number" || !Number.isFinite(startedAt) ||
      !Number.isFinite(completedAt) || completedAt <= startedAt) return undefined;
  const value = completedAt - startedAt;
  return value > 0 && value <= 7 * 24 * 60 * 60 * 1000 ? Math.round(value) : undefined;
};

function item(id: string, raw: Value, kind: PublicHistoryItem["kind"], type: string, value: string,
  title?: string): PublicHistoryItem {
  const boundedText = bounded(value, MAX_TEXT);
  const result: PublicHistoryItem = { id, turnId: text(raw.turnId) || "unknown", kind, type, text: boundedText.value };
  if (boundedText.truncated) result.truncated = true;
  const boundedTitle = title ? bounded(title, MAX_TITLE) : undefined;
  if (boundedTitle?.value) result.title = boundedTitle.value;
  const turnState = status(raw.turnStatus);
  if (turnState) result.turnStatus = turnState;
  if (typeof raw.status === "string" && raw.status.length <= 128) result.status = raw.status;
  const at = timestamp(raw.completedAtMs) ?? timestamp(raw.startedAtMs);
  if (at) result.timestamp = at;
  const durationMs = duration(raw.startedAtMs, raw.completedAtMs);
  if (durationMs !== undefined) result.durationMs = durationMs;
  return result;
}

function userText(raw: Value): string {
  if (typeof raw.text === "string") return raw.text;
  if (!Array.isArray(raw.content)) return "";
  return raw.content.map(value => {
    const part = object(value);
    if (part.type === "image" || part.type === "localImage" || part.type === "inputImage") return "[Image]";
    return text(part.text) || text(part.value);
  }).filter(Boolean).join("\n");
}

function publicTextContent(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map(entry => {
    const part = object(entry);
    if (part.type === "image" || part.type === "localImage" || part.type === "inputImage") return "[Image]";
    return text(part.text) || text(part.value);
  }).filter(Boolean).join("\n");
}

/** Project native Codex items into the controller's bounded public history contract. */
export function projectHistoryItems(rawItems: readonly Value[]): PublicHistoryItem[] {
  const result: PublicHistoryItem[] = [];
  for (const wrapper of rawItems) {
    const native = object(wrapper.item);
    if (!Object.keys(native).length) continue;
    const raw: Value = { ...native, turnId: text(wrapper.turnId) || "unknown", turnStatus: wrapper.turnStatus,
      startedAtMs: wrapper.startedAtMs, completedAtMs: wrapper.completedAtMs };
    const id = text(native.id);
    if (!id || id.length > 256) continue;
    switch (native.type) {
      case "userMessage": {
        const value = userText(raw);
        if (value) result.push(item(id, raw, "user", "user_message", value));
        break;
      }
      case "agentMessage": {
        const value = text(raw.text);
        if (value) result.push(item(id, raw, "assistant", "agent_message", value));
        break;
      }
      case "commandExecution": {
        const command = text(raw.command);
        const output = text(raw.aggregatedOutput);
        result.push(item(id, raw, "tool", "command_execution", output, command || "命令执行"));
        break;
      }
      case "fileChange": {
        const changes = Array.isArray(raw.changes) ? raw.changes.map(value => {
          const change = object(value);
          return [text(change.path), text(change.diff)].filter(Boolean).join("\n");
        }).filter(Boolean) : [];
        result.push(item(id, raw, "tool", "file_change", changes.join("\n"), "文件变更"));
        break;
      }
      case "mcpToolCall": {
        const server = text(raw.server), tool = text(raw.tool);
        const error = object(raw.error).message;
        const value = text(error) || publicTextContent(object(raw.result).content) || (raw.result ? "调用完成" : "");
        result.push(item(id, raw, "tool", "mcp_tool_call", value, [server, tool].filter(Boolean).join(" / ") || "MCP 调用"));
        break;
      }
      case "dynamicToolCall":
      case "functionCallOutput": {
        const name = text(raw.name) || text(raw.tool);
        const value = raw.type === "dynamicToolCall" ? publicTextContent(raw.contentItems) : text(raw.output) || text(raw.result);
        result.push(item(id, raw, "tool", raw.type === "dynamicToolCall" ? "dynamic_tool_call" : "function_call_output", value, name || "工具调用"));
        break;
      }
      case "webSearch": {
        const action = object(raw.action);
        const query = text(raw.query) || text(action.query) || text(action.url);
        result.push(item(id, raw, "tool", "web_search", query, "网页搜索"));
        break;
      }
      case "enteredReviewMode":
      case "exitedReviewMode":
      case "contextCompaction": {
        const label = raw.type === "contextCompaction" ? "上下文压缩" : raw.type === "enteredReviewMode" ? "进入审查模式" : "退出审查模式";
        result.push(item(id, raw, "system", text(raw.type), label));
        break;
      }
      default:
        // Reasoning, plans, and unknown native items are private implementation details.
        break;
    }
  }
  return result;
}
