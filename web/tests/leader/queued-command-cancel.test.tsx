import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeControlPlaneStatus } from "../../src/api/normalizers";
import { subscribeAuthState } from "../../src/auth/bootstrap";
import { CommandsSection } from "../../src/features/leader/components/CommandsSection";
import type { CommandRecord } from "../../src/types";
import { emptyExecutions, emptyGoals } from "../fixtures/status-fixtures";

const queued: CommandRecord = { commandId: "saved-command", requestId: `web_${"a".repeat(64)}`, nodeId: "offline", sessionId: "original", action: "send", prompt: "完成后继续", status: "queued", sendRoute: "control-socket", hasOutput: false, outputPreview: "", outputTruncated: false, createdAt: "2026-10-18T10:00:00Z", updatedAt: "2026-10-18T10:00:00Z", expiresAt: "2026-10-18T10:10:00Z" };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
function snapshot(commands = [queued]) {
  return normalizeControlPlaneStatus({ nodes: [], sessions: [], commands, executions: emptyExecutions(), goals: emptyGoals() }).commands;
}
function view(commands = snapshot()) {
  return <CommandsSection commands={commands} selectedNodeId={null} statusFilter="ALL" onStatusFilterChange={vi.fn()} />;
}
afterEach(() => vi.unstubAllGlobals());

describe("persisted web queue cancellation", () => {
  it("keeps the queued request untouched until explicit confirmation and can dismiss the dialog", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(view());
    fireEvent.click(screen.getByRole("button", { name: "取消排队" }));
    expect(screen.getByRole("dialog", { name: "取消排队消息" })).toBeVisible();
    expect(screen.getByText("仅移除这条尚未发送的消息；如果请求已开始发送，将无法取消。")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保留" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByTestId(`command-status-${queued.commandId}`)).toHaveTextContent("等待发送");
  });

  it("can cancel a persisted Web queue after remount from status alone, without a loaded session or original draft", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => response({ ...queued, status: "cancelled" }));
    vi.stubGlobal("fetch", fetchMock);
    const page = render(view());
    page.unmount();
    render(view(snapshot()));
    expect(screen.getByRole("button", { name: "取消排队" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "取消排队" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "确认取消排队" })));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toMatchObject(["/v1/sessions/offline/original/messages", {
      method: "POST", credentials: "same-origin", body: JSON.stringify({ cancelCommandId: queued.commandId }),
      headers: { "Content-Type": "application/json", "X-Super-Leader-Intent": "session-message" },
    }]);
    expect(screen.getByTestId(`command-status-${queued.commandId}`)).toHaveTextContent("已取消");
    expect(screen.queryByRole("button", { name: "取消排队" })).toBeNull();
  });

  it("does not claim cancellation when another login is rejected and never resubmits the prompt", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => response({}, 409));
    vi.stubGlobal("fetch", fetchMock);
    render(view());
    fireEvent.click(screen.getByRole("button", { name: "取消排队" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "确认取消排队" })));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("请求已开始发送，或不属于当前登录");
    expect(screen.getByTestId(`command-status-${queued.commandId}`)).toHaveTextContent("等待发送");
    expect(screen.queryByText("已取消", { selector: ".status-badge" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ cancelCommandId: queued.commandId });
  });

  it("only offers cancellation for queued Web sends, leaving chat, plans, unknown and terminal records unclaimed", () => {
    render(view(snapshot([
      { ...queued, commandId: "chat", requestId: "chat-request" },
      { ...queued, commandId: "plan", requestId: "plan_step_uuid" },
      { ...queued, commandId: "malformed", requestId: "web_short" },
      { ...queued, commandId: "unknown", status: "uncertain" },
      { ...queued, commandId: "accepted", status: "accepted" },
      { ...queued, commandId: "read", action: "read", sendRoute: undefined },
    ])));
    expect(screen.queryByRole("button", { name: "取消排队" })).toBeNull();
  });

  it("locks duplicate clicks while cancellation is pending", async () => {
    let resolve!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal("fetch", fetchMock);
    render(view());
    fireEvent.click(screen.getByRole("button", { name: "取消排队" }));
    fireEvent.click(screen.getByRole("button", { name: "确认取消排队" }));
    fireEvent.click(screen.getByRole("button", { name: "正在保存…" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => resolve(response({ ...queued, status: "cancelled" })));
    expect(screen.queryByRole("button", { name: "正在保存…" })).toBeNull();
  });

  it("rejects a mismatched cancellation receipt without changing the displayed command", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ ...queued, sessionId: "other", status: "cancelled" })));
    render(view());
    fireEvent.click(screen.getByRole("button", { name: "取消排队" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "确认取消排队" })));
    expect(screen.getByRole("alert")).toHaveTextContent("取消结果尚未确认");
    expect(screen.getByTestId(`command-status-${queued.commandId}`)).toHaveTextContent("等待发送");
  });

  it("expires the authenticated page when cancellation authorization is revoked", async () => {
    const subscriber = vi.fn();
    const unsubscribe = subscribeAuthState(subscriber);
    try {
      vi.stubGlobal("fetch", vi.fn(async () => response({}, 401)));
      render(view());
      fireEvent.click(screen.getByRole("button", { name: "取消排队" }));
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "确认取消排队" })));
      expect(subscriber).toHaveBeenCalledWith({ status: "unauthenticated", reason: "expired" });
    } finally { unsubscribe(); }
  });
});
