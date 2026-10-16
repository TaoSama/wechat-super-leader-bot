import { describe, expect, it } from "vitest";
import { selectSendRoute } from "../../src/sessions/send-eligibility.js";
import { ControllerCommandMessageSchema, PostCommandRequestSchema, SessionSchema } from "../../src/types.js";
import type { Session } from "../../src/types.js";
import { ToolArguments } from "../../src/leader/contracts.js";

const now = Date.parse("2026-10-11T12:00:00.000Z");
const at = (offset = 0) => new Date(now + offset).toISOString();
const native = (): Session => ({ id: "s", provider: "codex-app", title: "fixture", cwd: "/fixture",
  status: "idle", loaded: true, capabilities: ["read", "send"], observedAt: at() });
const ready = () => ({ route: "desktop-owner" as const, state: "ready" as const, observedAt: at(), validUntil: at(45000) });
const desktop = (): Session => ({ ...native(), status: "notLoaded", loaded: false, capabilities: ["read"], sendAvailability: ready() });

describe("independent send authority", () => {
  const resumable = (): Session => ({ ...native(), status: "notLoaded", loaded: false, capabilities: ["read", "resume-send"] });

  it.each(["notLoaded", "idle"])("selects explicit managed resume for unloaded %s without inventing native facts", status => {
    const session = { ...resumable(), status };
    const before = structuredClone(session);
    expect(selectSendRoute(session, now)).toEqual({ ready: true, route: "app-server-resume" });
    expect(SessionSchema.parse(session).capabilities).toEqual(["read", "resume-send"]);
    expect(session).toEqual(before);
  });

  it("preserves a frozen resume route after loading without selecting it for new work", () => {
    const session: Session = { ...native(), capabilities: ["read", "send", "resume-send"] };
    expect(selectSendRoute(session, now)).toEqual({ ready: true, route: "control-socket" });
    expect(selectSendRoute(session, now, "app-server-resume")).toEqual({ ready: true, route: "app-server-resume" });
    expect(selectSendRoute({ ...session, capabilities: ["read", "send"] }, now, "app-server-resume"))
      .toEqual({ ready: true, route: "control-socket" });
  });

  it.each([{ status: "active" }, { status: "unknown" }, { loaded: undefined },
    { observedAt: at(-45001) }, { observedAt: at(1) },
    { desktopObservation: { source: "codex-desktop", availability: "available", status: "idle", observedAt: at() } },
    { desktopObservation: { source: "codex-desktop", availability: "available", status: "active", observedAt: at() } },
    { desktopObservation: { source: "codex-desktop", availability: "available", status: "unknown", observedAt: at() } },
    { sendAvailability: ready() }])("never grants frozen loaded resume on unsafe evidence %#", overrides => {
    const session = { ...native(), capabilities: ["read", "send", "resume-send"], ...overrides } as Session;
    expect(selectSendRoute(session, now, "app-server-resume")).not.toEqual({ ready: true, route: "app-server-resume" });
  });

  it.each([{ loaded: true }, { loaded: undefined }, { status: "active" }, { status: "unknown" },
    { observedAt: at(-45001) }, { observedAt: at(1) }, { observedAt: "invalid" }, { capabilities: ["read"] },
    { id: "terminal:fixture", provider: "terminal/codex" }, { provider: "unknown" }])(
    "requires complete fresh unloaded native resume evidence %#", overrides => {
      expect(selectSendRoute({ ...resumable(), ...overrides } as Session, now).ready).toBe(false);
    });

  it.each(["idle", "active", "unknown"] as const)("does not resume while a fresh desktop owner is observed %s", status => {
    expect(selectSendRoute({ ...resumable(), desktopObservation: {
      source: "codex-desktop", availability: "available", status, observedAt: at(),
    } }, now).ready).toBe(false);
  });

  it("keeps valid desktop ready above resume and permits a new resume route after owner is unavailable", () => {
    expect(selectSendRoute({ ...resumable(), sendAvailability: ready() }, now)).toEqual({ ready: true, route: "desktop-owner" });
    const session: Session = { ...resumable(), sendAvailability: { ...ready(), state: "unavailable", reason: "unavailable" },
      desktopObservation: { source: "codex-desktop", availability: "unavailable", status: "unknown" } };
    expect(selectSendRoute(session, now)).toEqual({ ready: true, route: "app-server-resume" });
    expect(selectSendRoute({ ...session, sendAvailability: undefined }, now).ready).toBe(false);
    expect(selectSendRoute({ ...session, desktopObservation: undefined }, now).ready).toBe(false);
  });

  it("keeps resume capability separate from command actions and routing supplied by clients", () => {
    const wire = { type: "command", commandId: "c", nodeId: "n", sessionId: "s", action: "send", sendRoute: "app-server-resume", expiresAt: at(1000) };
    expect(ControllerCommandMessageSchema.safeParse(wire).success).toBe(true);
    expect(ControllerCommandMessageSchema.safeParse({ ...wire, action: "resume-send" }).success).toBe(false);
    expect(ControllerCommandMessageSchema.safeParse({ ...wire, sessionId: "terminal:fixture" }).success).toBe(false);
    expect(PostCommandRequestSchema.safeParse({ nodeId: "n", sessionId: "s", action: "resume-send", requestId: "r", prompt: "fixture" }).success).toBe(false);
  });

  it("selects native only when loaded, idle, capable and fresh", () => {
    expect(selectSendRoute(native(), now)).toEqual({ ready: true, route: "control-socket" });
    expect(selectSendRoute({ ...native(), observedAt: at(-45000) }, now).ready).toBe(true);
    for (const overrides of [{ loaded: undefined }, { loaded: false }, { status: "active" }, { capabilities: ["read"] },
      { observedAt: "now" }, { observedAt: at(1) }, { observedAt: at(-45001) }]) {
      expect(selectSendRoute({ ...native(), ...overrides } as Session, now).ready).toBe(false);
    }
  });

  it("allows desktop ready independently of native status, loading and capabilities", () => {
    expect(selectSendRoute(desktop(), now)).toEqual({ ready: true, route: "desktop-owner" });
    expect(SessionSchema.parse(desktop()).sendAvailability).toEqual(ready());
    expect(selectSendRoute({ ...desktop(), sendAvailability: { ...ready(), observedAt: at(-1), validUntil: at(44999) } }, now).ready).toBe(true);
  });

  it.each([undefined, null, {}, { ...ready(), route: "control-socket" }, { ...ready(), state: "blocked" },
    { ...ready(), state: "unavailable" }, { ...ready(), observedAt: "invalid" }, { ...ready(), validUntil: "invalid" },
    { ...ready(), observedAt: at(1) }, { ...ready(), validUntil: at() }, { ...ready(), validUntil: at(45001) },
    { ...ready(), observedAt: at(-50000), validUntil: at(-5000) }, { ...ready(), reason: "invalid" }])(
    "never falls back on present invalid or revoked desktop availability %#", value => {
      expect(selectSendRoute({ ...native(), sendAvailability: value } as Session, now).ready).toBe(false);
    });

  it("requires a present desktop observation to corroborate fresh available idle", () => {
    const observation = { source: "codex-desktop" as const, availability: "available" as const, status: "idle" as const, observedAt: at() };
    expect(selectSendRoute({ ...desktop(), desktopObservation: observation }, now).ready).toBe(true);
    for (const overrides of [{ status: "active" }, { status: "unknown" }, { availability: "unavailable" },
      { observedAt: undefined }, { observedAt: "now" }, { observedAt: at(1) }, { observedAt: at(-45001) }]) {
      expect(selectSendRoute({ ...desktop(), desktopObservation: { ...observation, ...overrides } } as Session, now).ready).toBe(false);
    }
    expect(selectSendRoute({ ...desktop(), desktopObservation: undefined }, now).ready).toBe(false);
    expect(selectSendRoute({ ...native(), loaded: false, desktopObservation: observation }, now).ready).toBe(false);
  });

  it("does not accept routing authority from HTTP callers or model actions", () => {
    const request = { nodeId: "n", sessionId: "s", action: "send", prompt: "fixture", requestId: "r" };
    expect(PostCommandRequestSchema.safeParse({ ...request, sendRoute: "desktop-owner" }).success).toBe(false);
    expect(ToolArguments.propose_plan.safeParse({ actions: [{ nodeId: "n", sessionId: "s", prompt: "fixture", sendRoute: "desktop-owner" }] }).success).toBe(false);
    const wire = { type: "command", commandId: "c", nodeId: "n", sessionId: "s", action: "read", expiresAt: at(1000) };
    expect(ControllerCommandMessageSchema.safeParse({ ...wire, sendRoute: "desktop-owner" }).success).toBe(false);
  });
});
