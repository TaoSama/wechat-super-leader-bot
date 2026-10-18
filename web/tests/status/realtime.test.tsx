import { emptyGoals, completedRelayFixture, emptyExecutions, executionFixture, goalFixture } from "../fixtures/status-fixtures";
import { act, renderHook, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useStatusPolling } from "../../src/features/status/useStatusPolling";

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  closed = false;
  onerror: (() => void) | null = null;
  constructor(public readonly url: string) { super(); FakeEventSource.instances.push(this); }
  close() { this.closed = true; }
  status(title = "初始会话", executions: unknown = emptyExecutions(), goals: unknown = emptyGoals()) {
    this.dispatchEvent(new MessageEvent("status", { data: JSON.stringify({
      nodes: [], commands: [], goals, executions, leaderMode: "model", leaderModel: "gpt-6.1-sol",
      sessions: [{ id: "session", nodeId: "demoair", title, status: "active", capabilities: ["read"] }],
    }) }));
  }
  fail() { this.onerror?.(); }
}

it("accepts the short-output relay on SSE before and after plan completion without changing its receipts", () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const { result, unmount } = renderHook(() => useStatusPolling(true, 1000));
  const stream = FakeEventSource.instances[0];
  const executions = { ...emptyExecutions(), items: [completedRelayFixture("active")] };
  act(() => stream.status("会话", executions));
  expect(result.current.data?.executions).toEqual(executions);
  expect(result.current.error).toBeNull();
  expect(result.current.connectionState).toBe("live");
  executions.items[0].status = "completed";
  act(() => stream.status("会话", executions));
  expect(result.current.data?.executions).toEqual(executions);
  expect(result.current.error).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  unmount(); expect(stream.closed).toBe(true); expect(vi.getTimerCount()).toBe(0);
});

it("keeps queued plan and goal snapshots live with frozen sources and no target turn receipt", () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const { result, unmount } = renderHook(() => useStatusPolling(true, 1000));
  const stream = FakeEventSource.instances[0];
  const executions = { ...emptyExecutions(), items: [completedRelayFixture("active")] };
  const goals = { ...emptyGoals(), items: [goalFixture()] };
  executions.items[0].steps[1].status = "queued"; delete executions.items[0].steps[1].turnId;
  goals.items[0].actions[1].status = "queued"; delete goals.items[0].actions[1].turnId;
  act(() => stream.status("排队中的会话", executions, goals));
  expect(result.current.data?.executions).toEqual(executions);
  expect(result.current.data?.goals).toEqual(goals);
  expect(result.current.data?.executions.items[0].steps[1].resultSources).toEqual(executions.items[0].steps[1].resultSources);
  expect(result.current.error).toBeNull(); expect(result.current.connectionState).toBe("live");
  expect(stream.closed).toBe(false); expect(fetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  unmount(); expect(stream.closed).toBe(true); expect(vi.getTimerCount()).toBe(0);
});

it("replaces goal evidence on the existing stream without polling, extra timers or replay, and rejects malformed updates", () => {
  const fetch = vi.fn(() => new Promise<Response>(() => {})); vi.stubGlobal("fetch", fetch);
  const { result, unmount } = renderHook(() => useStatusPolling(true, 1000));
  const stream = FakeEventSource.instances[0], goals = { ...emptyGoals(), items: [goalFixture()] };
  act(() => stream.status("原会话", emptyExecutions(), goals));
  expect(result.current.data?.goals).toEqual(goals);
  goals.items[0].status = "completed"; goals.items[0].actions[1].status = "completed";
  goals.items[0].criteria[0] = { ...goals.items[0].criteria[0], supported: true, actions: [2] };
  act(() => stream.status("原会话", emptyExecutions(), goals));
  expect(result.current.data?.goals).toEqual(goals);
  expect(fetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  act(() => stream.status("坏投影", emptyExecutions(), { ...goals, items: [null] }));
  expect(result.current.data?.goals).toEqual(goals);
  expect(result.current.error).toBe("实时状态格式无效，正在重新连接");
  expect(stream.closed).toBe(true); unmount(); expect(vi.getTimerCount()).toBe(0);
});

it("updates exact plan receipts on the existing same-origin stream with no poll, write or second timer", async () => {
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const { result, unmount } = renderHook(() => useStatusPolling(true, 1000));
  const stream = FakeEventSource.instances[0];
  const executions = { ...emptyExecutions(), items: [executionFixture()] };
  act(() => stream.status("会话", executions));
  expect(result.current.data?.executions).toEqual(executions);
  expect(stream.url).toBe("/v1/events"); expect(vi.getTimerCount()).toBe(0);
  executions.items[0].steps[0].status = "completed";
  executions.items[0].steps[1].status = "accepted";
  executions.items[0].steps[1].commandId = "second-command";
  executions.items[0].steps[1].turnId = "second-turn";
  act(() => stream.status("会话", executions));
  expect(result.current.data?.executions.items[0].steps.map(step => step.status)).toEqual(["completed", "accepted"]);
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(fetch).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  act(() => stream.dispatchEvent(new MessageEvent("auth-expired", { data: "{}" })));
  expect(result.current.data).toBeNull(); expect(stream.closed).toBe(true);
  unmount(); expect(vi.getTimerCount()).toBe(0);
});

it.each([null, {}, { ...emptyExecutions(), items: [null] }])("rejects malformed SSE plans without replacing valid data with an empty window %#", bad => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  const { result, unmount } = renderHook(() => useStatusPolling(true, 1000));
  const stream = FakeEventSource.instances[0];
  const executions = { ...emptyExecutions(), items: [executionFixture()] };
  act(() => stream.status("会话", executions));
  act(() => stream.status("错误快照", bad));
  expect(result.current.error).toBe("实时状态格式无效，正在重新连接");
  expect(result.current.data?.executions).toEqual(executions);
  expect(stream.closed).toBe(true);
  unmount(); expect(vi.getTimerCount()).toBe(0);
});

