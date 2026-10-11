import { describe, expect, it } from "vitest";
import { selectSendRoute } from "../src/send-eligibility.js";
import { ControllerCommandMessageSchema, PostCommandRequestSchema, SessionSchema } from "../src/types.js";
import type { Session } from "../src/types.js";
import { ToolArguments } from "../src/leader/contracts.js";

const now = Date.parse("2026-10-11T12:00:00.000Z");
const at = (offset = 0) => new Date(now + offset).toISOString();
const native = (): Session => ({ id: "s", provider: "codex-app", title: "fixture", cwd: "/fixture",
  status: "idle", loaded: true, capabilities: ["read", "send"], observedAt: at() });
const ready = () => ({ route: "desktop-owner" as const, state: "ready" as const, observedAt: at(), validUntil: at(45000) });
const desktop = (): Session => ({ ...native(), status: "notLoaded", loaded: false, capabilities: ["read"], sendAvailability: ready() });

describe("independent send authority", () => {
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
