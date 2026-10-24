import { describe, expect, it } from "vitest";
import { canQueueSession, sessionSendBlockReason } from "../../src/features/sessions/send-availability";
import { sendBlockReason } from "../../src/features/sessions/useSessionMessages";
import type { ScopedSession } from "../../src/types";

const NOW = Date.parse("2026-10-23T01:20:11Z");
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
const waiting: ScopedSession = {
  id: "original", nodeId: "air", provider: "codex-app", title: "Original", cwd: "/fixture",
  loaded: false, status: "notLoaded", capabilities: ["read"], observedAt: iso(),
  desktopObservation: { source: "codex-desktop", status: "idle", availability: "available", observedAt: iso(-11_000) },
  sendAvailability: { route: "desktop-owner", state: "unavailable", reason: "unavailable",
    observedAt: iso(-9_000), validUntil: iso(36_000) },
};

describe("durable queue admission while an idle owner's failed preflight is retried", () => {
  it("allows submission without rewriting the failed preflight into immediate authority", () => {
    const before = structuredClone(waiting);
    expect(canQueueSession(waiting, true, NOW)).toBe(true);
    expect(sendBlockReason(waiting, true, false, NOW)).toBeNull();
    expect(sessionSendBlockReason(waiting, NOW)).toContain("发送通道暂不可用");
    expect(waiting).toEqual(before);
  });

  it.each([
    { observedAt: iso(-600_000), validUntil: iso(-555_000) },
    { observedAt: "1970-01-01T00:00:00Z", validUntil: "1970-01-01T00:00:00Z" },
  ])("uses a fresh owner independently of the preserved preflight interval %#", interval => {
    expect(canQueueSession({ ...waiting, sendAvailability: { ...waiting.sendAvailability!, ...interval } }, true, NOW)).toBe(true);
  });

  it.each([
    { desktopObservation: undefined },
    { desktopObservation: { ...waiting.desktopObservation!, availability: "unavailable" } },
    { desktopObservation: { ...waiting.desktopObservation!, status: "unknown" } },
    { desktopObservation: { ...waiting.desktopObservation!, status: "active" } },
    { desktopObservation: { ...waiting.desktopObservation!, source: "unverified" } },
    { desktopObservation: { ...waiting.desktopObservation!, observedAt: undefined } },
    { desktopObservation: { ...waiting.desktopObservation!, observedAt: iso(-45_001) } },
    { desktopObservation: { ...waiting.desktopObservation!, observedAt: iso(1) } },
    { sendAvailability: undefined },
    { sendAvailability: { ...waiting.sendAvailability!, state: "blocked" } },
    { sendAvailability: { ...waiting.sendAvailability!, reason: "preflight-rejected" } },
    { sendAvailability: { ...waiting.sendAvailability!, reason: "checking" } },
    { sendAvailability: { ...waiting.sendAvailability!, route: "control-socket" } },
    { sendAvailability: { ...waiting.sendAvailability!, observedAt: iso(1), validUntil: iso(45_001) } },
    { sendAvailability: { ...waiting.sendAvailability!, validUntil: iso(-9_001) } },
    { sendAvailability: { ...waiting.sendAvailability!, validUntil: iso(36_001) } },
    { id: "invalid/id" },
    { nodeId: "" },
    { id: "terminal:unverified", provider: "terminal" },
    { status: "unknown", loaded: undefined, desktopObservation: undefined, sendAvailability: undefined },
  ])("does not grant queueing from invalid, missing or contradictory identity/proof %#", changes => {
    expect(canQueueSession({ ...waiting, ...changes } as ScopedSession, true, NOW)).toBe(false);
  });

  it("expires current owner proof locally and keeps offline/stale workspaces blocked", () => {
    expect(canQueueSession(waiting, true, NOW + 34_000)).toBe(true);
    expect(canQueueSession(waiting, true, NOW + 34_001)).toBe(false);
    expect(canQueueSession(waiting, false, NOW)).toBe(false);
    expect(sendBlockReason(waiting, false, false, NOW)).not.toBeNull();
    expect(sendBlockReason(waiting, true, true, NOW)).not.toBeNull();
    expect(canQueueSession(waiting, true, Number.NaN)).toBe(false);
  });
});
