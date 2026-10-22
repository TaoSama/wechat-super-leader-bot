import { emptyGoals, emptyExecutions  } from "../fixtures/status-fixtures";
// React 17+ JSX transform
import { render, screen, fireEvent, waitFor, act, within } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import App from "../../src/App";
import { ControlPlaneStatusResponse } from "../../src/types";
import { resetAuthHelperForTesting } from "../../src/auth/bootstrap";

const VALID_43_TOKEN = "aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789_-abcde"; // exactly 43 chars

const MOCK_STATUS_PAYLOAD: ControlPlaneStatusResponse = {
  goals: emptyGoals(), executions: emptyExecutions(),
  nodes: [
    {
      nodeId: "demomini",
      connected: true,
      lastHeartbeat: "2026-10-10T10:00:00.000Z",
      sessionCount: 2,
    },
    {
      nodeId: "demoair",
      connected: false,
      lastHeartbeat: "2026-10-10T09:50:00.000Z",
      sessionCount: 1,
    },
  ],
  sessions: [
    {
      id: "sess_alpha",
      nodeId: "demomini",
      provider: "codex-app",
      title: "重构 控制平面状态存储",
      cwd: "/Users/developer/Documents/ordinary/wechat-super-leader-bot",
      status: "running",
      capabilities: ["read", "send"],
      observedAt: "2026-10-10T10:00:00.000Z",
    },
    {
      id: "sess_readonly",
      nodeId: "demomini",
      provider: "codex-app",
      title: "生产日志只读巡检",
      cwd: "/var/log/super-leader",
      status: "idle",
      capabilities: ["read"],
      observedAt: "2026-10-10T09:59:30.000Z",
    },
    {
      id: "sess_legacy",
      nodeId: "linux-worker-9",
      provider: "codex-app",
      title: "离线节点遗留会话",
      cwd: "/home/worker/app",
      status: "unknown",
      capabilities: [],
      observedAt: "2026-10-10T08:15:00.000Z",
    },
  ],
  commands: [
    {
      commandId: "cmd_101_pending",
      requestId: "req_101",
      nodeId: "demomini",
      sessionId: "sess_alpha",
      action: "read",
      status: "pending",
      expiresAt: "2026-10-10T10:05:00.000Z",
      createdAt: "2026-10-10T10:00:01.000Z",
      updatedAt: "2026-10-10T10:00:01.000Z",
    },
    {
      commandId: "cmd_102_accepted",
      requestId: "req_102",
      nodeId: "demomini",
      sessionId: "sess_alpha",
      action: "send",
      prompt: "运行单元测试并汇报覆盖率",
      status: "accepted",
      output: "turn_9981",
      turnId: "turn_9981",
      expiresAt: "2026-10-10T10:05:00.000Z",
      createdAt: "2026-10-10T09:59:20.000Z",
      updatedAt: "2026-10-10T09:59:21.000Z",
    },
    {
      commandId: "cmd_103_completed",
      requestId: "req_103",
      nodeId: "demomini",
      sessionId: "sess_readonly",
      action: "read",
      status: "completed",
      output: "All 18 tests passed successfully.",
      expiresAt: "2026-10-10T10:04:00.000Z",
      createdAt: "2026-10-10T09:58:00.000Z",
      updatedAt: "2026-10-10T09:58:02.000Z",
    },
    {
      commandId: "cmd_104_failed",
      requestId: "req_104",
      nodeId: "demoair",
      sessionId: "sess_alpha",
      action: "send",
      prompt: "deploy production",
      status: "failed",
      error: "Command expired before execution",
      expiresAt: "2026-10-10T09:55:00.000Z",
      createdAt: "2026-10-10T09:50:00.000Z",
      updatedAt: "2026-10-10T09:55:01.000Z",
    },
    {
      commandId: "cmd_105_uncertain",
      requestId: "req_105",
      nodeId: "linux-worker-9",
      sessionId: "sess_legacy",
      action: "send",
      prompt: "check disk usage",
      status: "uncertain",
      error: "Node disconnected after dispatch",
      expiresAt: "2026-10-10T08:20:00.000Z",
      createdAt: "2026-10-10T08:15:00.000Z",
      updatedAt: "2026-10-10T08:15:10.000Z",
    },
  ],
};

