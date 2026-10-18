import { randomUUID } from "node:crypto";
import { hasSkillRefs } from "../../skills/catalog.js";
import { selectSendRoute } from "../../sessions/send-eligibility.js";
import { queueSendRoute } from "../../commands/queue.js";
import type { NodeHub } from "../../nodes/hub.js";
import { ConflictError, type IStore } from "../../store/interface.js";
import { PLAN_TTL_MS, type GoalRequest, type LeaderData, type LeaderReply } from "../contracts.js";
import { createGoal, matchesGoalCommand, type GoalProposal } from "./goal.js";
import type { GoalScheduler } from "./scheduler.js";
import { goalSummary } from "./presentation.js";

const CONFIRM_GOAL = /^确认目标\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[。！!]?$/i;
const CANCEL_GOAL = /^(?:请|帮我)?(?:取消目标|停止目标|停止持续目标)[。！!]?$/;
type Hub = Pick<NodeHub, "getNodeSession" | "getNodeSkills" | "isNodeConnected">;
type ErrorResult = { error: string };

export const goalConfirmation = (text: string): string | undefined => CONFIRM_GOAL.exec(text)?.[1].toLowerCase();
export const goalCancellation = (text: string): boolean => CANCEL_GOAL.test(text);

export class GoalConversation {
  constructor(private store: IStore, private hub: Hub, private scheduler: GoalScheduler, private now: () => number) {}

  async hasUnfinished(chatId: string): Promise<boolean> {
    const goal = await this.store.getLatestGoal(chatId);
    return goal?.status === "active" || goal?.status === "blocked";
  }

  private async validateTargets(proposal: Pick<GoalProposal, "targets">): Promise<ErrorResult | undefined> {
    const identities = new Set<string>();
    for (const target of proposal.targets) {
      const key = JSON.stringify([target.nodeId, target.sessionId]);
      if (identities.has(key)) return { error: "持续目标不能重复授权同一会话" };
      identities.add(key);
      const session = this.hub.getNodeSession(target.nodeId, target.sessionId) ?? await this.store.getKnownSession(target.nodeId,target.sessionId);
      if (!session || target.sessionId.startsWith("terminal:") ||
          session.provider.startsWith("terminal")) {
        return { error: "持续目标仅支持已知、在线且有精确完成能力的原生会话；不支持终端输入" };
      }
      if (this.hub.isNodeConnected(target.nodeId) && !hasSkillRefs(this.hub.getNodeSkills(target.nodeId), target.skills)) return { error: "目标技能版本变化或不可用；请重新查询并预览" };
      if (queueSendRoute(session,target.sendRoute) !== target.sendRoute) return { error: "目标发送资格或固定路线已变化；请重新查询并预览" };
    }
  }

  async propose(chatId: string, request: GoalRequest): Promise<GoalProposal | ErrorResult> {
    if (await this.hasUnfinished(chatId) || (await this.store.getLatestExecution(chatId))?.status === "active") {
      return { error: "已有未结束的固定计划或active/blocked目标；请先查询或取消" };
    }
    const targets: GoalProposal["targets"] = [];
    for (const target of request.targets) {
      const session = this.hub.getNodeSession(target.nodeId, target.sessionId) ?? await this.store.getKnownSession(target.nodeId,target.sessionId);
      const route = session ? queueSendRoute(session) : undefined;
      if (!route || route === "terminal-pane") return { error: "目标会话未知、只读或仅支持终端输入；请先澄清范围" };
      targets.push({ ...target, sendRoute: route });
    }
    const proposal: GoalProposal = { ...request, targets, id: randomUUID(), expiresAt: this.now() + PLAN_TTL_MS };
    const error = await this.validateTargets(proposal);
    return error ?? proposal;
  }

  async confirm(chatId: string, revision: number, proposal: GoalProposal, data: LeaderData): Promise<LeaderReply> {
    if (proposal.expiresAt <= this.now()) return { text: "目标预览已过期，未派发；请重新描述范围与预算。" };
    const error = await this.validateTargets(proposal);
    if (error) return { text: `${error.error}；未派发。` };
    try {
      await this.store.confirmGoal(createGoal(chatId, proposal, this.now()), {
        revision, messageId: data.inflight!.messageId, inputHash: data.inflight!.inputHash,
      }, this.now);
    } catch (error) {
      if (error instanceof ConflictError) return { text: "目标确认授权已失效或已有未结束授权，未新增派发；请先查询。" };
      throw error;
    }
    // The server-owned scheduler advances independently; never hold the chat lock during a model decision.
    const view = await this.scheduler.view(proposal.id, chatId);
    if (!view) throw new Error("Confirmed goal disappeared");
    return { text: `目标已确认，后台将按授权预算持续推进。\n${goalSummary(view)}` };
  }

  async cancel(chatId: string): Promise<LeaderReply> {
    const goal = await this.store.getLatestGoal(chatId);
    const view = goal && (goal.status === "active" || goal.status === "blocked") ? await this.scheduler.cancel(goal.id, chatId) : null;
    return { text: view ? `已取消待确认目标并撤销后续派发权。\n${goalSummary(view)}` : "已取消待确认目标；没有未结束的持续目标。不会停止原会话当前任务，也未新增派发。" };
  }

  async progress(chatId: string, goalId?: string): Promise<unknown> {
    const id = goalId ?? (await this.store.getLatestGoal(chatId))?.id;
    return id ? (await this.scheduler.view(id, chatId) ?? { error: "Goal does not belong to this chat" }) : { goal: null };
  }

  async recovery(chatId: string, goalId: string): Promise<string> {
    const view = await this.scheduler.view(goalId, chatId);
    return view ? `已确认目标仍按持久授权核查与推进：\n${goalSummary(view)}`
      : "没有可确认的持续目标记录，不自动创建或派发；请先查询。";
  }

  async ownsCommand(chatId: string, commandId: string, goalId?: string): Promise<boolean> {
    const goal = goalId ? await this.store.getGoal(goalId) : await this.store.getLatestGoal(chatId);
    if (!goal || goal.chatId !== chatId) return false;
    const command = await this.store.getCommand(commandId);
    return !!command && command.inputReceipt === undefined && goal.actions.some((action, index) =>
      action.attempt && matchesGoalCommand(goal, index, command));
  }
}
