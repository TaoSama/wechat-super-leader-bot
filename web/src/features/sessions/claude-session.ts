export const CLAUDE_CODE_PROVIDER = "claude-code";
export const CLAUDE_CODE_PROVIDER_LABEL = "Claude Code";
export const CLAUDE_SESSION_ID = /^claude:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isClaudeSessionId(id: string): boolean {
  return id.startsWith("claude:");
}

export function isClaudeCodeSession(session: { id: string; provider?: string }): boolean {
  return CLAUDE_SESSION_ID.test(session.id) && session.provider === CLAUDE_CODE_PROVIDER;
}
