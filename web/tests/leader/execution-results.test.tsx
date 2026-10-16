import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ExecutionsSection } from "../../src/features/leader/components/ExecutionsSection";
import { emptyExecutions, executionFixture, FIXTURE_NOW } from "../fixtures/status-fixtures";
import type { ConsoleExecution, ScopedSession } from "../../src/types";

const sessions: ScopedSession[] = ["air", "mini"].map(nodeId => ({ nodeId, id: "same-session", title: `${nodeId} 目标`,
  provider: "codex-app", cwd: "/synthetic", status: "idle", loaded: true, capabilities: ["read", "send"], observedAt: new Date(FIXTURE_NOW).toISOString() }));
function setup(plan: ConsoleExecution) {
  const onOpenSession = vi.fn();
  const props = { executions: { ...emptyExecutions(), items: [plan] }, sessions, selectedNodeId: "mini", schedulerEnabled: true, onOpenSession };
  const rendered = render(<ExecutionsSection {...props} />);
  fireEvent.click(screen.getByText("展开有序步骤与依赖"));
  const second = screen.getByTestId(`execution-step-${plan.id}-2`);
  return { ...rendered, second, props, onOpenSession };
}
function frozen() {
  const plan = executionFixture(); plan.steps[0].status = "completed";
  Object.assign(plan.steps[1], { status: "claimed", resultFrom: [1], resultSources: [{ step: 1,
    commandId: "first-command", turnId: "first-turn", outputSHA256: "b".repeat(64), outputLength: 4827,
    excerptLength: 1000, truncated: true }] });
  return plan;
}
it("shows waiting selections without claiming freezing, delivery or completion", () => {
  const plan = executionFixture(); plan.steps[1].resultFrom = [1];
  const { second } = setup(plan);
  expect(second).toHaveTextContent("将使用步骤 1 的已记录输出；尚未冻结资料");
  expect(second).toHaveTextContent("等待步骤 1 的精确完成回执");
  expect(second).not.toHaveTextContent("已冻结输入资料");
  expect(within(second).queryByText("来源核对详情")).toBeNull();
});
it("keeps frozen metadata behind a second disclosure and routes only to the original node/session", () => {
  const plan = frozen();
  const { second, onOpenSession } = setup(plan);
  expect(second).toHaveTextContent("已冻结输入资料 · 冻结不代表已送达");
  expect(second).toHaveTextContent("已裁剪 · 引用 1000 / 4827 字符");
  expect(second).toHaveTextContent("已领取 · 回执待核对");
  const hash = within(second).getByText("b".repeat(64)); expect(hash).not.toBeVisible();
  const summary = within(second).getByText("来源核对详情");
  expect(summary.tagName).toBe("SUMMARY");
  expect(summary.closest("details")).not.toHaveAttribute("open");
  fireEvent.click(summary);
  expect(hash).toBeVisible(); expect(summary.closest("details")).toHaveAttribute("open");
  expect(within(second).getByText(/未裁剪不等于原会话完整结果/)).toBeVisible();
  expect(within(second).getByText("first-command")).toBeVisible();
  fireEvent.click(within(second).getByRole("button", { name: /打开计划步骤 2/ }));
  expect(onOpenSession).toHaveBeenCalledExactlyOnceWith(sessions[1]);
  expect(within(second).queryByRole("button", { name: /发送|重试|重发|取消|确认/ })).toBeNull();
});
it("distinguishes empty and untrimmed recorded outputs without exposing source text", () => {
  const plan = frozen(); plan.steps[1].resultSources![0] = { ...plan.steps[1].resultSources![0], outputLength: 0, excerptLength: 0, truncated: false };
  // Raw receipt fields are never rendered even when an upstream caller bypasses normalization.
  Object.assign(plan.steps[1].resultSources![0], { excerpt: "secret result", prompt: "secret input" });
  const { second, rerender, props } = setup(plan);
  expect(second).toHaveTextContent("已记录输出为空"); expect(second).not.toHaveTextContent("secret result");
  expect(second).not.toHaveTextContent("secret input");
  plan.steps[1].resultSources![0].outputLength = 10; plan.steps[1].resultSources![0].excerptLength = 10;
  rerender(<ExecutionsSection {...props} />);
  expect(second).toHaveTextContent("未裁剪 · 引用 10 字符");
});
it("preserves the explicitly selected order across multiple frozen sources", () => {
  const plan = frozen(); plan.steps[1].status = "completed";
  Object.assign(plan.steps[1], { commandId: "second-command", turnId: "second-turn" });
  plan.steps.push({ ...plan.steps[1], step: 3, status: "claimed", commandId: undefined, turnId: undefined,
    dependsOn: [1, 2], resultFrom: [2, 1], resultSources: [
      { ...plan.steps[1].resultSources![0], step: 2, commandId: "second-command", turnId: "second-turn", outputLength: 0, excerptLength: 0, truncated: false },
      plan.steps[1].resultSources![0],
    ] });
  setup(plan);
  const third = screen.getByTestId(`execution-step-${plan.id}-3`);
  const list = third.querySelector(".execution-source-list")!;
  expect(within(list as HTMLElement).getAllByRole("listitem").map(item => item.textContent)).toEqual([
    "步骤 2已记录输出为空", "步骤 1已裁剪 · 引用 1000 / 4827 字符",
  ]);
});
it.each(["claimed", "uncertain", "accepted", "failed", "completed"] as const)("does not use frozen input to upgrade the %s receipt", status => {
  const plan = frozen(); plan.steps[1].status = status;
  if (status === "accepted" || status === "completed") Object.assign(plan.steps[1], { commandId: "second-command", turnId: "second-turn" });
  const { second } = setup(plan);
  expect(second).toHaveTextContent("冻结不代表已送达");
  expect(screen.getByRole("progressbar")).toHaveAttribute("value", status === "completed" ? "2" : "1");
  if (status !== "completed") expect(within(second).queryByText("精确完成", { exact: true })).toBeNull();
});
it("uses semantic disclosures without inline sizing or animation and keeps them available after updates", () => {
  const plan = frozen();
  const { second, rerender, props } = setup(plan);
  rerender(<ExecutionsSection {...props} />);
  expect(within(second).getByText("来源核对详情")).toBeInTheDocument();
  expect(second.querySelector(".execution-source-details")).not.toHaveAttribute("style");
});
