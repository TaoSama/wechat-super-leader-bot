import type { ExecutionView } from "./execution-scheduler.js";

const labels: Record<string, string> = {
  active: "自动推进中", completed: "已完成", failed: "已停止（失败）", cancelled: "已取消后续派发",
  expired: "授权已过期", waiting: "等待依赖完成或会话发送资格", claimed: "已领取，投递待核实",
  pending: "等待受理", accepted: "已受理，仍需等待完成", uncertain: "结果不明，暂停后续",
};

export function executionSummary(view: ExecutionView): string {
  const lines = view.steps.map(step => `${step.step}. [${step.nodeId}] ${step.sessionId}：${step.status}（${labels[step.status] ?? "待核查"}）` +
    `${step.dependsOn.length ? `；依赖步骤 ${step.dependsOn.join("、")}` : ""}` +
    `${step.commandId ? `\n命令 ${step.commandId}${step.turnId ? `，turn ${step.turnId}` : ""}` : ""}`);
  return `计划 ${view.id}：${labels[view.status] ?? view.status}\n${lines.join("\n")}\n` +
    `自动推进授权截止：${new Date(view.expiresAt).toISOString()}\n` +
    "accepted 仅表示输入受理，不代表工作完成；pending/uncertain 请先查询，勿重复派发。取消计划只停止后续派发，已领取的步骤可能已发送，不会停止原会话中的执行。";
}
