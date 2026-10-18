import { act, fireEvent, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSessionHistory } from "../../src/api/sessions";
import { HistoryCache, readSharedHistory } from "../../src/features/sessions/history-cache";
import { mergeHistoryPage } from "../../src/features/sessions/history-page";
import { useSessionHistory } from "../../src/features/sessions/useSessionHistory";
import { useHistoryScroll } from "../../src/features/sessions/useHistoryScroll";
import { HistoryItem, ScopedSession, SessionHistory } from "../../src/types";

vi.mock("../../src/api/sessions", async original => ({ ...await original<typeof import("../../src/api/sessions")>(), fetchSessionHistory: vi.fn() }));
const fetchHistory = vi.mocked(fetchSessionHistory);
const session: ScopedSession = { id: "session", nodeId: "air", provider: "codex-app", title: "会话", cwd: "/workspace", status: "idle", observedAt: "2026-10-11T10:00:00Z", capabilities: ["read"] };
const item = (id: string): HistoryItem => ({ id, text: id, turnId: "turn", type: "agentMessage", kind: "assistant" });
const page = (target: ScopedSession, ids: string[], nextCursor: string | null = "older"): SessionHistory => ({ session: target, historyContext: "cf7e282f-d6d2-4a98-a517-9fb753f2549b", source: "control-socket", items: ids.map(item), nextCursor, fetchedAt: "2026-10-11T10:00:00Z", truncated: false });
function pending<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const settle = () => act(async () => { await Promise.resolve(); });

