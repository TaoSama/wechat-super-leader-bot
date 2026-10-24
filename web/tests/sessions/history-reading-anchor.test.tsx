import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HistoryMessage } from "../../src/features/sessions/components/HistoryMessage";
import { useHistoryScroll } from "../../src/features/sessions/useHistoryScroll";
import type { HistoryItem } from "../../src/types";

const VIEWPORT_HEIGHT = 200;
const MESSAGE_HEIGHT = 100;
const EXPANDED_TOOL_HEIGHT = 1000;
const COLLAPSED_TOOL_HEIGHT = 40;
const READING_OFFSET = -25;
const observers: Array<{ callback: ResizeObserverCallback; disconnected: boolean }> = [];
const rows: HistoryItem[] = [
  { id: "tool", turnId: "tool-turn", kind: "tool", type: "commandExecution", title: "读取长输出", text: "工具输出\n".repeat(80), status: "completed" },
  ...Array.from({ length: 20 }, (_, index): HistoryItem => ({ id: `message-${index}`, turnId: `message-turn-${index}`, kind: "assistant", type: "agentMessage", text: `后续消息 ${index}` })),
];
const messageRows = (element: HTMLElement) => [...element.querySelectorAll<HTMLElement>("[data-history-id]")];
const rowHeight = (element: HTMLElement) => element.dataset.historyId === "tool"
  ? element.classList.contains("is-expanded") ? EXPANDED_TOOL_HEIGHT : COLLAPSED_TOOL_HEIGHT
  : MESSAGE_HEIGHT;
const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 300, width: 300, height, x: 0, y: top, toJSON: () => ({}) });
const totalHeight = (element: HTMLElement) => messageRows(element).reduce((total, row) => total + rowHeight(row), 0);
function firstVisibleId(element: HTMLElement, scrollTop = element.scrollTop) {
  let bottom = 0;
  return messageRows(element).find(row => { bottom += rowHeight(row); return bottom > scrollTop; })?.dataset.historyId;
}
const resize = () => act(() => { for (const observer of observers) if (!observer.disconnected) observer.callback([], {} as ResizeObserver); });

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("ResizeObserver", class {
    observer: typeof observers[number];
    constructor(callback: ResizeObserverCallback) { this.observer = { callback, disconnected: false }; observers.push(this.observer); }
    observe() {} unobserve() {} disconnect() { this.observer.disconnected = true; }
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const container = this.closest<HTMLElement>("[data-reading-window]");
    if (!container || container === this) return rect(0, VIEWPORT_HEIGHT);
    if (this.classList.contains("history-content")) return rect(-container.scrollTop, totalHeight(container));
    let top = 0;
    for (const row of messageRows(container)) {
      if (row === this) return rect(top - container.scrollTop, rowHeight(row));
      top += rowHeight(row);
    }
    return rect(0, 0);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function ReadingWindow({ owner = "one", visible = true }: { owner?: string; visible?: boolean }) {
  const scroll = useHistoryScroll({ owner, visible, items: rows, loadingOlder: false, nextCursor: null, loadOlder: async () => false });
  if (!visible) return null;
  return <div data-reading-window aria-label="滚动窗口" ref={element => {
    scroll.scrollRef.current = element;
    if (element) Object.defineProperties(element, {
      clientHeight: { configurable: true, value: VIEWPORT_HEIGHT },
      scrollHeight: { configurable: true, get: () => totalHeight(element) },
    });
  }} onScroll={scroll.onScroll} onClickCapture={scroll.onClickCapture}>
    <div className="history-content">{rows.map(item => <HistoryMessage key={`${owner}:${item.id}`} item={item} />)}</div>
  </div>;
}

it.each(["session", "list"] as const)("%s往返后长工具重新折叠，仍恢复到后续同一消息及相对偏移", mode => {
  const view = render(<ReadingWindow />);
  const container = screen.getByLabelText("滚动窗口");
  fireEvent.click(screen.getByRole("button", { name: "查看命令详情" })); resize();
  expect(screen.getByRole("region", { name: "命令详情" })).toBeVisible();
  container.scrollTop = EXPANDED_TOOL_HEIGHT + MESSAGE_HEIGHT - READING_OFFSET;
  fireEvent.scroll(container);
  const expandedScrollTop = container.scrollTop;
  expect(firstVisibleId(container)).toBe("message-1");
  expect(container.querySelector('[data-history-id="message-1"]')!.getBoundingClientRect().top).toBe(READING_OFFSET);

  if (mode === "session") view.rerender(<ReadingWindow owner="other" />);
  else view.rerender(<ReadingWindow visible={false} />);
  view.rerender(<ReadingWindow />);

  const reopened = screen.getByLabelText("滚动窗口");
  expect(screen.getByRole("button", { name: "查看命令详情" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByRole("region", { name: "命令详情" })).toBeNull();
  expect(firstVisibleId(reopened, expandedScrollTop)).toBe("message-10");
  expect(firstVisibleId(reopened)).toBe("message-1");
  expect(reopened.scrollTop).toBe(COLLAPSED_TOOL_HEIGHT + MESSAGE_HEIGHT - READING_OFFSET);
  expect(reopened.querySelector('[data-history-id="message-1"]')!.getBoundingClientRect().top).toBe(READING_OFFSET);
});
