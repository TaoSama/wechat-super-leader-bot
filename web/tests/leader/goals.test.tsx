import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { GoalsSection } from "../../src/features/leader/components/GoalsSection";
import { LeaderOverview } from "../../src/features/leader/components/LeaderOverview";
import { emptyGoals, emptyExecutions, goalFixture, FIXTURE_NOW } from "../fixtures/status-fixtures";
import type { ScopedSession } from "../../src/types";
const sessions: ScopedSession[] = ["air", "mini"].map(nodeId => ({ nodeId, id: "same-session", provider: "codex-app", title: `${nodeId} 原会话`,
  cwd: "/fixture", status: "idle", loaded: true, capabilities: ["read", "send"], observedAt: new Date(FIXTURE_NOW).toISOString() }));
function setup() {
  const goal = goalFixture(), onOpenSession = vi.fn();
  const props = { goals: { ...emptyGoals(), items: [goal] }, sessions, selectedNodeId: "mini", schedulerEnabled: true, onOpenSession };
  const ui = render(<GoalsSection {...props} />), card = screen.getByTestId(`goal-${goal.id}`);
  return { ...ui, goal, props, card, expand: () => fireEvent.click(within(card).getByText("展开完成条件与动作证据")) };
}
it("separates goal, reason, budgets and evidence; retains the entire cross-machine sequence under a node filter", () => {
  const { card, props, expand } = setup();
  expect(card).toHaveTextContent("持续推进中"); expect(card).toHaveTextContent("2 / 3");
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(within(card).getByText("所有测试通过")).not.toBeVisible();
  expand(); expect(card).toHaveTextContent("已受理 · 尚未完成"); expect(card).toHaveTextContent("尚未证实");
  expect(card).toHaveTextContent("turn-1"); expect(card).toHaveTextContent("turn-2");
  fireEvent.click(within(card).getByRole("button", { name: "打开目标动作 2 的会话 mini / same-session" }));
  expect(props.onOpenSession).toHaveBeenCalledExactlyOnceWith(sessions[1]);
  expect(within(card).queryByRole("button", { name: /确认|重发|取消/ })).toBeNull();
});
it("only announces model completion with all supported criteria; live replacement preserves the expanded card", () => {
  const { card, goal, props, expand, rerender } = setup(); expand();
  goal.actions[1].status = "completed";
  rerender(<GoalsSection {...props} />);
  expect(card).toHaveTextContent("持续推进中");
  goal.status = "completed";
  rerender(<GoalsSection {...props} />);
  expect(card).toHaveTextContent("完成依据待核查");
  goal.criteria[0] = { ...goal.criteria[0], supported: true, actions: [2] };
  rerender(<GoalsSection {...props} />);
  expect(card).toHaveTextContent("模型判断条件已满足"); expect(card).toHaveTextContent("不是独立业务验收");
  expect(within(card).getByText("所有测试通过")).toBeVisible();
});
it("shows blocked unsent actions and missing exact targets without replay or wrong-machine navigation", () => {
  const { card, goal, props, expand, rerender } = setup();
  goal.status = "blocked"; goal.reason = "需要用户补充信息"; goal.actions[1].status = "blocked";
  goal.targets[1].nodeId = "missing";
  rerender(<GoalsSection {...props} selectedNodeId={null} />); expand();
  expect(card).toHaveTextContent("需要处理"); expect(card).toHaveTextContent("已暂停");
  const button = within(card).getByRole("button", { name: "打开目标动作 2 的会话 missing / same-session" });
  expect(button).toBeDisabled(); fireEvent.click(button); expect(props.onOpenSession).not.toHaveBeenCalled();
});
it("uses projection time for expiry and puts goals ahead of fixed plans without adding empty panels", () => {
  const { card, goal, props, rerender } = setup(); goal.expiresAt = FIXTURE_NOW;
  rerender(<GoalsSection {...props} />); expect(card).toHaveTextContent("授权到期 · 状态待核对");
  rerender(<GoalsSection {...props} goals={{ ...props.goals, hasMore: true }} schedulerEnabled={false} />);
  expect(screen.getByText(/不是全部历史/)).toBeInTheDocument();
  expect(screen.getByText(/已有记录不代表当前正在推进/)).toBeInTheDocument();
  const data = { goals: props.goals, executions: emptyExecutions(), nodes: [], sessions, commands: [], leaderMode: "model" as const };
  rerender(<LeaderOverview data={data} nodes={[]} selectedNodeId={null} onSelectNodeId={vi.fn()} onOpenSession={vi.fn()} onBrowseSessions={vi.fn()} />);
  const headings = [...document.querySelectorAll(".leader-grid h2")];
  expect(headings[0]).toHaveTextContent("持续目标"); expect(headings[1]).toHaveTextContent("任务计划");
  rerender(<LeaderOverview data={{ ...data, goals: emptyGoals() }} nodes={[]} selectedNodeId={null} onSelectNodeId={vi.fn()} onOpenSession={vi.fn()} onBrowseSessions={vi.fn()} />);
  expect(screen.queryByRole("heading", { name: /持续目标/ })).toBeNull();
});
