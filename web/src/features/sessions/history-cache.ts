import { fetchSessionHistory } from "../../api/sessions";
import { SessionHistory } from "../../types";

const MAX_CACHED_SESSIONS = 8;
const MAX_CACHED_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 120_000;

/** Workspace-owned: unmounting or losing authentication releases all row data. */
export class HistoryCache<T> {
  private entries = new Map<string, { value: T; bytes: number; savedAt: number }>();
  private bytes = 0;

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.delete(key);
    if (Date.now() - entry.savedAt >= CACHE_TTL_MS) return undefined;
    this.entries.set(key, entry);
    this.bytes += entry.bytes;
    return entry.value;
  }

  set(key: string, value: T, bytes: number): void {
    this.delete(key);
    if (bytes > MAX_CACHED_BYTES) return;
    this.entries.set(key, { value, bytes, savedAt: Date.now() });
    this.bytes += bytes;
    while (this.entries.size > MAX_CACHED_SESSIONS || this.bytes > MAX_CACHED_BYTES) {
      this.delete(this.entries.keys().next().value!);
    }
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }

  clear(): void { this.entries.clear(); this.bytes = 0; }
}

type Arguments = Parameters<typeof fetchSessionHistory>;
interface Flight { controller: AbortController; promise: Promise<SessionHistory>; readers: number }
const flights = new Map<string, Flight>();

/** Share transport only; cancellation belongs to each reader independently. */
export function readSharedHistory(...args: Arguments): Promise<SessionHistory> {
  const [node, session, cursor, signal, context, source] = args;
  if (signal?.aborted) return Promise.reject(new DOMException("History request cancelled", "AbortError"));
  const key = JSON.stringify([node, session, cursor, context, source]);
  let flight = flights.get(key);
  if (!flight) {
    const controller = new AbortController();
    const promise = fetchSessionHistory(node, session, cursor, controller.signal, context, source);
    flight = { controller, promise, readers: 0 };
    flights.set(key, flight);
    const remove = () => { if (flights.get(key) === flight) flights.delete(key); };
    void promise.then(remove, remove);
  }
  const shared = flight;
  shared.readers++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const release = () => {
      settled = true;
      signal?.removeEventListener("abort", abort);
      shared.readers--;
      if (!shared.readers && flights.get(key) === shared) {
        flights.delete(key);
        shared.controller.abort();
      }
    };
    const abort = () => { if (!settled) { release(); reject(new DOMException("History request cancelled", "AbortError")); } };
    signal?.addEventListener("abort", abort, { once: true });
    void shared.promise.then(value => { if (!settled) { release(); resolve(value); } },
      error => { if (!settled) { release(); reject(error); } });
  });
}
