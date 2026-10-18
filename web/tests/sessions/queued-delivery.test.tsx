import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCommand } from "../../src/api/normalizers";
import { matchesCommandFilter } from "../../src/features/leader/command-filters";
import { sendBlockReason, useSessionMessages } from "../../src/features/sessions/useSessionMessages";
import type { CommandRecord, ScopedSession } from "../../src/types";

const NOW = Date.parse("2026-10-18T10:00:00Z");
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
const session: ScopedSession = { id: "session", nodeId: "air", provider: "codex-app", title: "原会话", cwd: "/fixture", status: "active", loaded: true, capabilities: ["read", "send"], observedAt: iso() };
const queued: CommandRecord = { commandId: "original-command", requestId: "server-request", nodeId: "air", sessionId: "session", action: "send", status: "queued", prompt: "稍后执行", sendRoute: "control-socket", createdAt: iso(), updatedAt: iso(), expiresAt: iso(60_000) };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("durable queue web admission", () => {
  it.each(["active", "busy", "running"])("allows known %s targets and offline targets to queue", status => {
    expect(sendBlockReason({ ...session, status }, true, false)).toBeNull();
    expect(sendBlockReason({ ...session, status }, false, false, NOW + 90_000)).toBeNull();
  });

  it.each([
    { capabilities: ["read"] }, { status: "unknown" }, { id: "wrong/target" }, { nodeId: "wrong/target" },
    { observedAt: "invalid" }, { sendAvailability: {} },
    { desktopObservation: { source: "codex-desktop", status: "unknown", availability: "available", observedAt: iso() } },
    { provider: "terminal/codex", id: "terminal:fixture" },
  ])("does not convert unknown, read-only or invalid targets into queue authority %#", patch => {
    expect(sendBlockReason({ ...session, ...patch } as ScopedSession, false, false)).not.toBeNull();
  });

  it("accepts busy desktop owner evidence without granting malformed or unknown evidence", () => {
    const desktop = { ...session, loaded: false, status: "notLoaded", capabilities: ["read"] as ScopedSession["capabilities"],
      sendAvailability: { route: "desktop-owner", state: "blocked", reason: "busy", observedAt: iso(), validUntil: iso(45_000) } as const,
      desktopObservation: { source: "codex-desktop", status: "active", availability: "available", observedAt: iso() } as const };
    expect(sendBlockReason(desktop, true, false)).toBeNull();
    expect(sendBlockReason({ ...desktop, desktopObservation: { ...desktop.desktopObservation, status: "unknown" } }, false, false)).not.toBeNull();
  });

  it("rejects invalid idle targets before the direct send route", () => {
    expect(sendBlockReason({ ...session, id: "wrong/target", status: "idle" }, true, false)).not.toBeNull();
    expect(sendBlockReason({ ...session, nodeId: "wrong/target", status: "idle" }, true, false)).not.toBeNull();
  });

  it.each(["queued", "cancelled", "expired"] as const)("preserves %s as its own status", status => {
    expect(normalizeCommand({ ...queued, status })?.status).toBe(status);
    expect(matchesCommandFilter(status, status)).toBe(true);
    expect(matchesCommandFilter(status, "running")).toBe(status === "queued");
    expect(matchesCommandFilter(status, "attention")).toBe(status === "expired");
  });
});

describe("queue receipt lifecycle", () => {
  it("polls queued → pending → accepted → completed and suppresses duplicate submissions", async () => {
    const statuses = ["pending", "accepted", "completed"] as const;
    let polls = 0;
    const fetchMock = vi.fn(async (url: string) => response(url.includes("/commands/") ? { ...queued, status: statuses[polls++] } : queued));
    vi.stubGlobal("fetch", fetchMock);
    const { result, unmount } = renderHook(() => useSessionMessages(session, vi.fn()));
    act(() => result.current.setDraft("稍后执行"));
    await act(async () => { const first = result.current.submit(); await result.current.submit(); await first; });
    expect(result.current.submission?.command?.status).toBe("queued");
    await act(async () => result.current.submit());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const status of statuses) {
      await act(async () => vi.advanceTimersByTimeAsync(5000));
      expect(result.current.submission?.command?.status).toBe(status);
    }
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(polls).toBe(3);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["cancelled", "expired"] as const)("treats %s as terminal and permits a subsequent explicit request", async status => {
    const fetchMock = vi.fn(async (url: string) => response({ ...queued, status: url.includes("/commands/") ? status : "queued" }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSessionMessages(session, vi.fn()));
    act(() => result.current.setDraft("稍后执行"));
    await act(async () => result.current.submit());
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(result.current.submission?.command?.status).toBe(status);
    expect(result.current.draft).toBe("稍后执行");
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    act(() => result.current.setDraft("新的请求"));
    await act(async () => result.current.submit());
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("cancels only the original queued command through the scoped authenticated endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => response({ ...queued, status: JSON.parse(String(init.body)).cancelCommandId ? "cancelled" : "queued" }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSessionMessages(session, vi.fn()));
    act(() => result.current.setDraft("稍后执行"));
    await act(async () => result.current.submit());
    await act(async () => { const first = result.current.cancel(); await result.current.cancel(); await first; });
    expect(result.current.submission?.command?.status).toBe("cancelled");
    expect(result.current.draft).toBe("稍后执行");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]).toMatchObject(["/v1/sessions/air/session/messages", { method: "POST", credentials: "same-origin", body: JSON.stringify({ cancelCommandId: queued.commandId }), headers: { "X-Super-Leader-Intent": "session-message" } }]);
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403])("reports authorization revocation (%i) without another send", async status => {
    const onAuthFailure = vi.fn();
    const fetchMock = vi.fn(async (url: string) => url.includes("/commands/") ? response({}, status) : response(queued));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSessionMessages(session, onAuthFailure));
    act(() => result.current.setDraft("稍后执行"));
    await act(async () => result.current.submit());
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/messages"))).toHaveLength(1);
  });

  it("rejects a receipt for a different session without allowing a retry send", async () => {
    const fetchMock = vi.fn(async (url: string) => response(url.includes("/commands/") ? { ...queued, sessionId: "other", status: "completed" } : queued));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSessionMessages(session, vi.fn()));
    act(() => result.current.setDraft("稍后执行"));
    await act(async () => result.current.submit());
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(result.current.pollingStopped).toBe(true);
    expect(result.current.submission?.command?.status).toBe("queued");
    await act(async () => result.current.submit());
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/messages"))).toHaveLength(1);
  });

  it("reconciles a lost submission by reading its original request id and never re-POSTs even after 404", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/messages")) throw new Error("connection lost");
      return response({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSessionMessages(session, vi.fn()));
    act(() => result.current.setDraft("稍后执行"));
    await act(async () => result.current.submit());
    const originalId = result.current.submission!.requestId;
    await act(async () => result.current.submit(true));
    expect(fetchMock.mock.calls[1][0]).toBe(`/v1/sessions/air/session/messages/${originalId}`);
    expect(result.current.submission?.uncertain).toBe(true);
    await act(async () => result.current.submit());
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/messages"))).toHaveLength(1);
  });
});
