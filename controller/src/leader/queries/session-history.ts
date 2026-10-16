import type { NodeHub } from "../../nodes/hub.js";
import { HistoryError } from "../../sessions/history.js";
import { isTerminalSession } from "../../sessions/terminal.js";
import type { SessionHistory } from "../../types.js";
import { recordedOutput } from "../plans/input.js";

export const LEADER_HISTORY_LIMIT = 8;
export const LEADER_HISTORY_JSON_LIMIT = 11000;
type HistoryHub = Pick<NodeHub, "isNodeConnected" | "getNodeSession" | "readHistory">;
type Target = { nodeId: string; sessionId: string };

const errors: Record<string, string> = {
  history_offline: "目标节点离线，未取得历史。",
  history_session_not_found: "目标会话不可用，未取得历史。",
  history_forbidden: "目标会话未提供读取能力，未取得历史。",
  history_unavailable: "目标的已记录历史不可用；未改读文件元数据或终端屏幕。",
  history_timeout: "读取历史超时，未取得最新输出。",
  history_disconnected: "读取期间节点断开，未取得历史。",
  history_context_expired: "原历史来源已失效，未切换其他来源。",
  history_incomplete: "原会话历史尚不完整，未返回部分内容冒充完整记录。",
  history_too_large: "原会话历史超过读取上限，未取得历史。",
  history_busy: "历史读取当前繁忙，请稍后再查。",
  history_invalid_response: "历史响应无效，未取得可信记录。",
  history_failed: "历史读取失败，最新输出未取得；不代表会话没有运行。",
};

function failure(code: string) {
  const safeCode = Object.hasOwn(errors, code) ? code : "history_failed";
  return { code: safeCode, error: errors[safeCode] };
}

/** Model projection only: no cursor, context, capabilities or execution receipt. */
function recentHistory(target: Target, history: SessionHistory) {
  if (history.session.id !== target.sessionId || history.items.length > LEADER_HISTORY_LIMIT) {
    throw new HistoryError(502, "history_invalid_response", "Invalid history response");
  }
  const items = history.items.map(item => {
    const excerpt = recordedOutput(item.text);
    return { id: item.id, turnId: item.turnId, kind: item.kind, type: item.type,
      text: excerpt.excerpt, ...(item.timestamp ? { timestamp: item.timestamp } : {}),
      truncated: item.truncated === true || excerpt.truncated };
  });
  const result = { ...target, source: history.source, fetchedAt: history.fetchedAt,
    scope: "recent_recorded_history", completeHistory: false,
    hasOlder: history.nextCursor !== null, omittedItems: 0,
    truncated: history.truncated || items.some(item => item.truncated), items };
  // Keep a contiguous recent suffix, in source order; never cut serialized JSON.
  while (JSON.stringify(result).length > LEADER_HISTORY_JSON_LIMIT && result.items.length) {
    result.items.shift();
    result.omittedItems++;
    result.truncated = true;
  }
  if (history.items.length > 0 && result.items.length === 0 || JSON.stringify(result).length > LEADER_HISTORY_JSON_LIMIT) {
    throw new HistoryError(502, "history_invalid_response", "History metadata exceeds model budget");
  }
  return result;
}

export async function readSessionHistory(hub: HistoryHub, target: Target, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!hub.isNodeConnected(target.nodeId)) return failure("history_offline");
  const session = hub.getNodeSession(target.nodeId, target.sessionId);
  if (!session || session.id !== target.sessionId) return failure("history_session_not_found");
  if (!session.capabilities.includes("read")) return failure("history_forbidden");
  if (isTerminalSession(session) && session.historySource !== "terminal-transcript") {
    return failure("history_unavailable");
  }
  try {
    const history = await hub.readHistory(target.nodeId, target.sessionId, { limit: LEADER_HISTORY_LIMIT }, signal);
    signal.throwIfAborted();
    return recentHistory(target, history);
  } catch (error) {
    signal.throwIfAborted();
    return failure(error instanceof HistoryError ? error.code : "history_failed");
  }
}
