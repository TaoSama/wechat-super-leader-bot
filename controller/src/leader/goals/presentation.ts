import { formatDisplayTime } from "../../display-time.js";
import type { Skill } from "../../skills/catalog.js";
import type { GoalProposal } from "./goal.js";
import type { GoalScheduler } from "./scheduler.js";
import { goalReason } from "./reason.js";
import { sessionLabels, type SessionTitle } from "../plans/presentation.js";

export function goalPreview(proposal: GoalProposal, catalog: (nodeId: string) => Skill[], title?: SessionTitle): string {
  const labels = sessionLabels(proposal.targets, title);
  const targets = proposal.targets.map((target, index) => {
    const skills = (target.skills ?? []).map((ref, skillIndex) => {
      const skill = catalog(target.nodeId).find(item => item.id === ref.id && item.digest === ref.digest);
      if (!skill) throw new Error("Selected skill unavailable while rendering preview");
      return `技能 ${skillIndex + 1}：${JSON.stringify(skill.name)}（版本已锁定）`;
    });
    return `${index + 1}. ${labels[index]}${skills.length ? `\n${skills.join("\n")}` : ""}`;
  });
  return `待确认持续目标（尚未派发）\n\n目标：${proposal.objective}\n` +
    `完成条件：\n${proposal.criteria.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n")}\n\n` +
    `授权会话范围：\n${targets.join("\n\n")}\n\n约束/禁止事项：${proposal.constraints}\n` +
    `结果共享：仅本目标已完成任务的有界结果可在上述会话间共享。\n` +
    `实际预算：最多 ${proposal.maxActions} 次任务派发、${proposal.maxDecisions} 轮决策，确认后 ${proposal.durationMinutes} 分钟到期；每轮请求最多3次尝试，未设金额上限。\n\n` +
    `确认后会在上述范围内根据结果持续推进，无须逐步确认；扩大范围、技能或预算需重新确认。原会话权限仍有效，约束不是权限隔离；完成由模型根据实际记录判断，仍需业务验收。失败或结果不明时暂停，不自动重发。\n\n` +
    `回复“确认”即可开始，或说“取消目标”。预览到期：${formatDisplayTime(proposal.expiresAt)}；查询会保留预览。取消只停止后续派发，不停止原会话当前任务。`;
}

export function goalSummary(view: NonNullable<Awaited<ReturnType<GoalScheduler["view"]>>>): string {
  const statuses: Record<string, string> = { active: "持续推进中", completed: "已完成", blocked: "需要处理", cancelled: "已取消", expired: "已过期", failed: "已停止（失败）" };
  return `持续目标：${statuses[view.status] ?? "待核查"}\n目标：${view.proposal.objective}\n` +
    `预算：已记录 ${view.actions.length}/${view.proposal.maxActions} 个动作；已消耗 ${view.decisionAttempts}/${view.proposal.maxDecisions} 轮决策。\n` +
    `授权到期：${formatDisplayTime(view.expiresAt)}${view.blockedReason ? `\n受阻原因：${goalReason(view.blockedReason)}` : ""}\n` +
    `无需再次确认。完成结论为模型根据实际记录的判断。可说“查看进度”或“取消目标”，取消不会停止原会话已有任务。`;
}
