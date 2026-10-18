import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSessionHistory } from "../../src/features/sessions/useSessionHistory";
import type { ScopedSession } from "../../src/types";

const CONTEXT = "cf7e282f-d6d2-4a98-a517-9fb753f2549b";
const PAGE_SIZE = 20;
const session: ScopedSession = { id: "session", nodeId: "node", provider: "codex-app", title: "会话", cwd: "/workspace",
  status: "idle", observedAt: "2026-10-18T10:00:00Z", capabilities: ["read", "send"], loaded: true };
const text = "历史text".repeat(2000);
const page = (start: number, nextCursor: string | null = "older") => ({
  session: { ...session, loaded: false, capabilities: ["read"] }, historyContext: CONTEXT, source: "control-socket",
  items: Array.from({ length: PAGE_SIZE }, (_, offset) => ({ id: String(start + offset), turnId: "turn", kind: "assistant", type: "agentMessage", text })),
  nextCursor, fetchedAt: "2026-10-18T10:00:00Z", truncated: false,
});
const response = (value: unknown) => new Response(JSON.stringify(value));
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("publishes only one 20-row long-text page before explicitly loading older history", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response(page(100)))
    .mockResolvedValueOnce(response(page(80, "oldest")))
    .mockResolvedValueOnce(response(page(101)));
  vi.stubGlobal("fetch", fetch);
  const started = performance.now();
  const view = renderHook(() => useSessionHistory(session, true, vi.fn()));
  await settle();
  const elapsed = performance.now() - started;
  expect(view.result.current.history?.items).toHaveLength(PAGE_SIZE);
  expect(view.result.current.history?.items[0].text.length).toBe(text.length);
  expect(view.result.current.history?.items.map(item => item.id)).toEqual(Array.from({ length: PAGE_SIZE }, (_, index) => String(index + 100)));
  expect(fetch).toHaveBeenCalledTimes(1);
  const first = new URL(fetch.mock.calls[0][0], "https://workspace.test");
  expect(first.searchParams.get("limit")).toBe(String(PAGE_SIZE));
  expect(first.searchParams.has("cursor")).toBe(false);
  expect(first.searchParams.has("historyContext")).toBe(false);
  expect(view.result.current.loading).toBe(false);
  // Read-only history metadata never replaces the authoritative selection.
  expect(session.loaded).toBe(true);
  expect(session.capabilities).toContain("send");
  console.info(`fixture history_first_page_ms=${elapsed.toFixed(2)} rows=${PAGE_SIZE} text_chars_per_row=${text.length} requests=${fetch.mock.calls.length}`);

  await act(async () => { expect(await view.result.current.loadOlder()).toBe(true); });
  const older = new URL(fetch.mock.calls[1][0], "https://workspace.test");
  expect(older.searchParams.get("cursor")).toBe("older");
  expect(older.searchParams.get("historyContext")).toBe(CONTEXT);
  expect(older.searchParams.get("limit")).toBe(String(PAGE_SIZE));
  expect(view.result.current.history?.items).toHaveLength(PAGE_SIZE * 2);
  await act(async () => { expect(await view.result.current.refresh()).toBe(true); });
  const latest = new URL(fetch.mock.calls[2][0], "https://workspace.test");
  expect(latest.searchParams.get("historyContext")).toBe(CONTEXT);
  expect(latest.searchParams.has("cursor")).toBe(false);
  expect(latest.searchParams.get("limit")).toBe(String(PAGE_SIZE));
  expect(view.result.current.history?.items[0].id).toBe("80");
  expect(view.result.current.history?.items.at(-1)?.id).toBe("120");
  view.unmount();
});

it("keeps the first 20 rows readable while polling and marks disjoint tail gaps", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValueOnce(response(page(100))).mockResolvedValueOnce(response(page(200)));
  vi.stubGlobal("fetch", fetch);
  const view = renderHook(() => useSessionHistory(session, true, vi.fn()));
  await settle();
  expect(fetch).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(view.result.current.history?.items).toHaveLength(PAGE_SIZE * 2);
  expect(view.result.current.gap).toBe(true);
  expect(view.result.current.gapBeforeId).toBe("200");
  expect(view.result.current.history?.nextCursor).toBe("older");
  view.unmount();
});

it("aborts a cold request on target change and ignores a late first-page response", async () => {
  let complete!: (value: Response) => void;
  const fetch = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { complete = resolve; }))
    .mockResolvedValueOnce(response({ ...page(200), session: { ...session, id: "other" } }));
  vi.stubGlobal("fetch", fetch);
  const view = renderHook(({ target }) => useSessionHistory(target, true, vi.fn()), { initialProps: { target: session } });
  const firstSignal = fetch.mock.calls[0][1].signal as AbortSignal;
  view.rerender({ target: { ...session, id: "other" } });
  expect(firstSignal.aborted).toBe(true);
  await settle();
  await act(async () => { complete(response(page(100))); });
  expect(view.result.current.history?.session.id).toBe("other");
  expect(view.result.current.history?.items[0].id).toBe("200");
  view.unmount();
});