beforeEach(() => {
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("applies realtime session/model changes without parallel polling and never replays commands", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const { result, unmount } = renderHook(() => useStatusPolling(true, 1000));
  expect(result.current.connectionState).toBe("connecting");
  const stream = FakeEventSource.instances[0];
  expect(stream.url).toBe("/v1/events");
  act(() => stream.status());
  expect(result.current.connectionState).toBe("live");
  expect(result.current.data?.leaderModel).toBe("gpt-6.1-sol");
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(fetch).not.toHaveBeenCalled();
  act(() => stream.status("实时新标题"));
  expect(result.current.data?.sessions[0].title).toBe("实时新标题");
  expect(result.current.lastUpdatedAt).not.toBeNull();
  unmount();
  expect(stream.closed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([401, 403])("probes session on EventSource errors and halts everything on HTTP %s", async code => {
  const onAuthFailure = vi.fn();
  const fetch = vi.fn(async (_url: string) => new Response("{}", { status: code }));
  vi.stubGlobal("fetch", fetch);
  const { result } = renderHook(() => useStatusPolling(true, 1000, onAuthFailure));
  const stream = FakeEventSource.instances[0];
  act(() => stream.status());
  await act(async () => { stream.fail(); await vi.advanceTimersByTimeAsync(0); });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe("/auth/session");
  expect(stream.closed).toBe(true);
  expect(result.current.isAuthError).toBe(true);
  expect(result.current.data).toBeNull();
  expect(result.current.lastUpdatedAt).toBeNull();
  expect(onAuthFailure).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(FakeEventSource.instances).toHaveLength(1);
});

it("auth-expired events clear data and halt all transports without another request", () => {
  const fetch = vi.fn();
  const failure = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const { result } = renderHook(() => useStatusPolling(true, 1000, failure));
  const stream = FakeEventSource.instances[0];
  act(() => stream.status());
  act(() => stream.dispatchEvent(new MessageEvent("auth-expired", { data: "{}" })));
  expect(stream.closed).toBe(true);
  expect(result.current.data).toBeNull();
  expect(result.current.isAuthError).toBe(true);
  expect(failure).toHaveBeenCalledTimes(1);
  expect(fetch).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("falls back after a transient disconnect then removes polling when the stream recovers", async () => {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(
    url === "/auth/session" ? { authenticated: true } : url === "/health" ? { status: "ok" } : { nodes: [], sessions: [], commands: [], goals: emptyGoals(), executions: emptyExecutions() }
  )));
  vi.stubGlobal("fetch", fetch);
  const { result } = renderHook(() => useStatusPolling(true, 1000));
  act(() => FakeEventSource.instances[0].status());
  await act(async () => { FakeEventSource.instances[0].fail(); await vi.advanceTimersByTimeAsync(0); });
  expect(result.current.connectionState).toBe("polling");
  expect(fetch.mock.calls.filter(([url]) => url === "/v1/status")).toHaveLength(1);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(FakeEventSource.instances).toHaveLength(2);
  act(() => FakeEventSource.instances[1].status("恢复后的标题"));
  const count = fetch.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(10_000));
  expect(fetch).toHaveBeenCalledTimes(count);
  expect(result.current.connectionState).toBe("live");
});

it("suspends while hidden or offline and obtains a fresh stream when visible/online", async () => {
  let visibility: DocumentVisibilityState = "visible";
  let online = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const { result } = renderHook(() => useStatusPolling(true, 1000));
  act(() => FakeEventSource.instances[0].status());
  act(() => { visibility = "hidden"; document.dispatchEvent(new Event("visibilitychange")); });
  expect(FakeEventSource.instances[0].closed).toBe(true);
  expect(result.current.connectionState).toBe("offline");
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(FakeEventSource.instances).toHaveLength(1);
  act(() => { visibility = "visible"; document.dispatchEvent(new Event("visibilitychange")); });
  act(() => FakeEventSource.instances[1].status("新鲜快照"));
  expect(result.current.data?.sessions[0].title).toBe("新鲜快照");
  act(() => { online = false; window.dispatchEvent(new Event("offline")); });
  expect(FakeEventSource.instances[1].closed).toBe(true);
  act(() => { online = true; window.dispatchEvent(new Event("online")); });
  expect(FakeEventSource.instances).toHaveLength(3);
  expect(fetch).not.toHaveBeenCalled();
});

it("keeps slow fallback polls single-flight, manual refresh does not abort them, and unmount cancels pending requests", async () => {
  vi.stubGlobal("EventSource", undefined);
  let finish!: (response: Response) => void;
  let signal: AbortSignal | undefined;
  const fetch = vi.fn((url: string, init: RequestInit) => {
    if (url === "/health") return Promise.resolve(new Response('{"status":"ok"}'));
    signal = init.signal ?? undefined;
    return new Promise<Response>(done => { finish = done; });
  });
  vi.stubGlobal("fetch", fetch);
  const { result, unmount } = renderHook(() => useStatusPolling(true, 1000));
  await act(async () => vi.advanceTimersByTimeAsync(5000));
  act(() => result.current.manualRefresh());
  expect(fetch.mock.calls.filter(([url]) => url === "/v1/status")).toHaveLength(1);
  expect(signal?.aborted).toBe(false);
  await act(async () => { finish(new Response(JSON.stringify({ nodes: [], sessions: [], commands: [], goals: emptyGoals(), executions: emptyExecutions() }))); await vi.advanceTimersByTimeAsync(0); });
  expect(result.current.data).not.toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(fetch.mock.calls.filter(([url]) => url === "/v1/status")).toHaveLength(2);
  unmount();
  expect(signal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([401, 403])("immediately clears stale data on status HTTP %s even if the health request never finishes", async code => {
  vi.stubGlobal("EventSource", undefined);
  let fail = false;
  const failure = vi.fn();
  const signals: AbortSignal[] = [];
  const fetch = vi.fn((url: string, init: RequestInit) => {
    if (init.signal) signals.push(init.signal);
    if (url === "/health" && fail) return new Promise<Response>(() => {});
    return Promise.resolve(new Response(JSON.stringify(url === "/health" ? { status: "ok" } :
      { nodes: [], sessions: [], commands: [], goals: emptyGoals(), executions: emptyExecutions() }), { status: url === "/v1/status" && fail ? code : 200 }));
  });
  vi.stubGlobal("fetch", fetch);
  const { result, unmount } = renderHook(() => useStatusPolling(true, 1000, failure));
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(result.current.data).not.toBeNull();
  fail = true;
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(result.current.isAuthError).toBe(true);
  expect(result.current.data).toBeNull();
  expect(result.current.lastUpdatedAt).toBeNull();
  expect(failure).toHaveBeenCalledTimes(1);
  expect(signals.at(-1)?.aborted).toBe(true);
  const requests = fetch.mock.calls.length;
  await act(async () => vi.advanceTimersByTimeAsync(60_000));
  expect(fetch).toHaveBeenCalledTimes(requests);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("repeated manual refreshes retain exactly one fallback timer and unmount removes it", async () => {
  vi.stubGlobal("EventSource", undefined);
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(
    url === "/health" ? { status: "ok" } : { nodes: [], sessions: [], commands: [], goals: emptyGoals(), executions: emptyExecutions() }
  )));
  vi.stubGlobal("fetch", fetch);
  const { result, unmount } = renderHook(() => useStatusPolling(true, 1000));
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(vi.getTimerCount()).toBe(1);
  for (let index = 0; index < 5; index++) {
    await act(async () => { result.current.manualRefresh(); await vi.advanceTimersByTimeAsync(0); });
    expect(vi.getTimerCount()).toBe(1);
  }
  expect(fetch.mock.calls.filter(([url]) => url === "/v1/status")).toHaveLength(6);
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(fetch.mock.calls.filter(([url]) => url === "/v1/status")).toHaveLength(7);
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
