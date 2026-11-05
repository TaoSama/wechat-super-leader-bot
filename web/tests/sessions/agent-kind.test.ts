import { describe, expect, it } from "vitest";
import { sessionAgentKind, targetAgentKind } from "../../src/features/sessions/agent-kind";
import { automationAgentKind } from "../../src/features/notifications/automation-contract";

const CLAUDE_ID = "claude:11111111-2222-4333-8444-555555555555";

describe("Codex and Claude Code type labels", () => {
  it.each([
    ["codex-app", "thread-1", "codex"], ["wechat-codex", "wechat:main", "codex"], ["terminal/codex", "terminal:x", "codex"],
    ["claude-code", CLAUDE_ID, "claude"], ["terminal/claude", "terminal:y", "claude"], ["terminal/grok", "terminal:z", null],
    ["unknown-agent", CLAUDE_ID, "claude"], ["unknown-agent", "thread-2", null],
  ])("maps provider %s (%s) to %s", (provider, id, kind) => {
    expect(sessionAgentKind({ id, provider })).toBe(kind);
  });
  it("derives a session schedule's type from its frozen target", () => {
    expect(targetAgentKind({ sessionId: CLAUDE_ID, sendRoute: "claude-resume" })).toBe("claude");
    expect(targetAgentKind({ sessionId: "thread-1", sendRoute: "app-server-resume" })).toBe("codex");
  });
  it("uses the executor for background schedules and nothing for reminders", () => {
    expect(automationAgentKind({ kind: "background", executor: "claude" })).toBe("claude");
    expect(automationAgentKind({ kind: "background" })).toBeUndefined();
    expect(automationAgentKind({ kind: "reminder", executor: "codex" })).toBeUndefined();
    expect(automationAgentKind({ kind: "session", target: { nodeId: "mini", sessionId: CLAUDE_ID, sendRoute: "claude-resume" } })).toBe("claude");
    expect(automationAgentKind({ kind: "session" })).toBeUndefined();
  });
});
