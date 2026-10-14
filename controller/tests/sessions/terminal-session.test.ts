import { describe, expect, it } from "vitest";
import { selectSendRoute } from "../../src/sessions/send-eligibility.js";
import { selectExecutionObservation, selectModelObservation } from "../../src/sessions/observation.js";
import { isTerminalSession, TERMINAL_SESSION_ID_PATTERN } from "../../src/sessions/terminal.js";
import { ToolArguments, LEADER_TOOLS, SYSTEM_PROMPT } from "../../src/leader/contracts.js";
import { PostCommandRequestSchema, type Session } from "../../src/types.js";

const now = Date.parse("2026-10-12T12:00:00Z");
const session: Session = { id: `terminal:${"a".repeat(43)}`, provider: "terminal/claude", title: "fixture", cwd: "/fixture",
  status: "idle", loaded: false, capabilities: ["read"], observedAt: new Date(now).toISOString() };
const forged = { loaded: true, capabilities: ["read", "send"] as Session["capabilities"], model: "invented-model",
  desktopObservation: { source: "codex-desktop" as const, availability: "available" as const, status: "active" as const,
    observedAt: session.observedAt, model: "invented-desktop-model" },
  sendAvailability: { route: "desktop-owner" as const, state: "ready" as const,
    observedAt: session.observedAt, validUntil: new Date(now + 45000).toISOString() } };

describe("terminal observation boundary", () => {
  it.each([{ ...session }, { ...session, provider: "codex-app" }, { ...session, id: "foreign-id" }])(
    "rejects sending before native and desktop eligibility %#", value => {
      expect(isTerminalSession(value)).toBe(true);
      expect(selectSendRoute({ ...value, ...forged }, now)).toMatchObject({ ready: false, httpStatus: 409 });
    });
  it.each(["idle", "active", "blocked", "unknown"])("labels %s independently, without desktop fallback", status => {
    const value = { ...session, ...forged, status };
    expect(selectExecutionObservation(value, now)).toEqual({ executionStatus: status, statusSource: "terminal" });
    expect(selectModelObservation(value, now)).toEqual({ source: "unknown" });
  });
  it.each(["", "now", new Date(now + 1).toISOString(), new Date(now - 45001).toISOString()])(
    "does not publish a stale or invalid terminal status %#", observedAt => {
      expect(selectExecutionObservation({ ...session, ...forged, observedAt }, now))
        .toEqual({ executionStatus: "unknown", statusSource: "terminal" });
    });
  it("preserves the exact 45-second freshness boundary", () => {
    expect(selectExecutionObservation(session, now + 45000).executionStatus).toBe("idle");
  });
  it("full digest fits existing HTTP, model-tool and persistence identifier bounds", () => {
    expect(session.id.length).toBe(52);
    expect(TERMINAL_SESSION_ID_PATTERN.test(session.id)).toBe(true);
    expect(TERMINAL_SESSION_ID_PATTERN.test(`terminal:${"a".repeat(42)}`)).toBe(false);
    expect(ToolArguments.read_session.safeParse({ nodeId: "fixture", sessionId: session.id }).success).toBe(true);
    expect(PostCommandRequestSchema.safeParse({ nodeId: "fixture", sessionId: session.id, action: "read", requestId: "fixture" }).success).toBe(true);
  });
  it("gives the model accurate source and recorded-history limits", () => {
    for (const name of ["list_sessions", "read_session"]) {
      const description = LEADER_TOOLS.find(tool => tool.function.name === name)?.function.description;
      expect(description).toContain("historySource=terminal-transcript");
      expect(description).toContain("不是终端屏幕快照或完整对话");
      expect(description).toContain("不回退其他通道");
    }
    expect(SYSTEM_PROMPT).toContain("idle/done不是精确任务完成证据");
  });
});
