import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForSendReadiness, SEND_READINESS_WAIT_MS } from "../../src/sessions/send-readiness.js";
import type { Session } from "../../src/types.js";

const target = { nodeId: "macair", sessionId: "invest" };
function fixture() {
  const now = Date.now(), observedAt = new Date(now).toISOString();
  const session: Session = { id: target.sessionId, provider: "codex-app", title: "投资", cwd: "/fixture",
    status: "notLoaded", loaded: false, capabilities: ["read"], observedAt,
    desktopObservation: { source: "codex-desktop", availability: "available", status: "idle", observedAt },
    sendAvailability: { route: "desktop-owner", state: "blocked", reason: "checking",
      observedAt: "1970-01-01T00:00:00Z", validUntil: "1970-01-01T00:00:00Z" } };
  const listeners = new Set<() => void>();
  const state = { connected: true, session: session as Session | null };
  const hub = { isNodeConnected: () => state.connected, getNodeSession: () => state.session,
    subscribeSessionChanges: vi.fn((_node: string, listener: () => void) => {
      listeners.add(listener); return () => { listeners.delete(listener); };
    }) };
  const changed = () => { for (const listener of [...listeners]) listener(); };
  const ready = () => {
    session.sendAvailability = { route: "desktop-owner", state: "ready", observedAt,
      validUntil: new Date(now + 45000).toISOString() };
    changed();
  };
  return { hub, session, state, listeners, changed, ready };
}
afterEach(() => vi.useRealTimers());

describe("bounded send readiness observation", () => {
  it("observes checking recovery and releases the listener", async () => {
    const f = fixture();
    const result = waitForSendReadiness(f.hub, [target]);
    expect(f.listeners.size).toBe(1);
    f.ready();
    expect(await result).toEqual({ ready: true, routes: ["desktop-owner"] });
    expect(f.listeners.size).toBe(0);
  });

  it("times out once without leaking a timer or listener", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const result = waitForSendReadiness(f.hub, [target]);
    await vi.advanceTimersByTimeAsync(SEND_READINESS_WAIT_MS);
    expect(await result).toMatchObject({ ready: false, target, reason: expect.stringContaining("超时") });
    expect(f.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["disconnect", "missing", "busy", "unavailable", "stale"])("stops immediately on %s", async change => {
    const f = fixture();
    const result = waitForSendReadiness(f.hub, [target]);
    if (change === "disconnect") f.state.connected = false;
    if (change === "missing") f.state.session = null;
    if (change === "busy") f.session.sendAvailability!.reason = "busy";
    if (change === "unavailable") f.session.sendAvailability!.state = "unavailable";
    if (change === "stale") f.session.desktopObservation!.observedAt = "1970-01-01T00:00:00Z";
    f.changed();
    expect(await result).toMatchObject({ ready: false, target });
    expect(f.listeners.size).toBe(0);
  });

  it("does not wait for an unknown target or override a fixed route", async () => {
    const f = fixture();
    f.state.session = null;
    expect(await waitForSendReadiness(f.hub, [target])).toMatchObject({ ready: false });
    expect(f.hub.subscribeSessionChanges).not.toHaveBeenCalled();
    f.state.session = f.session;
    expect(await waitForSendReadiness(f.hub, [{ ...target, sendRoute: "control-socket" }])).toMatchObject({ ready: false });
    expect(f.hub.subscribeSessionChanges).not.toHaveBeenCalled();
  });

  it("gives an actionable desktop-unavailable reason without claiming the cause is unloaded", async () => {
    const f = fixture();
    f.session.desktopObservation!.availability = "unavailable";
    f.session.sendAvailability!.state = "unavailable";
    const result = await waitForSendReadiness(f.hub, [target]);
    expect(result).toMatchObject({ ready: false, reason: expect.stringContaining("原 Codex 桌面打开该会话") });
    expect(result).toMatchObject({ reason: expect.stringContaining("不能确定不可用的具体原因") });
    expect(f.hub.subscribeSessionChanges).not.toHaveBeenCalled();
  });

  it("aborts a pending wait and releases its listener", async () => {
    const f = fixture(), controller = new AbortController();
    const result = waitForSendReadiness(f.hub, [target], { signal: controller.signal });
    controller.abort();
    expect(await result).toMatchObject({ ready: false, reason: expect.stringContaining("取消") });
    expect(f.listeners.size).toBe(0);
  });

  it("never falls back to native control when checking desktop authority disappears", async () => {
    const f = fixture();
    const result = waitForSendReadiness(f.hub, [target]);
    delete f.session.sendAvailability;
    Object.assign(f.session, { loaded: true, status: "idle", capabilities: ["read", "send"] });
    f.changed();
    expect(await result).toMatchObject({ ready: false, reason: expect.stringContaining("路线已变化") });
    expect(f.listeners.size).toBe(0);
  });

  it("checks every target before waiting and rejects an unavailable peer", async () => {
    const f = fixture(), other = { nodeId: "macmini", sessionId: "research" };
    const hub = { ...f.hub, isNodeConnected: (nodeId: string) => nodeId !== other.nodeId };
    expect(await waitForSendReadiness(hub, [target, other])).toMatchObject({ ready: false, target: other });
    expect(f.hub.subscribeSessionChanges).not.toHaveBeenCalled();
  });

  it("freezes an already-ready peer route while another target is checking", async () => {
    const f = fixture(), other = { ...target, sessionId: "research" };
    const peer = { ...f.session, id: other.sessionId };
    f.ready();
    const hub = { ...f.hub, getNodeSession: (_node: string, id: string) => id === other.sessionId ? peer : f.session };
    const result = waitForSendReadiness(hub, [target, other]);
    delete f.session.sendAvailability;
    Object.assign(f.session, { loaded: true, status: "idle", capabilities: ["read", "send"] });
    f.changed();
    expect(await result).toMatchObject({ ready: false, target, reason: expect.stringContaining("路线已变化") });
    expect(f.listeners.size).toBe(0);
  });
});
