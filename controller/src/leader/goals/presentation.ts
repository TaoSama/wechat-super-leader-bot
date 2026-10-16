import type { Skill } from "../../skills/catalog.js";
import type { GoalProposal } from "./goal.js";
import type { GoalScheduler } from "./scheduler.js";
import { goalReason } from "./reason.js";

export function goalPreview(proposal: GoalProposal, catalog: (nodeId: string) => Skill[]): string {
  const targets = proposal.targets.map((target, index) => {
    const skills = (target.skills ?? []).map((ref, skillIndex) => {
      const skill = catalog(target.nodeId).find(item => item.id === ref.id && item.digest === ref.digest);
      return `技能 ${skillIndex + 1}：${JSON.stringify(skill?.name ?? ref.id)}\nID：${ref.id}\nSHA256：${ref.digest}`;
    });
    return `${index + 1}. [${target.nodeId}] ${target.sessionId}\n固定路线：${target.sendRoute}\n${skills.length ? skills.join("\n") : "未选择技能"}`;
  });
  return `待确认持续目标（尚未派发）\n目标ID：${proposal.id}\n目标：${proposal.objective}\n` +
    `完成条件：\n${proposal.criteria.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n")}\n\n` +
    `授权会话范围：\n${targets.join("\n\n")}\n\n约束/禁止事项：${proposal.constraints}\n` +
    `授权共享：本目标已完成动作的有界结果可在上述会话间共享；不共享其他聊天、计划或任意历史。\n` +
    `动态权限：可依据本目标精确结果，在上述冻结范围与约束内决定后续任务，无须逐步确认。扩大范围、技能版本、资料来源或预算必须取消后重新确认。\n` +
    `实际预算：最多 ${proposal.maxActions} 次任务派发、${proposal.maxDecisions} 轮模型决策；确认后 ${proposal.durationMinutes} 分钟到期。每轮模型HTTP最多3次尝试，不承诺货币费用上限。\n` +
    `完成是基于本目标精确完成记录的模型条件判断，不是独立业务证明。uncertain/失败停止且不自动重发；blocked需取消后重新授权。\n` +
    `原生非隔离边界：不会新建Agent后端或恢复历史冒充附着；原会话自身权限仍有效，文字约束不是下游Agent的硬隔离。\n` +
    `回复“确认目标 ${proposal.id}”授权；预览到期：${new Date(proposal.expiresAt).toISOString()}。普通查询不清除此预览。\n` +
    `回复“取消目标”只停止后续派发，不停止原会话当前动作；已获派发许可的请求可能已经发送。`;
}

export function goalSummary(view: NonNullable<Awaited<ReturnType<GoalScheduler["view"]>>>): string {
  return `持续目标 ${view.id}：${view.status}\n目标：${view.proposal.objective}\n` +
    `预算：已记录 ${view.actions.length}/${view.proposal.maxActions} 个动作；已消耗 ${view.decisionAttempts}/${view.proposal.maxDecisions} 轮决策。\n` +
    `授权到期：${new Date(view.expiresAt).toISOString()}${view.blockedReason ? `\n受阻原因：${goalReason(view.blockedReason)}` : ""}\n` +
    `accepted不代表完成；completed为基于精确记录的模型判断，不是独立业务证明。取消仅停止后续派发，不会停止原会话已有任务。`;
}
