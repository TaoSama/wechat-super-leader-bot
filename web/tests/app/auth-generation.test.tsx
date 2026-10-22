import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App";
import {
  getAuthSessionSnapshot,
  getOrInitAuthSession,
  handleHashChangeLogin,
  resetAuthHelperForTesting,
  setUnauthenticatedSession,
  subscribeAuthState,
} from "../../src/auth/bootstrap";
import { emptyExecutions, emptyGoals } from "../fixtures/status-fixtures";

const FIRST_TOKEN = "a".repeat(43);
const SECOND_TOKEN = "b".repeat(43);
const EXPIRES_AT = "2026-10-23T12:00:00.000Z";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function session(): Response {
  return response({ authenticated: true, expiresAt: EXPIRES_AT });
}

function status(): Response {
  return response({ nodes: [], sessions: [], commands: [], goals: emptyGoals(), executions: emptyExecutions() });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}

function login(token = FIRST_TOKEN) {
  window.history.replaceState(null, "", `/#login=${token}`);
  return handleHashChangeLogin(window)!;
}

class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  closed = false;
  onerror: (() => void) | null = null;
  constructor(public readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
  }
  close() { this.closed = true; }
  expire() { this.dispatchEvent(new MessageEvent("auth-expired", { data: "{}" })); }
  fail() { this.onerror?.(); }
}

