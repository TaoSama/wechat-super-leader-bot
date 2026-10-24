import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { HistoryItem } from "../../types";

const NEAR_TOP_PX = 96;
const NEAR_BOTTOM_PX = 64;
const MAX_READING_POSITIONS = 8;
interface Options {
  owner: string;
  visible?: boolean;
  items: HistoryItem[];
  nextCursor: string | null;
  loadingOlder: boolean;
  automaticLoadPaused?: boolean;
  loadOlder: (beforeId?: string) => Promise<boolean>;
  onReadingLatestChange?: (latest: boolean) => void;
}
interface Anchor { element: HTMLElement; offset: number; fallback?: { element: HTMLElement; offset: number } }
interface RowGeometry { element: HTMLElement; top: number; bottom: number; summary?: RowGeometry }
interface SavedAnchor { id: string; group: boolean; offset: number; fallbackGroup?: string }
interface ReadingPosition { top: number; bottom: boolean; ids: string[]; tail: string; anchor?: SavedAnchor }

export function useHistoryScroll(options: Options) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const ownerRef = useRef(options.owner);
  const visibleRef = useRef(options.visible !== false);
  const elementRef = useRef<HTMLDivElement | null>(null);
  const processedRef = useRef<{ items: HistoryItem[]; loadingOlder: boolean; hasOlder: boolean } | null>(null);
  const generationRef = useRef(0);
  const bottomRef = useRef(true);
  const busyRef = useRef(false);
  const blockedRef = useRef(false);
  const anchorRef = useRef<Anchor | null>(null);
  const geometryRef = useRef<RowGeometry[]>([]);
  const geometryByElementRef = useRef(new Map<HTMLElement, RowGeometry>());
  const measuredContentSizeRef = useRef({ width: 0, height: 0 });
  const measuredViewportHeightRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const observerRef = useRef<{ element: HTMLDivElement; owner: string; observer: ResizeObserver } | null>(null);
  const readingIntentRef = useRef(false);
  const touchYRef = useRef<number | null>(null);
  const tailRef = useRef("");
  const idsRef = useRef<string[]>([]);
  const positionsRef = useRef(new Map<string, ReadingPosition>());
  const resumeRef = useRef<ReadingPosition | undefined>(undefined);
  const [newContent, setNewContent] = useState(false);
  const [autoLoadBlocked, setAutoLoadBlocked] = useState(false);

  function remember(element: HTMLDivElement) {
    lastScrollTopRef.current = element.scrollTop;
    const positions = positionsRef.current;
    positions.delete(optionsRef.current.owner);
    const anchor = anchorRef.current;
    const measured = anchor && geometryByElementRef.current.get(anchor.element);
    const savedAnchor = anchor && measured && measured.bottom > measured.top ? {
      id: anchor.element.dataset.historyId ?? anchor.element.dataset.historyGroup!,
      group: anchor.element.dataset.historyGroup !== undefined, offset: anchor.offset,
      fallbackGroup: anchor.element.closest<HTMLElement>("[data-history-turn]")?.dataset.historyTurn,
    } : undefined;
    positions.set(optionsRef.current.owner, { top: element.scrollTop, bottom: bottomRef.current, ids: idsRef.current, tail: tailRef.current, anchor: savedAnchor });
    while (positions.size > MAX_READING_POSITIONS) positions.delete(positions.keys().next().value!);
  }

  function measure(element: HTMLDivElement) {
    const top = element.getBoundingClientRect().top;
    const rows: RowGeometry[] = [...element.querySelectorAll<HTMLElement>("[data-history-id], [data-history-group]")].map(row => {
      const rect = row.getBoundingClientRect();
      return { element: row, top: rect.top - top + element.scrollTop, bottom: rect.bottom - top + element.scrollTop };
    });
    const summaries = new Map(rows.filter(row => row.element.dataset.historyGroup !== undefined).map(row => [row.element.dataset.historyGroup, row]));
    for (const row of rows) row.summary = summaries.get(row.element.closest<HTMLElement>("[data-history-turn]")?.dataset.historyTurn);
    geometryRef.current = rows;
    geometryByElementRef.current = new Map(rows.map(row => [row.element, row]));
    const content = element.querySelector(".history-content") ?? element;
    const size = content.getBoundingClientRect();
    measuredContentSizeRef.current = { width: size.width, height: size.height };
    measuredViewportHeightRef.current = element.clientHeight;
  }

  function hasContentResized(content: Element) {
    const size = content.getBoundingClientRect();
    const previous = measuredContentSizeRef.current;
    return Math.abs(size.width - previous.width) >= 0.5 || Math.abs(size.height - previous.height) >= 0.5;
  }

  function capture(): Anchor | null {
    const container = scrollRef.current;
    if (!container) return null;
    if (!geometryRef.current.length || geometryRef.current.at(-1)!.bottom <= 0) measure(container);
    const rows = geometryRef.current;
    // Scroll events reuse content coordinates: no layout read for every row.
    let low = 0;
    let high = rows.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (rows[middle].bottom <= container.scrollTop) low = middle + 1;
      else high = middle;
    }
    const row = rows[Math.min(low, rows.length - 1)];
    if (!row) return null;
    const fallback = row.summary;
    return { element: row.element, offset: row.top - container.scrollTop,
      fallback: fallback ? { element: fallback.element, offset: Math.max(0, fallback.top - container.scrollTop) } : undefined };

  }

  function restore(element: HTMLDivElement) {
    const current = anchorRef.current;
    const anchor = current?.element.isConnected ? current : current?.fallback?.element.isConnected ? current.fallback : null;
    if (!anchor) return;
    const delta = anchor.element.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset;
    if (Math.abs(delta) > 0.5) element.scrollTop += delta;
  }

  function followViewportResize(element: HTMLDivElement) {
    // Zero height is an unmeasured/hidden viewport, not a previous reading
    // window. Its first usable size must not turn a reader's scroll into follow.
    if (measuredViewportHeightRef.current <= 0) {
      measuredViewportHeightRef.current = element.clientHeight;
      return false;
    }
    if (element.clientHeight <= 0) return false;
    const resized = measuredViewportHeightRef.current !== element.clientHeight;
    if (resized && bottomRef.current && !readingIntentRef.current) {
      const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
      // A resize can queue scroll before ResizeObserver. Preserve the previous
      // following state unless the reader actually moved upward in the meantime.
      if (element.scrollTop >= Math.min(lastScrollTopRef.current, maximum) - 1) element.scrollTop = element.scrollHeight;
      else {
        bottomRef.current = false;
        anchorRef.current = capture();
      }
    }
    return resized;
  }

  const loadOlder = useCallback(async (beforeId?: string): Promise<boolean> => {
    const current = optionsRef.current;
    if (current.visible === false || busyRef.current || current.loadingOlder || beforeId === undefined && !current.nextCursor) return false;
    busyRef.current = true;
    blockedRef.current = false;
    setAutoLoadBlocked(false);
    anchorRef.current = capture();
    const owner = current.owner;
    const generation = generationRef.current;
    const belongsToCurrent = () => optionsRef.current.owner === owner && generationRef.current === generation;
    try {
      const loaded = await current.loadOlder(beforeId);
      if (!belongsToCurrent()) return false;
      if (!loaded) { anchorRef.current = null; blockedRef.current = true; setAutoLoadBlocked(true); }
      return loaded;
    } catch {
      if (belongsToCurrent()) { anchorRef.current = null; blockedRef.current = true; setAutoLoadBlocked(true); }
      return false;
    } finally { if (belongsToCurrent()) busyRef.current = false; }
  }, []);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element || optionsRef.current.visible === false) return;
    followViewportResize(element);
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distance <= 1) readingIntentRef.current = false;
    bottomRef.current = !readingIntentRef.current && distance < NEAR_BOTTOM_PX;
    optionsRef.current.onReadingLatestChange?.(bottomRef.current);
    anchorRef.current = bottomRef.current ? null : capture();
    remember(element);
    if (bottomRef.current) setNewContent(false);
    if (element.scrollTop < NEAR_TOP_PX && !blockedRef.current && !optionsRef.current.automaticLoadPaused) void loadOlder();
  }, [loadOlder]);

  const stopFollowing = useCallback(() => {
    readingIntentRef.current = true;
    bottomRef.current = false;
    anchorRef.current = capture();
    optionsRef.current.onReadingLatestChange?.(false);
  }, []);
  const onWheel = useCallback((event: { deltaY: number }) => {
    if (event.deltaY < 0) stopFollowing();
  }, [stopFollowing]);
  const onTouchStart = useCallback((event: { touches: ArrayLike<{ clientY: number }> }) => {
    touchYRef.current = event.touches[0]?.clientY ?? null;
  }, []);
  const onTouchMove = useCallback((event: { touches: ArrayLike<{ clientY: number }> }) => {
    const y = event.touches[0]?.clientY;
    if (y !== undefined && touchYRef.current !== null && y > touchYRef.current) stopFollowing();
    touchYRef.current = y ?? null;
  }, [stopFollowing]);
  const onKeyDown = useCallback((event: { key: string }) => {
    if (["ArrowUp", "PageUp", "Home"].includes(event.key)) stopFollowing();
  }, [stopFollowing]);
  const onClickCapture = useCallback((event: { target: EventTarget | null }) => {
    if (event.target instanceof Element && event.target.closest(".turn-tools-toggle, .tool-message-trigger")) stopFollowing();
  }, [stopFollowing]);

  const jumpLatest = useCallback(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    bottomRef.current = true;
    readingIntentRef.current = false;
    optionsRef.current.onReadingLatestChange?.(true);
    if (scrollRef.current) remember(scrollRef.current);
    anchorRef.current = null;
    setNewContent(false);
  }, []);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    const visible = options.visible !== false;
    const ownerChanged = ownerRef.current !== options.owner;
    const visibilityChanged = visibleRef.current !== visible;
    const elementChanged = elementRef.current !== element;
    const reopened = visible && (visibilityChanged || elementChanged);
    const viewportResized = element && measuredViewportHeightRef.current > 0 && element.clientHeight > 0 &&
      measuredViewportHeightRef.current !== element.clientHeight;
    const paginationChanged = processedRef.current?.hasOlder !== !!options.nextCursor;
    const inputsUnchanged = !ownerChanged && !visibilityChanged && !elementChanged && processedRef.current?.items === options.items &&
      processedRef.current.loadingOlder === options.loadingOlder;
    if (inputsUnchanged && !viewportResized && !paginationChanged) return;
    processedRef.current = { items: options.items, loadingOlder: options.loadingOlder, hasOlder: !!options.nextCursor };
    visibleRef.current = visible;
    elementRef.current = element;
    if (ownerChanged || visibilityChanged || elementChanged) {
      generationRef.current++;
      busyRef.current = false;
      anchorRef.current = null;
      geometryRef.current = [];
      geometryByElementRef.current.clear();
    }
    if (ownerChanged || reopened) {
      ownerRef.current = options.owner;
      resumeRef.current = positionsRef.current.get(options.owner);
      bottomRef.current = true;
      readingIntentRef.current = false;
      blockedRef.current = false;
      tailRef.current = "";
      idsRef.current = [];
      setNewContent(false);
      setAutoLoadBlocked(false);
      // A new source starts at its loading tail immediately, even before its
      // first page arrives. Do not carry the previous source's pixel offset.
      if (visible && element && !resumeRef.current) element.scrollTop = element.scrollHeight;
    }
    if (!visible || !element || !options.items.length) return;
    const reuseGeometry = inputsUnchanged && viewportResized &&
      !hasContentResized(element.querySelector(".history-content") ?? element);
    if (!ownerChanged && !reopened) followViewportResize(element);
    const resume = resumeRef.current;
    if (resume) {
      // Restore only when the retained rows still overlap this reading window.
      // An evicted/reset window starts at its newest page instead of reusing a
      // pixel offset from a different set of messages.
      if (options.items.some(item => item.id === resume.ids[0])) {
        bottomRef.current = resume.bottom;
        element.scrollTop = resume.top;
        if (!resume.bottom && resume.anchor) {
          measure(element);
          const saved = resume.anchor;
          const row = geometryRef.current.find(row => (saved.group ? row.element.dataset.historyGroup : row.element.dataset.historyId) === saved.id);
          const fallback = !row && geometryRef.current.find(row => row.element.dataset.historyGroup === saved.fallbackGroup);
          if (row) element.scrollTop = row.top - saved.offset;
          else if (fallback) element.scrollTop = fallback.top;
        }
        idsRef.current = resume.ids;
        tailRef.current = resume.tail;
      }
      resumeRef.current = undefined;
    }
    const tail = options.items.at(-1)!;
    const signature = `${tail.id}:${tail.text}:${tail.status ?? ""}`;
    const previousIds = idsRef.current;
    const previousIdSet = new Set(previousIds);
    const insertedItems = options.items.some((item) => !previousIdSet.has(item.id));
    if (bottomRef.current && (reopened || viewportResized || paginationChanged || signature !== tailRef.current || insertedItems)) {
      element.scrollTop = element.scrollHeight;
      anchorRef.current = null;
    } else if (!bottomRef.current) restore(element);
    // A viewport-only resize preserves row coordinates, including cached tool groups.
    if (reuseGeometry) measuredViewportHeightRef.current = element.clientHeight;
    else measure(element);
    anchorRef.current = bottomRef.current ? null : capture();
    if (!bottomRef.current && tailRef.current && signature !== tailRef.current) setNewContent(true);
    tailRef.current = signature;
    idsRef.current = options.items.map((item) => item.id);
    optionsRef.current.onReadingLatestChange?.(bottomRef.current);
    remember(element);
  });

  // The observer stays attached across tail polls. Its callback checks the
  // actual sizes so its initial delivery does not repeat a layout scan.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const current = observerRef.current;
    if (current && current.element === element && current.owner === options.owner && options.visible !== false) return;
    current?.observer.disconnect();
    observerRef.current = null;
    if (!element || options.visible === false || typeof ResizeObserver === "undefined") return;
    const content = element.querySelector(".history-content") ?? element;
    measuredViewportHeightRef.current = element.clientHeight;
    lastScrollTopRef.current = element.scrollTop;
    const observer = new ResizeObserver(() => {
      if (observerRef.current?.observer !== observer || scrollRef.current !== element || optionsRef.current.visible === false) return;
      const contentResized = hasContentResized(content);
      const viewportResized = followViewportResize(element);
      if (!contentResized && !viewportResized) return;
      if (bottomRef.current) element.scrollTop = element.scrollHeight;
      else restore(element);
      if (contentResized) measure(element);
      else measuredViewportHeightRef.current = element.clientHeight;
      anchorRef.current = bottomRef.current ? null : capture();
      remember(element);
    });
    observerRef.current = { element, owner: options.owner, observer };
    observer.observe(content);
    if (content !== element) observer.observe(element);
  });
  useLayoutEffect(() => () => {
    observerRef.current?.observer.disconnect();
    observerRef.current = null;
  }, []);

  return { scrollRef, onScroll, onWheel, onTouchStart, onTouchMove, onKeyDown, onClickCapture, loadOlder, jumpLatest, newContent, autoLoadBlocked };
}
