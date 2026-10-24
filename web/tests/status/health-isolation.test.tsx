import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../../src/App";
import { resetAuthHelperForTesting } from "../../src/auth/bootstrap";
import { useStatusPolling } from "../../src/features/status/useStatusPolling";
import { emptyExecutions, emptyGoals } from "../fixtures/status-fixtures";

const REQUEST_DEADLINE_MS = 20_000;
const POLL_INTERVAL_MS = 1_000;
const statusPayload = (title: string) => ({
  nodes: [], commands: [], goals: emptyGoals(), executions: emptyExecutions(),
  sessions: [{ id: "session", nodeId: "macair", title, status: "active", capabilities: [] }],
});
const response = (payload: unknown) => new Response(JSON.stringify(payload));

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  closed = false;
  constructor(_url: string) { super(); FakeEventSource.instances.push(this); }
  close() { this.closed = true; }
  status(title: string) {
    this.dispatchEvent(new MessageEvent("status", { data: JSON.stringify(statusPayload(title)) }));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("EventSource", undefined);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  resetAuthHelperForTesting();
  FakeEventSource.instances = [];
});

afterEach(() => {
  cleanup();
  resetAuthHelperForTesting();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([true, false])("accepts status immediately and continues polling when hanging health honors abort=%s", async honorsAbort => {
  let finishHealth!: (value: Response) => void;
  let healthSignal!: AbortSignal;
  let statusRequests = 0;
  let healthRequests = 0;
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
    if (url === "/v1/status") return Promise.resolve(response(statusPayload(`快照 ${++statusRequests}`)));
    if (++healthRequests > 1) return Promise.resolve(response({ status: "ok" }));
    healthSignal = init.signal as AbortSignal;
    return new Promise<Response>((resolve, reject) => {
      finishHealth = resolve;
      if (honorsAbort) healthSignal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  }));
  const { result, unmount } = renderHook(() => useStatusPolling(true, POLL_INTERVAL_MS));
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(result.current.data?.sessions[0].title).toBe("快照 1");
  expect(result.current.isLoading).toBe(false);
  expect(result.current.controllerHealthy).toBeNull();
  await act(async () => vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS));
  expect(healthSignal.aborted).toBe(true);
  expect(result.current.data?.sessions[0].title).toBe("快照 1");
  expect(result.current.error).toBeNull();
  expect(result.current.consecutiveFailures).toBe(0);
  expect(result.current.controllerHealthy).toBe(false);
  await act(async () => vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS));
  expect(result.current.data?.sessions[0].title).toBe("快照 2");
  expect(result.current.controllerHealthy).toBe(true);
  await act(async () => { finishHealth(response({ status: "unavailable" })); await vi.advanceTimersByTimeAsync(0); });
  expect(result.current.data?.sessions[0].title).toBe("快照 2");
  expect(result.current.controllerHealthy).toBe(true);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not let health from an older HTTP snapshot replace newer SSE health", async () => {
  vi.stubGlobal("EventSource", FakeEventSource);
  let finishHealth!: (value: Response) => void;
  vi.stubGlobal("fetch", vi.fn((url: string) => url === "/v1/status"
    ? Promise.resolve(response(statusPayload("HTTP 快照")))
    : new Promise<Response>(resolve => { finishHealth = resolve; })));
  const { result, unmount } = renderHook(() => useStatusPolling(true, POLL_INTERVAL_MS));
  const stream = FakeEventSource.instances[0];
  act(() => stream.status("初始 SSE"));
  await act(async () => { result.current.manualRefresh(); await vi.advanceTimersByTimeAsync(0); });
  expect(result.current.data?.sessions[0].title).toBe("HTTP 快照");
  act(() => stream.status("更新 SSE"));
  await act(async () => { finishHealth(response({ status: "unavailable" })); await vi.advanceTimersByTimeAsync(0); });
  expect(result.current.data?.sessions[0].title).toBe("更新 SSE");
  expect(result.current.controllerHealthy).toBe(true);
  expect(result.current.connectionState).toBe("live");
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels health on auth rejection without letting its late result restore state", async () => {
  vi.stubGlobal("EventSource", FakeEventSource);
  let finishHealth!: (value: Response) => void;
  let healthSignal!: AbortSignal;
  const onAuthFailure = vi.fn();
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
    if (url === "/v1/status") return Promise.resolve(response(statusPayload("HTTP 快照")));
    healthSignal = init.signal as AbortSignal;
    return new Promise<Response>(resolve => { finishHealth = resolve; });
  }));
  const { result, unmount } = renderHook(() => useStatusPolling(true, POLL_INTERVAL_MS, onAuthFailure));
  await act(async () => { result.current.manualRefresh(); await vi.advanceTimersByTimeAsync(0); });
  expect(result.current.data).not.toBeNull();
  act(() => FakeEventSource.instances[0].dispatchEvent(new Event("auth-expired")));
  expect(healthSignal.aborted).toBe(true);
  await act(async () => { finishHealth(response({ status: "ok" })); await vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS); });
  expect(result.current.data).toBeNull();
  expect(result.current.controllerHealthy).toBeNull();
  expect(result.current.isAuthError).toBe(true);
  expect(onAuthFailure).toHaveBeenCalledTimes(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels pending health on unmount and ignores it after a fresh hook mounts", async () => {
  let finishHealth!: (value: Response) => void;
  let healthSignal!: AbortSignal;
  let healthRequests = 0;
  vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
    if (url === "/v1/status") return Promise.resolve(response(statusPayload("有效快照")));
    if (++healthRequests > 1) return Promise.resolve(response({ status: "ok" }));
    healthSignal = init.signal as AbortSignal;
    return new Promise<Response>(resolve => { finishHealth = resolve; });
  }));
  const first = renderHook(() => useStatusPolling(true, POLL_INTERVAL_MS));
  await act(async () => vi.advanceTimersByTimeAsync(0));
  first.unmount();
  expect(healthSignal.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  const next = renderHook(() => useStatusPolling(true, POLL_INTERVAL_MS));
  await act(async () => { finishHealth(response({ status: "unavailable" })); await vi.advanceTimersByTimeAsync(0); });
  expect(next.result.current.data?.sessions[0].title).toBe("有效快照");
  expect(next.result.current.controllerHealthy).toBe(true);
  next.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("renders and refreshes the real App while health times out and later returns", async () => {
  let finishHealth!: (value: Response) => void;
  let healthRequests = 0;
  let statusRequests = 0;
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    if (url === "/auth/session") return Promise.resolve(response({ authenticated: true }));
    if (url === "/v1/status") return Promise.resolve(response(statusPayload(`工作台快照 ${++statusRequests}`)));
    if (url === "/health") {
      if (++healthRequests > 1) return Promise.resolve(response({ status: "ok" }));
      return new Promise<Response>(resolve => { finishHealth = resolve; });
    }
    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  }));
  const { unmount } = render(<App pollIntervalMs={POLL_INTERVAL_MS} />);
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(screen.getByText("工作台快照 1")).toBeInTheDocument();
  expect(screen.queryByTestId("telemetry-loading-state")).not.toBeInTheDocument();
  await act(async () => vi.advanceTimersByTimeAsync(REQUEST_DEADLINE_MS + POLL_INTERVAL_MS));
  expect(screen.getByText("工作台快照 2")).toBeInTheDocument();
  expect(screen.queryByTestId("telemetry-error-banner")).not.toBeInTheDocument();
  await act(async () => { finishHealth(response({ status: "unavailable" })); await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByText("工作台快照 2")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "立即刷新控制平面状态" })).toBeEnabled();
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
