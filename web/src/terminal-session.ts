export function isTerminalSession(session: { id?: string; provider?: string }): boolean {
  return session.id?.startsWith("terminal:") === true || session.provider?.startsWith("terminal/") === true;
}

export const MAX_TERMINAL_OBSERVATION_AGE_MS = 45_000;
export const TERMINAL_READ_ONLY_REASON = "终端目前仅开放状态与快照读取，尚未开放发送";
