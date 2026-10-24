import { emptyGoals, emptyExecutions  } from "../fixtures/status-fixtures";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeControlPlaneStatus } from "../../src/api/normalizers";
import { SessionWorkspace } from "../../src/features/sessions/components/SessionWorkspace";
import { sendBlockReason } from "../../src/features/sessions/useSessionMessages";
import { isSessionMessageTarget, normalizeSendAvailability, sessionSendBlockReason } from "../../src/features/sessions/send-availability";
import type { DesktopObservation, ScopedSession, SendAvailability } from "../../src/types";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const NODE_IDS = ["mac.mini", "mac-mini_1", "mac mini~主机", "mac/mini", "mac\\mini", "mac%2Fmini", "mac?mini#leaf", "m".repeat(64)];
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
const ready = (overrides: Partial<Extract<SendAvailability, { route: "desktop-owner" }>> = {}): SendAvailability => ({
  route: "desktop-owner", state: "ready", observedAt: iso(), validUntil: iso(45_000), ...overrides,
});
const observation = (overrides: Partial<DesktopObservation> = {}): DesktopObservation => ({
  source: "codex-desktop", availability: "available", status: "idle", observedAt: iso(), ...overrides,
});
const native: ScopedSession = {
  id: "fixture", nodeId: "air", provider: "codex-app", title: "原会话", cwd: "/fixture", model: "gpt-6.1-sol",
  status: "idle", loaded: true, capabilities: ["read", "send"], observedAt: iso(),
};
const desktop = (overrides: Partial<ScopedSession> = {}): ScopedSession => ({
  ...native, status: "notLoaded", loaded: false, capabilities: ["read"], observedAt: iso(-90_000),
  sendAvailability: ready(), desktopObservation: observation(), ...overrides,
});
const nodes = [{ nodeId: "air", connected: true, sessionCount: 1, lastHeartbeat: iso(), inferredOffline: false }];
const command = { commandId: "desktop-command", requestId: "request", nodeId: "air", sessionId: "fixture",
  action: "send", status: "completed", sendRoute: "desktop-owner", turnId: "native-turn", output: "ok",
  createdAt: iso(), updatedAt: iso(), expiresAt: iso(60_000) };
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const normalize = (raw: unknown) => normalizeControlPlaneStatus({ nodes, sessions: [raw], commands: [], goals: emptyGoals(), executions: emptyExecutions() }).sessions[0];

