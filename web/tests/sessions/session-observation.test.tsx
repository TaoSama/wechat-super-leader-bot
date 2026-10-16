import { emptyGoals, emptyExecutions  } from "../fixtures/status-fixtures";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeControlPlaneStatus } from "../../src/api/normalizers";
import { SessionWorkspace } from "../../src/features/sessions/components/SessionWorkspace";
import { sendBlockReason } from "../../src/features/sessions/useSessionMessages";
import { describeDesktopObservation, MAX_DESKTOP_OBSERVATION_AGE_MS, normalizeDesktopObservation, selectExecutionObservation } from "../../src/features/sessions/session-observation";
import type { DesktopObservation, ScopedSession } from "../../src/types";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
const desktop = (overrides: Partial<DesktopObservation> = {}): DesktopObservation => ({
  status: "active", availability: "available", source: "codex-desktop", observedAt: iso(), ...overrides,
});
const session = (status = "notLoaded", observation?: DesktopObservation): ScopedSession => ({
  id: "session", nodeId: "node", provider: "codex-app", title: "工作会话", cwd: "/fixture", status,
  loaded: false, capabilities: ["read"], observedAt: iso(-1000), desktopObservation: observation,
});
const nodes = [{ nodeId: "node", connected: true, inferredOffline: false, sessionCount: 1, lastHeartbeat: iso() }];
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("read-only desktop display selection", () => {
  it.each([
    ["notLoaded", desktop(), "active", "codex-desktop"],
    ["unknown", desktop({ status: "idle" }), "idle", "codex-desktop"],
    ["notLoaded", desktop({ observedAt: iso(-MAX_DESKTOP_OBSERVATION_AGE_MS) }), "active", "codex-desktop"],
    ["notLoaded", desktop({ availability: "unavailable" }), "notLoaded", "control-socket"],
    ["unknown", desktop({ observedAt: iso(-MAX_DESKTOP_OBSERVATION_AGE_MS - 1) }), "unknown", "control-socket"],
    ["notLoaded", desktop({ observedAt: iso(1) }), "notLoaded", "control-socket"],
    ["notLoaded", desktop({ observedAt: undefined }), "notLoaded", "control-socket"],
    ["notLoaded", desktop({ status: "unknown" }), "notLoaded", "control-socket"],
    ["unknown", undefined, "unknown", "control-socket"],
    ["notLoaded", undefined, "notLoaded", "control-socket"],
    ["active", desktop({ status: "idle" }), "active", "control-socket"],
    ["busy", desktop({ status: "idle" }), "busy", "control-socket"],
    ["running", desktop({ status: "idle" }), "running", "control-socket"],
    ["idle", desktop(), "idle", "control-socket"],
  ] as const)("selects %s without granting send %#", (status, observation, expected, source) => {
    const raw = session(status, observation);
    const original = structuredClone(raw);
    expect(selectExecutionObservation(raw, NOW)).toEqual({ executionStatus: expected, statusSource: source });
    expect(sendBlockReason(raw, true, false)).toContain("暂时只读");
    expect(raw).toEqual(original);
  });

  it("normalizes only the frozen desktop fields without touching control status", () => {
    const raw = session("notLoaded", desktop());
    const normalized = normalizeControlPlaneStatus({ nodes, sessions: [raw], commands: [], goals: emptyGoals(), executions: emptyExecutions() }).sessions[0];
    expect(normalized).toMatchObject(raw);
    for (const bad of [{ ...desktop(), availability: "offline" }, { ...desktop(), source: "other" },
      { ...desktop(), status: "busy" }, desktop({ observedAt: "now" }),
      desktop({ observedAt: "2026-02-30T12:00:00Z" }), desktop({ observedAt: "2026-10-11T24:00:00Z" })]) {
      expect(normalizeDesktopObservation(bad)).toBeUndefined();
    }
    expect(normalizeDesktopObservation({ ...desktop(), privateField: "discard" })).toEqual(desktop());
  });

  it.each([
    { connected: false, stale: false, loaded: true, reason: "机器离线" },
    { connected: true, stale: true, loaded: true, reason: "状态待更新" },
    { connected: true, stale: false, loaded: false, reason: "暂时只读" },
  ])("keeps transport and control send restrictions despite desktop idle %#", ({ connected, stale, loaded, reason }) => {
    const raw: ScopedSession = { ...session("idle", desktop({ status: "idle" })), loaded, capabilities: ["read", "send"] };
    expect(selectExecutionObservation(raw, NOW)).toEqual({ executionStatus: "idle", statusSource: "control-socket" });
    expect(sendBlockReason(raw, connected, stale)).toContain(reason);
  });

  it.each([
    [desktop({ availability: "unavailable" }), "已失联"],
    [desktop({ observedAt: iso(-45001) }), "观测已过期"],
    [desktop({ observedAt: iso(1) }), "观测时间异常"],
    [desktop({ observedAt: undefined }), "未取得观测时间"],
  ])("explains unusable desktop evidence %#", (observation, message) => {
    expect(describeDesktopObservation(observation as DesktopObservation, NOW)).toContain(message);
  });
});

