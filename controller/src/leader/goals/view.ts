import type { IStore } from "../../store/interface.js";
import { TurnIdSchema } from "../../types.js";
import { matchesGoalCommand, goalRequestId, type GoalRecord, type GoalDecisionInput } from "./goal.js";

export type GoalView = Pick<GoalRecord, "id" | "status" | "proposal" | "createdAt" | "expiresAt" | "decisions" | "decisionAttempts" | "blockedReason"> & {
  actions: GoalDecisionInput["actions"];
};
type GoalCommandReader = Pick<IStore, "findCommandByRequestId">;
export async function readGoalView(store: GoalCommandReader, goal: GoalRecord, now: number, metadataOnly = false): Promise<GoalView> {
  const { recordedOutput } = await import("../plans/input.js");
  const actions: GoalDecisionInput["actions"] = [];
  for (const [index, action] of goal.actions.entries()) {
    const base = { index: action.index, target: action.target, prompt: action.prompt, sourceActions: [...action.sourceActions] };
    const command = await store.findCommandByRequestId(goalRequestId(goal, index));
    if (command && (!action.attempt || !matchesGoalCommand(goal, index, command) || command.inputReceipt ||
      command.sendRoute === "terminal-pane" || ["accepted", "completed"].includes(command.status) && !TurnIdSchema.safeParse(command.turnId).success)) {
      actions.push({ ...base, status: "uncertain" });
    } else if (command) {
      let result;
      if (command.status === "completed") {
        if (metadataOnly) {
          // This is the immutable evidence already checked when the model decision was committed.
          // Status verifies its exact receipt identity; dispatch/decision paths still hash full bodies.
          const frozen = goal.decisions.at(-1)?.evidence.find(evidence => evidence.action === action.index &&
            evidence.commandId === command.commandId && evidence.turnId === command.turnId);
          if (frozen && "hasOutput" in command && command.hasOutput === true) result = structuredClone(frozen);
        } else {
          if (typeof command.output !== "string") { actions.push({ ...base, status: "uncertain" }); continue; }
          try { result = { action: action.index, commandId: command.commandId, turnId: command.turnId!, ...recordedOutput(command.output) }; }
          catch { actions.push({ ...base, status: "uncertain" }); continue; }
        }
      }
      actions.push({ ...base, status: command.status, commandId: command.commandId,
        ...(command.turnId ? { turnId: command.turnId } : {}), ...(result ? { result } : {}) });
    } else if (action.attempt) actions.push({ ...base, status: action.attempt.expiresAt <= now ? "uncertain" : "claimed" });
    else actions.push({ ...base, status: goal.status === "active" ? "waiting" : goal.status === "completed" ? "uncertain" : goal.status });
  }
  return { id: goal.id, status: goal.status, proposal: structuredClone(goal.proposal), createdAt: goal.createdAt,
    expiresAt: goal.expiresAt, actions, decisions: structuredClone(goal.decisions), decisionAttempts: goal.decisionAttempts,
    ...(goal.blockedReason ? { blockedReason: goal.blockedReason } : {}) };
}

export async function validateGoalProofs(store: GoalCommandReader, current: GoalRecord, next: GoalRecord, now: number): Promise<void> {
  const input = next.lease && JSON.stringify(next.lease) !== JSON.stringify(current.lease) ? next.lease.input :
    next.decisions.length > current.decisions.length ? current.lease?.input : undefined;
  const claimed = next.actions.some((a, i) => a.attempt && !current.actions[i]?.attempt);
  if (!input && !claimed) return;
  const view = await readGoalView(store, current, now);
  if (input && JSON.stringify(input.actions) !== JSON.stringify(view.actions)) throw new Error("Goal decision input differs from recorded commands");
  if (claimed) {
    const action = next.actions.at(-1)!;
    if (view.actions.at(-1)?.status !== "waiting" || view.actions.slice(0, -1).some(a => a.status !== "completed") || action.input.sources.some(s =>
      JSON.stringify(view.actions[s.action - 1]?.result) !== JSON.stringify(s))) throw new Error("Goal send predecessors are not completed");
  }
}
