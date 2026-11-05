import type { SendRoute } from "../../types";
import { CLAUDE_CODE_PROVIDER, CLAUDE_CODE_PROVIDER_LABEL, isClaudeSessionId } from "./claude-session";

export const AGENT_KINDS = ["codex", "claude"] as const;
export type AgentKind = typeof AGENT_KINDS[number];
export const AGENT_KIND_LABELS: Record<AgentKind, string> = { codex: "Codex", claude: CLAUDE_CODE_PROVIDER_LABEL };

const PROVIDER_KINDS: Record<string, AgentKind> = {
  "codex-app": "codex", "wechat-codex": "codex", "terminal/codex": "codex",
  [CLAUDE_CODE_PROVIDER]: "claude", "terminal/claude": "claude",
};

export function isAgentKind(value: unknown): value is AgentKind {
  return (AGENT_KINDS as readonly unknown[]).includes(value);
}

/** The agent behind a session; other terminal agents (for example grok) have no Codex/Claude type. */
export function sessionAgentKind(session: { id: string; provider?: string }): AgentKind | null {
  return PROVIDER_KINDS[session.provider ?? ""] ?? (isClaudeSessionId(session.id) ? "claude" : null);
}

/** The agent a session-kind schedule sends to, from its frozen target. */
export function targetAgentKind(target: { sessionId: string; sendRoute?: SendRoute }): AgentKind {
  return target.sendRoute === "claude-resume" || isClaudeSessionId(target.sessionId) ? "claude" : "codex";
}
