import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeCommand, normalizeSession } from "../../src/api/normalizers";
import { canResumeSession, sendRouteLabel, sessionSendBlockReason } from "../../src/features/sessions/send-availability";
import { sendBlockReason } from "../../src/features/sessions/useSessionMessages";
import { SessionWorkspace } from "../../src/features/sessions/components/SessionWorkspace";
import { emptyExecutions, emptyGoals } from "../fixtures/status-fixtures";
import type { ScopedSession } from "../../src/types";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
const session: ScopedSession = { id: "original", nodeId: "air", provider: "codex-app", title: "原会话", cwd: "/fixture",
  status: "notLoaded", loaded: false, capabilities: ["read", "resume-send"], observedAt: iso() };
const nodes = [{ nodeId: "air", connected: true, sessionCount: 1, lastHeartbeat: iso(), inferredOffline: false }];

describe("explicit managed resume capability", () => {
  it("preserves capability and native facts while separating recovery from desktop ready", () => {
    const parsed = normalizeSession(session)!;
    expect(parsed).toMatchObject({ status: "notLoaded", loaded: false, capabilities: ["read", "resume-send"] });
    expect(parsed.sendAvailability).toBeUndefined();
    expect(sessionSendBlockReason(parsed, NOW)).toBeNull();
    expect(sessionSendBlockReason({ ...parsed, status: "idle" }, NOW)).toBeNull();
    expect(sendRouteLabel("app-server-resume")).toContain("执行时检查占用");
    expect(sendBlockReason(parsed, false, false, NOW)).toBeNull();
    expect(sendBlockReason(parsed, true, true, NOW)).toContain("待更新");
  });

  it.each([{ loaded: true }, { loaded: undefined }, { status: "active" }, { status: "unknown" },
    { capabilities: ["read"] }, { observedAt: iso(-45001) }, { observedAt: iso(1) },
    { provider: "terminal/codex", id: "terminal:fixture" }])("requires fresh managed unloaded native evidence %#", changes => {
    expect(sessionSendBlockReason({ ...session, ...changes } as ScopedSession, NOW)).not.toBeNull();
  });

  it.each(["idle", "active", "unknown"] as const)("does not resume over a freshly available desktop owner: %s", status => {
    expect(canResumeSession({ ...session, desktopObservation: {
      source: "codex-desktop", availability: "available", status, observedAt: iso(),
    } }, NOW)).toBe(false);
  });

  it("allows explicit recovery after desktop loss, while malformed proof remains denied", () => {
    const unavailable = { route: "desktop-owner", state: "unavailable", reason: "unavailable", observedAt: iso(), validUntil: iso(45000) };
    const parsed = normalizeSession({ ...session, sendAvailability: unavailable,
      desktopObservation: { source: "codex-desktop", availability: "unavailable", status: "unknown" } })!;
    expect(sessionSendBlockReason(parsed, NOW)).toBeNull();
    expect(sessionSendBlockReason(normalizeSession({ ...session, sendAvailability: {} })!, NOW)).not.toBeNull();
    expect(sessionSendBlockReason(normalizeSession({ ...session, desktopObservation: {} })!, NOW)).not.toBeNull();
    const ready = { ...unavailable, state: "ready", reason: undefined };
    expect(canResumeSession(normalizeSession({ ...session, sendAvailability: ready })!, NOW)).toBe(false);
  });

  it("preserves resume route in persisted command receipts", () => {
    expect(normalizeCommand({ commandId: "c", nodeId: "air", sessionId: "original", action: "send",
      status: "accepted", sendRoute: "app-server-resume", turnId: "t" })?.sendRoute).toBe("app-server-resume");
  });
});

describe("resume composer semantics", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("shows unloaded facts and conditional recovery, then expires locally without sending", async () => {
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ session, historyContext: "cf7e282f-d6d2-4a98-a517-9fb753f2549b",
      source: "control-socket", fetchedAt: iso(), items: [], nextCursor: null, truncated: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<SessionWorkspace data={{ nodes, sessions: [session], commands: [], goals: emptyGoals(), executions: emptyExecutions() }}
      nodes={nodes} stale={false} onAuthFailure={vi.fn()} />);
    fireEvent.click(screen.getByTestId("session-row-air-original"));
    fireEvent.change(screen.getByLabelText("发送给当前会话"), { target: { value: "继续" } });
    await act(async () => {});
    expect(screen.queryByText("未加载")).toBeNull();
    expect(screen.getAllByRole("img", { name: "状态未知" })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "会话详情" }));
    expect(screen.getByText("会话需要时会自动恢复，发送前检查是否正在使用。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "关闭会话详情" }));
    expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled();
    await act(async () => vi.advanceTimersByTimeAsync(45001));
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/messages"))).toHaveLength(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
