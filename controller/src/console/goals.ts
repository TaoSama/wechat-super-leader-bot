import { z } from "zod";
import type { IStore } from "../store/interface.js";
import { normalizeGoal, validateGoalDecision, type GoalDecisionInput } from "../leader/goal.js";
import { readGoalView } from "../leader/goal-view.js";
import { goalReason } from "../leader/goal-reason.js";
import { TurnIdSchema } from "../types.js";

export const CONSOLE_GOAL_LIMIT = 12;
const TEXT_LIMIT = 512;
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000).refine(Number.isSafeInteger);
const number = z.number().int().min(1).max(12);
const clipped = (value: string) => ({ text: [...value].slice(0, TEXT_LIMIT).join(""), truncated: [...value].length > TEXT_LIMIT });
const GoalItemSchema = z.object({
  id: z.string().uuid(), status: z.enum(["active", "blocked", "completed", "cancelled", "expired"]),
  objective: z.string(), objectiveTruncated: z.boolean(), createdAt: timestamp, expiresAt: timestamp,
  maxActions: number, maxDecisions: z.number().int().min(1).max(24), decisionAttempts: z.number().int().min(0).max(24),
  reason: z.string().max(1000),
  targets: z.array(z.object({ nodeId: z.string().min(1).max(64), sessionId: z.string().min(1).max(64) }).strict()).min(1).max(4),
  criteria: z.array(z.object({ index: z.number().int().min(1).max(8), text: z.string().min(1).max(500),
    supported: z.boolean(), actions: z.array(number).max(12) }).strict()).min(1).max(8),
  actions: z.array(z.object({ index: number, target: z.number().int().min(1).max(4), prompt: z.string(), promptTruncated: z.boolean(),
    sourceActions: z.array(number).max(3), status: z.enum(["waiting", "claimed", "pending", "accepted", "completed", "failed", "uncertain", "blocked", "cancelled", "expired"]),
    commandId: z.string().min(1).max(64).optional(), turnId: TurnIdSchema.optional(),
  }).strict()).max(12),
}).strict();
export const ConsoleGoalsSchema = z.object({ observedAt: timestamp, limit: z.literal(CONSOLE_GOAL_LIMIT),
  hasMore: z.boolean(), items: z.array(GoalItemSchema).max(CONSOLE_GOAL_LIMIT) }).strict();
export type ConsoleGoals = z.infer<typeof ConsoleGoalsSchema>;

/** Explicit public projection, never spread durable leases, chat identity, input or result bodies. */
export async function readConsoleGoals(store: IStore, chatIds: readonly string[], observedAt: number): Promise<ConsoleGoals> {
  timestamp.parse(observedAt);
  const records = await store.listRecentGoals(chatIds, CONSOLE_GOAL_LIMIT + 1);
  const allowed = new Set(chatIds);
  if (!Array.isArray(records) || records.length > CONSOLE_GOAL_LIMIT + 1) throw new Error("Invalid goal list");
  const normalized = records.map(record => {
    const goal = normalizeGoal(record);
    if (!allowed.has(goal.chatId)) throw new Error("Goal list contains an unauthorized chat");
    return goal;
  });
  if (new Set(normalized.map(goal => goal.id)).size !== normalized.length) throw new Error("Duplicate goal list identity");
  const items = await Promise.all(normalized.slice(0, CONSOLE_GOAL_LIMIT).map(async goal => {
    const view = await readGoalView(store, goal, observedAt);
    const final = view.decisions.at(-1)?.decision;
    let supported = false;
    if (goal.status === "completed" && final?.type === "complete") {
      const input: GoalDecisionInput = { authorization: goal.proposal, actions: view.actions,
        decisions: view.decisions, availableTargets: [], decisionAttempts: view.decisionAttempts };
      try {
        validateGoalDecision(final, input);
        supported = JSON.stringify(goal.decisions.at(-1)!.evidence) === JSON.stringify(view.actions.flatMap(a => a.result ? [a.result] : []));
      }
      catch { supported = false; } // Preserve mismatched evidence as explicitly unverified, never successful.
    }
    const objective = clipped(goal.proposal.objective);
    return { id: goal.id, status: goal.status, objective: objective.text, objectiveTruncated: objective.truncated,
      createdAt: goal.createdAt, expiresAt: goal.expiresAt, maxActions: goal.proposal.maxActions,
      maxDecisions: goal.proposal.maxDecisions, decisionAttempts: view.decisionAttempts,
      reason: goalReason(view.blockedReason ?? final?.reason ?? "尚未记录决策"), targets: goal.proposal.targets.map(({ nodeId, sessionId }) => ({ nodeId, sessionId })),
      criteria: goal.proposal.criteria.map((text, index) => ({ index: index + 1, text, supported,
        actions: supported && final?.type === "complete" ? final.criteria.find(item => item.criterion === index + 1)!.actions : [] })),
      actions: view.actions.map(action => {
        const prompt = clipped(action.prompt);
        return { index: action.index, target: action.target, prompt: prompt.text, promptTruncated: prompt.truncated,
          sourceActions: [...action.sourceActions], status: action.status,
          ...(action.commandId ? { commandId: action.commandId } : {}), ...(action.turnId ? { turnId: action.turnId } : {}) };
      }),
    };
  }));
  return ConsoleGoalsSchema.parse({ observedAt, limit: CONSOLE_GOAL_LIMIT, hasMore: records.length > CONSOLE_GOAL_LIMIT, items });
}
