import { emptyGoals, emptyExecutions  } from "../fixtures/status-fixtures";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";
import { resetAuthHelperForTesting } from "../../src/auth/bootstrap";
import { ScopedSession, CommandRecord, SessionHistory } from "../../src/types";
import { useSessionHistory } from "../../src/features/sessions/useSessionHistory";
import { sendBlockReason, useSessionMessages } from "../../src/features/sessions/useSessionMessages";

const session: ScopedSession = { id: "same-id", nodeId: "air", provider: "codex-app", title: "工作会话", cwd: "/workspace", status: "idle", loaded: true, capabilities: ["read", "send"], observedAt: "2026-10-11T10:00:00Z", model: "gpt-6.1-sol", modelProvider: "company", reasoningEffort: "high" };
const second: ScopedSession = { ...session, nodeId: "mini", title: "另一个会话" };
const command: CommandRecord = { commandId: "cmd-1", requestId: "server-request", nodeId: "air", sessionId: "same-id", action: "send", status: "accepted", expiresAt: "2026-10-11T11:00:00Z", createdAt: "2026-10-11T10:00:00Z", updatedAt: "2026-10-11T10:00:00Z" };
const page: SessionHistory = { session, historyContext: "cf7e282f-d6d2-4a98-a517-9fb753f2549b", source: "control-socket", fetchedAt: "2026-10-11T10:00:00Z", nextCursor: "older/cursor", truncated: false, items: [{ id: "msg-1", turnId: "turn-1", type: "agentMessage", kind: "assistant", text: "**完成分析**\n\n|项目|结果|\n|---|---|\n|检查|通过|\n\n<img src='https://evil.test/raw'>\n\n![外部图片](https://evil.test/image.png)\n\n[坏链接](javascript:alert(1))" }, { id: "tool-1", turnId: "turn-1", type: "commandExecution", kind: "tool", title: "命令执行", text: "tool secret details" }] };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

function installFetch(onRequest?: (url: string, init?: RequestInit) => Promise<Response> | undefined) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    const overridden = onRequest?.(url, init);
    if (overridden) return overridden;
    if (url === "/auth/session") return response({ authenticated: true });
    if (url === "/auth/logout") return response({ authenticated: false });
    if (url === "/health") return response({ status: "ok" });
    if (url === "/v1/status") return response({ nodes: ["air", "mini"].map((nodeId) => ({ nodeId, connected: true, sessionCount: 1 })), sessions: [session, second], commands: [], goals: emptyGoals(), executions: emptyExecutions() });
    if (url.includes("/history")) return response({ ...page, session: url.includes("/mini/") ? second : session });
    if (url.endsWith("/messages")) return response(command);
    if (url.startsWith("/v1/commands/")) return response({ ...command, status: "completed", output: "完成输出" });
    return response({}, 404);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
async function openSession() {
  fireEvent.click(await screen.findByTestId("session-row-air-same-id"));
  await screen.findByText("完成分析");
}