describe("send qualification contract", () => {
  it.each([...NODE_IDS, " ", "🖥".repeat(32)])("accepts opaque command node ID %s without rewriting it", nodeId => {
    const session = desktop({ nodeId });
    expect(isSessionMessageTarget(session)).toBe(true);
    expect(sendBlockReason(session, true, false, NOW)).toBeNull();
    expect(sendBlockReason(session, false, false, NOW)).toBeNull();
    expect(session.nodeId).toBe(nodeId);
  });

  it.each([
    { nodeId: "" }, { nodeId: "m".repeat(65) }, { nodeId: "🖥".repeat(33) },
    { id: "fixture.with-dot" }, { id: "fixture/other" }, { id: "fixture other" }, { id: "s".repeat(65) },
    { id: `terminal:${"a".repeat(42)}` }, { id: `terminal:${"a".repeat(42)}.` },
  ])("keeps command length and session ID boundaries %#", changes => {
    const session = desktop({ nodeId: "mac.mini", ...changes });
    expect(isSessionMessageTarget(session)).toBe(false);
    expect(sendBlockReason(session, true, false, NOW)).toContain("会话目标无效");
  });

  it("preserves the terminal input target format on opaque nodes", () => {
    expect(isSessionMessageTarget(desktop({ nodeId: "mac.mini", id: `terminal:${"a".repeat(43)}` }))).toBe(true);
  });

  it("permits a qualified desktop without rewriting native loaded/status/capabilities or time", () => {
    const raw = desktop();
    const before = structuredClone(raw);
    expect(sessionSendBlockReason(normalize(raw), NOW)).toBeNull();
    expect(raw).toEqual(before);
    expect(normalize(raw)).toMatchObject({ loaded: false, status: "notLoaded", capabilities: ["read"], observedAt: iso(-90_000) });
    expect(sessionSendBlockReason(desktop({ desktopObservation: undefined }), NOW)).toBeNull();
  });

  it.each([
    null, [], false, {}, { ...ready(), route: "control-socket" }, { ...ready(), observedAt: "now" },
    { ...ready(), observedAt: "2026-02-30T12:00:00Z" }, { ...ready(), validUntil: "2026-10-11T24:00:00Z" },
    { ...ready(), reason: "unknown" }, { ...ready(), state: "yes" }, { ...ready(), extra: true },
  ])("retains invalid present availability as denial, never native fallback %#", bad => {
    const value = normalize({ ...native, sendAvailability: bad });
    expect(value.sendAvailability).toBeDefined();
    expect(sessionSendBlockReason(value, NOW)).not.toBeNull();
  });

  it.each([
    ready({ observedAt: iso(1) }), ready({ validUntil: iso() }), ready({ validUntil: iso(45_001) }),
    ready({ validUntil: iso(-1) }), ready({ state: "blocked", reason: "busy" }),
    ready({ state: "unavailable", reason: "checking" }), ready({ state: "blocked", reason: "preflight-rejected" }),
  ])("rejects time anomalies and blocked routes despite native readiness %#", availability => {
    expect(sessionSendBlockReason({ ...native, sendAvailability: availability }, NOW)).not.toBeNull();
  });

  it("uses an exclusive validUntil boundary and preserves native freshness boundaries", () => {
    expect(sessionSendBlockReason(desktop(), NOW + 44_999)).toBeNull();
    expect(sessionSendBlockReason(desktop(), NOW + 45_000)).not.toBeNull();
    expect(sessionSendBlockReason(native, NOW + 45_000)).toBeNull();
    expect(sessionSendBlockReason(native, NOW + 45_001)).not.toBeNull();
    expect(sessionSendBlockReason(native, NOW - 1)).not.toBeNull();
    expect(normalizeSendAvailability(undefined)).toBeUndefined();
  });

  it.each([
    null, {}, { ...observation(), source: "invalid" }, observation({ status: "active" }),
    observation({ status: "unknown" }), observation({ observedAt: undefined }),
    observation({ availability: "unavailable" }), observation({ observedAt: iso(-45_001) }),
    observation({ observedAt: iso(1) }), observation({ observedAt: "invalid" }),
  ])("existing unusable desktop observation vetoes ready, including after normalization %#", obs => {
    const raw = { ...desktop(), desktopObservation: obs };
    expect(sessionSendBlockReason(raw as ScopedSession, NOW)).not.toBeNull();
    expect(sessionSendBlockReason(normalize(raw), NOW)).not.toBeNull();
  });

  it.each([
    { loaded: undefined }, { loaded: false }, { status: "active" }, { status: "notLoaded" },
    { capabilities: [] }, { observedAt: "now" }, { observedAt: "2026-02-30T12:00:00Z" },
  ])("requires complete native evidence when availability is absent %#", changes => {
    expect(sessionSendBlockReason({ ...native, ...changes }, NOW)).not.toBeNull();
  });

  it("allows qualified offline queueing while preserving stale inventory denial", () => {
    expect(sendBlockReason(desktop(), false, false, NOW)).toBeNull();
    expect(sendBlockReason(desktop(), true, true, NOW)).toContain("待更新");
  });
});

