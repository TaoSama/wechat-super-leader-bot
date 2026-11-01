import { traceEvent } from "../runtime/telemetry.js";

export const MAX_HISTORY_CURSOR_LENGTH = 4096;
export const MAX_HISTORY_ID_BYTES = 128;
const METADATA_TIMEOUT_MS = 1_000;
const TURN_PAGE_LIMIT = 50;
const MAX_PAGES_PER_READ = 3;
const CACHE_LIMIT = 16;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHED_TURNS = 2048;

export type HistoryTurnStatus = "inProgress" | "completed" | "failed" | "interrupted";
export type HistoryTurnStatuses = Record<string, HistoryTurnStatus>;
type Value = Record<string, unknown>;
type MetadataRpc = (method: string, params: Value, timeoutMs: number) => Promise<unknown>;
type TurnCache = {
  lastUsed: number;
  busy: boolean;
  statuses: Map<string, HistoryTurnStatus>;
  wanted: Set<string>;
  latest: Set<string>;
  cursor: string | null;
  scanStarted: boolean;
  scanComplete: boolean;
};
const caches = new Map<string, TurnCache>();
const object = (value: unknown): Value => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Value : {};

export const historyIdentity = (value: unknown): string => {
  const id = typeof value === "string" ? value.trim() : "";
  return id && Buffer.byteLength(id, "utf8") <= MAX_HISTORY_ID_BYTES && !/[\s\0]/u.test(id) ? id : "";
};
export const historyTurnStatus = (value: unknown): HistoryTurnStatus | undefined =>
  value === "inProgress" || value === "completed" || value === "failed" || value === "interrupted" ? value : undefined;

export function historyCursor(value: unknown, seen: ReadonlySet<string>): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > MAX_HISTORY_CURSOR_LENGTH || seen.has(value)) {
    throw new Error("Codex app-server returned an invalid history cursor");
  }
  return value;
}

function cacheFor(key: string): TurnCache {
  const now = Date.now();
  for (const [id, entry] of caches) {
    if (!entry.busy && now - entry.lastUsed >= CACHE_TTL_MS) caches.delete(id);
  }
  const existing = caches.get(key);
  if (existing) { existing.lastUsed = now; return existing; }
  const entry: TurnCache = { lastUsed: now, busy: false, statuses: new Map(), wanted: new Set(), latest: new Set(),
    cursor: null, scanStarted: false, scanComplete: false };
  if (caches.size >= CACHE_LIMIT) {
    const oldest = [...caches].filter(([, value]) => !value.busy).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (!oldest) return entry;
    caches.delete(oldest[0]);
  }
  caches.set(key, entry);
  return entry;
}

function missing(entry: TurnCache): boolean {
  return [...entry.wanted].some(id => !entry.statuses.has(id) || entry.statuses.get(id) === "inProgress" && !entry.latest.has(id));
}

function remember(entry: TurnCache, turns: Value[]): void {
  for (const turn of turns) {
    const id = historyIdentity(turn.id), status = historyTurnStatus(turn.status);
    if (!id || !status) continue;
    if (!entry.statuses.has(id) && entry.statuses.size >= MAX_CACHED_TURNS) {
      if (!entry.wanted.has(id)) continue;
      const unwanted = [...entry.statuses.keys()].find(value => !entry.wanted.has(value));
      if (unwanted !== undefined) entry.statuses.delete(unwanted);
    }
    entry.statuses.set(id, status);
  }
}

function apply(entry: TurnCache): HistoryTurnStatuses | undefined {
  const statuses = Object.fromEntries([...entry.wanted].flatMap(id => {
    const status = entry.statuses.get(id);
    return status ? [[id, status]] : [];
  }));
  return Object.keys(statuses).length ? statuses : undefined;
}

/** Progress is bounded and isolated to one native runtime and thread; no transport is retained. */
export async function readHistoryTurnStatuses(rpc: MetadataRpc, cacheKey: string, threadId: string, items: Value[]):
Promise<HistoryTurnStatuses | undefined> {
  const wanted = new Set(items.map(item => historyIdentity(item.turnId)).filter(Boolean));
  if (!wanted.size) return undefined;
  const entry = cacheFor(cacheKey);
  for (const id of wanted) {
    if (!entry.wanted.has(id) && entry.wanted.size >= MAX_CACHED_TURNS) {
      const oldest = entry.wanted.values().next().value!;
      entry.wanted.delete(oldest); entry.statuses.delete(oldest);
    }
    entry.wanted.add(id);
  }
  for (const item of items) {
    const id = historyIdentity(item.turnId), status = historyTurnStatus(item.turnStatus);
    if (id && status && !entry.statuses.has(id)) remember(entry, [{ id, status }]);
  }
  if (entry.busy) return apply(entry);
  entry.busy = true;
  const deadline = performance.now() + METADATA_TIMEOUT_MS;
  const seen = new Set<string>();
  let requestedCursor: string | null = null;
  try {
    for (let page = 0; page < MAX_PAGES_PER_READ; page++) {
      requestedCursor = page === 0 ? null : entry.cursor;
      if (requestedCursor) seen.add(requestedCursor);
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      const result = object(await rpc("thread/turns/list", { threadId, sortDirection: "desc", limit: TURN_PAGE_LIMIT,
        itemsView: "notLoaded", ...(requestedCursor ? { cursor: requestedCursor } : {}) }, remaining));
      if (!Array.isArray(result.data) || result.data.length > TURN_PAGE_LIMIT) {
        throw new Error("Codex app-server returned an invalid turn metadata page");
      }
      const nextCursor = historyCursor(result.nextCursor, page === 0 ? new Set() : seen);
      const turns = result.data.map(object);
      remember(entry, turns);
      if (page === 0) entry.latest = new Set(turns.map(turn => historyIdentity(turn.id)).filter(Boolean));
      if (page > 0 || !entry.scanStarted || entry.scanComplete && missing(entry)) {
        entry.cursor = nextCursor; entry.scanStarted = true; entry.scanComplete = nextCursor === null;
      }
      if (entry.scanComplete || !missing(entry)) break;
    }
  } catch {
    // Restart a failed older scan on the next read; the successful item page stays valid.
    if (requestedCursor) { entry.cursor = null; entry.scanStarted = false; entry.scanComplete = false; }
    traceEvent("codex.history.turn_metadata.unavailable");
  } finally {
    entry.busy = false;
  }
  return apply(entry);
}
