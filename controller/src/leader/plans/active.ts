import type { IStore } from "../../store/interface.js";
import { MAX_ACTIVE_PLANS_PER_CHAT } from "../contracts.js";
import type { ExecutionRecord } from "./execution.js";
import type { ExecutionScheduler, ExecutionView } from "./scheduler.js";

const PLAN_BRIEF_PROMPT_CODE_POINTS = 24;

export const ACTIVE_PLAN_LIMIT_TEXT = `本聊天已有 ${MAX_ACTIVE_PLANS_PER_CHAT} 个进行中的计划，已达上限，没有新增派发。` +
  "请先查看进度，或回复“取消计划 <计划ID>”停止其中一个后再安排。";

/** Active plans of one chat, newest first; the console listing already orders active records first. */
export async function listChatActivePlans(store: Pick<IStore, "listRecentExecutions">, chatId: string): Promise<ExecutionRecord[]> {
  const recent = await store.listRecentExecutions([chatId], MAX_ACTIVE_PLANS_PER_CHAT + 1);
  return recent.filter(execution => execution.status === "active");
}

export function planBrief(execution: Pick<ExecutionRecord, "id" | "plan">): string {
  const prompt = Array.from(execution.plan.actions[0].prompt.replace(/\s+/gu, " ").trim());
  const head = prompt.slice(0, PLAN_BRIEF_PROMPT_CODE_POINTS).join("") + (prompt.length > PLAN_BRIEF_PROMPT_CODE_POINTS ? "…" : "");
  return `计划 ${execution.id}：共 ${execution.plan.actions.length} 步，首步“${head || "请求内容为空"}”`;
}

export function ambiguousCancellationText(plans: ExecutionRecord[]): string {
  return `当前有 ${plans.length} 个进行中的计划，没有停止任何计划。请回复“取消计划 <计划ID>”指定要停止的计划：\n` +
    plans.map(plan => `- ${planBrief(plan)}`).join("\n");
}

export type PlanCancellation =
  | { kind: "cancelled"; view: ExecutionView }
  | { kind: "none" }
  | { kind: "missing" }
  | { kind: "ambiguous"; plans: ExecutionRecord[] };

/** Cancels the selected plan; without an ID it only acts when exactly one plan is active. */
export async function cancelActivePlan(store: Pick<IStore, "getExecution" | "listRecentExecutions">,
  executions: Pick<ExecutionScheduler, "cancel">, chatId: string, planId?: string): Promise<PlanCancellation> {
  if (planId) {
    const execution = await store.getExecution(planId);
    if (execution?.chatId !== chatId || execution.status !== "active") return { kind: "missing" };
    const view = await executions.cancel(planId, chatId);
    return view ? { kind: "cancelled", view } : { kind: "missing" };
  }
  const plans = await listChatActivePlans(store, chatId);
  if (plans.length > 1) return { kind: "ambiguous", plans };
  const view = plans[0] ? await executions.cancel(plans[0].id, chatId) : null;
  return view ? { kind: "cancelled", view } : { kind: "none" };
}
