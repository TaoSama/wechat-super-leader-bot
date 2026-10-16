import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionWorkspace } from "../../src/features/sessions/components/SessionWorkspace";
import { MOBILE_SESSION_QUERY } from "../../src/features/sessions/useSessionNavigation";
import { emptyExecutions, emptyGoals } from "../fixtures/status-fixtures";
import type { ScopedSession } from "../../src/types";
import { StrictMode } from "react";
import { SessionDetails } from "../../src/features/sessions/components/SessionDetails";
import { sessionKey } from "../../src/features/sessions/useSessionHistory";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const iso = new Date(NOW).toISOString();
const session: ScopedSession = { id: "original", nodeId: "air", provider: "codex-app", title: "继续原会话", cwd: "/workspace/project",
  status: "idle", loaded: true, capabilities: ["read", "send"], model: "gpt-6.1-sol", preview: "已经定位到下一步", observedAt: iso };
const nodes = [{ nodeId: "air", connected: true, sessionCount: 1, lastHeartbeat: iso, inferredOffline: false }];
const data = { nodes, sessions: [session], commands: [], goals: emptyGoals(), executions: emptyExecutions() };
let mobile = true;
let fetchMock: ReturnType<typeof vi.fn>;

function workspace(onDetailVisibilityChange = vi.fn()) {
  return render(<SessionWorkspace data={data} nodes={nodes} stale={false} onAuthFailure={vi.fn()} onDetailVisibilityChange={onDetailVisibilityChange} />);
}
async function openSession() {
  fireEvent.click(screen.getByTestId("session-row-air-original"));
  await screen.findByText("原会话历史");
}
function sends() { return fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/messages")); }

beforeEach(() => {
  mobile = true;
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  window.history.replaceState({ existing: { keep: true } }, "", "/?entry=preserved#workspace");
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: query === MOBILE_SESSION_QUERY && mobile,
    media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/messages") ? {
    commandId: "command", nodeId: session.nodeId, sessionId: session.id, action: "send", status: "accepted", sendRoute: "desktop-owner",
    createdAt: iso, updatedAt: iso, expiresAt: iso,
  } : { session, historyContext: "cf7e282f-d6d2-4a98-a517-9fb753f2549b", source: "control-socket", fetchedAt: iso,
    items: [{ id: "message", turnId: "turn", type: "agentMessage", kind: "assistant", text: "原会话历史" }], nextCursor: null, truncated: false }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("mobile workspace navigation and composing", () => {
  it("挂载保留当前焦点，手机打开详情与返回列表才转移焦点", async () => {
    render(<><button autoFocus>工作区入口</button><SessionWorkspace data={data} nodes={nodes} stale={false} onAuthFailure={vi.fn()} /></>);
    expect(screen.getByRole("button", { name: "工作区入口" })).toHaveFocus();
    await openSession();
    expect(screen.getByRole("heading", { name: session.title })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "返回会话列表" }));
    expect(screen.getByTestId("session-row-air-original")).toHaveFocus();
    await waitFor(() => expect(window.history.state.superLeaderSessionWorkspace).toBeUndefined());
  });

  it("切换历史来源保留输入焦点，并为新来源重置阅读位置", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "history_too_large" }), { status: 413 }));
    workspace();
    fireEvent.click(screen.getByTestId("session-row-air-original"));
    const pagedHistory = await screen.findByRole("button", { name: "使用分页历史接口" });
    const historyScroll = screen.getByLabelText("会话历史");
    Object.defineProperties(historyScroll, { scrollHeight: { value: 1200, configurable: true }, clientHeight: { value: 300, configurable: true } });
    historyScroll.scrollTop = 360;
    fireEvent.scroll(historyScroll);
    const draft = screen.getByLabelText("发送给当前会话");
    draft.focus();
    fireEvent.click(pagedHistory);
    expect(draft).toHaveFocus();
    expect(historyScroll.scrollTop).toBe(1200);
    await screen.findByText("原会话历史");
    expect(draft).toHaveFocus();
  });

  it("桌面同屏切换会话时把焦点移到新会话标题", async () => {
    mobile = false;
    const other = { ...session, id: "other", title: "另一个会话" };
    render(<SessionWorkspace data={{ ...data, sessions: [session, other] }} nodes={nodes} stale={false} onAuthFailure={vi.fn()} />);
    await openSession();
    const draft = screen.getByLabelText("发送给当前会话");
    draft.focus();
    fireEvent.click(screen.getByTestId("session-row-air-original"));
    expect(draft).toHaveFocus();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ session: other,
      historyContext: "cf7e282f-d6d2-4a98-a517-9fb753f2549b", source: "control-socket", fetchedAt: iso,
      items: [{ id: "other-message", turnId: "turn", type: "agentMessage", kind: "assistant", text: "其它会话历史" }], nextCursor: null, truncated: false,
    }), { status: 200 }));
    fireEvent.click(screen.getByTestId("session-row-air-other"));
    expect(screen.getByRole("heading", { name: other.title })).toHaveFocus();
    await screen.findByText("其它会话历史");
  });

  it("后台导航及重新激活工作区都保留外部焦点", async () => {
    const view = (active: boolean, requestedSessionKey?: string) => <><button autoFocus>其它工作区操作</button><SessionWorkspace data={data} nodes={nodes} stale={false} active={active} requestedSessionKey={requestedSessionKey} onAuthFailure={vi.fn()} /></>;
    const { rerender } = render(view(false));
    const external = screen.getByRole("button", { name: "其它工作区操作" });
    expect(external).toHaveFocus();
    rerender(view(false, sessionKey(session)));
    expect(screen.getByRole("heading", { name: session.title })).toBeInTheDocument();
    expect(external).toHaveFocus();
    rerender(view(true, sessionKey(session)));
    await screen.findByText("原会话历史");
    expect(external).toHaveFocus();
  });

  it("手机返回保留选中项、草稿、列表滚动和URL，浏览器前进可以重新打开详情", async () => {
    const visibility = vi.fn();
    const { container } = workspace(visibility);
    const list = container.querySelector(".session-list")!;
    list.scrollTop = 240;
    fireEvent.scroll(list);
    const originalUrl = window.location.href;
    await openSession();
    const historyScroll = screen.getByLabelText("会话历史");
    Object.defineProperties(historyScroll, { scrollHeight: { value: 1200, configurable: true }, clientHeight: { value: 300, configurable: true } });
    historyScroll.scrollTop = 360;
    fireEvent.scroll(historyScroll);
    expect(visibility).toHaveBeenLastCalledWith(true);
    expect(window.history.state.existing).toEqual({ keep: true });
    expect(window.location.href).toBe(originalUrl);
    fireEvent.change(screen.getByLabelText("发送给当前会话"), { target: { value: "保留我的草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "返回会话列表" }));
    await waitFor(() => expect(window.history.state.superLeaderSessionWorkspace).toBeUndefined());
    expect(screen.queryByLabelText("发送给当前会话")).toBeNull();
    expect(screen.getByTestId("session-row-air-original")).toHaveAttribute("aria-pressed", "true");
    expect(list.scrollTop).toBe(240);
    expect(visibility).toHaveBeenLastCalledWith(false);
    act(() => window.history.forward());
    await waitFor(() => expect(screen.getByLabelText("发送给当前会话")).toHaveValue("保留我的草稿"));
    expect(screen.getByLabelText("会话历史").scrollTop).toBe(360);
    expect(window.location.href).toBe(originalUrl);
    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByLabelText("发送给当前会话")).toBeNull());
    expect(screen.getByTestId("session-row-air-original")).toHaveFocus();
  });

  it("手机Enter与输入法确认都换行，仅发送按钮提交一次，受理回执不声称任务完成", async () => {
    workspace();
    await openSession();
    const draft = screen.getByLabelText("发送给当前会话");
    fireEvent.change(draft, { target: { value: "第一行\n第二行" } });
    expect(fireEvent.keyDown(draft, { key: "Enter", code: "Enter", cancelable: true })).toBe(true);
    fireEvent.compositionStart(draft);
    fireEvent.keyDown(draft, { key: "Enter", keyCode: 229 });
    fireEvent.compositionEnd(draft);
    expect(sends()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await screen.findByText("已受理 (Accepted)");
    expect(sends()).toHaveLength(1);
    expect(screen.getByText("输入已被接受，执行结果尚未确认")).toBeVisible();
    const receipt = screen.getByText("查看发送详情").closest("details");
    expect(receipt).not.toHaveAttribute("open");
    expect(screen.getByText("发送通道：原桌面会话")).not.toBeVisible();
    expect(screen.queryByText("执行完成 (Completed)")).toBeNull();
  });

  it("桌面保留Enter发送，Shift Enter和IME不发送，不增加浏览器历史", async () => {
    mobile = false;
    const push = vi.spyOn(window.history, "pushState");
    workspace();
    await openSession();
    const draft = screen.getByLabelText("发送给当前会话");
    fireEvent.change(draft, { target: { value: "桌面消息" } });
    fireEvent.keyDown(draft, { key: "Enter", shiftKey: true });
    fireEvent.compositionStart(draft);
    fireEvent.keyDown(draft, { key: "Enter" });
    fireEvent.compositionEnd(draft);
    expect(sends()).toHaveLength(0);
    fireEvent.keyDown(draft, { key: "Enter" });
    await screen.findByText("已受理 (Accepted)");
    expect(sends()).toHaveLength(1);
    expect(push).not.toHaveBeenCalled();
  });

  it("详情面板有可访问名称、焦点循环、Escape和遮罩关闭，并恢复触发按钮焦点", async () => {
    workspace();
    await openSession();
    const trigger = screen.getByRole("button", { name: "会话详情" });
    trigger.focus();
    fireEvent.click(trigger);
    let dialog = screen.getByRole("dialog", { name: "会话详情" });
    const close = within(dialog).getByRole("button", { name: "关闭会话详情" });
    expect(close).toHaveFocus();
    expect(within(dialog).getByText(session.cwd)).toBeVisible();
    const last = within(dialog).getByRole("button", { name: "从详情刷新会话历史" });
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByText(session.cwd));
    expect(dialog).toBeInTheDocument();
    fireEvent.click(dialog);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("StrictMode重放effect后忽略上一次close事件，原生对话框保持打开", async () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, "showModal");
    const closed = vi.fn();
    const { unmount } = render(<StrictMode><SessionDetails onClose={closed}><p>原生详情</p></SessionDetails></StrictMode>);
    const dialog = screen.getByRole("dialog");
    await act(async () => {});
    expect(showModal).toHaveBeenCalledTimes(2);
    fireEvent(dialog, new Event("close"));
    expect(closed).not.toHaveBeenCalled();
    expect(dialog).toHaveAttribute("open");
    await act(async () => { (dialog as HTMLDialogElement).close(); });
    expect(closed).toHaveBeenCalledOnce();
    unmount();
  });

  it("返回列表停止历史轮询，重开立即刷新并保留草稿与阅读位置", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(window.history, "back").mockReturnValue(undefined);
    const { container, unmount } = workspace();
    fireEvent.click(screen.getByTestId("session-row-air-original"));
    await act(async () => {});
    expect(screen.getByText("原会话历史")).toBeInTheDocument();
    const historyCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("/history"));
    const historyScroll = screen.getByLabelText("会话历史");
    Object.defineProperties(historyScroll, { scrollHeight: { value: 1200, configurable: true }, clientHeight: { value: 300, configurable: true } });
    historyScroll.scrollTop = 360;
    fireEvent.scroll(historyScroll);
    fireEvent.change(screen.getByLabelText("发送给当前会话"), { target: { value: "继续保留草稿" } });
    await act(async () => vi.advanceTimersByTimeAsync(4000));
    expect(historyCalls()).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "返回会话列表" }));
    const pausedCount = historyCalls().length;
    await act(async () => vi.advanceTimersByTimeAsync(10000));
    expect(historyCalls()).toHaveLength(pausedCount);
    expect(container.querySelector(".has-selection")).toBeNull();
    expect(screen.getByTestId("session-row-air-original")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("session-row-air-original"));
    expect(historyCalls()).toHaveLength(pausedCount + 1);
    expect(screen.getByText("原会话历史")).toBeInTheDocument();
    expect(screen.getByLabelText("发送给当前会话")).toHaveValue("继续保留草稿");
    expect(screen.getByLabelText("会话历史").scrollTop).toBe(360);
    await act(async () => {});
    expect(screen.getByLabelText("会话历史").scrollTop).toBe(360);
    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("卸载时清理自身history状态和监听器，保留其它state，不留下浏览器监听", async () => {
    const remove = vi.spyOn(window, "removeEventListener");
    const visibility = vi.fn();
    const { unmount } = workspace(visibility);
    await openSession();
    expect(window.history.state.superLeaderSessionWorkspace).toBeDefined();
    unmount();
    expect(window.history.state).toEqual({ existing: { keep: true } });
    expect(remove).toHaveBeenCalledWith("popstate", expect.any(Function));
    expect(visibility).toHaveBeenLastCalledWith(false);
  });

  it("切换工作区时关闭顶层对话框，再回来保留当前会话和草稿", async () => {
    const visibility = vi.fn();
    const { rerender } = workspace(visibility);
    await openSession();
    fireEvent.change(screen.getByLabelText("发送给当前会话"), { target: { value: "等待继续" } });
    fireEvent.click(screen.getByRole("button", { name: "会话详情" }));
    rerender(<SessionWorkspace data={data} nodes={nodes} stale={false} active={false} onAuthFailure={vi.fn()} onDetailVisibilityChange={visibility} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(visibility).toHaveBeenLastCalledWith(false);
    rerender(<SessionWorkspace data={data} nodes={nodes} stale={false} active={true} onAuthFailure={vi.fn()} onDetailVisibilityChange={visibility} />);
    expect(screen.getByLabelText("发送给当前会话")).toHaveValue("等待继续");
    expect(visibility).toHaveBeenLastCalledWith(true);
    await act(async () => {});
  });
});
