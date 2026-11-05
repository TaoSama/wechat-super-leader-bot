import { createHash } from "node:crypto";
import { CommandError } from "../commands/service.js";
import { ConflictError, type IStore } from "../store/interface.js";
import type { ModelToolCall } from "./model/contracts.js";
import { CLAIM_TTL_MS, LeaderDataSchema, TURN_TIMEOUT_MS, type GoalRequest, type LeaderData, type LeaderReply, type Plan } from "./contracts.js";
import type { LeaderState } from "./state.js";
import type { GoalProposal } from "./goals/goal.js";
import { goalIsOpen } from "./goals/goal.js";
import type { GoalConversation } from "./goals/conversation.js";
import type { ExecutionScheduler } from "./plans/scheduler.js";
import { cancelActivePlan } from "./plans/active.js";
import { SessionTitles } from "./queries/session-titles.js";

/** The fields a console plan step may set; routes, skills and delivery modes stay server-owned. */
export interface ConsolePlanStep { nodeId: string; sessionId: string; prompt: string; dependsOn: number[]; resultFrom?: number[] }
export type ConsoleAuthorizationRequest =
  | { kind: "create_plan"; steps: ConsolePlanStep[] }
  | { kind: "create_goal"; goal: Omit<GoalRequest, "targets"> & { targets: { nodeId: string; sessionId: string }[] } }
  | { kind: "cancel_plan"; planId: string }
  | { kind: "cancel_goal"; goalId: string };
export type ConsoleAuthorizationOutcome = "created" | "cancelled" | "rejected" | "missing";
export interface ConsoleAuthorizationResult { outcome: ConsoleAuthorizationOutcome; id?: string; text: string; replayed: boolean }

interface Options {
  store: IStore; now: () => number; isAllowed: (chatId: string) => boolean; goalsAvailable: boolean;
  goals: GoalConversation; executions: Pick<ExecutionScheduler, "cancel">;
  save: (chatId: string, revision: number, data: LeaderData) => Promise<LeaderState>;
  propose: (call: ModelToolCall, chatId: string, data: LeaderData, titles: SessionTitles, signal: AbortSignal) => Promise<unknown>;
  executePlan: (chatId: string, revision: number, plan: Plan, data: LeaderData) => Promise<LeaderReply>;
  confirmGoal: (chatId: string, revision: number, goal: GoalProposal, data: LeaderData) => Promise<LeaderReply>;
}

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const CONSOLE_PLAN_CANCELLED_TEXT = "已取消计划后续派发；原会话当前执行未停止。";
const CONSOLE_GOAL_CANCELLED_TEXT = "已取消持续目标并撤销后续派发权；原会话当前动作未停止。";
const CONSOLE_RECOVERED_TEXT = "已创建；处理中断后已按持久记录核对，推进情况请查看进度。";
const CONSOLE_MESSAGE_PREFIX = "console_";
const CONSOLE_PENDING_RECOVERY_TEXT = "该聊天上一条请求仍在处理或待恢复，本次未创建或取消任何授权，请稍后重试。";

/** Stable per-submit identity; never collides with WeChat message IDs or other operations. */
export function consoleAuthorizationMessageId(requestId: string): string {
  return `${CONSOLE_MESSAGE_PREFIX}${hash(["console-authorization", requestId])}`;
}

/**
 * A console submit is the bound chat user's explicit authorization. It claims the same
 * chat lease as a WeChat message and reuses the leader's proposal, freeze and confirm path.
 */
export class ConsoleAuthorizations {
  constructor(private readonly options: Options) {}

  async authorize(chatId: string, requestId: string, request: ConsoleAuthorizationRequest): Promise<ConsoleAuthorizationResult> {
    const o = this.options;
    if (!o.isAllowed(chatId)) throw new CommandError(403, "CHAT_NOT_ALLOWED");
    if (request.kind === "create_goal" && !o.goalsAvailable) throw new CommandError(503, "Goal execution model unavailable");
    const messageId = consoleAuthorizationMessageId(requestId), inputHash = hash(request);
    const saved = await o.store.getLeaderState(chatId);
    const data = LeaderDataSchema.parse(saved?.data ?? {});
    const replay = (): ConsoleAuthorizationResult | undefined => {
      const receipt = data.receipts.find(item => item.messageId === messageId);
      if (!receipt) return undefined;
      if (receipt.inputHash !== inputHash) throw new ConflictError("Idempotency key already used with a different request");
      // A WeChat-side recovery receipt proves the claim ended but not what it created; never re-run it.
      if (receipt.source !== "console") throw new CommandError(409, receipt.text);
      return { outcome: request.kind.startsWith("create") ? "created" : "cancelled", id: receipt.authorizationId, text: receipt.text, replayed: true };
    };
    const replayed = replay();
    if (replayed) return replayed;
    if (data.inflight) {
      // An expired WeChat claim still owns its recovery receipt; never overwrite it.
      if (data.inflight.expiresAt > o.now() || !data.inflight.messageId.startsWith(CONSOLE_MESSAGE_PREFIX)) throw new CommandError(409, CONSOLE_PENDING_RECOVERY_TEXT);
      await this.recover(chatId, data);
      const recovered = replay();
      if (recovered) { await o.save(chatId, saved!.revision, data); return recovered; }
    }
    if (request.kind === "cancel_plan" || request.kind === "cancel_goal") data.steerGeneration++;
    data.inflight = { messageId, inputHash, expiresAt: o.now() + CLAIM_TTL_MS };
    const lease = { claimed: await o.save(chatId, saved?.revision ?? 0, data) };
    try {
      const result = await this.run(chatId, request, data, lease);
      data.inflight = undefined;
      if (result.outcome === "created" || result.outcome === "cancelled") {
        data.receipts.push({ messageId, inputHash, text: result.text, source: "console", ...(result.id ? { authorizationId: result.id } : {}) });
      }
      await o.save(chatId, lease.claimed.revision, data);
      return { ...result, replayed: false };
    } catch (error) {
      // Release only this still-owned lease. A persisted plan or goal becomes a receipt so retries never recreate it.
      const current = await o.store.getLeaderState(chatId);
      if (current?.revision === lease.claimed.revision) {
        const latest = LeaderDataSchema.parse(current.data);
        await this.recover(chatId, latest);
        await o.save(chatId, current.revision, latest);
      }
      throw error;
    }
  }

