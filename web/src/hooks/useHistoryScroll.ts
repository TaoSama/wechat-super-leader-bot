import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { HistoryItem } from "../types";

const NEAR_TOP_PX = 120;
const NEAR_BOTTOM_PX = 96;
interface Options {
  owner: string;
  items: HistoryItem[];
  nextCursor: string | null;
  loadingOlder: boolean;
  automaticLoadPaused?: boolean;
  loadOlder: () => Promise<boolean>;
}
interface Anchor { element: HTMLElement; offset: number }

export function useHistoryScroll(options: Options) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const ownerRef = useRef(options.owner);
  const generationRef = useRef(0);
  const bottomRef = useRef(true);
  const busyRef = useRef(false);
  const blockedRef = useRef(false);
  const anchorRef = useRef<Anchor | null>(null);
  const tailRef = useRef("");
  const idsRef = useRef<string[]>([]);
  const [newContent, setNewContent] = useState(false);
  const [autoLoadBlocked, setAutoLoadBlocked] = useState(false);

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
    if (busyRef.current || current.loadingOlder || !current.nextCursor) return false;
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
    if (!element) return;
    bottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
    if (busyRef.current) anchorRef.current = bottomRef.current ? null : capture();
    if (bottomRef.current) setNewContent(false);
    if (element.scrollTop < NEAR_TOP_PX && !blockedRef.current && !optionsRef.current.automaticLoadPaused) void loadOlder();
  }, [loadOlder]);

  const jumpLatest = useCallback(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    bottomRef.current = true;
    anchorRef.current = null;
    setNewContent(false);
  }, []);

  useLayoutEffect(() => {
    if (ownerRef.current !== options.owner) {
      ownerRef.current = options.owner;
      generationRef.current++;
      bottomRef.current = true;
      busyRef.current = false;
      blockedRef.current = false;
      anchorRef.current = null;
      tailRef.current = "";
      idsRef.current = [];
      setNewContent(false);
      setAutoLoadBlocked(false);
    }
    const element = scrollRef.current;
    if (!element || !options.items.length) return;
    const tail = options.items.at(-1)!;
    const signature = `${tail.id}:${tail.text}:${tail.status ?? ""}`;
    const previousIds = idsRef.current;
    const anchor = anchorRef.current;
    const anchorIndex = options.items.findIndex((item) => item.id === anchor?.element.dataset.historyId);
    const previousIdSet = new Set(previousIds);
    const insertedBeforeAnchor = !!anchor && anchorIndex >= 0 && options.items.slice(0, anchorIndex).some((item) => !previousIdSet.has(item.id));
    const insertedItems = options.items.some((item) => !previousIdSet.has(item.id));
    if (bottomRef.current && (signature !== tailRef.current || insertedItems)) {
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
  }, [options.owner, options.items, options.loadingOlder]);

  return { scrollRef, onScroll, loadOlder, jumpLatest, newContent, autoLoadBlocked };
}