describe("workspace desktop observations", () => {
  it.each(["active", "idle"] as const)("shows desktop %s in list and detail while retaining read-only send", status => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const raw = session("notLoaded", desktop({ status }));
    render(<SessionWorkspace data={{ nodes, sessions: [raw], commands: [], goals: emptyGoals(), executions: emptyExecutions() }} nodes={nodes} stale={false}
      active={false} onAuthFailure={vi.fn()} />);
    const row = screen.getByTestId("session-row-node-session");
    expect(row.querySelector(".session-state")).toHaveTextContent(status === "active" ? "执行中" : "空闲");
    expect(row.querySelector(".session-observation")).toBeNull();
    expect(row.children).toHaveLength(3);
    fireEvent.click(row);
    expect(document.querySelector(".detail-title .status-label")).toHaveTextContent(status === "active" ? "执行中" : "空闲");
    fireEvent.click(screen.getByRole("button", { name: "会话详情" }));
    expect(screen.getByText("控制接口：未加载")).toBeInTheDocument();
    expect(screen.getByText("桌面观测", { exact: false, selector: ".detail-subline > span" })).toHaveTextContent("2026-10-11");
    fireEvent.click(screen.getByRole("button", { name: "关闭会话详情" }));
    fireEvent.change(screen.getByLabelText("发送给当前会话"), { target: { value: "不会发送" } });
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
    expect(raw).toMatchObject({ status: "notLoaded", loaded: false, capabilities: ["read"], observedAt: iso(-1000) });
  });

  it("reports desktop loss while retaining the raw control state", () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    render(<SessionWorkspace data={{ nodes, sessions: [session("notLoaded", desktop({ availability: "unavailable" }))], commands: [], goals: emptyGoals(), executions: emptyExecutions() }}
      nodes={nodes} stale={false} active={false} onAuthFailure={vi.fn()} />);
    const row = screen.getByTestId("session-row-node-session");
    expect(within(row).getByText("未加载")).toBeInTheDocument();
    expect(row).toHaveTextContent("桌面已失联");
  });

  it.each([
    [desktop({ availability: "unavailable" }), "桌面已失联"],
    [desktop({ observedAt: iso(-45001) }), "桌面观测已过期"],
    [desktop({ observedAt: iso(1) }), "桌面观测时间异常"],
    [desktop({ observedAt: undefined }), "桌面观测时间缺失"],
    [desktop({ status: "unknown" }), "桌面状态未知"],
  ] as const)("异常观测在列表中只显示简短原因，完整时间与说明在详情中 %#", (observation, label) => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const raw = session("notLoaded", observation);
    render(<SessionWorkspace data={{ nodes, sessions: [raw], commands: [], goals: emptyGoals(), executions: emptyExecutions() }}
      nodes={nodes} stale={false} active={false} onAuthFailure={vi.fn()} />);
    const row = screen.getByTestId("session-row-node-session");
    expect(row.querySelector(".session-observation")?.textContent).toBe(label);
    fireEvent.click(row);
    fireEvent.click(screen.getByRole("button", { name: "会话详情" }));
    expect(within(screen.getByRole("dialog")).getByText(describeDesktopObservation(observation, NOW)!)).toBeVisible();
  });

  it("expires desktop status after 45 seconds even without a new status event", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { unmount } = render(<SessionWorkspace data={{ nodes, sessions: [session("notLoaded", desktop())], commands: [], goals: emptyGoals(), executions: emptyExecutions() }}
      nodes={nodes} stale={false} onAuthFailure={vi.fn()} />);
    const row = screen.getByTestId("session-row-node-session");
    expect(row.querySelector(".session-state")).toHaveTextContent("执行中");
    await act(async () => { await vi.advanceTimersByTimeAsync(MAX_DESKTOP_OBSERVATION_AGE_MS); });
    expect(row.querySelector(".session-state")).toHaveTextContent("执行中");
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(row.querySelector(".session-state")).toHaveTextContent("未加载");
    expect(row).toHaveTextContent("观测已过期");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires successive desktop observations with one timer and clears it on deactivation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const first = { ...session("notLoaded", desktop({ observedAt: iso(-1000) })), id: "first" };
    const second = { ...session("notLoaded", desktop()), id: "second" };
    const data = { nodes, sessions: [first, second], commands: [], goals: emptyGoals(), executions: emptyExecutions() };
    const { rerender, unmount } = render(<SessionWorkspace data={data} nodes={nodes} stale={false} onAuthFailure={vi.fn()} />);
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(MAX_DESKTOP_OBSERVATION_AGE_MS - 999); });
    expect(screen.getByTestId("session-row-node-first").querySelector(".session-state")).toHaveTextContent("未加载");
    expect(screen.getByTestId("session-row-node-second").querySelector(".session-state")).toHaveTextContent("执行中");
    expect(vi.getTimerCount()).toBe(1);
    rerender(<SessionWorkspace data={data} nodes={nodes} stale={false} active={false} onAuthFailure={vi.fn()} />);
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    rerender(<SessionWorkspace data={data} nodes={nodes} stale={false} active={true} onAuthFailure={vi.fn()} />);
    expect(screen.getByTestId("session-row-node-second").querySelector(".session-state")).toHaveTextContent("未加载");
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  });
});