  /** Ends a console claim; a frozen plan or goal that reached the store is recorded as created. */
  private async recover(chatId: string, data: LeaderData): Promise<void> {
    const claim = data.inflight;
    if (!claim) return;
    data.inflight = undefined;
    const id = claim.plan?.id ?? claim.goal?.id;
    const record = !id ? null : claim.plan ? await this.options.store.getExecution(id) : await this.options.store.getGoal(id);
    if (id && record?.chatId === chatId && !data.receipts.some(item => item.messageId === claim.messageId)) {
      data.receipts.push({ messageId: claim.messageId, inputHash: claim.inputHash, text: CONSOLE_RECOVERED_TEXT, source: "console", authorizationId: id });
    }
  }

  private async run(chatId: string, request: ConsoleAuthorizationRequest, data: LeaderData,
    lease: { claimed: LeaderState }): Promise<Omit<ConsoleAuthorizationResult, "replayed">> {
    const o = this.options;
    switch (request.kind) {
      case "cancel_plan": {
        const cancelled = await cancelActivePlan(o.store, o.executions, chatId, request.planId);
        return cancelled.kind === "cancelled" ? { outcome: "cancelled", id: request.planId, text: CONSOLE_PLAN_CANCELLED_TEXT }
          : { outcome: "missing", text: "没有该ID的进行中计划，未停止其他计划。" };
      }
      case "cancel_goal": {
        // One open goal per chat: only the chat's latest goal can be the one to cancel.
        const goal = await o.store.getLatestGoal(chatId);
        if (!goal || goal.id !== request.goalId || !goalIsOpen(goal)) return { outcome: "missing", text: "没有该ID的未结束持续目标，未停止其他目标。" };
        await o.goals.cancel(chatId);
        const after = await o.store.getGoal(goal.id);
        return after && !goalIsOpen(after) ? { outcome: "cancelled", id: goal.id, text: CONSOLE_GOAL_CANCELLED_TEXT }
          : { outcome: "rejected", text: "目标状态已变化，取消结果待核查；请刷新后再试。" };
      }
      case "create_plan":
      case "create_goal": {
        const previews = { pending: data.pending, pendingGoal: data.pendingGoal };
        const name = request.kind === "create_plan" ? "propose_plan" : "propose_goal";
        const args = request.kind === "create_plan"
          ? { actions: request.steps.map(step => ({ nodeId: step.nodeId, sessionId: step.sessionId, prompt: step.prompt,
            dependsOn: step.dependsOn, ...(step.resultFrom?.length ? { resultFrom: step.resultFrom } : {}) })) }
          : request.goal;
        const proposed = await o.propose({ id: `console_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
          chatId, data, new SessionTitles(), AbortSignal.timeout(TURN_TIMEOUT_MS));
        // A successful proposal stores a new frozen preview; anything else is a validation rejection.
        const plan = request.kind === "create_plan" && data.pending !== previews.pending ? data.pending : undefined;
        const goal = request.kind === "create_goal" && data.pendingGoal !== previews.pendingGoal ? data.pendingGoal : undefined;
        // Console authorizations never consume or replace a WeChat preview awaiting confirmation.
        data.pending = previews.pending; data.pendingGoal = previews.pendingGoal;
        if (!plan && !goal) {
          const error = proposed && typeof proposed === "object" && "error" in proposed && typeof proposed.error === "string" ? proposed.error : "授权内容未通过校验，没有派发。";
          return { outcome: "rejected", text: error };
        }
        data.inflight = { ...data.inflight!, ...(plan ? { plan } : { goal: goal! }) };
        lease.claimed = await o.save(chatId, lease.claimed.revision, data);
        const revision = lease.claimed.revision;
        const reply = plan ? await o.executePlan(chatId, revision, plan, data) : await o.confirmGoal(chatId, revision, goal!, data);
        const id = plan?.id ?? goal!.id;
        const record = plan ? await o.store.getExecution(id) : await o.store.getGoal(id);
        return record?.chatId === chatId ? { outcome: "created", id, text: reply.text } : { outcome: "rejected", text: reply.text };
      }
    }
  }
}
