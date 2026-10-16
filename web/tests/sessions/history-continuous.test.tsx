import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiAuthError, ApiHistoryError } from "../../src/api/errors";
import { fetchSessionHistory } from "../../src/api/sessions";
import { useSessionHistory } from "../../src/features/sessions/useSessionHistory";
import { useHistoryScroll } from "../../src/features/sessions/useHistoryScroll";
import { HistoryItem, ScopedSession, SessionHistory } from "../../src/types";

vi.mock("../../src/api/sessions", async (original) => ({ ...await original<typeof import("../../src/api/sessions")>(), fetchSessionHistory: vi.fn() }));
const fetchHistory = vi.mocked(fetchSessionHistory);
const session: ScopedSession = { id: "session", nodeId: "air", provider: "codex-app", title: "会话", cwd: "/workspace", status: "idle", observedAt: "2026-10-11T10:00:00Z", capabilities: ["read"] };
const item = (id: string, text = id): HistoryItem => ({ id, text, turnId: "turn", type: "agentMessage", kind: "assistant" });
const page = (ids: string[], nextCursor: string | null = "older"): SessionHistory => ({ session, historyContext: "cf7e282f-d6d2-4a98-a517-9fb753f2549b", source: "control-socket", items: ids.map((id) => item(id)), nextCursor, fetchedAt: "2026-10-11T10:00:00Z", truncated: false });
function pending<T>() { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
const settle = () => act(async () => { await Promise.resolve(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  fetchHistory.mockReset();
  fetchHistory.mockResolvedValue(page(["a", "b"]));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("持续会话快照", () => {
  it("超限暂停自动请求，仅显式选择分页接口后以新context读取同一会话", async () => {
    fetchHistory.mockRejectedValueOnce(new ApiHistoryError(413, "history_too_large", "历史超出读取大小限制。"));
    const { result } = renderHook(() => useSessionHistory(session, true, vi.fn()));
    await settle(); await advance(60_000);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    expect(result.current.sizeBlocked).toBe(true);
    expect(result.current.requestedSource).toBeUndefined();
    await act(async () => { expect(await result.current.usePagedHistory()).toBe(true); });
    expect(fetchHistory.mock.calls[1]).toEqual(["air", "session", undefined, expect.any(AbortSignal), undefined, "control-socket"]);
    expect(result.current.sizeBlocked).toBe(false);
    expect(result.current.history?.source).toBe("control-socket");
    await act(async () => { await result.current.loadOlder(); });
    expect(fetchHistory.mock.calls[2][4]).toBe(page([]).historyContext);
    expect(fetchHistory.mock.calls[2][5]).toBe("control-socket");
    await advance(2000);
    expect(fetchHistory.mock.calls.at(-1)?.[5]).toBe("control-socket");
  });

  it("显式换来源取消旧请求并清空旧页，迟到页不能混入，换会话后恢复自动选择", async () => {
    const old = pending<SessionHistory>();
    fetchHistory.mockResolvedValueOnce({ ...page(["old"]), source: "codex-desktop" }).mockReturnValueOnce(old.promise);
    const { result, rerender } = renderHook(({ target }) => useSessionHistory(target, true, vi.fn()), { initialProps: { target: session } });
    await settle();
    act(() => { void result.current.refresh(); });
    const signal = fetchHistory.mock.calls[1][3];
    await act(async () => { await result.current.usePagedHistory(); });
    expect(signal?.aborted).toBe(true);
    expect(result.current.history?.items.map(item => item.id)).toEqual(["a", "b"]);
    expect(fetchHistory.mock.calls[2][4]).toBeUndefined();
    await act(async () => old.resolve({ ...page(["late"]), source: "codex-desktop" }));
    expect(result.current.history?.items.some(item => item.id === "late")).toBe(false);
    rerender({ target: { ...session, id: "other" } });
    await settle();
    expect(fetchHistory.mock.calls.at(-1)?.[5]).toBeUndefined();
    expect(result.current.requestedSource).toBeUndefined();
  });

  it("选定分页接口时拒绝桌面来源，不自动退回或混入记录", async () => {
    const { result } = renderHook(() => useSessionHistory(session, true, vi.fn()));
    await settle();
    fetchHistory.mockResolvedValue({ ...page(["wrong"]), source: "codex-desktop" });
    await act(async () => { expect(await result.current.usePagedHistory()).toBe(false); });
    expect(result.current.history).toBeNull();
    expect(result.current.error).toContain("不匹配");
    await advance(4000);
    expect(fetchHistory.mock.calls.at(-1)?.[5]).toBe("control-socket");
  });
  it("首次无context，最新轮询和分页始终固定context", async () => {
    const { result } = renderHook(() => useSessionHistory(session, true, vi.fn()));
    await settle();
    expect(fetchHistory.mock.calls[0][4]).toBeUndefined();
    await advance(2000);
    await act(async () => { await result.current.loadOlder(); });
    expect(fetchHistory.mock.calls.slice(1).every(call => call[4] === page([]).historyContext)).toBe(true);
    expect(fetchHistory.mock.calls[1][2]).toBeUndefined();
    expect(fetchHistory.mock.calls[2][2]).toBe("older");
  });

  it("409保留内容并暂停轮询/翻页/重试和恢复事件，只有reset去掉context", async () => {
    fetchHistory.mockResolvedValueOnce(page(["read"])).mockRejectedValueOnce(new ApiHistoryError(409, "history_context_expired", "expired"));
    const { result, rerender } = renderHook(({ connected }) => useSessionHistory(session, connected, vi.fn()), { initialProps: { connected: true } });
    await settle(); await advance(2000);
    expect(result.current.contextExpired).toBe(true);
    expect(result.current.pollingPaused).toBe(true);
    expect(result.current.history?.items.map(entry => entry.id)).toEqual(["read"]);
    expect(result.current.error).toContain("请重新读取最新页");
    expect(result.current.history?.nextCursor).toBeNull();
    await act(async () => { expect(await result.current.loadOlder()).toBe(false); expect(await result.current.refresh()).toBe(false); });
    rerender({ connected: false }); rerender({ connected: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await advance(60_000);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    const fresh = { ...page(["fresh"]), source: "codex-desktop" as const, historyContext: "15c9ef38-59cc-410c-a0f0-6a54bcd7f41a" };
    fetchHistory.mockResolvedValue(fresh);
    await act(async () => { expect(await result.current.resetLatest()).toBe(true); });
    expect(fetchHistory.mock.calls[2][4]).toBeUndefined();
    expect(result.current.history?.items.map(entry => entry.id)).toEqual(["fresh"]);
    expect(result.current.contextExpired).toBe(false);
    await advance(2000);
    expect(fetchHistory.mock.calls[3][4]).toBe(fresh.historyContext);
  });

  it.each(["source", "context", "scope"])("拒绝不同%s的响应，保留原历史及后续请求context", async mismatch => {
    const wrong = { ...page(["wrong"]), ...(mismatch === "source" ? { source: "codex-desktop" as const } :
      mismatch === "context" ? { historyContext: "15c9ef38-59cc-410c-a0f0-6a54bcd7f41a" } : { session: { ...session, nodeId: "other" } }) };
    fetchHistory.mockResolvedValueOnce(page(["read"])).mockResolvedValueOnce(wrong);
    const { result } = renderHook(() => useSessionHistory(session, true, vi.fn()));
    await settle(); await advance(2000);
    expect(result.current.error).toContain("不匹配");
    expect(result.current.history?.items.map(entry => entry.id)).toEqual(["read"]);
    await advance(4000);
    expect(fetchHistory.mock.calls[2][4]).toBe(page([]).historyContext);
  });

  it("reset中止当前读取并清排队，不复用旧请求，迟到旧页不影响新源", async () => {
    const old = pending<SessionHistory>();
    const fresh = pending<SessionHistory>();
    fetchHistory.mockResolvedValueOnce(page(["read"])).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const { result } = renderHook(() => useSessionHistory(session, true, vi.fn()));
    await settle();
    act(() => { void result.current.refresh(); void result.current.loadOlder(); });
    const oldSignal = fetchHistory.mock.calls[1][3];
    let reset!: Promise<boolean>;
    act(() => { reset = result.current.resetLatest(); });
    expect(oldSignal?.aborted).toBe(true);
    expect(fetchHistory).toHaveBeenCalledTimes(3);
    expect(fetchHistory.mock.calls[2][4]).toBeUndefined();
    await act(async () => old.resolve(page(["late"])));
    expect(result.current.loadingLatest).toBe(true);
    expect(result.current.history?.items[0].id).toBe("read");
    await act(async () => { fresh.resolve({ ...page(["fresh"]), source: "codex-desktop", historyContext: "15c9ef38-59cc-410c-a0f0-6a54bcd7f41a" }); expect(await reset).toBe(true); });
    expect(result.current.history?.items.map(entry => entry.id)).toEqual(["fresh"]);
    expect(result.current.history?.source).toBe("codex-desktop");
    expect(fetchHistory).toHaveBeenCalledTimes(3);
  });

  it("reset失败后的重试仍开启新context，成功替换而非混入旧来源", async () => {
    fetchHistory.mockResolvedValueOnce(page(["read"])).mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce({ ...page(["fresh"]), source: "codex-desktop", historyContext: "15c9ef38-59cc-410c-a0f0-6a54bcd7f41a" });
    const { result } = renderHook(() => useSessionHistory(session, true, vi.fn()));
    await settle();
    await act(async () => { expect(await result.current.resetLatest()).toBe(false); });
    expect(result.current.history?.items[0].id).toBe("read");
    await advance(4000);
    expect(fetchHistory.mock.calls.slice(1).every(call => call[4] === undefined)).toBe(true);
    expect(result.current.history?.items.map(entry => entry.id)).toEqual(["fresh"]);
  });

  it("超过60轮后仍每两秒更新，历史请求不会发送消息", async () => {
    const { result } = renderHook(() => useSessionHistory(session, true, vi.fn()));
    await settle();
    await advance(140_000);
    expect(fetchHistory).toHaveBeenCalledTimes(71);
    expect(result.current.pollingPaused).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(fetchHistory.mock.calls.every(([nodeId, sessionId]) => nodeId === "air" && sessionId === "session")).toBe(true);
  });

  it("页面隐藏暂停并保留历史，恢复可见立即读取", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get");
    const { result } = renderHook(() => useSessionHistory(session, true, vi.fn()));
    await settle();
    visibility.mockReturnValue("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await advance(100_000);
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    expect(result.current.history?.items.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(result.current.pollingPaused).toBe(true);
    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await settle();
    expect(fetchHistory).toHaveBeenCalledTimes(2);
  });

  it("机器离线与网络离线暂停，恢复立即刷新而不丢已加载旧页", async () => {
    const online = vi.spyOn(navigator, "onLine", "get");
    fetchHistory.mockResolvedValueOnce(page(["a", "b"])).mockResolvedValueOnce(page(["old"], null));
    const { result, rerender } = renderHook(({ connected }) => useSessionHistory(session, connected, vi.fn()), { initialProps: { connected: true } });
    await settle();
    await act(async () => { await result.current.loadOlder(); });
    rerender({ connected: false });
    await advance(20_000);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    expect(result.current.history?.items[0].id).toBe("old");
    rerender({ connected: true });
    await settle();
    expect(fetchHistory).toHaveBeenCalledTimes(3);
    online.mockReturnValue(false);
    act(() => window.dispatchEvent(new Event("offline")));
    await advance(20_000);
    expect(fetchHistory).toHaveBeenCalledTimes(3);
    online.mockReturnValue(true);
    act(() => window.dispatchEvent(new Event("online")));
    await settle();
    expect(fetchHistory).toHaveBeenCalledTimes(4);
    expect(result.current.history?.items[0].id).toBe("old");
  });

  it("失败指数退避最高30秒，成功后恢复两秒且不会永久停", async () => {
    fetchHistory.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useSessionHistory(session, true, vi.fn()));
    await settle();
    await advance(4000 + 8000 + 16000 + 30000);
    expect(fetchHistory).toHaveBeenCalledTimes(5);
    await advance(29_999);
    expect(fetchHistory).toHaveBeenCalledTimes(5);
    fetchHistory.mockResolvedValue(page(["back"]));
    await advance(1);
    expect(result.current.error).toBeNull();
    await advance(2000);
    expect(fetchHistory).toHaveBeenCalledTimes(7);
  });

  it("会话切换中止迟到请求，不污染新会话或解除其单飞锁", async () => {
    const old = pending<SessionHistory>();
    const next = pending<SessionHistory>();
    fetchHistory.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const { result, rerender } = renderHook(({ current }) => useSessionHistory(current, true, vi.fn()), { initialProps: { current: session } });
    const signal = fetchHistory.mock.calls[0][3];
    rerender({ current: { ...session, nodeId: "mini" } });
    expect(signal?.aborted).toBe(true);
    await act(async () => old.resolve(page(["wrong"])));
    expect(result.current.history).toBeNull();
    expect(result.current.loadingLatest).toBe(true);
    await advance(10_000);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    await act(async () => next.resolve({ ...page(["right"]), session: { ...session, nodeId: "mini" } }));
    expect(result.current.history?.items[0].id).toBe("right");
  });

  it("分页与tail单飞排队，重复点击同一游标仅请求一次，更新内容且不重复ID", async () => {
    const tail = pending<SessionHistory>();
    fetchHistory.mockResolvedValueOnce(page(["a", "b"])).mockReturnValueOnce(tail.promise)
      .mockResolvedValueOnce(page(["old", "a"], "older-2")).mockResolvedValueOnce(page(["oldest", "old"], null));
    const { result } = renderHook(() => useSessionHistory(session, true, vi.fn()));
    await settle();
    act(() => { void result.current.refresh(); });
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => { first = result.current.loadOlder(); second = result.current.loadOlder(); });
    expect(first).toBe(second);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    await act(async () => { tail.resolve({ ...page(["a", "b", "c"]), items: [item("a"), item("b", "updated"), item("c")] }); await first; });
    expect(fetchHistory).toHaveBeenCalledTimes(3);
    expect(result.current.history?.items.map((entry) => entry.id)).toEqual(["old", "a", "b", "c"]);
    expect(result.current.history?.items[2].text).toBe("updated");
    await act(async () => { expect(await result.current.loadOlder()).toBe(true); });
    expect(result.current.history?.items.map((entry) => entry.id)).toEqual(["oldest", "old", "a", "b", "c"]);
    expect(result.current.history?.nextCursor).toBeNull();
  });

  it("重复cursor不会循环，最新刷新仍持续", async () => {
    fetchHistory.mockResolvedValueOnce(page(["a"])).mockResolvedValueOnce(page(["old"], "older"));
    const { result } = renderHook(() => useSessionHistory(session, true, vi.fn()));
    await settle();
    await act(async () => { expect(await result.current.loadOlder()).toBe(false); });
    expect(result.current.history?.nextCursor).toBeNull();
    expect(result.current.error).toContain("游标重复");
    await act(async () => { expect(await result.current.loadOlder()).toBe(false); });
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    await advance(2000);
    expect(fetchHistory).toHaveBeenCalledTimes(3);
  });

  it("空历史后出现新消息，新的older游标可继续加载", async () => {
    fetchHistory.mockResolvedValueOnce(page([], null)).mockResolvedValueOnce(page(["new"], "first-older")).mockResolvedValueOnce(page(["old"], null));
    const { result } = renderHook(() => useSessionHistory(session, true, vi.fn()));
    await settle();
    await advance(2000);
    expect(result.current.history?.nextCursor).toBe("first-older");
    await act(async () => { await result.current.loadOlder(); });
    expect(result.current.history?.items.map((entry) => entry.id)).toEqual(["old", "new"]);
  });

  it("真实缺口显式定位，补页直到重叠才恢复连续并保留旧游标", async () => {
    fetchHistory.mockResolvedValueOnce(page(["a", "b"], "original-older"))
      .mockResolvedValueOnce(page(["e", "f"], "bridge"))
      .mockResolvedValueOnce(page(["c", "d"], "bridge-2"))
      .mockResolvedValueOnce(page(["b", "c"], "ignored"));
    const { result } = renderHook(() => useSessionHistory(session, true, vi.fn()));
    await settle(); await advance(2000);
    expect(result.current.gapBeforeIds).toEqual(["e"]);
    await act(async () => { await result.current.loadOlder(); });
    expect(result.current.history?.items.map((entry) => entry.id)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(result.current.gapBeforeIds).toEqual(["c"]);
    await act(async () => { await result.current.loadOlder(); });
    expect(result.current.gap).toBe(false);
    expect(result.current.history?.nextCursor).toBe("original-older");
  });

  it("2000条窗口裁剪明确保留阅读段和最新尾部，分页与刷新持续，reset可恢复", async () => {
    const ids = Array.from({ length: 2000 }, (_, index) => `id-${index}`);
    fetchHistory.mockResolvedValueOnce(page(ids)).mockResolvedValueOnce(page([ids.at(-1)!, "live"]))
      .mockResolvedValueOnce(page(["earlier"], "older-2")).mockResolvedValueOnce(page(["live", "latest"]));
    const { result } = renderHook(() => useSessionHistory(session, true, vi.fn()));
    await settle(); await advance(2000);
    expect(result.current.history?.items).toHaveLength(2000);
    expect(result.current.history?.items[0].id).toBe("id-0");
    expect(result.current.windowNotice).toContain("释放历史窗口");
    expect(result.current.memoryGap).toBe(true);
    expect(result.current.history?.items.at(-1)?.id).toBe("live");
    expect(result.current.pollingPaused).toBe(false);
    expect(result.current.history?.nextCursor).toBe("older");
    await act(async () => { expect(await result.current.loadOlder()).toBe(true); });
    expect(result.current.history?.items[0].id).toBe("earlier");
    expect(result.current.history?.nextCursor).toBe("older-2");
    await advance(2000);
    expect(result.current.history?.items.at(-1)?.id).toBe("latest");
    expect(result.current.history?.items).toHaveLength(2000);
    await act(async () => { await result.current.resetLatest(); });
    expect(result.current.memoryGap).toBe(false);
    expect(result.current.windowNotice).toBeNull();
  });

  it("鉴权失败立即清历史、中止排队且不再轮询", async () => {
    const denied = pending<SessionHistory>();
    const onAuthFailure = vi.fn();
    fetchHistory.mockResolvedValueOnce(page(["secret"])).mockReturnValueOnce(denied.promise);
    const { result } = renderHook(() => useSessionHistory(session, true, onAuthFailure));
    await settle();
    fetchHistory.mockRejectedValue(new ApiAuthError(401, "expired"));
    act(() => { void result.current.refresh(); void result.current.loadOlder(); });
    await act(async () => denied.reject(new ApiAuthError(401, "expired")));
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
    expect(result.current.history).toBeNull();
    await advance(60_000);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
  });
});

function ScrollHarness({ items, loadOlder, owner = "air", automaticLoadPaused }: { items: HistoryItem[]; loadOlder: () => Promise<boolean>; owner?: string; automaticLoadPaused?: boolean }) {
  const scroll = useHistoryScroll({ owner, items, nextCursor: "older", loadingOlder: false, automaticLoadPaused, loadOlder });
  return <><div ref={scroll.scrollRef} onScroll={scroll.onScroll} aria-label="历史测试">{items.map((entry) => <div key={entry.id} data-history-id={entry.id}>{entry.text}</div>)}</div>
    <button onClick={() => void scroll.loadOlder()}>重试更早</button>{scroll.newContent && <button onClick={scroll.jumpLatest}>新消息</button>}{scroll.autoLoadBlocked && <span>自动加载已暂停</span>}</>;
}
function geometry() {
  const container = screen.getByLabelText("历史测试");
  let extra = 0;
  Object.defineProperties(container, { clientHeight: { value: 200, configurable: true }, scrollHeight: { get: () => container.children.length * 100 + extra, configurable: true } });
  const rect = (top: number) => ({ top, bottom: top + 100, left: 0, right: 200, width: 200, height: 100, x: 0, y: top, toJSON: () => ({}) });
  vi.spyOn(container, "getBoundingClientRect").mockImplementation(() => rect(0));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) { return rect([...container.children].indexOf(this) * 100 - container.scrollTop); });
  return { container, expand: () => { extra += 200; } };
}

describe("连续滚动锚点", () => {
  it("自动加载暂停时不响应近顶滚动，手动入口仍可用，解除暂停恢复自动加载", async () => {
    const loadOlder = vi.fn().mockResolvedValue(true);
    const items = [item("a"), item("b"), item("c"), item("d")];
    const { rerender } = render(<ScrollHarness items={items} loadOlder={loadOlder} automaticLoadPaused />);
    const { container } = geometry();
    container.scrollTop = 20;
    fireEvent.scroll(container); fireEvent.scroll(container);
    expect(loadOlder).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重试更早" }));
    await settle();
    expect(loadOlder).toHaveBeenCalledTimes(1);
    fireEvent.scroll(container);
    expect(loadOlder).toHaveBeenCalledTimes(1);
    rerender(<ScrollHarness items={items} loadOlder={loadOlder} automaticLoadPaused={false} />);
    fireEvent.scroll(container);
    await settle();
    expect(loadOlder).toHaveBeenCalledTimes(2);
  });

  it("慢分页期间继续从50滚到150，tail增长不算prepend，旧页200px只补到350", async () => {
    const read = pending<boolean>();
    const loadOlder = vi.fn().mockReturnValue(read.promise);
    const items = Array.from({ length: 8 }, (_, index) => item(`row-${index}`));
    const { rerender } = render(<ScrollHarness items={items} loadOlder={loadOlder} />);
    const { container } = geometry();
    container.scrollTop = 50;
    fireEvent.scroll(container);
    expect(loadOlder).toHaveBeenCalledTimes(1);
    container.scrollTop = 150;
    fireEvent.scroll(container);
    rerender(<ScrollHarness items={[...items, item("tail")]} loadOlder={loadOlder} />);
    expect(container.scrollTop).toBe(150);
    await act(async () => read.resolve(true));
    rerender(<ScrollHarness items={[item("old-1"), item("old-2"), ...items, item("tail")]} loadOlder={loadOlder} />);
    expect(container.scrollTop).toBe(350);
    expect(loadOlder).toHaveBeenCalledTimes(1);
  });

  it("慢分页中跳到最新，迟到prepend仍跟随底部且不恢复旧阅读锚点", async () => {
    const read = pending<boolean>();
    const loadOlder = vi.fn().mockReturnValue(read.promise);
    const items = Array.from({ length: 8 }, (_, index) => item(`row-${index}`));
    const { rerender } = render(<ScrollHarness items={items} loadOlder={loadOlder} />);
    const { container } = geometry();
    container.scrollTop = 50;
    fireEvent.scroll(container);
    rerender(<ScrollHarness items={[...items, item("tail")]} loadOlder={loadOlder} />);
    fireEvent.click(screen.getByRole("button", { name: "新消息" }));
    expect(container.scrollTop).toBe(900);
    await act(async () => read.resolve(true));
    rerender(<ScrollHarness items={[item("old-1"), item("old-2"), ...items, item("tail")]} loadOlder={loadOlder} />);
    expect(container.scrollTop).toBe(1100);
    expect(screen.queryByRole("button", { name: "新消息" })).toBeNull();
  });

  it("A→B→A旧分页结果不暂停新页或解开新请求锁", async () => {
    const old = pending<boolean>();
    const current = pending<boolean>();
    const loadOlder = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const items = [item("a"), item("b"), item("c"), item("d")];
    const { rerender } = render(<ScrollHarness owner="air" items={items} loadOlder={loadOlder} />);
    const { container } = geometry();
    fireEvent.click(screen.getByRole("button", { name: "重试更早" }));
    rerender(<ScrollHarness owner="mini" items={items} loadOlder={loadOlder} />);
    rerender(<ScrollHarness owner="air" items={items} loadOlder={loadOlder} />);
    fireEvent.click(screen.getByRole("button", { name: "重试更早" }));
    await act(async () => old.resolve(false));
    expect(screen.queryByText("自动加载已暂停")).toBeNull();
    container.scrollTop = 20;
    fireEvent.scroll(container);
    expect(loadOlder).toHaveBeenCalledTimes(2);
    await act(async () => current.resolve(true));
  });

  it("靠近顶部自动单飞连续分页，失败不无限重试，保留手动入口", async () => {
    const read = pending<boolean>();
    const loadOlder = vi.fn().mockReturnValueOnce(read.promise).mockResolvedValueOnce(false).mockResolvedValue(true);
    render(<ScrollHarness items={[item("a"), item("b"), item("c"), item("d")]} loadOlder={loadOlder} />);
    const { container } = geometry();
    container.scrollTop = 20;
    fireEvent.scroll(container); fireEvent.scroll(container);
    expect(loadOlder).toHaveBeenCalledTimes(1);
    await act(async () => read.resolve(true));
    fireEvent.scroll(container);
    await settle();
    expect(loadOlder).toHaveBeenCalledTimes(2);
    expect(screen.getByText("自动加载已暂停")).toBeInTheDocument();
    fireEvent.scroll(container); fireEvent.scroll(container);
    expect(loadOlder).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "重试更早" }));
    await settle();
    expect(loadOlder).toHaveBeenCalledTimes(3);
  });

  it("同时tail增长与prepend只补偿锚点前方高度，离底新消息不抢位置", async () => {
    const read = pending<boolean>();
    const loadOlder = vi.fn().mockReturnValue(read.promise);
    const items = [item("a"), item("b"), item("c"), item("d")];
    const { rerender } = render(<ScrollHarness items={items} loadOlder={loadOlder} />);
    const { container } = geometry();
    container.scrollTop = 60;
    fireEvent.scroll(container);
    rerender(<ScrollHarness items={[...items, item("tail")]} loadOlder={loadOlder} />);
    expect(container.scrollTop).toBe(60);
    expect(screen.getByRole("button", { name: "新消息" })).toBeInTheDocument();
    rerender(<ScrollHarness items={[item("old"), ...items, item("tail")]} loadOlder={loadOlder} />);
    expect(container.scrollTop).toBe(160);
    await act(async () => read.resolve(true));
    fireEvent.click(screen.getByRole("button", { name: "新消息" }));
    expect(container.scrollTop).toBe(600);
  });

  it("工具展开不跟随到底，owner切换清除旧新消息提示", async () => {
    const items = [item("a"), item("b"), item("c"), item("d")];
    const loadOlder = vi.fn().mockResolvedValue(true);
    const { rerender } = render(<ScrollHarness items={items} loadOlder={loadOlder} />);
    const { container, expand } = geometry();
    container.scrollTop = 200;
    fireEvent.scroll(container);
    expand();
    rerender(<ScrollHarness items={[...items]} loadOlder={loadOlder} />);
    expect(container.scrollTop).toBe(200);
    container.scrollTop = 150; fireEvent.scroll(container);
    rerender(<ScrollHarness items={[...items, item("new")]} loadOlder={loadOlder} />);
    expect(screen.getByRole("button", { name: "新消息" })).toBeInTheDocument();
    rerender(<ScrollHarness owner="mini" items={[item("another")]} loadOlder={loadOlder} />);
    expect(screen.queryByRole("button", { name: "新消息" })).toBeNull();
    expect(container.scrollTop).toBe(300);
  });
});
