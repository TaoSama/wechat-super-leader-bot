import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { HistoryItem } from "../../types";

const NEAR_TOP_PX = 120;
const NEAR_BOTTOM_PX = 96;
const MAX_READING_POSITIONS = 8;
interface Options {
  owner: string;
  visible?: boolean;
  items: HistoryItem[];
  nextCursor: string | null;
  loadingOlder: boolean;
  automaticLoadPaused?: boolean;
  loadOlder: () => Promise<boolean>;
}
interface Anchor { element: HTMLElement; offset: number }
interface ReadingPosition { top: number; bottom: boolean; ids: string[]; tail: string }

export function useHistoryScroll(options: Options) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const ownerRef = useRef(options.owner);
  const visibleRef = useRef(options.visible !== false);
  const elementRef = useRef<HTMLDivElement | null>(null);
  const processedRef = useRef<{ items: HistoryItem[]; loadingOlder: boolean } | null>(null);
  const generationRef = useRef(0);
  const bottomRef = useRef(true);
  const busyRef = useRef(false);
  const blockedRef = useRef(false);
  const anchorRef = useRef<Anchor | null>(null);
  const tailRef = useRef("");
  const idsRef = useRef<string[]>([]);
  const positionsRef = useRef(new Map<string, ReadingPosition>());
  const resumeRef = useRef<ReadingPosition | undefined>(undefined);
  const [newContent, setNewContent] = useState(false);
  const [autoLoadBlocked, setAutoLoadBlocked] = useState(false);

  function remember(element: HTMLDivElement) {
    const positions = positionsRef.current;
    positions.delete(optionsRef.current.owner);
    positions.set(optionsRef.current.owner, { top: element.scrollTop, bottom: bottomRef.current, ids: idsRef.current, tail: tailRef.current });
    while (positions.size > MAX_READING_POSITIONS) positions.delete(positions.keys().next().value!);
  }

  function capture(): Anchor | null {
    const container = scrollRef.current;
    if (!container) return null;
    const top = container.getBoundingClientRect().top;
    const messages = [...container.querySelectorAll<HTMLElement>("[data-history-id]")];
    const visible = messages.find((element) => element.getBoundingClientRect().bottom > top) ?? messages[0];
    return visible ? { element: visible, offset: visible.getBoundingClientRect().top - top } : null;
  }

  const loadOlder = useCallback(async (): Promise<boolean> => {
    const current = optionsRef.current;
    if (current.visible === false || busyRef.current || current.loadingOlder || !current.nextCursor) return false;
    busyRef.current = true;
    blockedRef.current = false;
    setAutoLoadBlocked(false);
    anchorRef.current = capture();
    const owner = current.owner;
    const generation = generationRef.current;
    const belongsToCurrent = () => optionsRef.current.owner === owner && generationRef.current === generation;
    try {
      const loaded = await current.loadOlder();
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
    bottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
    remember(element);
    if (busyRef.current) anchorRef.current = bottomRef.current ? null : capture();
    if (bottomRef.current) setNewContent(false);
    if (element.scrollTop < NEAR_TOP_PX && !blockedRef.current && !optionsRef.current.automaticLoadPaused) void loadOlder();
  }, [loadOlder]);

  const jumpLatest = useCallback(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    bottomRef.current = true;
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
    if (!ownerChanged && !visibilityChanged && !elementChanged && processedRef.current?.items === options.items &&
      processedRef.current.loadingOlder === options.loadingOlder) return;
    processedRef.current = { items: options.items, loadingOlder: options.loadingOlder };
    visibleRef.current = visible;
    elementRef.current = element;
    if (ownerChanged || visibilityChanged || elementChanged) {
      generationRef.current++;
      busyRef.current = false;
      anchorRef.current = null;
    }
    if (ownerChanged || reopened) {
      ownerRef.current = options.owner;
      resumeRef.current = positionsRef.current.get(options.owner);
      bottomRef.current = true;
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
    const resume = resumeRef.current;
    if (resume) {
      // Restore only when the retained rows still overlap this reading window.
      // An evicted/reset window starts at its newest page instead of reusing a
      // pixel offset from a different set of messages.
      if (options.items.some(item => item.id === resume.ids[0])) {
        bottomRef.current = resume.bottom;
        element.scrollTop = resume.top;
        idsRef.current = resume.ids;
        tailRef.current = resume.tail;
      }
      resumeRef.current = undefined;
    }
    const tail = options.items.at(-1)!;
    const signature = `${tail.id}:${tail.text}:${tail.status ?? ""}`;
    const previousIds = idsRef.current;
    const anchor = anchorRef.current;
    const anchorIndex = options.items.findIndex((item) => item.id === anchor?.element.dataset.historyId);
    const previousIdSet = new Set(previousIds);
    const insertedBeforeAnchor = !!anchor && anchorIndex >= 0 && options.items.slice(0, anchorIndex).some((item) => !previousIdSet.has(item.id));
    const insertedItems = options.items.some((item) => !previousIdSet.has(item.id));
    if (bottomRef.current && (reopened || signature !== tailRef.current || insertedItems)) {
      element.scrollTop = element.scrollHeight;
      anchorRef.current = null;
    } else if (anchor && insertedBeforeAnchor) {
      if (anchor.element.isConnected) element.scrollTop += anchor.element.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset;
      anchorRef.current = null;
    }
    if (!bottomRef.current && tailRef.current && signature !== tailRef.current) setNewContent(true);
    if (anchor && !options.loadingOlder && !busyRef.current && !insertedBeforeAnchor) anchorRef.current = null;
    tailRef.current = signature;
    idsRef.current = options.items.map((item) => item.id);
    remember(element);
  });

  return { scrollRef, onScroll, loadOlder, jumpLatest, newContent, autoLoadBlocked };
}
