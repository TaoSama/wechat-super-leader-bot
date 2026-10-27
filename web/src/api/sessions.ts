import { SessionHistory, HistoryItem, CommandRecord } from "../types";
import { isHistoryContext, isSessionHistorySource, MAX_HISTORY_DURATION_MS } from "../features/sessions/history-contract";
import { normalizeSession, normalizeCommand } from "./normalizers";
import { sessionRequest } from "./request";

const HISTORY_LIMIT = 20;
const MAX_TURN_STATUSES = 2048;
const MAX_TURN_ID_BYTES = 128;
const TURN_STATUSES = new Set(["inProgress", "completed", "failed", "interrupted"]);

function sessionPath(nodeId: string, sessionId: string): string {
  return `/v1/sessions/${encodeURIComponent(nodeId)}/${encodeURIComponent(sessionId)}`;
}

export async function fetchSessionHistory(nodeId: string, sessionId: string, cursor?: string, signal?: AbortSignal, historyContext?: string, source?: "control-socket" | "wechat-codex"): Promise<SessionHistory> {
  if (historyContext !== undefined && !isHistoryContext(historyContext) || cursor && !historyContext) throw new Error("历史读取参数无效");
  if (source !== undefined && source !== "control-socket" && source !== "wechat-codex") throw new Error("历史读取参数无效");
  const query = new URLSearchParams({ limit: String(HISTORY_LIMIT) });
  if (source) query.set("source", source);
  if (cursor) query.set("cursor", cursor);
  if (historyContext) query.set("historyContext", historyContext);
  const raw = await sessionRequest(`${sessionPath(nodeId, sessionId)}/history?${query}`, { method: "GET", headers: { Accept: "application/json" }, signal }, true);
  if (typeof raw !== "object" || raw === null) throw new Error("历史响应格式无效");
  const data = raw as Record<string, unknown>;
  if (!isHistoryContext(data.historyContext) || historyContext !== undefined && data.historyContext !== historyContext) throw new Error("历史响应与当前读取上下文不匹配");
  if (data.session && typeof data.session === "object" && "nodeId" in data.session && data.session.nodeId !== nodeId) throw new Error("历史响应与当前会话不匹配");
  const session = normalizeSession({ ...(typeof data.session === "object" ? data.session : {}), nodeId });
  if (!session || session.id !== sessionId || !Array.isArray(data.items) || typeof data.fetchedAt !== "string") throw new Error("历史响应与当前会话不匹配");
  if (data.items.length > HISTORY_LIMIT) throw new Error("历史响应超出单页条数限制");
  if (!isSessionHistorySource(data.source, session)) throw new Error("历史响应与当前读取来源不匹配");
  if (source !== undefined && data.source !== source) throw new Error("历史响应与所选读取来源不匹配");
  const items = data.items.map((item: unknown): HistoryItem => {
    if (typeof item !== "object" || item === null) throw new Error("历史条目格式无效");
    const value = item as Record<string, unknown>;
    if (typeof value.id !== "string" || typeof value.text !== "string" || typeof value.turnId !== "string" || !["user", "assistant", "tool", "system"].includes(String(value.kind))) throw new Error("历史条目格式无效");
    if (data.source === "terminal-transcript" && ((value.kind !== "user" && value.kind !== "assistant") ||
        (value.type !== "transcript_message" && value.type !== "transcript_chunk"))) throw new Error("CLI 会话记录条目格式无效");
    if (value.turnStatus !== undefined && (typeof value.turnStatus !== "string" || !TURN_STATUSES.has(value.turnStatus))) throw new Error("历史轮次状态无效");
    const durationMs = typeof value.durationMs === "number" && Number.isSafeInteger(value.durationMs) && value.durationMs >= 0 && value.durationMs <= MAX_HISTORY_DURATION_MS
      ? value.durationMs : undefined;
    return { turnStatus: value.turnStatus as HistoryItem["turnStatus"], id: value.id, text: value.text, turnId: value.turnId, kind: value.kind as HistoryItem["kind"], type: typeof value.type === "string" ? value.type : "unknown", title: typeof value.title === "string" ? value.title : undefined, status: typeof value.status === "string" ? value.status : undefined, timestamp: typeof value.timestamp === "string" ? value.timestamp : undefined, ...(durationMs === undefined ? {} : { durationMs }), truncated: value.truncated === true };
  });
  let turnStatuses: SessionHistory["turnStatuses"];
  if (data.turnStatuses !== undefined) {
    if (!data.turnStatuses || typeof data.turnStatuses !== "object" || Array.isArray(data.turnStatuses)) throw new Error("历史轮次状态无效");
    const entries = Object.entries(data.turnStatuses);
    if (entries.length > MAX_TURN_STATUSES || entries.some(([id, status]) => !id || new TextEncoder().encode(id).length > MAX_TURN_ID_BYTES || typeof status !== "string" || !TURN_STATUSES.has(status))) throw new Error("历史轮次状态无效");
    turnStatuses = Object.fromEntries(entries) as SessionHistory["turnStatuses"];
  }
  return { session, turnStatuses, historyContext: data.historyContext, source: data.source, items, nextCursor: typeof data.nextCursor === "string" ? data.nextCursor : null, fetchedAt: data.fetchedAt, truncated: data.truncated === true };
}

export async function sendSessionMessage(nodeId: string, sessionId: string, prompt: string, requestId: string, signal?: AbortSignal): Promise<CommandRecord> {
  const raw = await sessionRequest(`${sessionPath(nodeId, sessionId)}/messages`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", "X-Super-Leader-Intent": "session-message" }, body: JSON.stringify({ prompt, requestId }), signal });
  const command = normalizeCommand(raw);
  if (!command || command.action !== "send" || command.nodeId !== nodeId || command.sessionId !== sessionId) throw new Error("发送回执与当前会话不匹配，需核查");
  return command;
}

export async function fetchCommand(commandId: string, signal?: AbortSignal): Promise<CommandRecord> {
  const command = normalizeCommand(await sessionRequest(`/v1/commands/${encodeURIComponent(commandId)}`, { method: "GET", headers: { Accept: "application/json" }, signal }));
  if (!command || command.commandId !== commandId) throw new Error("命令回执格式无效");
  return command;
}

export async function fetchSessionMessage(nodeId: string, sessionId: string, requestId: string, signal?: AbortSignal): Promise<CommandRecord> {
  const command = normalizeCommand(await sessionRequest(`${sessionPath(nodeId, sessionId)}/messages/${encodeURIComponent(requestId)}`, { method: "GET", headers: { Accept: "application/json" }, signal }));
  if (!command || command.action !== "send" || command.nodeId !== nodeId || command.sessionId !== sessionId) throw new Error("原请求回执与当前会话不匹配，需核查");
  return command;
}

export async function cancelSessionMessage(nodeId: string, sessionId: string, commandId: string, signal?: AbortSignal): Promise<CommandRecord> {
  const command = normalizeCommand(await sessionRequest(`${sessionPath(nodeId, sessionId)}/messages`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", "X-Super-Leader-Intent": "session-message" }, body: JSON.stringify({ cancelCommandId: commandId }), signal }));
  if (!command || command.action !== "send" || command.commandId !== commandId || command.nodeId !== nodeId || command.sessionId !== sessionId) throw new Error("取消回执与当前请求不匹配，需核查");
  return command;
}