beforeEach(() => {
  resetAuthHelperForTesting();
  window.history.replaceState(null, "", "/");
  delete window.__SUPER_LEADER_LOGIN_TOKEN__;
  delete window.__SUPER_LEADER_LOGIN_ERROR__;
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  resetAuthHelperForTesting();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("authentication generation isolation", () => {
  it("replaces the SSE connection even when renewed sessions have the same expiry, and ignores the old stream", async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url === "/auth/session" || url === "/auth/exchange") return session();
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);
    render(<App />);
    await screen.findByRole("button", { name: "工作看板" });
    const originalGeneration = getAuthSessionSnapshot().generation;
    const original = FakeEventSource.instances[0];

    await act(async () => { await login(); });

    expect(getAuthSessionSnapshot().generation).toBeGreaterThan(originalGeneration);
    expect(original.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(2);
    const renewed = FakeEventSource.instances[1];
    act(() => { original.expire(); original.fail(); });
    expect(screen.getByRole("button", { name: "工作看板" })).toBeInTheDocument();
    expect(renewed.closed).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);

    act(() => renewed.expire());
    expect(screen.getByTestId("auth-expired-banner")).toBeInTheDocument();
    expect(renewed.closed).toBe(true);
  });

  it("ignores an old stream expiry synchronously after a new login starts, before effects clean up", async () => {
    const exchange = deferredResponse();
    let exchangeSignal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
      if (url === "/auth/session") return Promise.resolve(session());
      if (url === "/auth/exchange") {
        exchangeSignal = init.signal;
        return exchange.promise;
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    render(<App />);
    await screen.findByRole("button", { name: "工作看板" });
    const original = FakeEventSource.instances[0];

    act(() => {
      void login();
      original.expire();
      expect(getAuthSessionSnapshot().state.status).toBe("checking");
      expect(exchangeSignal?.aborted).toBe(false);
    });
    await act(async () => { exchange.resolve(session()); });

    expect(screen.getByRole("button", { name: "工作看板" })).toBeInTheDocument();
    expect(screen.queryByTestId("auth-expired-banner")).toBeNull();
    expect(FakeEventSource.instances).toHaveLength(2);
  });

  it("keeps a fresh login when the initial session check returns a late 401 despite cancellation", async () => {
    const initial = deferredResponse();
    let initialSignal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
      if (url === "/auth/session") {
        initialSignal = init.signal;
        return initial.promise;
      }
      if (url === "/auth/exchange") return Promise.resolve(session());
      throw new Error(`Unexpected request: ${url}`);
    }));
    render(<App />);
    const originalInitialization = getOrInitAuthSession();
    await act(async () => { await login(); });
    expect(initialSignal?.aborted).toBe(true);
    const renewed = FakeEventSource.instances[0];

    await act(async () => { initial.resolve(response({}, 401)); await originalInitialization; });

    expect(await originalInitialization).toEqual({ status: "authenticated", expiresAt: EXPIRES_AT });
    expect(screen.getByRole("button", { name: "工作看板" })).toBeInTheDocument();
    expect(getAuthSessionSnapshot().state.status).toBe("authenticated");
    expect(renewed.closed).toBe(false);
  });

  it("does not publish an older exchange failure after a newer token succeeds", async () => {
    const older = deferredResponse();
    const subscriber = vi.fn();
    subscribeAuthState(subscriber);
    vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => {
      const { token } = JSON.parse(init.body as string) as { token: string };
      return token === FIRST_TOKEN ? older.promise : Promise.resolve(session());
    }));
    const originalInitialization = login();
    await login(SECOND_TOKEN);
    const renewedGeneration = getAuthSessionSnapshot().generation;
    older.resolve(response({}, 401));
    expect(await originalInitialization).toEqual({ status: "authenticated", expiresAt: EXPIRES_AT });
    expect(getAuthSessionSnapshot().generation).toBe(renewedGeneration);
    expect(getAuthSessionSnapshot().state.status).toBe("authenticated");
    expect(subscriber).not.toHaveBeenCalledWith({ status: "unauthenticated", reason: "invalid_link" });
  });

  it("invalidating auth supersedes pending initialization and rejects stale generation failures", async () => {
    const initial = deferredResponse();
    vi.stubGlobal("fetch", vi.fn(() => initial.promise));
    const promise = getOrInitAuthSession();
    const oldGeneration = getAuthSessionSnapshot().generation;
    expect(setUnauthenticatedSession("none", oldGeneration)).toBe(true);
    initial.resolve(session());

    expect(await promise).toEqual({ status: "unauthenticated", reason: "none" });
    expect(setUnauthenticatedSession("expired", oldGeneration)).toBe(false);
    expect(getAuthSessionSnapshot().state).toEqual({ status: "unauthenticated", reason: "none" });
  });

  it("ignores a fallback status request's late 401 after renewing the login", async () => {
    vi.stubGlobal("EventSource", undefined);
    const initialStatus = deferredResponse();
    let statusRequests = 0;
    let initialSignal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
      if (url === "/auth/session" || url === "/auth/exchange") return Promise.resolve(session());
      if (url === "/health") return Promise.resolve(response({ status: "ok" }));
      if (url === "/v1/status") {
        if (++statusRequests === 1) { initialSignal = init.signal; return initialStatus.promise; }
        return Promise.resolve(status());
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    render(<App />);
    await waitFor(() => expect(statusRequests).toBe(1));
    await act(async () => { await login(); });
    await waitFor(() => expect(statusRequests).toBe(2));
    expect(initialSignal?.aborted).toBe(true);

    await act(async () => { initialStatus.resolve(response({}, 401)); });

    expect(screen.getByRole("button", { name: "工作看板" })).toBeInTheDocument();
    expect(screen.queryByTestId("auth-expired-banner")).toBeNull();
    expect(getAuthSessionSnapshot().state.status).toBe("authenticated");
  });

  it("ignores a recovery session probe's late 401 after renewing the SSE login", async () => {
    const recovery = deferredResponse();
    let sessionChecks = 0;
    let recoverySignal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn((url: string, init: RequestInit) => {
      if (url === "/auth/session") {
        if (++sessionChecks === 1) return Promise.resolve(session());
        recoverySignal = init.signal;
        return recovery.promise;
      }
      if (url === "/auth/exchange") return Promise.resolve(session());
      throw new Error(`Unexpected request: ${url}`);
    }));
    render(<App />);
    await screen.findByRole("button", { name: "工作看板" });
    act(() => FakeEventSource.instances[0].fail());
    expect(sessionChecks).toBe(2);
    await act(async () => { await login(); });
    expect(recoverySignal?.aborted).toBe(true);

    await act(async () => { recovery.resolve(response({}, 401)); });

    expect(screen.getByRole("button", { name: "工作看板" })).toBeInTheDocument();
    expect(screen.queryByTestId("auth-expired-banner")).toBeNull();
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].closed).toBe(false);
  });
});
