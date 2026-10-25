import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionWorkspace } from "../../src/features/sessions/components/SessionWorkspace";
import { sessionStatusLabel } from "../../src/features/sessions/components/SessionStatus";
import { selectExecutionObservation } from "../../src/features/sessions/session-observation";
import { selectModelObservation } from "../../src/features/sessions/model-observation";
import { sessionSendBlockReason } from "../../src/features/sessions/send-availability";
import { TERMINAL_READ_ONLY_REASON } from "../../src/features/sessions/terminal-session";
import type { ScopedSession } from "../../src/types";
import { emptyGoals, emptyExecutions  } from "../fixtures/status-fixtures";

const now = Date.parse("2026-10-12T12:00:00Z");
const terminal: ScopedSession = { id: `terminal:${"a".repeat(43)}`, nodeId: "fixture", provider: "terminal/claude",
  title: "终端测试", cwd: "/fixture", status: "blocked", loaded: false, capabilities: ["read"], observedAt: new Date(now).toISOString() };
const nodes = [{ nodeId: "fixture", connected: true, sessionCount: 1, lastHeartbeat: terminal.observedAt, inferredOffline: false }];

describe("terminal observation workspace", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it.each([["done", "已完成"], ["error", "错误"], ["awaiting_input", "等待输入"], ["notLoaded", "未加载"]] as const)(
    "exposes an explicit detail label for %s", (status, label) => {
      expect(sessionStatusLabel(status)).toBe(label);
    });
  it.each([{ ...terminal }, { ...terminal, provider: "codex-app" }, { ...terminal, id: "foreign" }])(
    "never grants send from forged native or desktop metadata %#", value => {
      const forged: ScopedSession = { ...value, status: "idle", loaded: true, capabilities: ["read", "send"], model: "not-evidence",
        sendAvailability: { route: "desktop-owner", state: "ready", observedAt: terminal.observedAt, validUntil: new Date(now + 45000).toISOString() },
        desktopObservation: { source: "codex-desktop", availability: "available", status: "active", observedAt: terminal.observedAt, model: "also-not-evidence" } };
      expect(sessionSendBlockReason(forged, now)).toBe(TERMINAL_READ_ONLY_REASON);
      expect(selectModelObservation(forged, now)).toEqual({ source: "unknown" });
      expect(selectExecutionObservation(forged, now)).toEqual({ executionStatus: "idle", statusSource: "terminal" });
      expect(selectExecutionObservation(forged, now + 45001)).toEqual({ executionStatus: "unknown", statusSource: "terminal" });
    });
  it("shows snapshot limits without history requests, retries or send access; expires status locally", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("Terminal view must not request history")));
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<SessionWorkspace data={{ nodes, sessions: [terminal], commands: [], goals: emptyGoals(), executions: emptyExecutions() }}
      nodes={nodes} stale={false} onAuthFailure={vi.fn()} />);
    const row = screen.getByTestId(`session-row-fixture-${terminal.id}`);
    expect(within(row).getByText("等")).toBeInTheDocument();
    fireEvent.click(row);
    expect(screen.getByText("需要回复")).toBeInTheDocument();
    expect(document.querySelector(".detail-title .session-status-dot")).toHaveAccessibleName("需要回复");
    expect(screen.getByLabelText("终端观测说明")).toHaveTextContent("不是完整对话记录");
    expect(screen.getByText(TERMINAL_READ_ONLY_REASON)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "刷新会话历史" })).not.toBeInTheDocument();
    expect(screen.queryByText("正在准备会话历史")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("发送给当前会话"), { target: { value: "不可发送" } });
    fireEvent.keyDown(screen.getByLabelText("发送给当前会话"), { key: "Enter" });
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
    await act(async () => vi.advanceTimersByTimeAsync(45001));
    expect(within(row).getByText("未知")).toBeInTheDocument();
    expect(document.querySelector(".detail-title .session-status-dot")).toHaveAccessibleName("状态未知");
    expect(screen.queryByText("需要回复")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
