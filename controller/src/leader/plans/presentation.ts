import type { ExecutionView } from "./scheduler.js";

const labels: Record<string, string> = {
  active: "自动推进中", completed: "已完成", failed: "已停止（失败）", cancelled: "已取消后续派发",
  expired: "授权已过期", waiting: "等待前序完成或会话可用", claimed: "发送中，等待回执",
  pending: "等待接收", accepted: "已接收，等待完成", uncertain: "结果不明，暂停后续",
};

export type SessionTitle = (nodeId: string, sessionId: string) => string | undefined;

export function sessionLabel(nodeId: string, sessionId: string, title?: string): string {
  return `[${nodeId}] ${title?.trim() || `会话 ${sessionId.slice(0, 8)}`}`;
}

export function sessionLabels(targets: { nodeId: string; sessionId: string }[], title?: SessionTitle): string[] {
  const labels = targets.map(target => sessionLabel(target.nodeId, target.sessionId, title?.(target.nodeId, target.sessionId)));
  return targets.map((target, index) => {
    const peers = targets.filter((other, peer) => labels[peer] === labels[index] && other.sessionId !== target.sessionId);
    if (!peers.length) return labels[index];
    let length = 8;
    while (length < target.sessionId.length && peers.some(other => other.sessionId.slice(0, length) === target.sessionId.slice(0, length))) length++;
    return `${labels[index]}（${target.sessionId.slice(0, length)}）`;
  });
}

export function executionSummary(view: ExecutionView, title?: SessionTitle): string {
  const targets = sessionLabels(view.steps, title);
  const lines = view.steps.map((step, index) => `${step.step}. ${targets[index]}：${labels[step.status] ?? "待核查"}` +
    `${step.dependsOn.length ? `；依赖步骤 ${step.dependsOn.join("、")}` : ""}` +
    `${step.resultSources ? `；已冻结输入资料：${step.resultSources.map(source => `步骤 ${source.step}（${source.outputLength === 0 ? "已记录输出为空" : source.truncated ? "已裁剪" : "未裁剪"}）`).join("、")}，冻结不代表已送达` :
      step.resultFrom.length ? `；将使用步骤 ${step.resultFrom.join("、")} 的已记录输出` : ""}`);
  return `计划：${labels[view.status] ?? "待核查"}\n\n${lines.join("\n")}\n\n` +
    "已接收不代表工作完成，无需再次确认。可说“查看进度”或“取消计划”；取消不会停止原会话中的执行。";
}
