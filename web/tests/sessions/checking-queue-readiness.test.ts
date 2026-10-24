import { describe, expect, it } from "vitest";
import { canQueueSession, sessionSendBlockReason } from "../../src/features/sessions/send-availability";
import { sendBlockReason } from "../../src/features/sessions/useSessionMessages";
import type { ScopedSession } from "../../src/types";

const NOW = Date.parse("2026-10-23T00:00:00Z");
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
const checking: ScopedSession = {
  id: "original", nodeId: "macair", provider: "codex-app", title: "原会话", cwd: "/fixture",
  status: "notLoaded", loaded: false, capabilities: ["read"], observedAt: iso(),
  desktopObservation: { source: "codex-desktop", status: "idle", availability: "available", observedAt: iso() },
  sendAvailability: { route: "desktop-owner", state: "blocked", reason: "checking",
    observedAt: iso(-600_000), validUntil: iso(-555_000) },
};

describe("queue admission during an idle desktop readiness check", () => {
  it("accepts a persistent queue entry without granting immediate send authority", () => {
    const before = structuredClone(checking);
    expect(canQueueSession(checking, true, NOW)).toBe(true);
    expect(sendBlockReason(checking, true, false, NOW)).toBeNull();
    expect(sessionSendBlockReason(checking, NOW)).toContain("正在检查");
    expect(checking).toEqual(before);
  });

  it("accepts first-check zero epoch and an independently unknown native status", () => {
    expect(canQueueSession({ ...checking, status: "unknown", sendAvailability: { ...checking.sendAvailability!,
      observedAt: "1970-01-01T00:00:00Z", validUntil: "1970-01-01T00:00:00Z" } }, true, NOW)).toBe(true);
  });

  it.each([
    { desktopObservation: undefined },
    { desktopObservation: { ...checking.desktopObservation!, status: "unknown" } },
    { desktopObservation: { ...checking.desktopObservation!, status: "active" } },
    { desktopObservation: { ...checking.desktopObservation!, availability: "unavailable" } },
    { desktopObservation: { ...checking.desktopObservation!, observedAt: iso(-45_001) } },
    { desktopObservation: { ...checking.desktopObservation!, observedAt: iso(1) } },
    { desktopObservation: { ...checking.desktopObservation!, source: "invalid" } },
    { sendAvailability: undefined },
    { sendAvailability: { ...checking.sendAvailability!, state: "unavailable" } },
    { sendAvailability: { ...checking.sendAvailability!, route: "control-socket" } },
    { sendAvailability: { ...checking.sendAvailability!, reason: "preflight-rejected" } },
    { sendAvailability: { ...checking.sendAvailability!, observedAt: iso(1), validUntil: iso(45_001) } },
    { sendAvailability: { ...checking.sendAvailability!, validUntil: iso(-600_001) } },
    { sendAvailability: { ...checking.sendAvailability!, validUntil: iso(-554_999) } },
  ])("rejects missing, failed or contradictory evidence %#", changes => {
    expect(canQueueSession({ ...checking, ...changes } as ScopedSession, true, NOW)).toBe(false);
  });

  it("does not extend checking admission to offline or stale workspaces", () => {
    expect(canQueueSession(checking, false, NOW)).toBe(false);
    expect(sendBlockReason(checking, false, false, NOW)).not.toBeNull();
    expect(sendBlockReason(checking, true, true, NOW)).not.toBeNull();
  });
});
