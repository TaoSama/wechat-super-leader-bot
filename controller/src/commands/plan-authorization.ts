import type { CommandAuthority, CommandRecord } from "../types.js";
import type { IStore } from "../store/interface.js";
import { matchesExecutionCommand, sameExecutionAuthorization } from "../leader/plans/execution.js";
import { readExecutionView } from "../leader/plans/view.js";

const STOPPED_STEP_STATUSES = new Set(["failed", "cancelled", "expired"]);

/** Queued work retains its approved attempt, but must obey the plan's current stop and input conditions. */
export async function isPlanCommandAuthorized(store: Pick<IStore, "getExecution" | "findCommandByRequestId">,
  command: CommandRecord, authority: Extract<CommandAuthority, { type: "plan" | "goal" }>): Promise<boolean | "paused"> {
  if (authority.type !== "plan") return false;
  const snapshot = await store.getExecution(authority.id);
  if (!snapshot || snapshot.chatId !== authority.chatId || snapshot.status !== "active" || snapshot.expiresAt <= Date.now()) return false;
  const index = snapshot.plan.actions.findIndex((_, step) => !!snapshot.attempts[step] && matchesExecutionCommand(snapshot, step, command));
  if (index < 0) return false;
  // This also checks exact receipts and the frozen result input of every attempted step.
  const view = await readExecutionView(store, snapshot, Date.now());
  const current = await store.getExecution(authority.id);
  if (!current || current.status !== "active" || current.expiresAt <= Date.now() ||
      !sameExecutionAuthorization(snapshot, current) ||
      JSON.stringify(snapshot.attempts[index]) !== JSON.stringify(current.attempts[index]) ||
      view.steps.some(step => STOPPED_STEP_STATUSES.has(step.status))) return false;
  if (view.steps.some(step => step.status === "uncertain")) return "paused";
  return snapshot.plan.actions[index].dependsOn.every(step => view.steps[step - 1].status === "completed");
}
