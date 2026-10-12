import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import App from "../src/App";
import { resetAuthHelperForTesting } from "../src/auth";
import { completedRelayFixture, emptyExecutions } from "./status-fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  resetAuthHelperForTesting();
});

it("loads the completed two-step HTTP relay and refreshes its plan status without a telemetry error", async () => {
  resetAuthHelperForTesting();
  window.location.hash = "";
  const plan = completedRelayFixture("active");
  const payload = { nodes: [], sessions: [], commands: [], leaderMode: "model",
    executions: { ...emptyExecutions(), items: [plan] } };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = input.toString();
    if (url === "/auth/session") return new Response(JSON.stringify({ authenticated: true }));
    if (url === "/health") return new Response(JSON.stringify({ status: "ok" }));
    if (url === "/v1/status") return new Response(JSON.stringify(payload));
    throw new Error(`Unexpected read request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", undefined);
  render(<App />);

  const card = await screen.findByTestId(`execution-${plan.id}`);
  fireEvent.click(screen.getByRole("button", { name: "Super Leader" }));
  expect(card).toHaveTextContent("已完成 2 / 2 步");
  expect(card).toHaveTextContent("步骤完成，计划待核对");
  expect(screen.queryByTestId("telemetry-error-banner")).toBeNull();
  fireEvent.click(within(card).getByText("展开有序步骤与依赖"));
  expect(within(card).getByTestId(`execution-step-${plan.id}-2`)).toHaveTextContent("未裁剪 · 引用 28 字符");

  plan.status = "completed";
  fireEvent.click(screen.getByRole("button", { name: "立即刷新控制平面状态" }));
  await waitFor(() => expect(card).toHaveTextContent("计划已完成"));
  expect(within(card).getByRole("progressbar")).toHaveAttribute("value", "2");
  expect(screen.queryByTestId("telemetry-error-banner")).toBeNull();
  for (const [input, init] of fetchMock.mock.calls) {
    if (input.toString().startsWith("/v1/")) expect(init?.method).toBe("GET");
  }
});
