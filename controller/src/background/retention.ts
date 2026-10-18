import { createHash } from "node:crypto";
import { BackgroundSpecSchema, type BackgroundSpec, type BackgroundWorker } from "./contracts.js";

export function backgroundSpecFingerprint(spec: BackgroundSpec): string {
  return createHash("sha256").update(JSON.stringify(BackgroundSpecSchema.parse(spec))).digest("hex");
}
export function assertSameBackgroundCreation(prior: BackgroundWorker, incoming: BackgroundWorker): void {
  if (prior.chatId !== incoming.chatId || prior.scheduleId !== incoming.scheduleId || prior.scheduledAt !== incoming.scheduledAt ||
    (prior.specFingerprint ?? backgroundSpecFingerprint(prior.spec)) !== backgroundSpecFingerprint(incoming.spec)) {
    throw new Error("Background run creation conflicts with its persisted authorization");
  }
}
/** Keep attachment ownership receipts; execution bodies expire with the workspace. */
export function clearBackgroundBody(worker: BackgroundWorker, now: number): void {
  worker.specFingerprint ??= backgroundSpecFingerprint(worker.spec);
  worker.spec.prompt = "[expired]";
  worker.spec.preferences = [];
  worker.observations = [];
  for (const prompt of worker.prompts) prompt.prompt = "";
  for (const invocation of worker.invocations) {
    invocation.task = ""; invocation.input = null; delete invocation.result;
    if (invocation.receipt) {
      invocation.receipt.summary = "";
      delete invocation.receipt.error; delete invocation.receipt.threadId;
      delete invocation.receipt.attachments; delete invocation.receipt.nextCheckAt;
    }
  }
  if (worker.initialOutcome?.status === "completed" || worker.initialOutcome?.status === "failed") {
    worker.initialOutcome = { status: worker.initialOutcome.status, result: { text: "", meaningful: false } };
  }
  worker.bodyClearedAt = now;
}
