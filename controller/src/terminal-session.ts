/** Terminal snapshots never carry native turn or desktop-owner authority. */
export function isTerminalSession(session: { id?: string; provider?: string }): boolean {
  return session.id?.startsWith("terminal:") === true || session.provider?.startsWith("terminal/") === true;
}

export const TERMINAL_SESSION_ID_PATTERN = /^terminal:[A-Za-z0-9_-]{43}$/;
export const MAX_TERMINAL_OBSERVATION_AGE_MS = 45_000;
