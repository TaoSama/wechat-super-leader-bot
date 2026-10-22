import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiHistoryError } from "../../src/api/errors";
import { fetchSessionHistory } from "../../src/api/sessions";
import { useSessionHistory } from "../../src/features/sessions/useSessionHistory";
import { HistoryItem, ScopedSession, SessionHistory } from "../../src/types";

vi.mock("../../src/api/sessions", async original => ({ ...await original<typeof import("../../src/api/sessions")>(), fetchSessionHistory: vi.fn() }));
const fetchHistory = vi.mocked(fetchSessionHistory);
const OLD_CONTEXT = "cf7e282f-d6d2-4a98-a517-9fb753f2549b";
const NEW_CONTEXT = "15c9ef38-59cc-410c-a0f0-6a54bcd7f41a";
const target: ScopedSession = { id: "session", nodeId: "air", provider: "codex-app", title: "会话", cwd: "/workspace", status: "idle", observedAt: "2026-10-11T10:00:00Z", capabilities: ["read"] };
const row = (id: string): HistoryItem => ({ id, text: id, turnId: "turn", type: "agentMessage", kind: "assistant" });
const page = (ids: string[], historyContext = OLD_CONTEXT): SessionHistory => ({ session: target, historyContext, source: "control-socket", items: ids.map(row), nextCursor: `${historyContext}-older`, fetchedAt: "2026-10-11T10:00:00Z", truncated: false });
const expired = () => new ApiHistoryError(409, "history_context_expired", "expired");
const settle = () => act(async () => { await Promise.resolve(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
function pending<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }

beforeEach(() => {
  vi.useFakeTimers();
  fetchHistory.mockReset();
  fetchHistory.mockResolvedValue(page(["fresh"], NEW_CONTEXT));
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("过期历史上下文恢复", () => {
  it("仅最新页自动建立同一会话新context，保留旧画面直至新页成功并丢弃旧cursor", async () => {
    const replacement = pending<SessionHistory>();
    fetchHistory.mockResolvedValueOnce(page(["old"])).mockRejectedValueOnce(expired()).mockReturnValueOnce(replacement.promise);
    const { result } = renderHook(() => useSessionHistory(target, true, vi.fn()));
    await settle(); await advance(2000);
    expect(fetchHistory).toHaveBeenCalledTimes(3);
    expect(fetchHistory.mock.calls[1][4]).toBe(OLD_CONTEXT);
    expect(fetchHistory.mock.calls[2]).toEqual(["air", "session", undefined, expect.any(AbortSignal), undefined, undefined]);
    expect(result.current.history?.items.map(item => item.id)).toEqual(["old"]);
    expect(result.current.history?.nextCursor).toBeNull();
    expect(result.current.loadingLatest).toBe(true);
    expect(result.current.contextExpired).toBe(false);
    await act(async () => replacement.resolve({ ...page(["new"], NEW_CONTEXT), source: "codex-desktop" }));
    expect(result.current.history?.items.map(item => item.id)).toEqual(["new"]);
    expect(result.current.history?.source).toBe("codex-desktop");
    expect(result.current.error).toBeNull();
    fetchHistory.mockResolvedValue({ ...page(["new"], NEW_CONTEXT), source: "codex-desktop" });
    await advance(2000);
    expect(fetchHistory.mock.calls[3][4]).toBe(NEW_CONTEXT);
    await act(async () => { await result.current.loadOlder(); });
    expect(fetchHistory.mock.calls[4][2]).toBe(`${NEW_CONTEXT}-older`);
    expect(fetchHistory.mock.calls[4][4]).toBe(NEW_CONTEXT);
  });

  it("首屏正在向上阅读时409保留窗口，明确reset后才替换", async () => {
    fetchHistory.mockResolvedValueOnce(page(["reading"])).mockRejectedValueOnce(expired());
    const { result } = renderHook(() => useSessionHistory(target, true, vi.fn()));
    await settle();
    const setReadingLatest = result.current.setReadingLatest;
    act(() => result.current.setReadingLatest(false));
    await advance(2000);
    expect(result.current.contextExpired).toBe(true);
    expect(result.current.history?.items.map(item => item.id)).toEqual(["reading"]);
    expect(result.current.setReadingLatest).toBe(setReadingLatest);
    await advance(60_000);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    await act(async () => { expect(await result.current.resetLatest()).toBe(true); });
    expect(fetchHistory.mock.calls[2][4]).toBeUndefined();
    expect(result.current.history?.items.map(item => item.id)).toEqual(["fresh"]);
  });

  it("自动恢复请求途中开始向上读时也不能用新页覆盖原窗", async () => {
    const replacement = pending<SessionHistory>();
    fetchHistory.mockResolvedValueOnce(page(["reading"])).mockRejectedValueOnce(expired()).mockReturnValueOnce(replacement.promise);
    const { result } = renderHook(() => useSessionHistory(target, true, vi.fn()));
    await settle(); await advance(2000);
    act(() => result.current.setReadingLatest(false));
    await act(async () => replacement.resolve(page(["replacement"], NEW_CONTEXT)));
    expect(result.current.contextExpired).toBe(true);
    expect(result.current.history?.items.map(item => item.id)).toEqual(["reading"]);
    await advance(60_000);
    expect(fetchHistory).toHaveBeenCalledTimes(3);
    await act(async () => { expect(await result.current.resetLatest()).toBe(true); });
    expect(result.current.history?.items.map(item => item.id)).toEqual(["fresh"]);
  });

  it("新会话默认阅读最新页，不沿用上个会话的阅读位置标记", async () => {
    const other = { ...target, id: "other" };
    fetchHistory.mockResolvedValueOnce(page(["original"]))
      .mockResolvedValueOnce({ ...page(["other-old"]), session: other }).mockRejectedValueOnce(expired())
      .mockResolvedValueOnce({ ...page(["other-new"], NEW_CONTEXT), session: other });
    const { result, rerender } = renderHook(({ session }) => useSessionHistory(session, true, vi.fn()), { initialProps: { session: target } });
    await settle();
    act(() => result.current.setReadingLatest(false));
    rerender({ session: other }); await settle(); await advance(2000);
    expect(result.current.contextExpired).toBe(false);
    expect(result.current.history?.items.map(item => item.id)).toEqual(["other-new"]);
    expect(fetchHistory.mock.calls[3][4]).toBeUndefined();
  });

  it("自动恢复失败后仍用新context退避重试，不重复使用淘汰context或合并旧来源", async () => {
    fetchHistory.mockResolvedValueOnce(page(["old"])).mockRejectedValueOnce(expired()).mockRejectedValueOnce(new Error("temporary"));
    const { result } = renderHook(() => useSessionHistory(target, true, vi.fn()));
    await settle(); await advance(2000);
    expect(result.current.history?.items[0].id).toBe("old");
    expect(result.current.error).toBe("temporary");
    await advance(7999);
    expect(fetchHistory).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(fetchHistory.mock.calls[3][4]).toBeUndefined();
    expect(result.current.history?.items.map(item => item.id)).toEqual(["fresh"]);
    expect(result.current.history?.historyContext).toBe(NEW_CONTEXT);
  });

  it("恢复页仍验证精确session，错误会话不能替换旧画面", async () => {
    fetchHistory.mockResolvedValueOnce(page(["old"])).mockRejectedValueOnce(expired())
      .mockResolvedValueOnce({ ...page(["wrong"], NEW_CONTEXT), session: { ...target, id: "other" } });
    const { result } = renderHook(() => useSessionHistory(target, true, vi.fn()));
    await settle(); await advance(2000);
    expect(result.current.error).toContain("不匹配");
    expect(result.current.history?.items.map(item => item.id)).toEqual(["old"]);
    await advance(8000);
    expect(result.current.history?.items.map(item => item.id)).toEqual(["fresh"]);
  });

  it("显式分页来源恢复时保留选择，拒绝桌面响应", async () => {
    fetchHistory.mockResolvedValueOnce(page(["initial"])).mockResolvedValueOnce(page(["paged"]))
      .mockRejectedValueOnce(expired()).mockResolvedValueOnce({ ...page(["wrong"], NEW_CONTEXT), source: "codex-desktop" });
    const { result } = renderHook(() => useSessionHistory(target, true, vi.fn()));
    await settle();
    await act(async () => { await result.current.usePagedHistory(); });
    await advance(2000);
    expect(fetchHistory.mock.calls[3][4]).toBeUndefined();
    expect(fetchHistory.mock.calls[3][5]).toBe("control-socket");
    expect(result.current.history?.items.map(item => item.id)).toEqual(["paged"]);
    expect(result.current.error).toContain("不匹配");
    await advance(8000);
    expect(result.current.history?.items.map(item => item.id)).toEqual(["fresh"]);
    expect(fetchHistory.mock.calls[4][5]).toBe("control-socket");
  });

  it("向上翻页请求409保留原窗口并暂停，明确reset后才丢旧context", async () => {
    fetchHistory.mockResolvedValueOnce(page(["read"])).mockRejectedValueOnce(expired());
    const { result } = renderHook(() => useSessionHistory(target, true, vi.fn()));
    await settle();
    await act(async () => { expect(await result.current.loadOlder()).toBe(false); });
    expect(result.current.contextExpired).toBe(true);
    expect(result.current.pollingPaused).toBe(true);
    expect(result.current.error).toContain("已保留读取内容");
    expect(result.current.history?.items.map(item => item.id)).toEqual(["read"]);
    await advance(60_000);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
    await act(async () => { expect(await result.current.resetLatest()).toBe(true); });
    expect(fetchHistory.mock.calls[2][4]).toBeUndefined();
    expect(result.current.history?.items.map(item => item.id)).toEqual(["fresh"]);
  });

  it("切换会话再返回仍保护缓存的旧页窗口", async () => {
    fetchHistory.mockResolvedValueOnce(page(["tail"])).mockResolvedValueOnce(page(["older"]))
      .mockResolvedValueOnce({ ...page(["other"], NEW_CONTEXT), session: { ...target, id: "other" } }).mockRejectedValueOnce(expired());
    const { result, rerender } = renderHook(({ session }) => useSessionHistory(session, true, vi.fn()), { initialProps: { session: target } });
    await settle();
    await act(async () => { await result.current.loadOlder(); });
    rerender({ session: { ...target, id: "other" } }); await settle();
    rerender({ session: target }); await settle();
    expect(result.current.history?.items.map(item => item.id)).toEqual(["older", "tail"]);
    expect(result.current.contextExpired).toBe(true);
    await advance(60_000);
    expect(fetchHistory).toHaveBeenCalledTimes(4);
  });

  it("轮询累积的较早行同样保留，不能因尚未loadOlder自动丢弃", async () => {
    fetchHistory.mockResolvedValueOnce(page(["a", "b"])).mockResolvedValueOnce(page(["b", "c"]))
      .mockRejectedValueOnce(expired());
    const { result } = renderHook(() => useSessionHistory(target, true, vi.fn()));
    await settle(); await advance(4000);
    expect(result.current.history?.items.map(item => item.id)).toEqual(["a", "b", "c"]);
    expect(result.current.contextExpired).toBe(true);
    await advance(60_000);
    expect(fetchHistory).toHaveBeenCalledTimes(3);
  });

  it("终端文本上下文仍需明确重读，409不自动替换其来源", async () => {
    const terminal: ScopedSession = { ...target, id: `terminal:${"A".repeat(43)}`, provider: "terminal/claude",
      historySource: "terminal-transcript", observedAt: new Date(Date.now()).toISOString() };
    const terminalPage: SessionHistory = { ...page(["terminal-read"]), session: terminal, source: "terminal-transcript" };
    fetchHistory.mockResolvedValueOnce(terminalPage).mockRejectedValueOnce(expired());
    const { result } = renderHook(() => useSessionHistory(terminal, true, vi.fn()));
    await settle(); await advance(2000);
    expect(result.current.contextExpired).toBe(true);
    expect(result.current.history?.items.map(item => item.id)).toEqual(["terminal-read"]);
    await advance(30_000);
    expect(fetchHistory).toHaveBeenCalledTimes(2);
  });

  it("首次没有context的409不会自动重试循环", async () => {
    fetchHistory.mockRejectedValue(expired());
    const { result } = renderHook(() => useSessionHistory(target, true, vi.fn()));
    await settle(); await advance(60_000);
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    expect(result.current.contextExpired).toBe(true);
    expect(result.current.history).toBeNull();
  });

  it("自动恢复新context连续409也不会循环", async () => {
    fetchHistory.mockResolvedValueOnce(page(["old"])).mockRejectedValue(expired());
    const { result } = renderHook(() => useSessionHistory(target, true, vi.fn()));
    await settle(); await advance(2000);
    expect(fetchHistory).toHaveBeenCalledTimes(3);
    expect(result.current.contextExpired).toBe(true);
    expect(result.current.history?.items.map(item => item.id)).toEqual(["old"]);
    await advance(60_000);
    expect(fetchHistory).toHaveBeenCalledTimes(3);
  });

  it("恢复途中切换会话会取消旧请求，迟到响应不会污染新会话", async () => {
    const replacement = pending<SessionHistory>();
    fetchHistory.mockResolvedValueOnce(page(["old"])).mockRejectedValueOnce(expired()).mockReturnValueOnce(replacement.promise)
      .mockResolvedValueOnce({ ...page(["other"], NEW_CONTEXT), session: { ...target, id: "other" } });
    const { result, rerender } = renderHook(({ session }) => useSessionHistory(session, true, vi.fn()), { initialProps: { session: target } });
    await settle(); await advance(2000);
    const signal = fetchHistory.mock.calls[2][3];
    rerender({ session: { ...target, id: "other" } }); await settle();
    expect(signal?.aborted).toBe(true);
    await act(async () => replacement.resolve(page(["late"], NEW_CONTEXT)));
    expect(result.current.history?.items.map(item => item.id)).toEqual(["other"]);
  });

  it("空最新页的最新精确turnStatuses更新保留旧工具，后续inProgress观测也生效", async () => {
    const initial = page(["tool"]);
    initial.items = [{ ...row("tool"), kind: "tool", turnStatus: "inProgress" }];
    fetchHistory.mockResolvedValueOnce(initial).mockResolvedValueOnce({ ...page([]), turnStatuses: { turn: "completed" } })
      .mockResolvedValueOnce({ ...page([]), turnStatuses: { turn: "inProgress" } });
    const { result } = renderHook(() => useSessionHistory(target, true, vi.fn()));
    await settle(); await advance(2000);
    expect(result.current.history?.items[0].turnStatus).toBe("completed");
    await advance(2000);
    expect(result.current.history?.items[0].turnStatus).toBe("inProgress");
  });
});