async function refreshHistory() {
  fireEvent.click(screen.getByRole("button", { name: "会话详情" }));
  fireEvent.click(await screen.findByRole("button", { name: "从详情刷新会话历史" }));
  fireEvent.click(screen.getByRole("button", { name: "关闭会话详情" }));
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(session.observedAt));
  resetAuthHelperForTesting();
  window.history.replaceState(null, "", "/");
});
afterEach(() => { resetAuthHelperForTesting(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("会话工作台交互与安全", () => {
  it.each([150, 700])("滚动至 %i 时，失效提示固定在头部，保留内容且仅显式重读更换来源", async (scrollTop) => {
    let reads = 0;
    const fetchMock = installFetch(url => {
      if (!url.includes("/history")) return;
      reads++;
      if (reads === 2) return Promise.resolve(response({ code: "history_context_expired", error: "PRIVATE" }, 409));
      if (reads >= 3) return Promise.resolve(response({ ...page, historyContext: "15c9ef38-59cc-410c-a0f0-6a54bcd7f41a",
        source: "codex-desktop", items: [{ ...page.items[0], text: "新上下文内容" }] }));
    });
    render(<App />);
    await openSession();
    const scroll = screen.getByLabelText("会话历史");
    Object.defineProperties(scroll, { scrollHeight: { value: 1000, configurable: true }, clientHeight: { value: 200, configurable: true } });
    scroll.scrollTop = scrollTop;
    fireEvent.scroll(scroll);
    await refreshHistory();
    await screen.findByText(/历史读取上下文已失效/);
    const alert = screen.getByRole("alert");
    expect(alert.closest(".detail-heading")).not.toBeNull();
    expect(alert.closest(".history-scroll")).toBeNull();
    expect(screen.getAllByRole("button", { name: "重新读取最新页" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "重新读取最新页" }).closest(".detail-heading")).not.toBeNull();
    expect(scroll.scrollTop).toBe(scrollTop);
    expect(screen.getByText("完成分析")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试读取" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "会话详情" }));
    expect(screen.getByRole("button", { name: "从详情刷新会话历史" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "关闭会话详情" }));
    expect(screen.queryByRole("button", { name: "加载更早的消息" })).toBeNull();
    const historyCalls = () => fetchMock.mock.calls.filter(([url]) => url.includes("/history"));
    expect(historyCalls()[1][0]).toContain(`historyContext=${page.historyContext}`);
    fireEvent.click(screen.getByRole("button", { name: "重新读取最新页" }));
    await screen.findByText("新上下文内容");
    expect(screen.queryByText("完成分析")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(historyCalls()[2][0]).not.toContain("historyContext");
  });

  it("停在最新底部800时上下文过期自动恢复准确同会话新页，不保留旧cursor", async () => {
    let reads = 0;
    const fetchMock = installFetch(url => {
      if (!url.includes("/history")) return;
      reads++;
      if (reads === 2) return Promise.resolve(response({ code: "history_context_expired" }, 409));
      if (reads >= 3) return Promise.resolve(response({ ...page, historyContext: "15c9ef38-59cc-410c-a0f0-6a54bcd7f41a", items: [{ ...page.items[0], text: "自动恢复的最新内容" }] }));
    });
    render(<App />);
    await openSession();
    const scroll = screen.getByLabelText("会话历史");
    Object.defineProperties(scroll, { scrollHeight: { value: 1000, configurable: true }, clientHeight: { value: 200, configurable: true } });
    scroll.scrollTop = 800; fireEvent.scroll(scroll);
    await refreshHistory();
    await screen.findByText("自动恢复的最新内容");
    expect(screen.queryByText("完成分析")).toBeNull();
    expect(screen.queryByText(/历史读取上下文已失效/)).toBeNull();
    const historyCalls = fetchMock.mock.calls.filter(([url]) => url.includes("/history"));
    expect(historyCalls[2][0]).not.toContain("historyContext");
    expect(historyCalls[2][0]).not.toContain("cursor=");
  });

  it("带历史间隙的上下文失效后保留间隙提示，隐藏分页入口且只保留头部重读入口", async () => {
    let reads = 0;
    installFetch(url => {
      if (!url.includes("/history")) return;
      reads++;
      if (reads === 2) return Promise.resolve(response({ ...page, items: [{ ...page.items[0], id: "new-tail", text: "较新的消息" }] }));
      if (reads === 3) return Promise.resolve(response({ code: "history_context_expired" }, 409));
    });
    render(<App />);
    await openSession();
    await refreshHistory();
    await screen.findByText("较新的消息");
    expect(screen.getByRole("button", { name: "补齐这段历史" })).toBeInTheDocument();
    await refreshHistory();
    await screen.findByText(/历史读取上下文已失效/);
    expect(screen.getByText(/此处还有未加载的消息/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "补齐这段历史" })).toBeNull();
    expect(screen.queryByRole("button", { name: "加载更早的消息" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "重新读取最新页" })).toHaveLength(1);
    expect(screen.getByRole("alert").closest(".detail-heading")).not.toBeNull();
  });

  it("仅选择后读取历史，显示真实模型，安全 Markdown 与工具按需展开", async () => {
    const fetchMock = installFetch();
    const { container } = render(<App />);
    await screen.findByTestId("session-row-air-same-id");
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("/history"))).toHaveLength(0);
    expect(screen.getByTestId("session-row-air-same-id")).not.toHaveTextContent("gpt-6.1-sol");
    await openSession();
    fireEvent.click(screen.getByRole("button", { name: "会话详情" }));
    const details = screen.getByRole("dialog", { name: "会话详情" });
    expect(within(details).getByText("模型").nextElementSibling).toHaveTextContent("gpt-6.1-sol");
    expect(within(details).getByText("Provider").nextElementSibling).toHaveTextContent("company");
    expect(within(details).getByText("模型来源").nextElementSibling).toHaveTextContent("控制接口记录");
    fireEvent.click(screen.getByRole("button", { name: "关闭会话详情" }));
    expect(container.querySelector(".markdown strong")).toHaveTextContent("完成分析");
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(screen.queryByText("tool secret details")).toBeNull();
    const tool = container.querySelector(".tool-message button") as HTMLButtonElement;
    fireEvent.click(tool);
    await screen.findByText("tool secret details");
    fireEvent.click(screen.getByRole("button", { name: "加载更早的消息" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.includes("cursor=older%2Fcursor"))).toBe(true));
  });

  it("同 sessionId 在不同机器草稿隔离，返回列表，退出清空敏感内容", async () => {
    installFetch();
    render(<App />);
    await openSession();
    fireEvent.change(screen.getByLabelText("发送给当前会话"), { target: { value: "air draft" } });
    fireEvent.click(screen.getByTestId("session-row-mini-same-id"));
    expect(screen.getByLabelText("发送给当前会话")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("发送给当前会话"), { target: { value: "mini draft" } });
    fireEvent.click(screen.getByTestId("session-row-air-same-id"));
    expect(screen.getByLabelText("发送给当前会话")).toHaveValue("air draft");
    fireEvent.click(screen.getByRole("button", { name: "返回会话列表" }));
    expect(screen.queryByLabelText("发送给当前会话")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "退出控制台登录" }));
    await screen.findByText("把工作带在身边");
    expect(screen.queryByText("完成分析")).toBeNull();
    expect(screen.queryByTestId("session-row-air-same-id")).toBeNull();
  });

  it("IME Enter 不发送，连点仅一次 POST，Cookie intent 且无管理写入口", async () => {
    let resolveSend!: (value: Response) => void;
    const fetchMock = installFetch((url) => url.endsWith("/messages") ? new Promise((resolve) => { resolveSend = resolve; }) : undefined);
    render(<App />);
    await openSession();
    const draft = screen.getByLabelText("发送给当前会话");
    fireEvent.change(draft, { target: { value: "中文输入" } });
    fireEvent.compositionStart(draft);
    fireEvent.keyDown(draft, { key: "Enter", keyCode: 229 });
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/messages"))).toHaveLength(0);
    fireEvent.compositionEnd(draft);
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    fireEvent.click(screen.getByRole("button", { name: "发送中…" }));
    const calls = fetchMock.mock.calls.filter(([url]) => url.endsWith("/messages"));
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ method: "POST", credentials: "same-origin", headers: { "X-Super-Leader-Intent": "session-message", "Content-Type": "application/json" } });
    expect(calls[0][1]?.headers).not.toHaveProperty("Origin");
    expect(calls[0][1]?.headers).not.toHaveProperty("Authorization");
    await act(async () => resolveSend(response(command)));
    expect(screen.getByText("已受理 (Accepted)", { selector: ".send-receipt > span" })).toBeInTheDocument();
    expect(screen.getByText("输入已被接受，执行结果尚未确认")).toBeInTheDocument();
    expect(screen.queryByText("执行完成 (Completed)", { selector: ".send-receipt > span" })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => url === "/v1/commands" || url === "/v1/messages")).toBe(false);
  });

  it("网络不确定保留草稿和requestId，手动核查只读取原请求", async () => {
    let attempt = 0;
    const fetchMock = installFetch((url) => url.endsWith("/messages") && ++attempt === 1 ? Promise.reject(new Error("network")) : url.includes("/messages/") ? Promise.resolve(response(command)) : undefined);
    render(<App />);
    await openSession();
    fireEvent.change(screen.getByLabelText("发送给当前会话"), { target: { value: "不重复执行" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await screen.findByText("提交结果待核查");
    expect(screen.getByLabelText("发送给当前会话")).toHaveValue("不重复执行");
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/messages"))).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "核查发送状态" }));
    await screen.findByText("已受理 (Accepted)", { selector: ".send-receipt > span" });
    const calls = fetchMock.mock.calls.filter(([url]) => url.endsWith("/messages"));
    expect(calls).toHaveLength(1);
    const originalRequest = JSON.parse(String(calls[0][1]?.body)).requestId;
    expect(fetchMock.mock.calls.find(([url]) => url.endsWith(`/messages/${originalRequest}`))?.[1]?.method).toBe("GET");
  });

  it.each([
    [{ ...session, loaded: undefined }, true, false, "当前控制接口未加载此会话，暂时只读"],
    [{ ...session, loaded: false }, true, false, "当前控制接口未加载此会话，暂时只读"],
    [{ ...session, status: "notLoaded" }, true, false, "当前控制接口未加载此会话，暂时只读"],
    [{ ...session, capabilities: [] }, true, false, "发送能力"],
    [session, true, true, "待更新"],
  ])("不可发送原因正确 %#", (value, connected, stale, text) => {
    expect(sendBlockReason(value as ScopedSession, connected as boolean, stale as boolean)).toContain(text);
  });

  it("阅读旧消息不被刷新拉走，加载更早页保留滚动锚点", async () => {
    let tailVersion = 0;
    let height = 1000;
    installFetch((url) => {
      if (!url.includes("/history")) return;
      if (url.includes("cursor=")) {
        height += 100;
        return Promise.resolve(response({ ...page, nextCursor: null, items: [{ ...page.items[0], id: "older-1", text: "更早消息" }] }));
      }
      if (tailVersion) return Promise.resolve(response({ ...page, items: [...page.items, { ...page.items[0], id: "latest-1", text: "最新消息" }] }));
      return Promise.resolve(response(page));
    });
    render(<App />);
    await openSession();
    const scroll = screen.getByLabelText("会话历史");
    Object.defineProperties(scroll, { scrollHeight: { get: () => height, configurable: true }, clientHeight: { value: 200, configurable: true } });
    const rect = (top: number) => ({ top, bottom: top + 100, left: 0, right: 300, width: 300, height: 100, x: 0, y: top, toJSON: () => ({}) });
    vi.spyOn(scroll, "getBoundingClientRect").mockImplementation(() => rect(0));
    const messageRects = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const messages = [...scroll.querySelectorAll("[data-history-id]")];
      return rect(messages.indexOf(this) * 100 - scroll.scrollTop);
    });
    scroll.scrollTop = 150;
    fireEvent.scroll(scroll);
    tailVersion = 1;
    await refreshHistory();
    await screen.findByText("最新消息");
    expect(scroll.scrollTop).toBe(150);
    expect(screen.getByRole("button", { name: "有新消息 · 跳到最新" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "有新消息 · 跳到最新" }).closest(".latest-message-slot")?.parentElement).toHaveClass("session-bottom-slot");
    fireEvent.click(screen.getByRole("button", { name: "加载更早的消息" }));
    await screen.findByText("更早消息");
    expect(scroll.scrollTop).toBe(250);
    fireEvent.click(screen.getByRole("button", { name: "有新消息 · 跳到最新" }));
    expect(scroll.scrollTop).toBe(1100);
    messageRects.mockRestore();
  });

  it("历史接口认证失败清空草稿和历史，明确拒绝发送保留草稿", async () => {
    let rejectHistory = false;
    installFetch((url) => {
      if (url.endsWith("/messages")) return Promise.resolve(response({}, 409));
      if (rejectHistory && url.includes("/history")) return Promise.resolve(response({}, 401));
    });
    render(<App />);
    await openSession();
    fireEvent.change(screen.getByLabelText("发送给当前会话"), { target: { value: "保留这段草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    await screen.findByText("请求未成功 (HTTP 409)");
    expect(screen.getByLabelText("发送给当前会话")).toHaveValue("保留这段草稿");
    rejectHistory = true;
    await refreshHistory();
    await screen.findByTestId("auth-expired-banner");
    expect(screen.queryByLabelText("发送给当前会话")).toBeNull();
    expect(screen.queryByText("完成分析")).toBeNull();
  });
});

describe("请求隔离与轮询", () => {
  it("会话切换中止旧历史，迟到响应不污染当前会话", async () => {
    let resolveOld!: (value: Response) => void;
    let oldSignal: AbortSignal | undefined;
    installFetch((url, init) => url.includes("/air/") ? new Promise((resolve) => { resolveOld = resolve; oldSignal = init?.signal ?? undefined; }) : undefined);
    const { result, rerender } = renderHook(({ current }) => useSessionHistory(current, true, vi.fn()), { initialProps: { current: session } });
    rerender({ current: second });
    await waitFor(() => expect(result.current.history?.session.nodeId).toBe("mini"));
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => resolveOld(response(page)));
    expect(result.current.history?.session.nodeId).toBe("mini");
  });

  it("历史轮询单飞并持续更新，不连续的最新页明确标缺口", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let resolvePending!: (value: Response) => void;
    installFetch((url) => {
      if (!url.includes("/history")) return;
      calls++;
      if (calls === 1) return new Promise((resolve) => { resolvePending = resolve; });
      return Promise.resolve(response({ ...page, items: [{ ...page.items[0], id: "new-item" }] }));
    });
    const { result } = renderHook(() => useSessionHistory(session, true, vi.fn()));
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(calls).toBe(1);
    await act(async () => resolvePending(response(page)));
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(result.current.gap).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(400_000));
    expect(calls).toBe(203);
    expect(result.current.pollingPaused).toBe(false);
  });

  it("accepted 查询到 completed 才结束，poll失败后手动核查恢复轮询", async () => {
    vi.useFakeTimers();
    let commandCalls = 0;
    installFetch((url) => {
      if (!url.startsWith("/v1/commands/")) return;
      commandCalls++;
      return Promise.resolve(commandCalls === 1 ? response({}, 502) : response({ ...command, status: commandCalls === 2 ? "accepted" : "completed" }));
    });
    const { result } = renderHook(() => useSessionMessages(session, vi.fn()));
    act(() => result.current.setDraft("测试消息"));
    await act(async () => result.current.submit());
    expect(result.current.submission?.command?.status).toBe("accepted");
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(result.current.pollingStopped).toBe(true);
    await act(async () => result.current.submit(true));
    expect(result.current.pollingStopped).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(result.current.submission?.command?.status).toBe("completed");
    expect(commandCalls).toBe(3);
  });

  it("A→B→A 旧请求 finally 不解除新请求发送锁", async () => {
    const resolvers: Array<(value: Response) => void> = [];
    const fetchMock = installFetch((url) => url.endsWith("/messages") || url.includes("/messages/") ? new Promise((resolve) => resolvers.push(resolve)) : undefined);
    const { result, rerender } = renderHook(({ current }) => useSessionMessages(current, vi.fn()), { initialProps: { current: session } });
    act(() => result.current.setDraft("A消息"));
    act(() => { void result.current.submit(); });
    rerender({ current: second });
    rerender({ current: session });
    act(() => { void result.current.submit(true); });
    expect(result.current.sending).toBe(true);
    await act(async () => resolvers[0](response(command)));
    expect(result.current.sending).toBe(true);
    await act(async () => result.current.submit(true));
    expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/messages"))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("/messages/"))).toHaveLength(1);
    await act(async () => resolvers[1](response(command)));
    expect(result.current.sending).toBe(false);
  });
});
