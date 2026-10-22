import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useHistoryScroll } from "../../src/features/sessions/useHistoryScroll";
import { HistoryTurn } from "../../src/features/sessions/components/HistoryTurn";
import { historyTurns } from "../../src/features/sessions/history-turns";
import type { HistoryItem } from "../../src/types";

const SELECTOR = "[data-history-id], [data-history-group]";
const heights = new Map<string, number>();
const geometryCache = new Map<HTMLElement, Map<HTMLElement, { top: number; height: number }>>();
const observers: Array<{ callback: ResizeObserverCallback; disconnected: boolean }> = [];
const row = (id: string, kind: HistoryItem["kind"] = "assistant", turnId = id): HistoryItem => ({ id, kind, turnId, text: id, type: kind === "tool" ? "commandExecution" : "agentMessage", turnStatus: "completed", status: kind === "tool" ? "completed" : undefined });
const rowKey = (element: HTMLElement) => element.dataset.historyId ?? element.dataset.historyGroup!;
const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 300, width: 300, height, x: 0, y: top, toJSON: () => ({}) });
let measured: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  heights.clear(); geometryCache.clear(); observers.length = 0;
  vi.stubGlobal("ResizeObserver", class {
    observer: typeof observers[number];
    constructor(callback: ResizeObserverCallback) { this.observer = { callback, disconnected: false }; observers.push(this.observer); }
    observe() {} unobserve() {} disconnect() { this.observer.disconnected = true; }
  });
  measured = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const container = this.closest<HTMLElement>("[data-reading-window]");
    if (!container || container === this) return rect(0, 200);
    if (this.classList.contains("history-content")) {
      const height = [...container.querySelectorAll<HTMLElement>(SELECTOR)].reduce((total, element) => total + (heights.get(rowKey(element)) ?? 100), 0);
      return rect(-container.scrollTop, height);
    }
    let coordinates = geometryCache.get(container);
    if (!coordinates) {
      coordinates = new Map();
      let top = 0;
      for (const element of container.querySelectorAll<HTMLElement>(SELECTOR)) {
        const height = heights.get(rowKey(element)) ?? 100;
        coordinates.set(element, { top, height });
        top += height;
      }
      geometryCache.set(container, coordinates);
    }
    const position = coordinates.get(this);
    return position ? rect(position.top - container.scrollTop, position.height) : rect(0, 0);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const resize = () => act(() => { geometryCache.clear(); for (const observer of observers) if (!observer.disconnected) observer.callback([], {} as ResizeObserver); });

function Window({ items, owner = "one", grouped = false }: { items: HistoryItem[]; owner?: string; grouped?: boolean }) {
  const scroll = useHistoryScroll({ owner, items, loadingOlder: false, nextCursor: null, loadOlder: async () => false });
  return <><div data-reading-window aria-label="滚动窗口" ref={element => {
    scroll.scrollRef.current = element;
    if (element) Object.defineProperties(element, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, get: () => [...element.querySelectorAll<HTMLElement>(SELECTOR)].reduce((total, row) => total + (heights.get(rowKey(row)) ?? 100), 0) },
    });
  }} onScroll={scroll.onScroll} onWheel={scroll.onWheel} onTouchStart={scroll.onTouchStart} onTouchMove={scroll.onTouchMove} onKeyDown={scroll.onKeyDown} onClickCapture={scroll.onClickCapture}>
    <div className="history-content">{grouped ? historyTurns(items, []).map(turn => <HistoryTurn key={`${owner}:${turn.key}`} turn={turn} />) : items.map(item => <p data-history-id={item.id} key={item.id}>{item.text}</p>)}</div>
  </div>{scroll.newContent && <button onClick={scroll.jumpLatest}>回到最新</button>}</>;
}

it("晚到内容变高和旧消息文字增长保持当前消息视觉位置，尾部新增不抢滚动", () => {
  const rows = Array.from({ length: 20 }, (_, index) => row(String(index)));
  const view = render(<Window items={rows} />);
  const container = screen.getByLabelText("滚动窗口");
  container.scrollTop = 550; fireEvent.scroll(container);
  heights.set("0", 280); resize();
  expect(container.scrollTop).toBe(730);
  heights.set("1", 170);
  geometryCache.clear();
  view.rerender(<Window items={rows.map(item => item.id === "1" ? { ...item, text: "晚到的更长内容" } : item)} />);
  expect(container.scrollTop).toBe(800);
  geometryCache.clear();
  view.rerender(<Window items={[...rows, row("new")]} />);
  expect(container.scrollTop).toBe(800);
  expect(screen.getByRole("button", { name: "回到最新" })).toBeVisible();
});

