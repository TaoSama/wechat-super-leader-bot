/** Existing Claude Code sessions reported by an opt-in daemon adapter. */
export const CLAUDE_CODE_PROVIDER = "claude-code";
export const CLAUDE_SESSION_ID_PATTERN = /^claude:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isClaudeSessionId(sessionId: string): boolean {
  return sessionId.startsWith("claude:");
}

/** Only an exact Claude Code session reported by its own provider may use claude-resume. */
export function isClaudeCodeSession(session: { id: string; provider?: string }): boolean {
  return CLAUDE_SESSION_ID_PATTERN.test(session.id) && session.provider === CLAUDE_CODE_PROVIDER;
}
