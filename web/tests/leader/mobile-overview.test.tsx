import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { LeaderOverview } from "../../src/features/leader/components/LeaderOverview";
import { CommandsSection } from "../../src/features/leader/components/CommandsSection";
import { ControlPlaneStatusResponse, CommandRecord, ScopedSession } from "../../src/types";
import { DerivedNodeStatus } from "../../src/features/status/useStatusPolling";
import { emptyExecutions, emptyGoals } from "../fixtures/status-fixtures";

const session: ScopedSession = {
  id: "same-session", nodeId: "local", title: "验证移动端看板", provider: "codex-app",
  cwd: "/workspace", status: "idle", loaded: true, capabilities: ["read", "send"], observedAt: "2026-10-17T08:00:00Z",
};
const remoteSession = { ...session, nodeId: "remote", title: "核查远程任务" };
const nodes: DerivedNodeStatus[] = [session, remoteSession].map(item => ({
  nodeId: item.nodeId, connected: true, sessionCount: 1, lastHeartbeat: item.observedAt, inferredOffline: false,
}));
function command(status: CommandRecord["status"], target = session): CommandRecord {
  return {
    commandId: status, requestId: `request-${status}`, nodeId: target.nodeId, sessionId: target.id,
    action: "send", status, prompt: `请求 ${status}`, output: status === "completed" ? "精确完成回执正文" : undefined,
    createdAt: "2026-10-17T08:00:00Z", updatedAt: "2026-10-17T08:00:00Z", expiresAt: "2026-10-17T08:10:00Z",
  };
}
const data: ControlPlaneStatusResponse = {
  nodes, sessions: [session, remoteSession], leaderMode: "model", leaderModel: "leader-model",
  goals: emptyGoals(), executions: emptyExecutions(),
  commands: [command("uncertain"), command("accepted"), command("input-written"), command("completed"), command("failed", remoteSession)],
};
function setup(selectedNodeId: string | null = null) {
  const props = { data, nodes, selectedNodeId, onSelectNodeId: vi.fn(), onOpenSession: vi.fn(), onBrowseSessions: vi.fn() };
  return { ...render(<LeaderOverview {...props} />), props };
}

it("排队、取消和过期分别展示，取消不会计入完成", () => {
  render(<CommandsSection commands={[command("queued"), command("cancelled"), command("expired")]} selectedNodeId={null} sessions={[session]} statusFilter="ALL" onStatusFilterChange={vi.fn()} />);
  expect(within(screen.getByRole("region", { name: "执行中" })).getByTestId("command-item-queued")).toBeVisible();
  expect(within(screen.getByRole("region", { name: "需要处理" })).getByTestId("command-item-expired")).toBeVisible();
  expect(screen.getByTestId("command-item-cancelled")).not.toBeVisible();
  fireEvent.click(screen.getByText("查看已取消"));
  expect(screen.getByTestId("command-item-cancelled")).toBeVisible();
  expect(screen.queryByRole("region", { name: "最近完成" })).toBeNull();
});

it("keeps risks visible while secondary machine, mode and completed evidence starts folded", () => {
  const { container } = setup();
  expect(screen.getByTestId("command-item-uncertain")).toBeVisible();
  expect(screen.getByTestId("command-item-input-written")).toBeVisible();
  expect(screen.getByTestId("command-item-accepted")).toHaveTextContent("执行结果尚未确认");
  expect(screen.getByTestId("command-item-completed")).not.toBeVisible();
  expect(screen.getByTestId("node-card-local")).not.toBeVisible();
  expect(screen.getByRole("region", { name: "Leader 运行模式" })).toHaveTextContent("leader-model");
  expect(screen.getByText(/具体任务的进展与结果/)).not.toBeVisible();
  expect(screen.getByText("回执如何解读").closest("details")).not.toHaveAttribute("open");
  expect(container.querySelector(".leader-machine-scope")!.compareDocumentPosition(container.querySelector(".leader-grid")!))
    .toBe(Node.DOCUMENT_POSITION_FOLLOWING);
});

