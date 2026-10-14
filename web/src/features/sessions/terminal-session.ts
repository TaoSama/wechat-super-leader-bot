export function isTerminalSession(session: { id?: string; provider?: string }): boolean {
  return session.id?.startsWith("terminal:") === true || session.provider?.startsWith("terminal/") === true;
}

export const MAX_TERMINAL_OBSERVATION_AGE_MS = 45_000;
export const TERMINAL_READ_ONLY_REASON = "终端默认只读，当前未开放发送";

const TERMINAL_HISTORY_ID_PATTERN = /^terminal:[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const TERMINAL_HISTORY_PROVIDERS = new Set(["terminal/codex", "terminal/claude", "terminal/grok"]);

export function isTerminalHistoryTarget(session: { id?: string; provider?: string }): boolean {
  return TERMINAL_HISTORY_ID_PATTERN.test(session.id ?? "") && session.id === session.id?.trim() &&
    TERMINAL_HISTORY_PROVIDERS.has(session.provider ?? "");
}
