import { emptyGoals, emptyExecutions  } from "../fixtures/status-fixtures";
import React from "react";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import App from "../../src/App";
import {
  extractAndClearLoginToken,

  handleHashChangeLogin,
  resetAuthHelperForTesting,
} from "../../src/auth/bootstrap";

const TOKEN_43 = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ABCDE"; // exactly 43 chars
const TOKEN_43_ALT = "1234567890abcdefghijklmnopqrstuvwxyz_ABCDE-"; // another 43 chars

describe("Web Console One-Time Link Authentication Flow", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    delete window.__SUPER_LEADER_LOGIN_TOKEN__;
    delete window.__SUPER_LEADER_LOGIN_ERROR__;
    window.location.hash = "";
    resetAuthHelperForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete window.__SUPER_LEADER_LOGIN_TOKEN__;
    delete window.__SUPER_LEADER_LOGIN_ERROR__;
    window.location.hash = "";
    resetAuthHelperForTesting();
  });

  it("1. 立即同步提取并清除地址栏 hash 和 search，严格校验 43 字符 base64url", () => {
    window.history.pushState(null, "", "/dashboard?utm_source=wechat#login=" + TOKEN_43);

    const replaceStateSpy = vi.spyOn(window.history, "replaceState");

    const token = extractAndClearLoginToken(window);
    expect(token).toBe(TOKEN_43);

    // Both hash and search must be cleared, leaving only pathname
    expect(replaceStateSpy).toHaveBeenCalledWith(null, "", window.location.pathname);
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("");

    // Second call must return null (already extracted)
    expect(extractAndClearLoginToken(window)).toBeNull();
  });

  it("2. 若 replaceState 发生异常必须 fail closed，拒绝在未清理 URL 的情况下返回 token", () => {
    window.location.hash = `#login=${TOKEN_43}`;
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {
      throw new Error("SecurityError: history state restricted");
    });

    const token = extractAndClearLoginToken(window);
    expect(token).toBeNull();
  });

  it("3. 非严格 43 字符或含非法字符时拒绝提取", () => {
    // 42 chars
    window.location.hash = "#login=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ABCD";
    expect(extractAndClearLoginToken(window)).toBeNull();

    // 44 chars
    window.location.hash = "#login=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ABCDEF";
    expect(extractAndClearLoginToken(window)).toBeNull();

    // Invalid chars (+/)
    window.location.hash = "#login=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/ABCDE";
    expect(extractAndClearLoginToken(window)).toBeNull();
  });

  it("4. React StrictMode 双挂载下同 token 仅发起一次 POST /auth/exchange，杜绝 race 401", async () => {
    let exchangeCalls = 0;
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/auth/exchange") {
        exchangeCalls++;
        // Simulate real network delay (30ms) to ensure StrictMode remount happens during in-flight exchange
        await new Promise((resolve) => setTimeout(resolve, 30));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            authenticated: true,
            expiresAt: "2026-10-10T11:00:00.000Z",
          }),
        };
      }
      if (url === "/health") {
        return {
          ok: true,
          status: 200,
          json: async () => ({ status: "ok" }),
        };
      }
      if (url === "/v1/status") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            leaderMode: "model",
            nodes: [{ nodeId: "macmini", connected: true, lastHeartbeat: "", sessionCount: 1 }],
            sessions: [],
            commands: [], goals: emptyGoals(), executions: emptyExecutions(),
          }),
        };
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });

    vi.stubGlobal("fetch", fetchMock);
    window.location.hash = `#login=${TOKEN_43}`;

    // Render under StrictMode
    render(
      <React.StrictMode>
        <App />
      </React.StrictMode>
    );

    // Wait until authenticated and telemetry appears
    await waitFor(() => {
      expect(screen.getByTestId("node-card-macmini")).toBeInTheDocument();
    });

    // Address bar hash must have been stripped immediately
    expect(window.location.hash).toBe("");

    // Exactly 1 exchange request must be dispatched
    expect(exchangeCalls).toBe(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/auth/exchange",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ token: TOKEN_43 }),
      })
    );
  });

  it("5. 页面刷新时无 URL token，自动通过 GET /auth/session 恢复 1 小时会话，绝不写入 Storage", async () => {
    const localSpy = vi.spyOn(window.localStorage, "setItem");
    const sessionSpy = vi.spyOn(window.sessionStorage, "setItem");

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/auth/session") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            authenticated: true,
            expiresAt: "2026-10-10T11:00:00.000Z",
          }),
        });
      }
      if (url === "/health") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ status: "ok" }),
        });
      }
      if (url === "/v1/status") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            leaderMode: "model",
            nodes: [{ nodeId: "macmini", connected: true, lastHeartbeat: "", sessionCount: 1 }],
            sessions: [],
            commands: [], goals: emptyGoals(), executions: emptyExecutions(),
          }),
        });
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("定时更新", { exact: false })).toBeInTheDocument();
      expect(screen.getByTestId("node-card-macmini")).toBeInTheDocument();
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/auth/session",
      expect.objectContaining({
        method: "GET",
        credentials: "same-origin",
      })
    );

    expect(localSpy).not.toHaveBeenCalled();
    expect(sessionSpy).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("6. 一次性链接兑换 401 失败时，呈现链接失效友好提示与微信引导，绝无 raw token 输入框", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/auth/exchange") {
        return Promise.resolve({
          ok: false,
          status: 401,
          json: async () => ({ error: "Unauthorized" }),
        });
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });

    vi.stubGlobal("fetch", fetchMock);
    window.location.hash = `#login=${TOKEN_43}`;

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("auth-invalid-link-banner")).toHaveTextContent("当前登录链接无效或已过期");
      expect(screen.getByText("需要微信一次性登录链接")).toBeInTheDocument();
      expect(screen.getByText("给我控制台链接")).toBeInTheDocument();
    });

    // Address bar was cleaned even when exchange failed
    expect(window.location.hash).toBe("");

    // Verify absolutely no password/token input exists in the document
    expect(screen.queryByPlaceholderText(/CONTROLLER_TOKEN/)).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("7. 轮询期间遭遇 401 会话失效时，停止轮询并清空遥测数据，回退至会话过期提示", async () => {
    let statusCallCount = 0;
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/auth/session") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            authenticated: true,
            expiresAt: "2026-10-10T11:00:00.000Z",
          }),
        });
      }
      if (url === "/health") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ status: "ok" }),
        });
      }
      if (url === "/v1/status") {
        statusCallCount++;
        if (statusCallCount === 1) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              nodes: [{ nodeId: "macmini", connected: true, lastHeartbeat: "", sessionCount: 1 }],
              sessions: [],
              commands: [], goals: emptyGoals(), executions: emptyExecutions(),
            }),
          });
        }
        return Promise.resolve({
          ok: false,
          status: 401,
          json: async () => ({ error: "Session expired" }),
        });
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });

    vi.stubGlobal("fetch", fetchMock);

    render(<App pollIntervalMs={5000} />);

    // First poll succeeds and displays node
    await waitFor(() => {
      expect(screen.getByTestId("node-card-macmini")).toBeInTheDocument();
    });

    // Trigger manual refresh which returns 401
    fireEvent.click(screen.getByRole("button", { name: "立即刷新控制平面状态" }));

    await waitFor(() => {
      expect(screen.getByTestId("auth-expired-banner")).toHaveTextContent("控制台会话已过期");
      expect(screen.queryByTestId("node-card-macmini")).toBeNull();
    });
  });

  it("8. 支持 index.html 早期 bootstrap 全局变量（合法 token 与非法格式标记安全防护）", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/auth/exchange") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            authenticated: true,
            expiresAt: "2026-10-10T11:00:00.000Z",
          }),
        });
      }
      if (url === "/health") {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: "ok" }) });
      }
      if (url === "/v1/status") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ nodes: [], sessions: [], commands: [], goals: emptyGoals(), executions: emptyExecutions() }),
        });
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    // 1) Early bootstrap saved valid token
    window.__SUPER_LEADER_LOGIN_TOKEN__ = TOKEN_43;
    render(<App />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/auth/exchange",
        expect.objectContaining({
          body: JSON.stringify({ token: TOKEN_43 }),
        })
      );
    });

    // Global variable must be deleted after consumption
    expect(window.__SUPER_LEADER_LOGIN_TOKEN__).toBeUndefined();

    // 2) Early bootstrap recorded error (e.g. invalid format or sanitize error)
    resetAuthHelperForTesting();
    window.__SUPER_LEADER_LOGIN_ERROR__ = "invalid_token_format";
    const { unmount } = render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("auth-invalid-link-banner")).toBeInTheDocument();
    });

    expect(window.__SUPER_LEADER_LOGIN_ERROR__).toBeUndefined();
    unmount();
  });

  it("9. 同一 Tab 内接收新 #login= 链接进行 hash 导航时，立即提取清理并重走认证流", async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/auth/session") {
        // Initial load: no active session
        return Promise.resolve({
          ok: false,
          status: 401,
          json: async () => ({ error: "No session" }),
        });
      }
      if (url === "/auth/exchange") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            authenticated: true,
            expiresAt: "2026-10-10T11:00:00.000Z",
          }),
        });
      }
      if (url === "/health") {
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: "ok" }) });
      }
      if (url === "/v1/status") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            nodes: [{ nodeId: "macmini", connected: true, lastHeartbeat: "", sessionCount: 1 }],
            sessions: [],
            commands: [], goals: emptyGoals(), executions: emptyExecutions(),
          }),
        });
      }
      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    // Starts in unauthenticated guidance state
    await waitFor(() => {
      expect(screen.getByText("需要微信一次性登录链接")).toBeInTheDocument();
    });

    // User receives new one-time link in the same open tab, triggering hashchange
    await act(async () => {
      window.location.hash = `#login=${TOKEN_43_ALT}`;
      handleHashChangeLogin(window);
    });

    // App receives auth state change without full page reload
    await waitFor(() => {
      expect(screen.getByTestId("node-card-macmini")).toBeInTheDocument();
    });

    // Address bar hash stripped immediately
    expect(window.location.hash).toBe("");

    // Exchange called with the new token
    expect(fetchMock).toHaveBeenCalledWith(
      "/auth/exchange",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: TOKEN_43_ALT }),
      })
    );
  });
});
