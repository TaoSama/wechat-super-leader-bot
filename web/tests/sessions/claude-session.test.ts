import { describe, expect, it } from "vitest";
import { normalizeCommand, normalizeSession } from "../../src/api/normalizers";
import { canQueueSession, isSessionMessageTarget, sendRouteLabel, sessionSendBlockReason } from "../../src/features/sessions/send-availability";
import { isSessionHistorySource } from "../../src/features/sessions/history-contract";
import type { ScopedSession } from "../../src/types";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const session: ScopedSession = { id: "claude:11111111-2222-4333-8444-555555555555", nodeId: "air", provider: "claude-code",
  title: "repo", cwd: "/repo", status: "idle", loaded: false, capabilities: ["read", "resume-send"], observedAt: new Date(NOW).toISOString() };

describe("Claude Code sessions", () => {
  it("allow sending only on a fresh idle session and queue busy ones", () => {
    const parsed = normalizeSession(session)!;
    expect(isSessionMessageTarget(parsed)).toBe(true);
    expect(sessionSendBlockReason(parsed, NOW)).toBeNull();
    expect(sessionSendBlockReason({ ...parsed, status: "active" }, NOW)).toContain("正在使用");
    expect(sessionSendBlockReason({ ...parsed, capabilities: ["read"] }, NOW)).toContain("仅支持读取");
    expect(canQueueSession({ ...parsed, status: "active" }, true, NOW)).toBe(true);
    expect(canQueueSession({ ...parsed, provider: "codex-app" }, true, NOW)).toBe(false);
  });

  it("labels the route and binds claude-transcript history to Claude sessions", () => {
    expect(sendRouteLabel("claude-resume")).toContain("Claude Code");
    expect(normalizeCommand({ commandId: "c", nodeId: "air", sessionId: session.id, action: "send", status: "accepted",
      sendRoute: "claude-resume", createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
      expiresAt: new Date(NOW + 60000).toISOString() })?.sendRoute).toBe("claude-resume");
    expect(isSessionHistorySource("claude-transcript", session)).toBe(true);
    expect(isSessionHistorySource("control-socket", session)).toBe(false);
    expect(isSessionHistorySource("claude-transcript", { ...session, id: "original", provider: "codex-app" })).toBe(false);
  });
});