it("2000行连续滚动重用几何缓存，不逐帧测量每条DOM", () => {
  const rows = Array.from({ length: 2000 }, (_, index) => row(String(index)));
  render(<Window items={rows} />);
  const container = screen.getByLabelText("滚动窗口");
  measured.mockClear();
  for (let step = 0; step < 50; step++) { container.scrollTop = 50000 - step * 100; fireEvent.scroll(container); }
  expect(measured).not.toHaveBeenCalled();
});

it.each(["wheel", "touch", "keyboard"])("%s向上阅读意图在靠近底部时也立即停止跟随，新消息不会把人拉回去", mode => {
  const rows = Array.from({ length: 8 }, (_, index) => row(String(index)));
  const view = render(<Window items={rows} />);
  const container = screen.getByLabelText("滚动窗口");
  container.scrollTop = 600; fireEvent.scroll(container);
  if (mode === "wheel") fireEvent.wheel(container, { deltaY: -20 });
  if (mode === "touch") { fireEvent.touchStart(container, { touches: [{ clientY: 100 }] }); fireEvent.touchMove(container, { touches: [{ clientY: 120 }] }); }
  if (mode === "keyboard") fireEvent.keyDown(container, { key: "ArrowUp" });
  container.scrollTop = 580; fireEvent.scroll(container);
  geometryCache.clear();
  view.rerender(<Window items={[...rows, row("new")]} />);
  expect(container.scrollTop).toBe(580);
  fireEvent.click(screen.getByRole("button", { name: "回到最新" }));
  expect(container.scrollTop).toBe(900);
});

const groupedRows = () => [row("question", "user", "turn"), row("tool-a", "tool", "turn"), row("tool-b", "tool", "turn"), row("answer", "assistant", "turn"), ...Array.from({ length: 10 }, (_, index) => row(`tail-${index}`))];
it("收起当前可见工具后锚点回退同轮摘要，消息不会跳到无关轮次", () => {
  render(<Window grouped items={groupedRows()} />);
  const container = screen.getByLabelText("滚动窗口");
  const button = screen.getByRole("button", { name: /2 项工具记录/ });
  fireEvent.click(button); resize();
  container.scrollTop = 250; fireEvent.scroll(container);
  expect(container.querySelector('[data-history-id="tool-a"]')).not.toBeNull();
  fireEvent.click(button); resize();
  expect(container.scrollTop).toBe(100);
  expect(button.getBoundingClientRect().top).toBe(0);
  expect(screen.getByText("answer")).toBeVisible();
});

it("快速切回会话时读过的工具已重新折叠，阅读位置回到同轮摘要", () => {
  const rows = groupedRows();
  const view = render(<Window grouped items={rows} />);
  const container = screen.getByLabelText("滚动窗口");
  fireEvent.click(screen.getByRole("button", { name: /2 项工具记录/ })); resize();
  container.scrollTop = 250; fireEvent.scroll(container);
  geometryCache.clear();
  view.rerender(<Window owner="other" grouped items={[row("other")]} />);
  geometryCache.clear();
  view.rerender(<Window grouped items={rows} />);
  expect(container.scrollTop).toBe(100);
  expect(screen.getByRole("button", { name: /2 项工具记录/ }).getBoundingClientRect().top).toBe(0);
});

it("父轮询且items未变时保持同一个ResizeObserver，不重新全列表测量", () => {
  const rows = Array.from({ length: 40 }, (_, index) => row(String(index)));
  const view = render(<Window items={rows} />);
  expect(observers).toHaveLength(1);
  measured.mockClear();
  view.rerender(<Window items={rows} />);
  view.rerender(<Window items={rows} />);
  expect(observers).toHaveLength(1);
  expect(measured).not.toHaveBeenCalled();
  resize();
  expect(measured).toHaveBeenCalledTimes(1);
});

it("停在最新时异步字体或内容增高继续跟随尾部，主动展开工具则保留阅读位置", () => {
  const rows = Array.from({ length: 8 }, (_, index) => row(String(index)));
  const view = render(<Window items={rows} />);
  const container = screen.getByLabelText("滚动窗口");
  container.scrollTop = 600; fireEvent.scroll(container);
  heights.set("0", 300); resize();
  expect(container.scrollTop).toBe(1000);
  view.unmount();
  geometryCache.clear();
  render(<Window grouped items={groupedRows()} />);
  const grouped = screen.getByLabelText("滚动窗口");
  grouped.scrollTop = grouped.scrollHeight - 200; fireEvent.scroll(grouped);
  const previous = grouped.scrollTop;
  fireEvent.click(screen.getByRole("button", { name: /2 项工具记录/ })); resize();
  expect(grouped.scrollTop).toBe(previous + 200);
  expect(grouped.scrollTop).not.toBe(grouped.scrollHeight);
});
