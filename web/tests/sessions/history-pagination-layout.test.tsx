import { useRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useHistoryScroll } from "../../src/features/sessions/useHistoryScroll";
import type { HistoryItem } from "../../src/types";

const ROW_HEIGHT = 100;
const VIEWPORT_HEIGHT = 200;
const PAGINATION_HEIGHT = 52;
const rows: HistoryItem[] = Array.from({ length: 8 }, (_, index) => ({ id: String(index), turnId: String(index), kind: "assistant", type: "agentMessage", text: String(index) }));
const paginationHeight = (element: HTMLElement) => element.querySelector("button") ? PAGINATION_HEIGHT : 0;
const rectangle = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 300, width: 300, height, x: 0, y: top, toJSON: () => ({}) });

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const viewport = this.closest<HTMLElement>("[data-viewport]");
    if (!viewport || this === viewport) return rectangle(0, VIEWPORT_HEIGHT);
    const start = paginationHeight(viewport) - viewport.scrollTop;
    return this.classList.contains("history-content") ? rectangle(start, rows.length * ROW_HEIGHT)
      : rectangle(start + Number(this.dataset.historyId) * ROW_HEIGHT, ROW_HEIGHT);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function Window({ nextCursor }: { nextCursor: string | null }) {
  const position = useRef(0);
  const scroll = useHistoryScroll({ owner: "same-history", items: rows, nextCursor, loadingOlder: false, loadOlder: async () => false });
  return <div data-viewport aria-label="history" ref={element => {
    scroll.scrollRef.current = element;
    if (element) Object.defineProperties(element, {
      clientHeight: { configurable: true, value: VIEWPORT_HEIGHT },
      scrollHeight: { configurable: true, get: () => rows.length * ROW_HEIGHT + paginationHeight(element) },
      scrollTop: { configurable: true, get: () => { position.current = Math.min(position.current, element.scrollHeight - VIEWPORT_HEIGHT); return position.current; }, set: value => { position.current = Math.max(0, Math.min(value, element.scrollHeight - VIEWPORT_HEIGHT)); } },
    });
  }} onScroll={scroll.onScroll} onWheel={scroll.onWheel}>
    {nextCursor && <button>Older history</button>}
    <div className="history-content">{rows.map(item => <p data-history-id={item.id} key={item.id}>{item.text}</p>)}</div>
  </div>;
}

it("keeps the tail at bottom when pagination disappears and returns with identical history items", () => {
  const view = render(<Window nextCursor="older" />);
  const viewport = screen.getByLabelText("history");
  expect(viewport.scrollTop).toBe(viewport.scrollHeight - VIEWPORT_HEIGHT);
  view.rerender(<Window nextCursor={null} />);
  expect(viewport.scrollTop).toBe(viewport.scrollHeight - VIEWPORT_HEIGHT);
  view.rerender(<Window nextCursor="older" />);
  expect(viewport.scrollTop).toBe(viewport.scrollHeight - VIEWPORT_HEIGHT);
});

it.each([20, 300])("preserves an upward reader's anchor %i pixels from bottom across pagination changes", distance => {
  const view = render(<Window nextCursor="older" />);
  const viewport = screen.getByLabelText("history");
  fireEvent.wheel(viewport, { deltaY: -distance });
  viewport.scrollTop -= distance;
  fireEvent.scroll(viewport);
  const anchor = [...viewport.querySelectorAll<HTMLElement>("[data-history-id]")].find(element => {
    const rect = element.getBoundingClientRect();
    return rect.bottom > 0 && rect.top < VIEWPORT_HEIGHT;
  })!;
  const top = viewport.scrollTop;
  const offset = anchor.getBoundingClientRect().top;
  view.rerender(<Window nextCursor={null} />);
  expect(anchor.getBoundingClientRect().top).toBe(offset);
  expect(viewport.scrollTop).toBe(top - PAGINATION_HEIGHT);
  view.rerender(<Window nextCursor="older" />);
  expect(anchor.getBoundingClientRect().top).toBe(offset);
  expect(viewport.scrollTop).toBe(top);
});
