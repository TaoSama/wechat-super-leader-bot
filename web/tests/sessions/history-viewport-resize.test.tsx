import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useHistoryScroll } from "../../src/features/sessions/useHistoryScroll";
import type { HistoryItem } from "../../src/types";

const ROW_HEIGHT = 100;
const CONTENT_WIDTH = 360;
const NARROW_CONTENT_WIDTH = 240;
const INITIAL_VIEWPORT_HEIGHT = 500;
const SMALL_VIEWPORT_HEIGHT = 250;
const rows: HistoryItem[] = Array.from({ length: 10 }, (_, index) => ({
  id: String(index), text: String(index), kind: "assistant", type: "agentMessage", turnId: String(index),
}));
const observers: Array<{ callback: ResizeObserverCallback; targets: Element[]; disconnected: boolean }> = [];
let viewportHeight: number;
let contentWidth: number;
let firstRowGrowth: number;
let latestChanged: ReturnType<typeof vi.fn>;
let measured: ReturnType<typeof vi.spyOn>;
const contentHeight = () => viewportHeight > 0 ? rows.length * ROW_HEIGHT + firstRowGrowth : 0;
const rect = (top: number, height: number) => ({
  top, bottom: top + height, left: 0, right: contentWidth, width: contentWidth, height, x: 0, y: top, toJSON: () => ({}),
});

