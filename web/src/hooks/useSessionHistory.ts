import { useCallback, useEffect, useRef, useState } from "react";
import { ApiAuthError, ApiHistoryError, fetchSessionHistory } from "../api";
import { HistoryItem, ScopedSession, SessionHistory } from "../types";
import { HISTORY_CONTEXT_EXPIRED_MESSAGE, isHistoryContext, isSessionHistorySource, terminalHistoryBlockReason } from "../history-contract";
import { isTerminalSession, MAX_TERMINAL_OBSERVATION_AGE_MS } from "../terminal-session";

const HISTORY_POLL_MS = 2000;
const MAX_RETRY_MS = 30_000;
const MAX_DISPLAY_ITEMS = 2000;
const LIVE_TAIL_ITEMS = 30;

export function sessionKey(session: Pick<ScopedSession, "id" | "nodeId">): string {
  return JSON.stringify([session.nodeId, session.id]);
}

interface HistoryState {
  owner: string;
  history: SessionHistory | null;
  loading: boolean;
  loadingOlder: boolean;
  loadingLatest: boolean;
  error: string | null;
  gap: boolean;
  gapBeforeId: string | null;
  gapBeforeIds: string[];
  memoryGap: boolean;
  pollingPaused: boolean;
  contextExpired: boolean;
  windowNotice: string | null;
  requestedSource?: "control-socket";
  sizeBlocked?: boolean;
}
interface Gap { beforeId: string; cursor: string | null; previousIds: Set<string>; seen: Set<string> }
interface Job { older: boolean; reset: boolean; resolve: (loaded: boolean) => void; promise: Promise<boolean> }
const EMPTY: HistoryState = { owner: "", history: null, loading: false, loadingOlder: false, loadingLatest: false, error: null, gap: false, gapBeforeId: null, gapBeforeIds: [], memoryGap: false, pollingPaused: false, contextExpired: false, windowNotice: null };

// Page order is authoritative; existing IDs retain their place while their contents update.
function mergePage(current: HistoryItem[], incoming: HistoryItem[], insertion: number): HistoryItem[] {
  const result = [...current];
  const unique = [...new Map(incoming.map((item) => [item.id, item])).values()];
  let position = insertion;
  for (let i = 0; i < unique.length; i++) {
    const item = unique[i];
    const existing = result.findIndex((value) => value.id === item.id);
    if (existing >= 0) { result[existing] = item; position = existing + 1; continue; }
    const next = unique.slice(i + 1).map((value) => result.findIndex((entry) => entry.id === value.id)).find((index) => index >= 0);
    if (next !== undefined) position = next;
    result.splice(position, 0, item);
    position++;
  }
  return result;
}