describe("workspace send route feedback", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  function setup(session = desktop(), onSend?: () => Promise<Response>) {
    const targetNodes = [{ ...nodes[0], nodeId: session.nodeId }];
    const targetCommand = { ...command, nodeId: session.nodeId, sessionId: session.id };
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/messages")) return onSend ? onSend() : response(targetCommand);
      if (url.includes("/commands/")) return response(targetCommand);
      return response({ session, historyContext: "cf7e282f-d6d2-4a98-a517-9fb753f2549b", source: "control-socket", fetchedAt: iso(), items: [], nextCursor: null, truncated: false });
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = render(<SessionWorkspace data={{ nodes: targetNodes, sessions: [session], commands: [], goals: emptyGoals(), executions: emptyExecutions() }}
      nodes={targetNodes} stale={false} onAuthFailure={vi.fn()} />);
    fireEvent.click(screen.getByTestId(`session-row-${session.nodeId}-${session.id}`));
    fireEvent.change(screen.getByLabelText("发送给当前会话"), { target: { value: "继续原会话" } });
    return { ...result, fetchMock };
  }
  const sendCalls = (mock: ReturnType<typeof setup>["fetchMock"]) => mock.mock.calls.filter(([url]) => url.endsWith("/messages"));

  it.each(NODE_IDS)("sends once to encoded opaque node %s and accepts its unchanged receipt", async nodeId => {
    const { fetchMock } = setup(desktop({ nodeId }));
    const send = screen.getByRole("button", { name: "发送消息" });
    expect(send).toBeEnabled();
    await act(async () => fireEvent.click(send));
    const calls = sendCalls(fetchMock);
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0];
    expect(url).toBe(`/v1/sessions/${encodeURIComponent(nodeId)}/fixture/messages`);
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-Super-Leader-Intent": "session-message" } });
    expect(JSON.parse(String(init?.body))).toEqual({ prompt: "继续原会话", requestId: expect.any(String) });
    expect(screen.getByText("执行完成 (Completed)")).toBeInTheDocument();
    expect(screen.getByLabelText("发送给当前会话")).toHaveValue("");
  });

  it.each([
    { nodeId: "m".repeat(65) }, { id: "fixture.with-dot" }, { id: "fixture/other" }, { id: "fixture other" },
  ])("blocks invalid targets at both button and Enter without posting %#", async changes => {
    const { fetchMock } = setup(desktop({ nodeId: "mac.mini", ...changes }));
    const send = screen.getByRole("button", { name: "发送消息" });
    expect(send).toBeDisabled();
    await act(async () => {
      fireEvent.click(send);
      fireEvent.keyDown(screen.getByLabelText("发送给当前会话"), { key: "Enter" });
    });
    expect(sendCalls(fetchMock)).toHaveLength(0);
    expect(screen.getByLabelText("发送给当前会话")).toHaveValue("继续原会话");
  });

  it("enables ready desktop and displays the persisted route in its receipt", async () => {
    const { fetchMock } = setup();
    fireEvent.click(screen.getByRole("button", { name: "会话详情" }));
    expect(screen.queryByText("控制接口：未加载")).toBeNull();
    expect(screen.getByText("通过原会话发送，保留会话设置。")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭会话详情" }));
    const send = screen.getByRole("button", { name: "发送消息" });
    expect(send).toBeEnabled();
    expect(send).toHaveAccessibleDescription("Enter 发送 · Shift + Enter 换行");
    await act(async () => fireEvent.click(send));
    expect(sendCalls(fetchMock)).toHaveLength(1);
    expect(screen.getByText("发送通道：原桌面会话")).toBeInTheDocument();
    expect(screen.getByText("执行完成 (Completed)")).toBeInTheDocument();
  });

  it.each([
    { state: "blocked" as const, reason: "checking" as const },
    { state: "unavailable" as const, reason: "unavailable" as const },
  ])("accepts a queued submission while a freshly idle owner's preflight is $state/$reason", async availability => {
    const checking = desktop({ sendAvailability: ready({ ...availability,
      observedAt: "1970-01-01T00:00:00Z", validUntil: "1970-01-01T00:00:00Z" }) });
    const { fetchMock } = setup(checking, async () => response({ ...command, status: "queued", turnId: undefined, output: undefined }));
    const send = screen.getByRole("button", { name: "发送消息" });
    expect(send).toBeEnabled();
    await act(async () => fireEvent.click(send));
    expect(sendCalls(fetchMock)).toHaveLength(1);
    expect(screen.getByText("发送通道：原桌面会话")).toBeInTheDocument();
    expect(screen.getByLabelText("发送给当前会话")).toHaveValue("");
    expect(screen.queryByText("执行完成 (Completed)")).toBeNull();
  });

  it("expires readiness locally without waiting for a heartbeat and retains the draft", async () => {
    const { fetchMock, unmount } = setup(desktop({ sendAvailability: ready({ validUntil: iso(1000) }) }));
    expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled();
    await act(async () => vi.advanceTimersByTimeAsync(1001));
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
    expect(screen.getByText("发送资格已过期或时间异常，等待自动更新")).toBeInTheDocument();
    expect(screen.getByLabelText("发送给当前会话")).toHaveValue("继续原会话");
    expect(sendCalls(fetchMock)).toHaveLength(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["button", "enter"])("rechecks at %s gesture even if expiry timer has not fired", async method => {
    const { fetchMock } = setup();
    await act(async () => {});
    vi.setSystemTime(NOW + 45_001); // Move clock without running background-tab timers.
    expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled();
    if (method === "button") fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    else fireEvent.keyDown(screen.getByLabelText("发送给当前会话"), { key: "Enter" });
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
    expect(sendCalls(fetchMock)).toHaveLength(0);
  });

  it("does not replay an unknown request after delayed expiry but keeps its draft", async () => {
    const { fetchMock } = setup(desktop(), () => Promise.reject(new Error("network")));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送消息" })));
    expect(sendCalls(fetchMock)).toHaveLength(1);
    vi.setSystemTime(NOW + 45_001);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "核查发送状态" })));
    expect(sendCalls(fetchMock)).toHaveLength(1);
    expect(screen.getByLabelText("发送给当前会话")).toHaveValue("继续原会话");
  });

  it("allows read-only receipt reconciliation after qualification expires, without another POST", async () => {
    const { fetchMock } = setup(desktop(), () => Promise.resolve(response({ ...command, status: "uncertain" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送消息" })));
    vi.setSystemTime(NOW + 45_001);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "核查发送状态" })));
    expect(sendCalls(fetchMock)).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("/commands/"))).toHaveLength(1);
    expect(screen.getByText("发送通道：原桌面会话")).toBeInTheDocument();
    expect(screen.getByText("执行完成 (Completed)")).toBeInTheDocument();
  });
});
