import { createHash } from "node:crypto";
import { sameCommandPayload } from "../../commands/queue.js";
import type { IStore } from "../../store/interface.js";
import type { CommandRecord } from "../../types.js";
import type { Plan } from "../contracts.js";

export function steerPlanRequestId(chatId: string, planId: string): string {
  return `leader_steer_${createHash("sha256").update(JSON.stringify([chatId, planId])).digest("hex")}`;
}

/** Reconcile the frozen one-step supplement without admitting or transmitting a command. */
export async function recoverSteerPlanCommand(store: Pick<IStore, "findCommandByRequestId" | "markExpiredActiveCommandsUncertain">,
  chatId: string, plan: Plan): Promise<CommandRecord | null> {
  const action = plan.actions[0];
  if (plan.actions.length !== 1 || action.deliveryMode !== "steer" || !action.sendRoute) return null;
  await store.markExpiredActiveCommandsUncertain();
  const requestId = steerPlanRequestId(chatId, plan.id);
  const command = await store.findCommandByRequestId(requestId);
  // Cancellation revokes dispatch authority, while the original chat still owns its receipt.
  if (!command || command.sendRoute !== action.sendRoute || command.authority?.type !== "chat" || command.authority.chatId !== chatId ||
      !sameCommandPayload(command, { ...action, action: "send", requestId })) return null;
  return command;
}
