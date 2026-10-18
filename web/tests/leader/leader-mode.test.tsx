import { emptyGoals, emptyExecutions  } from "../fixtures/status-fixtures";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "../../src/App";
import { resetAuthHelperForTesting } from "../../src/auth/bootstrap";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetAuthHelperForTesting();
});

it.each([
  { mode: "rules", label: "基础协作", detail: "尚未开启模型规划" },
  { mode: "model", label: "智能协作", detail: "具体任务的进展与结果" },
  { mode: undefined, label: "正在确认运行方式", detail: "暂未获取到运行方式" },
  { mode: "unexpected", label: "正在确认运行方式", detail: "暂未获取到运行方式" },
])("shows truthful Leader mode for $mode", async ({ mode, label, detail }) => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/auth/session") {
      return new Response(JSON.stringify({ authenticated: true, expiresAt: "2026-10-10T11:00:00.000Z" }), { status: 200 });
    }
    if (url === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    if (url === "/v1/status") {
      return new Response(JSON.stringify({ leaderMode: mode, nodes: [], sessions: [], commands: [], goals: emptyGoals(), executions: emptyExecutions() }), { status: 200 });
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