beforeEach(() => {
  fetchHistory.mockReset();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("历史读取缓存", () => {
  it("切回会话立即恢复已加载的旧页，后台按原context刷新且不混入另一会话", async () => {
    const other = { ...session, id: "other" };
    const refresh = pending<SessionHistory>();
    fetchHistory.mockResolvedValueOnce(page(session, ["tail"]))
      .mockResolvedValueOnce(page(session, ["old"], null))
      .mockResolvedValueOnce(page(other, ["different"]))
      .mockReturnValueOnce(refresh.promise);
    const { result, rerender } = renderHook(({ target }) => useSessionHistory(target, true, vi.fn()), { initialProps: { target: session } });
    await settle();
    await act(async () => { await result.current.loadOlder(); });
    rerender({ target: other });
    await settle();
    expect(result.current.history?.items.map(row => row.id)).toEqual(["different"]);
    rerender({ target: session });
    expect(result.current.history?.items.map(row => row.id)).toEqual(["old", "tail"]);
    expect(fetchHistory.mock.calls[3][4]).toBe(page(session, []).historyContext);
    expect(result.current.loadingLatest).toBe(true);
    await act(async () => refresh.resolve(page(session, ["tail", "new"])));
    expect(result.current.history?.items.map(row => row.id)).toEqual(["old", "tail", "new"]);
    expect(result.current.history?.nextCursor).toBeNull();
  });

  it("有界LRU按最近使用、总字节和TTL释放历史", () => {
    vi.useFakeTimers();
    try {
      const cache = new HistoryCache<string>();
      for (let index = 0; index < 8; index++) cache.set(String(index), String(index), 10);
      expect(cache.get("0")).toBe("0");
      cache.set("8", "8", 10);
      expect(cache.get("1")).toBeUndefined();
      cache.set("large", "large", 4 * 1024 * 1024);
      expect(cache.get("0")).toBeUndefined();
      expect(cache.get("large")).toBe("large");
      vi.advanceTimersByTime(120_000);
      expect(cache.get("large")).toBeUndefined();
      cache.set("oversized", "oversized", 4 * 1024 * 1024 + 1);
      expect(cache.get("oversized")).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it("相同请求共享传输，一个读取者取消不会中断其他读取者", async () => {
    const remote = pending<SessionHistory>();
    fetchHistory.mockReturnValueOnce(remote.promise);
    const first = new AbortController();
    const second = new AbortController();
    const one = readSharedHistory("air", "session", undefined, first.signal);
    const two = readSharedHistory("air", "session", undefined, second.signal);
    const cancelled = expect(one).rejects.toMatchObject({ name: "AbortError" });
    first.abort();
    await cancelled;
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    expect(fetchHistory.mock.calls[0][3]?.aborted).toBe(false);
    remote.resolve(page(session, ["shared"]));
    expect((await two).items[0].id).toBe("shared");
  });

  it("最后的读取者取消会中止网络，迟到响应不能复用为新请求", async () => {
    const remote = pending<SessionHistory>();
    fetchHistory.mockReturnValueOnce(remote.promise).mockResolvedValueOnce(page(session, ["fresh"]));
    const controller = new AbortController();
    const read = readSharedHistory("air", "session", undefined, controller.signal);
    const cancelled = expect(read).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await cancelled;
    expect(fetchHistory.mock.calls[0][3]?.aborted).toBe(true);
    expect((await readSharedHistory("air", "session")).items[0].id).toBe("fresh");
    remote.resolve(page(session, ["late"]));
  });
});

describe("增量历史合并", () => {
  it("无变化的30条尾页保留整个窗口和条目引用，流式变化只替换变化行", () => {
    const current = Array.from({ length: 2000 }, (_, index) => item(String(index)));
    const tail = current.slice(-30).map(row => ({ ...row }));
    expect(mergeHistoryPage(current, tail, current.length)).toBe(current);
    tail[29] = { ...tail[29], text: "streamed" };
    const updated = mergeHistoryPage(current, tail, current.length);
    expect(updated[0]).toBe(current[0]);
    expect(updated[1998]).toBe(current[1998]);
    expect(updated[1999].text).toBe("streamed");
    expect(current[1999].text).toBe("1999");
  });

  it("合并新旧交错页时保留服务端页顺序和已有窗口顺序，重复id取最后值", () => {
    const current = [item("c"), item("f")];
    const incoming = [item("a"), item("b"), item("c"), item("d"), item("e"), item("f"), item("g"), { ...item("b"), text: "last" }];
    const result = mergeHistoryPage(current, incoming, 0);
    expect(result.map(row => row.id)).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(result[1].text).toBe("last");
    expect(result[2]).toBe(current[0]);
  });
});

function ReadingWindow({ owner, items, visible = true, detached = false, elementKey }: {
  owner: string; items: HistoryItem[]; visible?: boolean; detached?: boolean; elementKey?: string;
}) {
  const scroll = useHistoryScroll({ owner, visible, items, nextCursor: null, loadingOlder: false, loadOlder: async () => false });
  if (detached) return null;
  return <div key={elementKey} data-testid="reading-window" ref={element => {
    scroll.scrollRef.current = element;
    if (element) Object.defineProperties(element, {
      scrollHeight: { configurable: true, value: 600 }, clientHeight: { configurable: true, value: 200 },
    });
  }} onScroll={scroll.onScroll}>
    {items.map(row => <p data-history-id={row.id} key={row.id}>{row.text}</p>)}
    {scroll.newContent && <span>有新消息</span>}
  </div>;
}

it("切回缓存窗口恢复阅读位置，随后的新消息仍然不会抢滚动", () => {
  const rows = [item("a"), item("b")];
  const view = render(<ReadingWindow owner="first" items={rows} />);
  const container = view.getByTestId("reading-window");
  Object.defineProperties(container, { scrollHeight: { configurable: true, value: 600 }, clientHeight: { configurable: true, value: 200 } });
  container.scrollTop = 200;
  fireEvent.scroll(container);
  view.rerender(<ReadingWindow owner="other" items={[item("different")]} />);
  view.rerender(<ReadingWindow owner="first" items={rows} />);
  expect(container.scrollTop).toBe(200);
  view.rerender(<ReadingWindow owner="first" items={[...rows, item("new")]} />);
  expect(container.scrollTop).toBe(200);
  expect(view.getByText("有新消息")).toBeInTheDocument();
});

it("新来源的空加载页同步清除旧来源位置，页到达后继续定位最新", () => {
  const view = render(<ReadingWindow owner="automatic" items={[]} />);
  const container = view.getByTestId("reading-window");
  container.scrollTop = 180;
  fireEvent.scroll(container);
  view.rerender(<ReadingWindow owner="paged" items={[]} />);
  expect(container.scrollTop).toBe(600);
  view.rerender(<ReadingWindow owner="paged" items={[item("fresh")]} />);
  expect(container.scrollTop).toBe(600);
});

it("同owner隐藏再打开重挂DOM时恢复旧位置，隐藏期间的新消息不抢阅读", () => {
  const rows = [item("a"), item("b")];
  const view = render(<ReadingWindow owner="same" items={rows} />);
  const container = view.getByTestId("reading-window");
  container.scrollTop = 180;
  fireEvent.scroll(container);
  view.rerender(<ReadingWindow owner="same" items={rows} visible={false} detached />);
  view.rerender(<ReadingWindow owner="same" items={[...rows, item("new")]} visible={false} detached />);
  view.rerender(<ReadingWindow owner="same" items={[...rows, item("new")]} />);
  const remounted = view.getByTestId("reading-window");
  expect(remounted).not.toBe(container);
  expect(remounted.scrollTop).toBe(180);
  expect(view.getByText("有新消息")).toBeInTheDocument();
});

it("首次打开隐藏详情时定位最新页，底部状态再次打开继续跟随最新", () => {
  const rows = [item("a"), item("b")];
  const view = render(<ReadingWindow owner="same" items={rows} visible={false} detached />);
  view.rerender(<ReadingWindow owner="same" items={rows} />);
  expect(view.getByTestId("reading-window").scrollTop).toBe(600);
  view.rerender(<ReadingWindow owner="same" items={rows} visible={false} detached />);
  view.rerender(<ReadingWindow owner="same" items={[...rows, item("new")]} />);
  expect(view.getByTestId("reading-window").scrollTop).toBe(600);
  expect(view.queryByText("有新消息")).toBeNull();
});

it("详情保留DOM但不可见时忽略滚动事件，再显示仍恢复旧阅读位置", () => {
  const rows = [item("a"), item("b")];
  const view = render(<ReadingWindow owner="same" items={rows} />);
  const container = view.getByTestId("reading-window");
  container.scrollTop = 180;
  fireEvent.scroll(container);
  view.rerender(<ReadingWindow owner="same" items={rows} visible={false} />);
  container.scrollTop = 0;
  fireEvent.scroll(container);
  view.rerender(<ReadingWindow owner="same" items={rows} />);
  expect(view.getByTestId("reading-window")).toBe(container);
  expect(container.scrollTop).toBe(180);
});

it("同owner可见DOM替换仍恢复位置；历史窗口失效后不复用旧像素位置", () => {
  const rows = [item("a"), item("b")];
  const view = render(<ReadingWindow owner="same" items={rows} elementKey="first" />);
  const container = view.getByTestId("reading-window");
  container.scrollTop = 180;
  fireEvent.scroll(container);
  view.rerender(<ReadingWindow owner="same" items={rows} elementKey="second" />);
  expect(view.getByTestId("reading-window")).not.toBe(container);
  expect(view.getByTestId("reading-window").scrollTop).toBe(180);
  view.rerender(<ReadingWindow owner="same" items={rows} visible={false} detached />);
  view.rerender(<ReadingWindow owner="same" items={[item("fresh")]} />);
  expect(view.getByTestId("reading-window").scrollTop).toBe(600);
});