function createStandardFetchMock(statusData: unknown = MOCK_STATUS_PAYLOAD, httpStatus = 200) {
  return vi.fn().mockImplementation((input: RequestInfo | URL) => {
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

    if (url === "/auth/logout") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          authenticated: false,
        }),
      });
    }

    if (url === "/health") {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ status: "ok", timestamp: "2026-10-10T10:00:00.000Z" }),
      });
    }

    if (url === "/v1/status") {
      return Promise.resolve({
        ok: httpStatus >= 200 && httpStatus < 300,
        status: httpStatus,
        json: async () => statusData,
      });
    }

    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });
}

describe("Super Leader 会话工作台", () => {
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

  it("1. 保持一次性 token 严格在内存中消费，URL 立即从地址栏清除，绝不写入 localStorage 或 sessionStorage", async () => {
    const fetchMock = createStandardFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const localSetItemSpy = vi.spyOn(window.localStorage, "setItem");
    const sessionSetItemSpy = vi.spyOn(window.sessionStorage, "setItem");

    // Real window hash
    window.location.hash = `#login=${VALID_43_TOKEN}`;

    render(<App />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/auth/exchange",
        expect.objectContaining({
          method: "POST",
          credentials: "same-origin",
          body: JSON.stringify({ token: VALID_43_TOKEN }),
        })
      );
    });

    // Verify fragment was immediately stripped from the address bar
    expect(window.location.hash).toBe("");

    // Verify zero persistence to storage
    expect(localSetItemSpy).not.toHaveBeenCalled();
    expect(sessionSetItemSpy).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("2. 准确展示节点在线/离线（含历史会话推导出的离线节点）、会话复合标识与能力，以及全部 5 种指令状态（严禁混淆 accepted 与 completed）", async () => {
    const fetchMock = createStandardFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    window.location.hash = `#login=${VALID_43_TOKEN}`;
    render(<App />);

    // Wait for nodes to render
    await waitFor(() => {
      expect(screen.getByTestId("node-card-demomini")).toBeInTheDocument();
    });

    // Online node & Offline nodes (including inferred offline node linux-worker-9)
    expect(screen.getByTestId("node-card-demomini")).toHaveTextContent("在线 (ONLINE)");
    expect(screen.getByTestId("node-card-demoair")).toHaveTextContent("离线 (OFFLINE)");
    expect(screen.getByTestId("node-card-linux-worker-9")).toHaveTextContent(
      "离线 (OFFLINE)"
    );

    // Sessions and capabilities
    const alphaRow = screen.getByTestId("session-row-demomini-sess_alpha");
    expect(alphaRow).toHaveTextContent("模型未报告");
    expect(within(alphaRow).getByRole("img", { name: "执行中" })).toBeInTheDocument();
    expect(alphaRow).toHaveTextContent("重构 控制平面状态存储");

    const roRow = screen.getByTestId("session-row-demomini-sess_readonly");
    expect(within(roRow).getByRole("img", { name: "空闲" })).toBeInTheDocument();

    const noneRow = screen.getByTestId("session-row-linux-worker-9-sess_legacy");
    expect(within(noneRow).getByRole("img", { name: "状态未知" })).toBeInTheDocument();

    // Command 5 statuses check:
    // 1) pending
    expect(screen.getByTestId("command-status-cmd_101_pending")).toHaveTextContent(
      "等待响应 (Pending)"
    );
    // 2) accepted acknowledges input without claiming an execution outcome.
    const acceptedBadge = screen.getByTestId("command-status-cmd_102_accepted");
    expect(acceptedBadge).toHaveTextContent("已受理 (Accepted)");
    expect(acceptedBadge).not.toHaveTextContent("执行完成 (Completed)");
    expect(screen.getByTestId("command-item-cmd_102_accepted")).toHaveTextContent("关联 Turn: turn_9981");
    expect(screen.getByTestId("command-item-cmd_102_accepted")).toHaveTextContent("派发截止（非执行时限）");
    expect(screen.getByTestId("command-item-cmd_102_accepted")).toHaveTextContent(
      "输入已被接受，执行结果尚未确认"
    );
    // 3) completed
    expect(
      screen.getByTestId("command-status-cmd_103_completed")
    ).toHaveTextContent("执行完成 (Completed)");
    // 4) failed
    expect(screen.getByTestId("command-status-cmd_104_failed")).toHaveTextContent(
      "执行失败 (Failed)"
    );
    // 5) uncertain
    expect(
      screen.getByTestId("command-status-cmd_105_uncertain")
    ).toHaveTextContent("状态存疑 (Uncertain)");
    expect(screen.getByTestId("command-item-cmd_105_uncertain")).toHaveTextContent(
      "不确定，需核验，勿自动重发"
    );
  });

  it("3. 未选择会话时仅查询状态，不调用任何管理写入入口", async () => {
    const fetchMock = createStandardFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    window.location.hash = `#login=${VALID_43_TOKEN}`;
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("node-card-demomini")).toBeInTheDocument();
    });

    // Verify commands endpoints are strictly GET
    for (const call of fetchMock.mock.calls) {
      const url = call[0].toString();
      const init = call[1] as RequestInit | undefined;
      if (url.startsWith("/v1/")) {
        expect(init?.method ?? "GET").toBe("GET");
      }
    }

    // Ensure no action buttons to dispatch commands exist
    expect(screen.queryByRole("button", { name: /发送指令|派发|执行命令/ })).toBeNull();
  });

  it("4. 支持 5 秒定时轮询、错误态横幅重试，以及组件卸载时通过 AbortController 取消请求", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let statusCallCount = 0;
    let lastSignal: AbortSignal | undefined;

    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/auth/session") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ authenticated: true, expiresAt: "2026-10-10T11:00:00.000Z" }),
        });
      }

      if (url === "/health") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ status: "ok", timestamp: "2026-10-10T10:00:00.000Z" }),
        });
      }

      if (url === "/v1/status") {
        statusCallCount += 1;
        lastSignal = init?.signal ?? undefined;
        if (statusCallCount === 2) {
          return Promise.resolve({
            ok: false,
            status: 502,
            json: async () => ({ error: "Bad Gateway from upstream" }),
          });
        }
        if (statusCallCount === 3) {
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => MOCK_STATUS_PAYLOAD,
        });
      }

      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({}),
      });
    });

    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(<App pollIntervalMs={5000} />);

    await waitFor(() => {
      expect(statusCallCount).toBe(1);
    });

    // Advance 5 seconds to trigger second poll (which simulates 502 failure)
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });

    await waitFor(() => {
      expect(statusCallCount).toBe(2);
      expect(screen.getByTestId("telemetry-error-banner")).toHaveTextContent(
        "Bad Gateway from upstream"
      );
    });

    // Previous data remains visible without full page reload
    expect(screen.getByTestId("node-card-demomini")).toBeInTheDocument();

    // Start an actual pending refresh; completed reads need no cancellation.
    fireEvent.click(screen.getByRole("button", { name: "立即刷新控制平面状态" }));
    expect(statusCallCount).toBe(3);
    expect(lastSignal?.aborted).toBe(false);
    // Unmount and verify the pending request is cancelled.
    unmount();
    expect(lastSignal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it.each([undefined, null, { ...emptyExecutions(), items: [null] }])("首次 HTTP 计划投影无效时明确报错，不冒充空计划（%j）", async executions => {
    const fetchMock = createStandardFetchMock({ ...MOCK_STATUS_PAYLOAD, executions });
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<App />);
    await waitFor(() => {
      expect(screen.getByTestId("telemetry-error-banner")).toHaveTextContent("持久计划状态格式无效，无法确认计划进度");
    });
    expect(screen.queryByText("当前窗口没有已确认计划")).not.toBeInTheDocument();
    expect(screen.queryByTestId("node-card-demomini")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /任务计划/ })).not.toBeInTheDocument();
    unmount();
  });

  it("5. 支持空数据状态（无节点、无会话、无命令）与微信引导展示（不提供 raw token 表单输入）", async () => {
    const emptyPayload: ControlPlaneStatusResponse = {
      nodes: [],
      sessions: [],
      commands: [], goals: emptyGoals(), executions: emptyExecutions(),
    };
    const fetchMock = createStandardFetchMock(emptyPayload, 200);
    vi.stubGlobal("fetch", fetchMock);

    window.location.hash = `#login=${VALID_43_TOKEN}`;
    render(<App />);

    await waitFor(() => {
      expect(screen.getByText("暂无已连接的宿主节点")).toBeInTheDocument();
    });
    expect(screen.getByText("暂无会话")).toBeInTheDocument();
    expect(screen.getByText("暂无匹配的指令审计记录")).toBeInTheDocument();

    // Verify there is absolutely NO token input box
    expect(screen.queryByPlaceholderText(/输入 CONTROLLER_TOKEN/)).toBeNull();
    expect(screen.queryByRole("textbox", { name: /token/i })).toBeNull();
  });

  it("6. 支持节点筛选联动、移动端分区切换与退出登录（注销失败明确提示，不谎报成功）", async () => {
    let logoutShouldFail = false;
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url === "/auth/exchange" || url === "/auth/session") {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            authenticated: true,
            expiresAt: "2026-10-10T11:00:00.000Z",
          }),
        });
      }

      if (url === "/auth/logout") {
        if (logoutShouldFail) {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: async () => ({ error: "Internal Server Error" }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ authenticated: false }),
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
          json: async () => MOCK_STATUS_PAYLOAD,
        });
      }

      return Promise.reject(new Error(`Unexpected URL ${url}`));
    });

    vi.stubGlobal("fetch", fetchMock);

    window.location.hash = `#login=${VALID_43_TOKEN}`;
    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId("node-card-demomini")).toBeInTheDocument();
    });

    // Filter by node demoair
    fireEvent.click(screen.getByRole("button", { name: "工作看板" }));
    fireEvent.click(
      screen.getByRole("button", { name: "按节点 demoair 筛选会话与指令" })
    );

    // Only demoair commands should remain visible
    expect(
      screen.getByTestId("command-item-cmd_104_failed")
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("command-item-cmd_101_pending")
    ).not.toBeInTheDocument();

    // Clear node filter
    fireEvent.click(screen.getByRole("button", { name: "取消筛选节点 demoair" }));
    expect(
      screen.getByTestId("command-item-cmd_101_pending")
    ).toBeInTheDocument();

    // 1. Simulate logout failure
    logoutShouldFail = true;
    fireEvent.click(screen.getByRole("button", { name: "退出控制台登录" }));

    await waitFor(() => {
      expect(screen.getByTestId("logout-error-banner")).toHaveTextContent("退出登录失败");
    });
    // Ensure still authenticated, not falsely revoked
    expect(screen.getByTestId("node-card-demomini")).toBeInTheDocument();

    // 2. Simulate successful logout
    logoutShouldFail = false;
    fireEvent.click(screen.getByRole("button", { name: "退出控制台登录" }));

    await waitFor(() => {
      expect(screen.getByText("把工作带在身边")).toBeInTheDocument();
      expect(screen.getByText("给我控制台链接")).toBeInTheDocument();
    });
  });
});
