import { StrictMode } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../../src/App";
import { getOrInitAuthSession, resetAuthHelperForTesting } from "../../src/auth/bootstrap";
import { emptyExecutions, emptyGoals } from "../fixtures/status-fixtures";

const LOGIN_TOKEN = "a".repeat(43);
const SESSION_EXPIRES_AT = "2026-10-24T10:00:00.000Z";

class AuthRaceEventSource extends EventTarget {
  static instances: AuthRaceEventSource[] = [];
  closed = false;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    super();
    AuthRaceEventSource.instances.push(this);
  }

  close() { this.closed = true; }

  status() {
    this.dispatchEvent(new MessageEvent("status", { data: JSON.stringify({
      nodes: [], sessions: [], commands: [], goals: emptyGoals(), executions: emptyExecutions(),
    }) }));
  }
}

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  resetAuthHelperForTesting();
  AuthRaceEventSource.instances = [];
  vi.stubGlobal("EventSource", AuthRaceEventSource);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  resetAuthHelperForTesting();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

it.each([false, true])("keeps a successful hash login and its stream after the initial session returns a late 401 (StrictMode=%s)", async strict => {
  let releaseInitialSession!: (response: Response) => void;
  const initialSession = new Promise<Response>(resolve => { releaseInitialSession = resolve; });
  const fetch = vi.fn((url: string) => {
    if (url === "/auth/session") return initialSession;
    if (url === "/auth/exchange") return Promise.resolve(new Response(JSON.stringify({
      authenticated: true, expiresAt: SESSION_EXPIRES_AT,
    })));
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetch);

  const app = <App />;
  render(strict ? <StrictMode>{app}</StrictMode> : app);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe("/auth/session");
  const initialAuth = getOrInitAuthSession();

  // Setting the real hash delivers the browser's hashchange event to the module listener.
  await act(async () => {
    const hashChanged = new Promise<void>(resolve => {
      window.addEventListener("hashchange", () => resolve(), { once: true });
    });
    window.location.hash = `#login=${LOGIN_TOKEN}`;
    await hashChanged;
    await getOrInitAuthSession();
  });
  await waitFor(() => {
    expect(screen.getByRole("button", { name: "退出控制台登录" })).toBeInTheDocument();
    expect(AuthRaceEventSource.instances).toHaveLength(1);
  }, { timeout: 5000 });
  const stream = AuthRaceEventSource.instances[0];
  act(() => stream.status());
  expect(screen.getByText("实时连接")).toBeInTheDocument();
  expect(window.location.hash).toBe("");

  await act(async () => {
    releaseInitialSession(new Response("{}", { status: 401 }));
    await initialAuth;
  });

  expect(await getOrInitAuthSession()).toEqual({ status: "authenticated", expiresAt: SESSION_EXPIRES_AT });
  expect(screen.queryByText("把工作带在身边")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "退出控制台登录" })).toBeInTheDocument();
  expect(screen.getByText("实时连接")).toBeInTheDocument();
  expect(stream.closed).toBe(false);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(["/auth/session", "/auth/exchange"]);
});
