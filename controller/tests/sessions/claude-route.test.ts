import { describe, expect, it } from "vitest";
import { selectSendRoute } from "../../src/sessions/send-eligibility.js";
import { queueSendRoute } from "../../src/commands/queue.js";
import { routeSupportsDeliveryMode } from "../../src/commands/delivery.js";
import { ControllerCommandMessageSchema, SessionHistorySchema, validateCommandSendRoute, type Session } from "../../src/types.js";

const CLAUDE_ID = "claude:11111111-2222-4333-8444-555555555555";
const claude = (overrides: Partial<Session> = {}): Session => ({ id: CLAUDE_ID, provider: "claude-code", title: "repo", cwd: "/repo",
  status: "idle", loaded: false, capabilities: ["read", "resume-send"], observedAt: new Date().toISOString(), ...overrides });
const command = (overrides: Record<string, unknown>) => ({ type: "command", commandId: "c", nodeId: "n", sessionId: CLAUDE_ID,
  action: "send", prompt: "x", expiresAt: new Date(Date.now() + 60000).toISOString(), sendRoute: "claude-resume", ...overrides });

describe("claude-resume route", () => {
  it("selects claude-resume only for a fresh idle Claude Code session", () => {
    expect(selectSendRoute(claude())).toEqual({ ready: true, route: "claude-resume" });
    expect(selectSendRoute(claude({ status: "active" }))).toMatchObject({ ready: false, httpStatus: 409 });
    expect(selectSendRoute(claude({ status: "unknown" }))).toMatchObject({ ready: false });
    expect(selectSendRoute(claude({ observedAt: new Date(Date.now() - 60000).toISOString() }))).toMatchObject({ ready: false });
    expect(selectSendRoute(claude({ capabilities: ["read"] }))).toMatchObject({ ready: false, httpStatus: 400 });
    expect(selectSendRoute(claude({ provider: "codex-app" }))).toMatchObject({ ready: false });
    // A Claude-looking provider can never borrow a Codex route.
    expect(selectSendRoute(claude({ id: "plain", capabilities: ["read", "send"], loaded: true }))).toMatchObject({ ready: false });
  });

  it("queues busy Claude Code sessions on their only route and keeps terminals excluded", () => {
    expect(queueSendRoute(claude({ status: "active" }))).toBe("claude-resume");
    expect(queueSendRoute(claude(), "claude-resume")).toBe("claude-resume");
    expect(queueSendRoute(claude(), "app-server-resume")).toBeUndefined();
    expect(queueSendRoute(claude({ capabilities: ["read"] }))).toBeUndefined();
    expect(queueSendRoute({ ...claude(), id: "terminal:" + "a".repeat(43), provider: "terminal/claude" })).toBeUndefined();
    const codex: Session = { id: "s", provider: "codex-app", title: "", cwd: "", status: "idle", loaded: true, capabilities: ["read", "send"], observedAt: new Date().toISOString() };
    expect(queueSendRoute(codex)).toBe("control-socket");
  });

  it("binds Claude Code IDs to next-turn claude-resume in the wire contract", () => {
    expect(ControllerCommandMessageSchema.safeParse(command({})).success).toBe(true);
    expect(ControllerCommandMessageSchema.safeParse(command({ sendRoute: "app-server-resume" })).success).toBe(false);
    expect(ControllerCommandMessageSchema.safeParse(command({ sessionId: "codex-thread" })).success).toBe(false);
    expect(ControllerCommandMessageSchema.safeParse(command({ sessionId: "claude:not-a-uuid" })).success).toBe(false);
    expect(ControllerCommandMessageSchema.safeParse(command({ deliveryMode: "steer", expectedTurnId: "t" })).success).toBe(false);
    expect(routeSupportsDeliveryMode("claude-resume", "steer")).toBe(false);
    expect(() => validateCommandSendRoute({ action: "send", sessionId: CLAUDE_ID, sendRoute: "control-socket" })).toThrow();
    expect(() => validateCommandSendRoute({ action: "send", sessionId: "s", sendRoute: "claude-resume" })).toThrow();
    expect(() => validateCommandSendRoute({ action: "send", sessionId: CLAUDE_ID, sendRoute: "claude-resume" })).not.toThrow();
  });

  it("accepts claude-transcript history only for Claude Code sessions", () => {
    const history = (session: Session, source: string) => ({ session, source, historyContext: "11111111-2222-4333-8444-555555555555",
      items: [], nextCursor: null, fetchedAt: new Date().toISOString(), truncated: false });
    expect(SessionHistorySchema.safeParse(history(claude(), "claude-transcript")).success).toBe(true);
    expect(SessionHistorySchema.safeParse(history(claude(), "control-socket")).success).toBe(false);
    expect(SessionHistorySchema.safeParse(history(claude({ id: "s", provider: "codex-app" }), "claude-transcript")).success).toBe(false);
  });
});
