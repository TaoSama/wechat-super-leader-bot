import { emptyExecutions } from "./status-fixtures";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "../src/App";
import { resetAuthHelperForTesting } from "../src/auth";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetAuthHelperForTesting();
});

it.each([
  { mode: "rules", label: "规则模式（未启用模型 Leader）", detail: "不具备开放式模型规划" },
  { mode: "model", label: "模型 Leader 模式", detail: "不代表模型当前可用或任务已完成" },
  { mode: undefined, label: "Leader 模式未知", detail: "不能推断模型已启用" },
  { mode: "unexpected", label: "Leader 模式未知", detail: "不能推断模型已启用" },
])("shows truthful Leader mode for $mode", async ({ mode, label, detail }) => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/auth/session") {
      return new Response(JSON.stringify({ authenticated: true, expiresAt: "2026-10-10T11:00:00.000Z" }), { status: 200 });
    }
    if (url === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    if (url === "/v1/status") {
      return new Response(JSON.stringify({ leaderMode: mode, nodes: [], sessions: [], commands: [], executions: emptyExecutions() }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  });

  vi.stubGlobal("fetch", fetchMock);

  render(<App />);

  fireEvent.click(await screen.findByRole("button", { name: "Super Leader" }));
  const region = await screen.findByRole("region", { name: "Leader 运行模式" });
  expect(region).toHaveTextContent(label);
  expect(region).toHaveTextContent(detail);

  const calledUrls = fetchMock.mock.calls.map(([url]) => url);
  expect(calledUrls).toContain("/auth/session");
  expect(calledUrls).toContain("/v1/status");
  expect(calledUrls).toContain("/health");
});
