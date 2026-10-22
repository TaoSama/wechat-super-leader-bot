import { describe, expect, it } from "vitest";
import { canQueueSession, sessionSendBlockReason } from "../../src/features/sessions/send-availability";
import { sendBlockReason } from "../../src/features/sessions/useSessionMessages";
import type { ScopedSession } from "../../src/types";

const NOW = Date.parse("2026-10-22T14:40:00Z");
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
const busy: ScopedSession = {
  id: "original", nodeId: "demoair", provider: "codex-app", title: "运行中的原会话", cwd: "/fixture",
  status: "notLoaded", loaded: false, capabilities: ["read"], observedAt: iso(),
  desktopObservation: { source: "codex-desktop", status: "active", availability: "available", observedAt: iso() },
  sendAvailability: { route: "desktop-owner", state: "blocked", reason: "busy", observedAt: iso(-600_000), validUntil: iso(-555_000) },
};

describe("queue admission during a long desktop turn", () => {
  it("uses the fresh active owner observation when its preserved preflight has expired", () => {
    const before = structuredClone(busy);
    expect(canQueueSession(busy, true, NOW)).toBe(true);
    expect(sendBlockReason(busy, true, false, NOW)).toBeNull();
    expect(sessionSendBlockReason(busy, NOW)).not.toBeNull();
    expect(busy).toEqual(before);
  });

  it("also queues when the separate native runtime is unknown or no idle preflight has run", () => {
    expect(canQueueSession({ ...busy, status: "unknown" }, true, NOW)).toBe(true);
    expect(canQueueSession({ ...busy, sendAvailability: { ...busy.sendAvailability!, observedAt: "1970-01-01T00:00:00Z", validUntil: "1970-01-01T00:00:00Z" } }, true, NOW)).toBe(true);
  });

  it.each([
    { desktopObservation: undefined },
    { desktopObservation: { ...busy.desktopObservation!, status: "idle" as const } },
    { desktopObservation: { ...busy.desktopObservation!, status: "unknown" as const } },
    { desktopObservation: { ...busy.desktopObservation!, availability: "unavailable" as const } },
    { desktopObservation: { ...busy.desktopObservation!, observedAt: iso(-45_001) } },
    { desktopObservation: { ...busy.desktopObservation!, observedAt: iso(1) } },
    { sendAvailability: undefined },
    { sendAvailability: { ...busy.sendAvailability!, reason: "preflight-rejected" as const } },
    { sendAvailability: { ...busy.sendAvailability!, observedAt: iso(1), validUntil: iso(45_001) } },
    { sendAvailability: { ...busy.sendAvailability!, validUntil: iso(-600_001) } },
    { sendAvailability: { ...busy.sendAvailability!, validUntil: iso(-554_999) } },
  ])("does not use missing, stale, contradictory or invalid evidence %#", change => {
    expect(canQueueSession({ ...busy, ...change } as ScopedSession, true, NOW)).toBe(false);
  });

  it("keeps stale workspace data blocked even with fresh owner evidence", () => {
    expect(sendBlockReason(busy, true, true, NOW)).not.toBeNull();
  });
});