beforeEach(() => {
  viewportHeight = INITIAL_VIEWPORT_HEIGHT;
  contentWidth = CONTENT_WIDTH;
  firstRowGrowth = 0;
  observers.length = 0;
  latestChanged = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    state: typeof observers[number];
    constructor(callback: ResizeObserverCallback) {
      this.state = { callback, targets: [], disconnected: false };
      observers.push(this.state);
    }
    observe(target: Element) { this.state.targets.push(target); }
    disconnect() { this.state.disconnected = true; }
  });
  measured = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function(this: HTMLElement) {
    const container = this.closest<HTMLElement>("[data-reading-window]");
    if (!container || container === this) return rect(0, viewportHeight);
    if (this.classList.contains("history-content")) return rect(-container.scrollTop, contentHeight());
    const index = Number(this.dataset.historyId);
    const top = index * ROW_HEIGHT + (index > 0 ? firstRowGrowth : 0);
    return rect(top - container.scrollTop, ROW_HEIGHT + (index === 0 ? firstRowGrowth : 0));
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function Window({ owner = "session", visible = true, items = rows, loadingOlder = false }: {
  owner?: string; visible?: boolean; items?: HistoryItem[]; loadingOlder?: boolean;
}) {
  const scroll = useHistoryScroll({ owner, visible, items, loadingOlder, nextCursor: null,
    loadOlder: async () => false, onReadingLatestChange: latestChanged });
  return <><div data-reading-window hidden={!visible} aria-label="history" onScroll={scroll.onScroll} onWheel={scroll.onWheel}
    onKeyDown={scroll.onKeyDown} ref={element => {
      scroll.scrollRef.current = element;
      if (!element) return;
      let top = element.scrollTop;
      Object.defineProperties(element, {
        clientHeight: { configurable: true, get: () => element.hidden ? 0 : viewportHeight },
        scrollHeight: { configurable: true, get: () => element.hidden ? 0 : contentHeight() },
        scrollTop: { configurable: true,
          get: () => element.hidden ? 0 : Math.min(top, Math.max(0, contentHeight() - viewportHeight)),
          set: (value: number) => { top = Math.max(0, Math.min(value, contentHeight() - viewportHeight)); },
        },
      });
    }}><div className="history-content">{items.map(row => <p data-history-id={row.id} key={row.id}>{row.text}</p>)}</div></div>
    {scroll.newContent && <button onClick={scroll.jumpLatest}>回到最新</button>}</>;
}

function deliverResize() {
  act(() => {
    for (const observer of observers) if (!observer.disconnected) observer.callback([], {} as ResizeObserver);
  });
}

it("隐藏后尺寸变化再打开时，先恢复保存的阅读锚点，不捕获临时归零位置", () => {
  const view = render(<Window />);
  const container = screen.getByLabelText("history");
  container.scrollTop = 350;
  fireEvent.scroll(container);
  viewportHeight = SMALL_VIEWPORT_HEIGHT;
  deliverResize();
  view.rerender(<Window visible={false} />);
  expect(container.scrollTop).toBe(0);
  viewportHeight = INITIAL_VIEWPORT_HEIGHT;
  view.rerender(<Window />);
  expect(container.scrollTop).toBe(350);
  expect(container.querySelector('[data-history-id="3"]')!.getBoundingClientRect().top).toBe(-50);
});

it("首次从不可测高度变为可测高度不覆盖用户刚选择的阅读位置", () => {
  viewportHeight = 0;
  render(<Window />);
  const container = screen.getByLabelText("history");
  viewportHeight = INITIAL_VIEWPORT_HEIGHT;
  container.scrollTop = 350;
  fireEvent.scroll(container);
  deliverResize();
  expect(container.scrollTop).toBe(350);
  expect(latestChanged).toHaveBeenLastCalledWith(false);
  viewportHeight = SMALL_VIEWPORT_HEIGHT;
  deliverResize();
  expect(container.scrollTop).toBe(350);
});

it.each(["observer-first", "scroll-first", "render-first"])("容器缩小保持最新消息，覆盖 %s 的通知顺序", order => {
  const view = render(<Window />);
  const container = screen.getByLabelText("history");
  expect(container.scrollTop).toBe(500);
  viewportHeight = SMALL_VIEWPORT_HEIGHT;
  if (order === "scroll-first") fireEvent.scroll(container);
  if (order === "render-first") view.rerender(<Window />);
  deliverResize();
  fireEvent.scroll(container);
  expect(container.scrollTop).toBe(750);
  expect(container.scrollTop + container.clientHeight).toBe(container.scrollHeight);
  expect(latestChanged).toHaveBeenLastCalledWith(true);
  expect(screen.queryByRole("button", { name: "回到最新" })).not.toBeInTheDocument();
});

it.each(["observer-first", "scroll-first", "render-first"])("向上阅读时容器缩小保持原锚点，覆盖 %s", order => {
  const view = render(<Window />);
  const container = screen.getByLabelText("history");
  fireEvent.wheel(container, { deltaY: -ROW_HEIGHT });
  container.scrollTop = 350;
  fireEvent.scroll(container);
  viewportHeight = SMALL_VIEWPORT_HEIGHT;
  if (order === "scroll-first") fireEvent.scroll(container);
  if (order === "render-first") view.rerender(<Window />);
  deliverResize();
  fireEvent.scroll(container);
  expect(container.scrollTop).toBe(350);
  expect(container.querySelector('[data-history-id="3"]')!.getBoundingClientRect().top).toBe(-50);
  expect(latestChanged).toHaveBeenLastCalledWith(false);
});

it("resize 已发生而 observer 尚未处理时，向上阅读意图优先于跟底", () => {
  render(<Window />);
  const container = screen.getByLabelText("history");
  viewportHeight = SMALL_VIEWPORT_HEIGHT;
  fireEvent.keyDown(container, { key: "ArrowUp" });
  container.scrollTop = 480;
  fireEvent.scroll(container);
  deliverResize();
  expect(container.scrollTop).toBe(480);
  expect(latestChanged).toHaveBeenLastCalledWith(false);
});

it.each(["observer-first", "scroll-first"])("resize 同时拖动滚动条向上时不强制跟底，覆盖 %s", order => {
  render(<Window />);
  const container = screen.getByLabelText("history");
  viewportHeight = SMALL_VIEWPORT_HEIGHT;
  container.scrollTop = 350;
  if (order === "scroll-first") fireEvent.scroll(container);
  deliverResize();
  fireEvent.scroll(container);
  expect(container.scrollTop).toBe(350);
  expect(latestChanged).toHaveBeenLastCalledWith(false);
});

it("容器变高时浏览器夹限 scrollTop 不会丢失跟底状态，随后缩小仍跟底", () => {
  render(<Window />);
  const container = screen.getByLabelText("history");
  viewportHeight = 750;
  fireEvent.scroll(container);
  deliverResize();
  expect(container.scrollTop).toBe(250);
  viewportHeight = SMALL_VIEWPORT_HEIGHT;
  deliverResize();
  expect(container.scrollTop).toBe(750);
});

it.each(["observer-first", "render-first"])("只改变容器高度不重新测量全部行，并且重复通知幂等，覆盖 %s", order => {
  const view = render(<Window />);
  const container = screen.getByLabelText("history");
  measured.mockClear();
  viewportHeight = SMALL_VIEWPORT_HEIGHT;
  if (order === "render-first") view.rerender(<Window />);
  deliverResize();
  deliverResize();
  expect(container.scrollTop).toBe(750);
  expect(measured.mock.instances.filter(element => (element as HTMLElement).dataset.historyId !== undefined)).toHaveLength(0);
});

it.each(["observer-first", "render-first"])("容器宽度变化即使内容总高度未变也重新测量行，覆盖 %s", order => {
  const view = render(<Window />);
  const container = screen.getByLabelText("history");
  measured.mockClear();
  viewportHeight = SMALL_VIEWPORT_HEIGHT;
  contentWidth = NARROW_CONTENT_WIDTH;
  if (order === "render-first") {
    view.rerender(<Window />);
    expect(measured.mock.instances.filter(element => (element as HTMLElement).dataset.historyId !== undefined).length).toBeGreaterThan(0);
  }
  deliverResize();
  expect(container.scrollTop).toBe(750);
  expect(measured.mock.instances.filter(element => (element as HTMLElement).dataset.historyId !== undefined).length).toBeGreaterThan(0);
});

it.each(["items", "loadingOlder"])("容器高度变化与 %s 更新同批发生时仍重新测量行", changed => {
  const view = render(<Window />);
  measured.mockClear();
  viewportHeight = SMALL_VIEWPORT_HEIGHT;
  view.rerender(<Window items={changed === "items" ? [...rows] : rows} loadingOlder={changed === "loadingOlder"} />);
  expect(measured.mock.instances.filter(element => (element as HTMLElement).dataset.historyId !== undefined).length).toBeGreaterThan(0);
});

it.each(["observer-first", "render-first"])("容器缩小与旧消息增高同批发生时，阅读锚点按新几何恢复，覆盖 %s", order => {
  const view = render(<Window />);
  const container = screen.getByLabelText("history");
  container.scrollTop = 350;
  fireEvent.scroll(container);
  viewportHeight = SMALL_VIEWPORT_HEIGHT;
  firstRowGrowth = 200;
  if (order === "render-first") view.rerender(<Window />);
  deliverResize();
  expect(container.scrollTop).toBe(550);
  expect(container.querySelector('[data-history-id="3"]')!.getBoundingClientRect().top).toBe(-50);
});

it("切换会话后旧 observer 的迟到容器通知不改变新会话阅读位置", () => {
  const view = render(<Window />);
  const stale = observers[0];
  view.rerender(<Window owner="other" />);
  const container = screen.getByLabelText("history");
  container.scrollTop = 350;
  fireEvent.scroll(container);
  viewportHeight = SMALL_VIEWPORT_HEIGHT;
  act(() => stale.callback([], {} as ResizeObserver));
  expect(container.scrollTop).toBe(350);
  deliverResize();
  expect(container.scrollTop).toBe(350);
});
