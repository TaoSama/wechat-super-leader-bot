import type { HistorySource, ScopedSession } from "../../types";
import { isTerminalHistoryTarget, isTerminalSession, MAX_TERMINAL_OBSERVATION_AGE_MS } from "./terminal-session";

const HISTORY_CONTEXT_PATTERN = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;

export const HISTORY_CONTEXT_EXPIRED_MESSAGE = "历史读取上下文已失效，已保留读取内容；请重新读取最新页。";
export const MAX_HISTORY_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export function isHistoryContext(value: unknown): value is string {
  return typeof value === "string" && HISTORY_CONTEXT_PATTERN.test(value);
}

export function hasTerminalHistorySource(session: Pick<ScopedSession, "id" | "provider" | "historySource">): boolean {
  return session.historySource === "terminal-transcript" && isTerminalHistoryTarget(session);
}

export function hasWechatHistorySource(session: Pick<ScopedSession, "id" | "nodeId" | "provider" | "historySource" | "capabilities">): boolean {
  return session.historySource === "wechat-codex" && session.provider === "wechat-codex" && session.nodeId === "wechat" &&
    session.capabilities.length === 1 && session.capabilities[0] === "read";
}

export function isSessionHistorySource(source: unknown, session: ScopedSession): source is HistorySource {
  if (source === "terminal-transcript") return hasTerminalHistorySource(session);
  if (source === "wechat-codex") return hasWechatHistorySource(session);
  return !isTerminalSession(session) && (source === "control-socket" || source === "codex-desktop");
}

export function terminalHistoryBlockReason(session: ScopedSession, now = Date.now()): string | null {
  if (!isTerminalSession(session)) return null;
  if (!hasTerminalHistorySource(session)) return "CLI 会话记录来源不可用，已暂停读取并保留已读内容。";
  const observedAt = Date.parse(session.observedAt);
  if (!Number.isFinite(observedAt) || observedAt > now || now - observedAt > MAX_TERMINAL_OBSERVATION_AGE_MS) {
    return "终端观测已过期，已暂停读取 CLI 会话记录并保留已读内容。";
  }
  return null;
}