export function useSessionHistory(session: ScopedSession | null, connected: boolean, onAuthFailure: () => void) {
  const owner = session ? sessionKey(session) : "";
  const terminalObservedAt = session && isTerminalSession(session) ? session.observedAt : undefined;
  const [state, setState] = useState<HistoryState>(EMPTY);
  const requestRef = useRef<(older?: boolean, reset?: boolean) => Promise<boolean>>(async () => false);
  const lifecycleRef = useRef<() => void>(() => undefined);
  const sourceRef = useRef<(source?: "control-socket") => Promise<boolean>>(async () => false);
  const authRef = useRef(onAuthFailure);
  const connectedRef = useRef(connected);
  const sessionRef = useRef(session);
  connectedRef.current = connected;
  sessionRef.current = session;
  authRef.current = onAuthFailure;

  useEffect(() => {
    if (!session) { setState({ ...EMPTY, owner }); return; }
    const target = session;
    let disposed = false;
    let active: { controller: AbortController; job: Job } | null = null;
    let timer: number | undefined;
    let observationTimer: number | undefined;
    let latest: SessionHistory | null = null;
    let oldestCursor: string | null = null;
    let olderSeen = new Set<string>();
    let gaps: Gap[] = [];
    let memoryGap = false;
    let paginationError: string | null = null;
    let failures = 0;
    let contextExpired = false;
    let needsReset = false;
    let requestedSource: "control-socket" | undefined;
    let sizeBlocked = false;
    const queue: Job[] = [];
    const readable = () => !!sessionRef.current && sessionKey(sessionRef.current) === owner && !terminalHistoryBlockReason(sessionRef.current);
    const available = () => connectedRef.current && readable() && navigator.onLine !== false && document.visibilityState !== "hidden";
    setState({ ...EMPTY, owner, loading: available(), pollingPaused: !available() });

    function publish(error: string | null = null) {
      const cursor = contextExpired ? null : gaps.length && !memoryGap ? gaps[gaps.length - 1].cursor : oldestCursor;
      setState({ owner, history: latest ? { ...latest, nextCursor: cursor } : null, loading: !!active,
        loadingOlder: !!active?.job.older, loadingLatest: !!active && !active.job.older, error: error ?? paginationError,
        gap: gaps.length > 0, gapBeforeId: gaps[0]?.beforeId ?? null, gapBeforeIds: gaps.map((gap) => gap.beforeId),
        memoryGap, pollingPaused: contextExpired || sizeBlocked || !available(), contextExpired, requestedSource, sizeBlocked,
        windowNotice: memoryGap ? "历史窗口最多保留2000条：较早消息与最新30条之间部分内容未显示。继续向上可加载更早历史，重新读取最新页可释放历史窗口并恢复最新一段连续记录。" : null });
    }

    function cancel() {
      window.clearTimeout(timer);
      active?.controller.abort();
      active?.job.resolve(false);
      active = null;
      for (const job of queue.splice(0)) job.resolve(false);
    }

    function schedule() {
      window.clearTimeout(timer);
      if (!disposed && !contextExpired && !sizeBlocked && available()) timer = window.setTimeout(() => void request(), Math.min(MAX_RETRY_MS, HISTORY_POLL_MS * 2 ** failures));
    }

    async function pump() {
      if (disposed || active || contextExpired || !available()) return;
      const job = queue.shift();
      if (!job) { schedule(); return; }
      const bridge = job.older && !memoryGap ? gaps[gaps.length - 1] : undefined;
      const cursor = job.older ? bridge ? bridge.cursor : oldestCursor : undefined;
      if (job.older && !cursor) { job.resolve(false); void pump(); return; }
      const controller = new AbortController();
      const flight = { controller, job };
      active = flight;
      window.clearTimeout(timer);
      publish();
      let loaded = false;
      let error: string | null = null;
      try {
        const historyContext = needsReset ? undefined : latest?.historyContext;
        const page = await fetchSessionHistory(target.nodeId, target.id, cursor ?? undefined, controller.signal, historyContext, requestedSource);
        const current = sessionRef.current;
        if (disposed || controller.signal.aborted || active !== flight || !current || !available()) return;
        if (!isHistoryContext(page.historyContext) || page.session.nodeId !== target.nodeId || page.session.id !== target.id ||
            !isSessionHistorySource(page.source, page.session) || !isSessionHistorySource(page.source, current) ||
            requestedSource !== undefined && page.source !== requestedSource ||
            isTerminalSession(target) && page.session.provider !== current.provider ||
            historyContext !== undefined && (page.historyContext !== historyContext || page.source !== latest?.source ||
              isTerminalSession(target) && page.session.provider !== latest?.session.provider)) {
          throw new Error("历史响应与当前读取来源或上下文不匹配");
        }
        if (!latest || job.reset || needsReset) {
          latest = { ...page, items: [...new Map(page.items.map((item) => [item.id, item])).values()] };
          oldestCursor = page.nextCursor;
          gaps = [];
          memoryGap = false;
          paginationError = null;
          olderSeen = new Set();
          needsReset = false;
        } else if (job.older) {
          const seen = bridge?.seen ?? olderSeen;
          seen.add(cursor!);
          const next = page.nextCursor;
          const stalled = !!next && seen.has(next);
          const insertion = bridge ? latest.items.findIndex((item) => item.id === bridge.beforeId) : 0;
          const overlap = bridge && page.items.some((item) => bridge.previousIds.has(item.id));
          latest = { ...latest, items: mergePage(latest.items, page.items, Math.max(0, insertion)), truncated: latest.truncated || page.truncated };
          if (bridge) {
            if (overlap) gaps = gaps.filter((gap) => gap !== bridge);
            else { bridge.beforeId = page.items[0]?.id ?? bridge.beforeId; bridge.cursor = stalled ? null : next; }
          } else oldestCursor = stalled ? null : next;
          if (stalled) error = "历史分页游标重复，已停止自动翻页；可重新读取最新页后重试。";
          if (bridge && !overlap && !next) error = "未能补齐快照之间的消息，请重新读取最新页后重试。";
          paginationError = error;
        } else if (page.items.length) {
          const ids = new Set(latest.items.map((item) => item.id));
          const overlap = page.items.some((item) => ids.has(item.id));
          if (latest.items.length && !overlap) gaps.push({ beforeId: page.items[0].id, cursor: page.nextCursor, previousIds: ids, seen: new Set() });
          if (!latest.items.length) { oldestCursor = page.nextCursor; olderSeen.clear(); }
          latest = { ...page, items: mergePage(latest.items, page.items, latest.items.length), truncated: latest.truncated || page.truncated };
        } else latest = { ...latest, fetchedAt: page.fetchedAt, session: page.session };
        if (latest.items.length > MAX_DISPLAY_ITEMS) {
          latest = { ...latest, items: [...latest.items.slice(0, MAX_DISPLAY_ITEMS - LIVE_TAIL_ITEMS), ...latest.items.slice(-LIVE_TAIL_ITEMS)] };
          memoryGap = true;
          // Middle eviction keeps both the older reading window and current tail, never silently joining them.
          gaps = [{ beforeId: latest.items[MAX_DISPLAY_ITEMS - LIVE_TAIL_ITEMS].id, cursor: null, previousIds: new Set(), seen: new Set() }];
        }
        failures = 0;
        if (sizeBlocked) paginationError = null;
        sizeBlocked = false;
        loaded = !error;
      } catch (reason) {
        if (disposed || controller.signal.aborted || active !== flight) return;
        if (reason instanceof ApiAuthError) {
          disposed = true;
          cancel();
          latest = null;
          gaps = [];
          olderSeen.clear();
          detach();
          setState({ ...EMPTY, owner });
          authRef.current();
          return;
        }
        failures = Math.min(failures + 1, 4);
        error = reason instanceof Error ? reason.message : "无法获取会话历史";
        if (reason instanceof ApiHistoryError && reason.statusCode === 413) {
          sizeBlocked = true;
          paginationError = error;
          for (const queued of queue.splice(0)) queued.resolve(false);
        }
        if (reason instanceof ApiHistoryError && reason.statusCode === 409) {
          contextExpired = true;
          paginationError = error = HISTORY_CONTEXT_EXPIRED_MESSAGE;
          window.clearTimeout(timer);
          for (const queued of queue.splice(0)) queued.resolve(false);
        }
      } finally {
        job.resolve(loaded);
        if (!disposed && active === flight) {
          active = null;
          publish(error);
          if (queue.length) void pump(); else schedule();
        }
      }
    }

    function request(older = false, reset = false): Promise<boolean> {
      if (disposed || !available()) return Promise.resolve(false);
      if (reset) {
        cancel();
        contextExpired = false;
        needsReset = true;
        paginationError = null;
        failures = 0;
        sizeBlocked = false;
      } else if (contextExpired || needsReset && older) return Promise.resolve(false);
      const duplicate = [active?.job, ...queue].find((job) => job && job.older === older && (!reset || job.reset));
      if (duplicate) return duplicate.promise;
      let resolve!: (loaded: boolean) => void;
      const promise = new Promise<boolean>((done) => { resolve = done; });
      queue.push({ older, reset, resolve, promise });
      void pump();
      return promise;
    }

    function reconcile() {
      if (disposed) return;
      window.clearTimeout(observationTimer);
      const current = sessionRef.current;
      if (current && isTerminalSession(current) && !terminalHistoryBlockReason(current)) {
        observationTimer = window.setTimeout(reconcile, Date.parse(current.observedAt) + MAX_TERMINAL_OBSERVATION_AGE_MS - Date.now() + 1);
      }
      if (contextExpired || sizeBlocked) { publish(); return; }
      if (!available()) { cancel(); publish(current && terminalHistoryBlockReason(current) ||
        (connectedRef.current && navigator.onLine !== false ? null : "机器或网络离线，已暂停实时更新，恢复连接后自动继续")); }
      else { failures = 0; void request(); }
    }
    requestRef.current = request;
    sourceRef.current = (source) => {
      if (disposed || isTerminalSession(target) || !available()) return Promise.resolve(false);
      cancel();
      requestedSource = source;
      // Changing source starts a new reading context, never merging old pages.
      latest = null;
      oldestCursor = null;
      gaps = [];
      memoryGap = false;
      olderSeen.clear();
      return request(false, true);
    };
    lifecycleRef.current = reconcile;
    function detach() {
      document.removeEventListener("visibilitychange", reconcile);
      window.removeEventListener("online", reconcile);
      window.removeEventListener("offline", reconcile);
    }
    document.addEventListener("visibilitychange", reconcile);
    window.addEventListener("online", reconcile);
    window.addEventListener("offline", reconcile);
    reconcile();
    return () => {
      disposed = true;
      cancel();
      window.clearTimeout(observationTimer);
      detach();
      requestRef.current = async () => false;
      lifecycleRef.current = () => undefined;
      sourceRef.current = async () => false;
    };
  }, [owner]);

  useEffect(() => lifecycleRef.current(), [connected, session?.historySource, terminalObservedAt, session?.provider]);
  const refresh = useCallback(() => requestRef.current(), []);
  const loadOlder = useCallback(() => requestRef.current(true), []);
  const resetLatest = useCallback(() => requestRef.current(false, true), []);
  const usePagedHistory = useCallback(() => sourceRef.current("control-socket"), []);
  const useAutomaticHistory = useCallback(() => sourceRef.current(), []);
  const readBlockReason = session ? terminalHistoryBlockReason(session) : null;
  return { ...(state.owner === owner ? state : { ...EMPTY, owner, loading: !!owner }),
    canRead: !!session && connected && !readBlockReason, readBlockReason, refresh, loadOlder, resetLatest, usePagedHistory, useAutomaticHistory };
}
