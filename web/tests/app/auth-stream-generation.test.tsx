import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../../src/App";
import { fetchAuthSession } from "../../src/api/auth";
import { getAuthSessionSnapshot, getOrInitAuthSession, resetAuthHelperForTesting } from "../../src/auth/bootstrap";
import { useStatusPolling } from "../../src/features/status/useStatusPolling";
import { emptyExecutions, emptyGoals } from "../fixtures/status-fixtures";

const LOGIN_TOKEN = "L".repeat(43);
const INITIAL_EXPIRY = "2026-10-23T12:00:00.000Z";
const RENEWED_EXPIRY = "2026-10-23T13:00:00.000Z";
let cookieGeneration = 0;

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  readonly cookieGeneration = cookieGeneration;
  closed = false;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
  }

  close() { this.closed = true; }

  status(nodeId: string) {
    this.dispatchEvent(new MessageEvent("status", { data: JSON.stringify({
      leaderMode: "model", nodes: [{ nodeId, connected: true, lastHeartbeat: "", sessionCount: 0 }],
      sessions: [], commands: [], goals: emptyGoals(), executions: emptyExecutions(),
    }) }));
  }

  expire() { this.dispatchEvent(new MessageEvent("auth-expired", { data: "{}" })); }
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(fulfill => { resolve = fulfill; });
  return { promise, resolve };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  resetAuthHelperForTesting();
  cookieGeneration = 0;
  FakeEventSource.instances = [];
  window.history.replaceState(null, "", "/");
  delete window.__SUPER_LEADER_LOGIN_TOKEN__;
  delete window.__SUPER_LEADER_LOGIN_ERROR__;
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  resetAuthHelperForTesting();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

it.each([RENEWED_EXPIRY, INITIAL_EXPIRY])("renews the actual App stream after same-tab hash login, including expiry %s", async expiresAt => {
  const exchange = deferredResponse();
  const oldPoll = deferredResponse();
  let oldPollSignal: AbortSignal | undefined;
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/auth/session") return Promise.resolve(jsonResponse({
      authenticated: true, expiresAt: cookieGeneration ? expiresAt : INITIAL_EXPIRY,
    }));
    if (url === "/auth/exchange") return exchange.promise.then(response => {
      cookieGeneration++;
      return response;
    });
    if (url === "/health") return Promise.resolve(jsonResponse({ status: "ok" }));
    if (url === "/v1/status") {
      oldPollSignal = init?.signal ?? undefined;
      return oldPoll.promise;
    }
    throw new Error(`Unexpected URL ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);

  await act(async () => { render(<React.StrictMode><App /></React.StrictMode>); });
  expect(FakeEventSource.instances).toHaveLength(1);
  const previous = FakeEventSource.instances[0];
  act(() => previous.status("original"));
  expect(screen.getByTestId("node-card-original")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "立即刷新控制平面状态" }));
  expect(oldPollSignal?.aborted).toBe(false);

  // Use the browser's hashchange event and the installed module listener.
  await act(async () => {
    const changed = new Promise<void>(resolve => window.addEventListener("hashchange", () => resolve(), { once: true }));
    window.location.hash = `#login=${LOGIN_TOKEN}`;
    await changed;
  });
  expect(fetchMock).toHaveBeenCalledWith("/auth/exchange", expect.objectContaining({
    method: "POST", credentials: "same-origin", body: JSON.stringify({ token: LOGIN_TOKEN }),
  }));
  await act(async () => { exchange.resolve(jsonResponse({ authenticated: true, expiresAt })); });

  expect(FakeEventSource.instances).toHaveLength(2);
  const renewed = FakeEventSource.instances[1];
  expect(previous.closed).toBe(true);
  expect(oldPollSignal?.aborted).toBe(true);
  expect(renewed.url).toBe("/v1/events");
  expect(renewed.cookieGeneration).toBe(1);
  expect(renewed.closed).toBe(false);
  expect(window.location.hash).toBe("");
  act(() => renewed.status("renewed"));
  expect(screen.getByTestId("node-card-renewed")).toBeInTheDocument();

  // Simulate events already queued by the previous transport and a fetch ignoring abort.
  await act(async () => {
    previous.status("stale");
    previous.expire();
    oldPoll.resolve(jsonResponse({ error: "Old session expired" }, 401));
  });
  expect(screen.queryByTestId("node-card-stale")).toBeNull();
  expect(screen.queryByTestId("auth-expired-banner")).toBeNull();
  expect(screen.getByTestId("node-card-renewed")).toBeInTheDocument();
  expect(renewed.closed).toBe(false);
  await expect(fetchAuthSession()).resolves.toEqual({ authenticated: true, expiresAt });

  // A genuine expiry from the current transport still clears the workspace.
  act(() => renewed.expire());
  expect(screen.getByTestId("auth-expired-banner")).toBeInTheDocument();
  expect(screen.queryByTestId("node-card-renewed")).toBeNull();
  expect(renewed.closed).toBe(true);
});

it("ignores old callbacks before rerender and rebuilds when only the auth generation changes", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) !== "/auth/session") throw new Error(`Unexpected URL ${String(input)}`);
    return jsonResponse({ authenticated: true, expiresAt: INITIAL_EXPIRY });
  }));
  await getOrInitAuthSession();
  const onAuthFailure = vi.fn();
  const { result, rerender } = renderHook(
    ({ generation }) => useStatusPolling(true, undefined, onAuthFailure, generation),
    { initialProps: { generation: getAuthSessionSnapshot().generation } },
  );
  const previous = FakeEventSource.instances[0];
  act(() => previous.status("original"));

  // The authority has advanced while React still has the previous render's props.
  await act(async () => {
    await getOrInitAuthSession(window, true);
    previous.status("stale");
    previous.expire();
  });
  expect(onAuthFailure).not.toHaveBeenCalled();
  expect(result.current.data?.nodes[0].nodeId).toBe("original");
  expect(result.current.isAuthError).toBe(false);
  expect(previous.closed).toBe(false);

  rerender({ generation: getAuthSessionSnapshot().generation });
  expect(previous.closed).toBe(true);
  expect(FakeEventSource.instances).toHaveLength(2);
  const renewed = FakeEventSource.instances[1];
  act(() => renewed.status("renewed"));
  expect(result.current.data?.nodes[0].nodeId).toBe("renewed");
  act(() => renewed.expire());
  expect(onAuthFailure).toHaveBeenCalledOnce();
  expect(result.current.isAuthError).toBe(true);
});
