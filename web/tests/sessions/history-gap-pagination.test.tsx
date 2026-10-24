import { act, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSessionHistory } from "../../src/api/sessions";
import { SessionWorkspace } from "../../src/features/sessions/components/SessionWorkspace";
import { useSessionHistory } from "../../src/features/sessions/useSessionHistory";
import type { ScopedSession, SessionHistory } from "../../src/types";
import { emptyExecutions, emptyGoals } from "../fixtures/status-fixtures";

vi.mock("../../src/api/sessions", async original => ({ ...await original<typeof import("../../src/api/sessions")>(), fetchSessionHistory: vi.fn() }));
const fetchHistory = vi.mocked(fetchSessionHistory);
const POLL_MS = 2000;
const CONTEXT = "cf7e282f-d6d2-4a98-a517-9fb753f2549b";
const NOW = "2026-10-11T10:00:00Z";
const session: ScopedSession = { id: "session", nodeId: "air", provider: "codex-app", title: "会话", cwd: "/workspace", status: "idle", observedAt: NOW, capabilities: ["read"] };
const nodes = [{ nodeId: "air", connected: true, sessionCount: 1, lastHeartbeat: NOW, inferredOffline: false }];
const page = (ids: string[], nextCursor: string | null): SessionHistory => ({
  session, historyContext: CONTEXT, source: "control-socket", fetchedAt: NOW, truncated: false, nextCursor,
  items: ids.map(id => ({ id, text: id, turnId: "turn", type: "agentMessage", kind: "assistant" })),
});
const settle = () => act(async () => { await Promise.resolve(); });
const poll = () => act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
const displayedIds = () => [...screen.getByLabelText("会话历史").querySelectorAll<HTMLElement>("[data-history-id]")].map(row => row.dataset.historyId);

function installPages(latestCursor: string | null = "bridge-2") {
  const snapshots = [page(["a", "b"], "original-older"), page(["d", "e"], "bridge-1"), page(["g", "h"], latestCursor)];
  fetchHistory.mockImplementation(async (_node, _session, cursor) => {
    if (!cursor) return snapshots.shift() ?? page(["g", "h"], latestCursor);
    if (cursor === "bridge-1") return page(["b", "c"], "ignored-1");
    if (cursor === "bridge-2") return page(["e", "f"], "ignored-2");
    if (cursor === "original-older") return page(["old", "a"], null);
    throw new Error(`Unexpected history cursor: ${cursor}`);
  });
}

function gapButton(beforeId: string) {
  const row = screen.getByLabelText("会话历史").querySelector(`[data-history-id="${beforeId}"]`)!;
  const boundary = row.closest(".history-turn")!.parentElement!;
  return within(boundary).getByRole("button", { name: "补齐这段历史" });
}

async function openWorkspace() {
  render(<SessionWorkspace data={{ nodes, sessions: [session], commands: [], goals: emptyGoals(), executions: emptyExecutions() }} nodes={nodes} stale={false} onAuthFailure={vi.fn()} />);
  fireEvent.click(screen.getByTestId("session-row-air-session"));
  await settle(); await poll(); await poll();
  expect(screen.getAllByRole("button", { name: "补齐这段历史" })).toHaveLength(2);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  fetchHistory.mockReset();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  window.history.replaceState(null, "", "/");
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("按所点击的历史缺口补页", () => {
  it.each(["d", "g"])("先点击 %s 前缺口时只补该段，再补另一段并保留最旧游标", async first => {
    installPages();
    await openWorkspace();
    fireEvent.click(gapButton(first));
    await settle();
    expect(fetchHistory.mock.calls.at(-1)?.[2]).toBe(first === "d" ? "bridge-1" : "bridge-2");
    expect(displayedIds()).toEqual(first === "d" ? ["a", "b", "c", "d", "e", "g", "h"] : ["a", "b", "d", "e", "f", "g", "h"]);
    expect(screen.getAllByRole("button", { name: "补齐这段历史" })).toHaveLength(1);
    const second = first === "d" ? "g" : "d";
    fireEvent.click(gapButton(second));
    await settle();
    expect(fetchHistory.mock.calls.at(-1)?.[2]).toBe(second === "d" ? "bridge-1" : "bridge-2");
    expect(screen.queryByRole("button", { name: "补齐这段历史" })).toBeNull();
    expect(displayedIds()).toEqual(["a", "b", "c", "d", "e", "f", "g", "h"]);
    fireEvent.click(screen.getByRole("button", { name: "加载更早的消息" }));
    await settle();
    expect(fetchHistory.mock.calls.at(-1)?.[2]).toBe("original-older");
    expect(displayedIds()).toEqual(["old", "a", "b", "c", "d", "e", "f", "g", "h"]);
    expect(fetchHistory.mock.calls.slice(1).every(call => call[4] === CONTEXT)).toBe(true);
  });

  it("最新缺口没有游标时仍能点击较早缺口并保留最新缺口", async () => {
    installPages(null);
    await openWorkspace();
    expect(screen.queryByRole("button", { name: "加载更早的消息" })).toBeNull();
    fireEvent.click(gapButton("d"));
    await settle();
    expect(fetchHistory.mock.calls.at(-1)?.[2]).toBe("bridge-1");
    expect(displayedIds()).toEqual(["a", "b", "c", "d", "e", "g", "h"]);
    expect(screen.getAllByRole("button", { name: "补齐这段历史" })).toEqual([gapButton("g")]);
  });

  it("tail请求期间分别排队两个缺口，同缺口合并且过期目标不回退到其它游标", async () => {
    installPages();
    const { result } = renderHook(() => useSessionHistory(session, true, vi.fn()));
    await settle(); await poll(); await poll();
    let resolveTail!: (value: SessionHistory) => void;
    fetchHistory.mockReturnValueOnce(new Promise(resolve => { resolveTail = resolve; }));
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      void result.current.refresh();
      first = result.current.loadOlder("d");
      second = result.current.loadOlder("g");
      expect(result.current.loadOlder("d")).toBe(first);
    });
    expect(first).not.toBe(second);
    await act(async () => { resolveTail(page(["g", "h"], "bridge-2")); expect(await first).toBe(true); expect(await second).toBe(true); });
    expect(fetchHistory.mock.calls.slice(-2).map(call => call[2])).toEqual(["bridge-1", "bridge-2"]);
    expect(result.current.gapBeforeIds).toEqual([]);
    const calls = fetchHistory.mock.calls.length;
    await act(async () => { expect(await result.current.loadOlder("d")).toBe(false); });
    expect(fetchHistory).toHaveBeenCalledTimes(calls);
  });
});
