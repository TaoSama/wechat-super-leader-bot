import type { DeliveryPlan } from "../deliveries/contracts.js";

// The list renders 240 UTF-16 characters; retain one more to signal an omitted suffix.
export const CONSOLE_DELIVERY_PREVIEW_CHARS = 241;
export type ConsoleDelivery = Pick<DeliveryPlan, "id" | "kind" | "status" | "mode" | "createdAt" | "expiresAt" | "retainedUntil"> & {
  messages: string[];
  artifact: Pick<DeliveryPlan["artifact"], "id" | "name" | "size" | "expiresAt">;
};

/** Status carries a list preview; full content and transport messages stay in the delivery repository. */
export function consoleDelivery(plan: DeliveryPlan): ConsoleDelivery {
  return {
    id: plan.id, kind: plan.kind, status: plan.status, mode: plan.mode,
    messages: plan.messages.length ? [plan.messages[0].slice(0, CONSOLE_DELIVERY_PREVIEW_CHARS)] : [],
    artifact: { id: plan.artifact.id, name: plan.artifact.name, size: plan.artifact.size, expiresAt: plan.artifact.expiresAt },
    createdAt: plan.createdAt, expiresAt: plan.expiresAt, retainedUntil: plan.retainedUntil,
  };
}
