import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ExecutionsSection } from "../../src/features/leader/components/ExecutionsSection";
import { LeaderOverview } from "../../src/features/leader/components/LeaderOverview";
import type { ConsoleExecution, ScopedSession } from "../../src/types";
import { emptyGoals, emptyExecutions, executionFixture, FIXTURE_NOW  } from "../fixtures/status-fixtures";

const sessions: ScopedSession[] = ["air", "mini"].map(nodeId => ({ nodeId, id: "same-session", provider: "codex-app",
  title: `${nodeId} 原会话`, cwd: "/fixture", status: "idle", loaded: true, capabilities: ["read", "send"],
  observedAt: new Date(FIXTURE_NOW).toISOString() }));
function setup(plan = executionFixture(), selectedNodeId: string | null = null, hasMore = false) {
  const onOpenSession = vi.fn();
  const props = { executions: { ...emptyExecutions(), hasMore, items: [plan] }, sessions, selectedNodeId, schedulerEnabled: true, onOpenSession };
  const rendered = render(<ExecutionsSection {...props} />);
  const card = screen.getByTestId(`execution-${plan.id}`);
  return { ...rendered, card, props, onOpenSession, expand: () => fireEvent.click(within(card).getByText("展开有序步骤与依赖")) };
}
it("counts only exact completion and keeps ordered cross-machine predecessors when filtering", () => {
  const { card, expand, onOpenSession } = setup(executionFixture(), "mini", true);
  expect(card).toHaveTextContent("已完成 0 / 2 步");
  expect(screen.getByRole("progressbar")).toHaveAttribute("value", "0");
  expect(screen.getByText(/不是全部历史/)).toBeInTheDocument();
  expect(screen.getByText(/跨机步骤及其前驱完整保留/)).toBeInTheDocument();
  const second = within(card).getByTestId(`execution-step-${executionFixture().id}-2`);
  expect(within(second).getByText("完成后检查文档")).not.toBeVisible();
  expand();
  expect(within(card).getAllByRole("listitem")).toHaveLength(2);
  expect(card).toHaveTextContent("已受理 · 尚未完成");
  expect(card).toHaveTextContent("等待步骤 1 的精确完成回执");
  expect(card).toHaveTextContent("依赖步骤 1 · 仅精确完成才解锁");
  fireEvent.click(within(card).getByRole("button", { name: "打开计划步骤 2 的会话 mini / same-session" }));
  expect(onOpenSession).toHaveBeenCalledExactlyOnceWith(sessions[1]);
  expect(within(card).queryByRole("button", { name: /取消|确认|重试|重发/ })).toBeNull();
});
it("explains uncertainty and pauses the whole plan without inventing completion or resend actions", () => {
  const plan = executionFixture(); plan.steps[0].status = "uncertain";
  const { card, expand } = setup(plan); expand();
  expect(card).toHaveTextContent("推进已暂停");
  expect(card).toHaveTextContent("整个计划暂停后续推进");
  expect(card).toHaveTextContent("请勿重发");
  expect(card).toHaveTextContent("已完成 0 / 2 步");
  expect(card).toHaveTextContent("first-turn");
});
it.each(["cancelled", "expired", "failed"] as const)("preserves accepted facts when the plan is %s", status => {
  const plan = executionFixture(); plan.status = status; plan.steps[1].status = status;
  const { card, expand } = setup(plan); expand();
  expect(card).toHaveTextContent("已受理 · 尚未完成");
  expect(card).toHaveTextContent("first-command");
  expect(card).toHaveTextContent("first-turn");
  expect(card).toHaveTextContent("已完成 0 / 2 步");
  if (status === "cancelled") expect(card).toHaveTextContent("不会停止原会话已有任务");
});
it("uses server projection time for expiry without adding timers or rewriting live receipts", async () => {
  vi.useFakeTimers();
  try {
    const plan = executionFixture(); plan.expiresAt = FIXTURE_NOW;
    const { card, expand, unmount } = setup(plan);
    expect(vi.getTimerCount()).toBe(0);
    expand();
    // jsdom queues the native details toggle event with one zero-delay timeout.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(card).toHaveTextContent("授权到期，计划待核对");
    expect(card).toHaveTextContent("已有任务仍按原回执核验");
    expect(card).toHaveTextContent("已受理 · 尚未完成");
    expect(plan.status).toBe("active");
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  } finally { vi.useRealTimers(); }
});
it("distinguishes completed steps awaiting reconciliation from a completed plan, and target qualification from dependencies", () => {
  const plan = executionFixture(); plan.steps[0].status = "completed";
  const { card, expand, rerender, props } = setup(plan); expand();
  expect(card).toHaveTextContent("已完成 1 / 2 步");
  expect(card).toHaveTextContent("等待调度检查固定目标的发送资格；具体原因未报告");
  const completed: ConsoleExecution = { ...plan, steps: plan.steps.map(step => ({ ...step, status: "completed", commandId: `cmd-${step.step}`, turnId: `turn-${step.step}` })) };
  rerender(<ExecutionsSection {...props} executions={{ ...props.executions, items: [completed] }} />);
  expect(card).toHaveTextContent("步骤完成，计划待核对");
  expect(card).not.toHaveTextContent("计划已完成");
  rerender(<ExecutionsSection {...props} executions={{ ...props.executions, items: [{ ...completed, status: "completed" }] }} />);
  expect(card).toHaveTextContent("计划已完成");
});
it("disables missing exact targets rather than navigating to the same ID on another node", () => {
  const plan = executionFixture(); plan.steps[1].nodeId = "missing"; plan.steps[1].promptTruncated = true;
  const { card, expand, onOpenSession } = setup(plan); expand();
  const target = within(card).getByRole("button", { name: "打开计划步骤 2 的会话 missing / same-session" });
  expect(target).toBeDisabled(); fireEvent.click(target);
  expect(onOpenSession).not.toHaveBeenCalled();
  expect(card).toHaveTextContent("目标暂不可定位，不能跳转到其他会话");
  expect(card).toHaveTextContent("请求摘要已截断，并非完整内容");
});
it("places plans before commands and distinguishes empty-window from a filter with no match", () => {
  const plan = executionFixture();
  const data = { nodes: [], sessions, commands: [], goals: emptyGoals(), executions: { ...emptyExecutions(), items: [plan] } };
  const { container, rerender } = render(<LeaderOverview data={data} nodes={[]} selectedNodeId={null}
    onSelectNodeId={vi.fn()} onOpenSession={vi.fn()} onBrowseSessions={vi.fn()} />);
  const headings = [...container.querySelectorAll(".leader-grid h2")];
  expect(headings[0]).toHaveTextContent("任务计划");
  expect(headings[1]).toHaveTextContent("成果交付");
  expect(headings[2]).toHaveTextContent("指令动态");
  rerender(<ExecutionsSection executions={data.executions} sessions={sessions} selectedNodeId="other" schedulerEnabled={true} onOpenSession={vi.fn()} />);
  expect(screen.getByText("当前窗口没有包含这台机器的计划")).toBeInTheDocument();
  rerender(<ExecutionsSection executions={emptyExecutions()} sessions={sessions} selectedNodeId={null} schedulerEnabled={true} onOpenSession={vi.fn()} />);
  expect(screen.getByText("当前窗口没有已确认计划")).toBeInTheDocument();
});
it("shows the first request in the folded summary and keeps the full plan ID in details", () => {
  const plan = executionFixture();
  const { card, expand } = setup(plan);
  expect(within(card).getByText(`首步：${plan.steps[0].prompt}`)).toBeVisible();
  expect(within(card).getByText(`计划 ${plan.id}`)).not.toBeVisible();
  expand();
  expect(within(card).getByText(`计划 ${plan.id}`)).toBeVisible();
});
it.each(["uncertain", "accepted", "waiting", "failed"] as const)("does not claim a persisted completed plan is complete with a %s receipt", status => {
  const plan = executionFixture(); plan.status = "completed"; plan.steps[0].status = status;
  const { card, expand } = setup(plan); expand();
  expect(card).toHaveTextContent("回执待核查，计划待核对");
  expect(card).not.toHaveTextContent("计划已完成");
  expect(card).toHaveTextContent("不能确认计划完成");
  expect(plan.status).toBe("completed");
});
it.each(["rules", "unknown", undefined] as const)("does not imply automatic scheduling in %s mode", leaderMode => {
  const plan = executionFixture(); plan.steps[0].status = "completed";
  const data = { nodes: [], sessions, commands: [], leaderMode, goals: emptyGoals(), executions: { ...emptyExecutions(), items: [plan] } };
  render(<LeaderOverview data={data} nodes={[]} selectedNodeId={null} onSelectNodeId={vi.fn()} onOpenSession={vi.fn()} onBrowseSessions={vi.fn()} />);
  const card = screen.getByTestId(`execution-${plan.id}`);
  expect(card).toHaveTextContent("调度未启用");
  expect(card).not.toHaveTextContent("自动推进中");
  fireEvent.click(within(card).getByText("展开有序步骤与依赖"));
  expect(card).toHaveTextContent("调度未启用，等待后续派发");
  expect(card).toHaveTextContent("已完成 1 / 2 步");
  expect(card).toHaveTextContent("first-turn");
});
