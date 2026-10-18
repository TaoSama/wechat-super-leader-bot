import type { DeliveryPlan } from "./contracts.js";

export class CatchupConflictError extends Error {
  constructor() { super("Catch-up sources changed before they could be reserved"); }
}

export function catchupEligible(plan: DeliveryPlan, chatId: string, now: number, reservationId?: string): boolean {
  return plan.chatId === chatId && plan.kind !== "progress" && plan.status === "waiting_for_user" &&
    (plan.submittedMessages ?? 0) === 0 && plan.expiresAt > now && plan.retainedUntil > now &&
    (reservationId ? plan.catchupId === reservationId : !plan.catchupId);
}

export function catchupSourcesValid(plan: DeliveryPlan, sources: readonly DeliveryPlan[], now: number, reserved: boolean): boolean {
  return (plan.catchupSourceIds?.length ?? 0) >= 2 && sources.length === plan.catchupSourceIds!.length &&
    sources.every(source => catchupEligible(source, plan.chatId, now, reserved ? plan.id : undefined));
}
