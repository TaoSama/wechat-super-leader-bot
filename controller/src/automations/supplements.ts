import { createHash } from "node:crypto";
import { z } from "zod";
import { supplementId } from "./identity.js";
import { MAX_AUTOMATION_TEXT, type AutomationOutbox, type AutomationRun, type AutomationSupplement, type Schedule } from "./contracts.js";

const SupplementSchema = z.object({
  runId: z.string().min(1), scheduleId: z.string().min(1), chatId: z.string().min(1), invocationId: z.string().uuid(),
  text: z.string().min(1).max(MAX_AUTOMATION_TEXT).refine(text => Boolean(text.trim()), "Supplement text cannot be blank"),
  kind: z.enum(["completed", "failed", "recovered"]), createdAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
}).strict().refine(input => input.expiresAt > input.createdAt, "Supplement expiry must follow its creation time");
export function supplementOutbox(raw: AutomationSupplement, schedule: Schedule | undefined | null,
  run: AutomationRun | undefined | null): AutomationOutbox {
  const input = SupplementSchema.parse(raw);
  if (!schedule || schedule.kind !== "background" || !run || schedule.id !== input.scheduleId ||
    schedule.chatId !== input.chatId || run.chatId !== input.chatId || run.scheduleId !== input.scheduleId || run.id !== input.runId) {
    throw new Error("Background supplement does not match its authorized schedule and run");
  }
  const fingerprint = createHash("sha256").update(JSON.stringify([input.runId, input.scheduleId, input.chatId,
    input.invocationId, input.text, input.kind, input.createdAt, input.expiresAt])).digest("hex");
  return { id: supplementId(input.runId, input.invocationId), runId: input.runId, scheduleId: input.scheduleId,
    chatId: input.chatId, text: input.text, kind: input.kind, createdAt: input.createdAt, expiresAt: input.expiresAt,
    status: "pending", supplement: { invocationId: input.invocationId, fingerprint } };
}
export function assertSameSupplement(prior: AutomationOutbox, incoming: AutomationOutbox): void {
  if (!prior.supplement || prior.supplement.fingerprint !== incoming.supplement?.fingerprint) {
    throw new Error("Background supplement idempotency key conflicts with an earlier result");
  }
}
