import { emptyGoals, emptyExecutions  } from "./status-fixtures";
import { act, renderHook, cleanup } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useStatusPolling } from "../src/hooks/useStatusPolling";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each([401, 403])("stops automatic polling after %s, clears stale data and triggers onAuthFailure", async (code) => {
  vi.useFakeTimers();
  let status = 200;
  let requests = 0;
  const onAuthFailure = vi.fn();

  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/health") return new Response(JSON.stringify({ status: "ok" }));
    requests++;
    return new Response(
      JSON.stringify(status === 200 ? { nodes: [], sessions: [], commands: [], goals: emptyGoals(), executions: emptyExecutions() } : { error: "denied" }),
      { status }
    );
  }));

  const { result, rerender } = renderHook(
    ({ enabled }) => useStatusPolling(enabled, 1000, onAuthFailure),
    { initialProps: { enabled: true } }
  );

  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(result.current.data).not.toBeNull();

  // Simulate server returning 401 or 403
  status = code;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });

  expect(result.current.isAuthError).toBe(true);
  expect(result.current.data).toBeNull();
  expect(result.current.lastUpdatedAt).toBeNull();
  expect(onAuthFailure).toHaveBeenCalled();

  const rejectedCount = requests;
  // Verify polling has stopped
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(requests).toBe(rejectedCount);

  // Recovery: re-enable after re-authenticating
  status = 200;
  rerender({ enabled: false });
  rerender({ enabled: true });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(result.current.isAuthError).toBe(false);
  expect(result.current.data).not.toBeNull();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(requests).toBe(rejectedCount + 2);
});

it("continues automatic recovery after transient HTTP failures", async () => {
  vi.useFakeTimers();
  let requests = 0;

  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/health") return new Response(JSON.stringify({ status: "ok" }));
    requests++;
    return requests === 1
      ? new Response("{}", { status: 502 })
      : new Response(JSON.stringify({ nodes: [], sessions: [], commands: [], goals: emptyGoals(), executions: emptyExecutions() }));
  }));

  const { result } = renderHook(() => useStatusPolling(true, 1000));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(result.current.error).not.toBeNull();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(requests).toBe(2);
  expect(result.current.error).toBeNull();
});

it("stops polling and clears telemetry when enabled is toggled to false", async () => {
  vi.useFakeTimers();
  let requests = 0;

  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/health") return new Response(JSON.stringify({ status: "ok" }));
    requests++;
    return new Response(JSON.stringify({ nodes: [], sessions: [], commands: [], goals: emptyGoals(), executions: emptyExecutions() }));
  }));

  const { result, rerender } = renderHook(
    ({ enabled }) => useStatusPolling(enabled, 1000),
    { initialProps: { enabled: true } }
  );

  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(result.current.data).not.toBeNull();
  expect(requests).toBe(1);

  // Toggle enabled to false (e.g. logout)
  rerender({ enabled: false });
  expect(result.current.data).toBeNull();
  expect(result.current.lastUpdatedAt).toBeNull();

  await act(async () => {
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(requests).toBe(1);
});