it("summary counts filter actual command states and completed opens its evidence group", () => {
  setup();
  fireEvent.click(screen.getByRole("button", { name: "查看需要处理指令 3 条" }));
  expect(screen.getByLabelText("按指令状态过滤")).toHaveTextContent("需要处理");
  expect(screen.getByTestId("command-item-input-written")).toBeVisible();
  expect(screen.queryByTestId("command-item-accepted")).toBeNull();
  expect(screen.queryByTestId("command-item-completed")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "查看执行中指令 1 条" }));
  expect(screen.getByTestId("command-item-accepted")).toBeVisible();
  expect(screen.queryByTestId("command-item-input-written")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "查看最近完成指令 1 条" }));
  const completed = screen.getByTestId("command-item-completed");
  expect(completed).toBeVisible();
  expect(within(completed).getByText("精确完成回执正文")).not.toBeVisible();
  fireEvent.click(within(completed).getByText("指令详情与回执"));
  expect(within(completed).getByText("精确完成回执正文")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "清空指令筛选" }));
  expect(screen.getByLabelText("按指令状态过滤")).toHaveTextContent("全部状态");
  expect(screen.getByTestId("command-item-uncertain")).toBeVisible();
});

it("an empty status and machine combination can recover by clearing both filters", () => {
  const { props } = setup("remote");
  expect(screen.getByRole("button", { name: "查看需要处理指令 1 条" })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "查看执行中指令 0 条" }));
  expect(screen.getByText("暂无匹配的指令审计记录")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "清空指令筛选" }));
  expect(props.onSelectNodeId).toHaveBeenCalledExactlyOnceWith(null);
  expect(screen.getByLabelText("按指令状态过滤")).toHaveTextContent("全部状态");
});

it("compact machine scope and expanded machine cards share the same selection callback", () => {
  const { props } = setup();
  fireEvent.click(screen.getByRole("combobox", { name: "筛选看板机器" }));
  fireEvent.click(screen.getByRole("option", { name: "remote" }));
  expect(props.onSelectNodeId).toHaveBeenLastCalledWith("remote");
  fireEvent.click(screen.getByText("机器状态"));
  fireEvent.click(screen.getByRole("button", { name: "按节点 local 筛选会话与指令" }));
  expect(props.onSelectNodeId).toHaveBeenLastCalledWith("local");
  fireEvent.click(within(screen.getByTestId("command-item-uncertain")).getByRole("button", { name: session.title }));
  expect(props.onOpenSession).toHaveBeenCalledExactlyOnceWith(session);
});

it("retains a disappeared machine selection with a visible recovery action", () => {
  const { props } = setup("missing");
  expect(screen.getByLabelText("筛选看板机器")).toHaveTextContent("missing · 未报告");
  fireEvent.click(screen.getByRole("combobox", { name: "筛选看板机器" }));
  expect(screen.getByRole("option", { name: "missing · 未报告" })).toHaveAttribute("aria-selected", "true");
  fireEvent.click(screen.getByRole("button", { name: "关闭筛选看板机器" }));
  fireEvent.click(screen.getByRole("button", { name: "清除机器筛选" }));
  expect(props.onSelectNodeId).toHaveBeenCalledExactlyOnceWith(null);
});

it("command status selection follows the parent state and reports selection changes", () => {
  const onStatusFilterChange = vi.fn();
  const props = { commands: data.commands, selectedNodeId: null, statusFilter: "accepted" as const, onStatusFilterChange };
  const { rerender } = render(<CommandsSection {...props} />);
  fireEvent.click(screen.getByRole("combobox", { name: "按指令状态过滤" }));
  fireEvent.click(screen.getByRole("option", { name: /^状态存疑/ }));
  expect(onStatusFilterChange).toHaveBeenCalledExactlyOnceWith("uncertain");
  expect(screen.getByTestId("command-item-accepted")).toBeVisible();
  expect(screen.queryByTestId("command-item-uncertain")).toBeNull();
  rerender(<CommandsSection {...props} statusFilter="uncertain" />);
  expect(screen.getByTestId("command-item-uncertain")).toBeVisible();
  expect(screen.queryByTestId("command-item-accepted")).toBeNull();
});
