import { createHash, randomUUID } from "node:crypto";
import { CLAIM_LEASE_MS, type AutomationRun, type AutomationOutbox, type RunnerOutcome, type Schedule } from "./contracts.js";
import { dueOccurrence } from "./timing.js";

export function newRun(schedule: Schedule, now: number, owner: string, existing?: AutomationRun): AutomationRun {
  const { scheduledAt, nextAt } = dueOccurrence(schedule, now);
  const expired = now >= scheduledAt + schedule.businessTtlMs;
  const run: AutomationRun = {
    id: existing?.id ?? randomUUID(), scheduleId: schedule.id, chatId: schedule.chatId, scheduledAt,
    status: expired ? "expired" : "dispatching", createdAt: existing?.createdAt ?? now, updatedAt: now,
    claimOwner: owner, claimUntil: now + CLAIM_LEASE_MS,
  };
  schedule.nextAt = nextAt;
  schedule.updatedAt = now;
  if (expired) { if (nextAt === null) schedule.status = "completed"; }
  else schedule.activeRunId = run.id;
  return run;
}

export function finishRun(schedule: Schedule, run: AutomationRun, outcome: RunnerOutcome, now: number): AutomationOutbox | undefined {
  run.updatedAt = now;
  run.claimUntil = now;
  run.status = outcome.status;
  delete run.error;
  schedule.updatedAt = now;
  if (outcome.status === "running") {
    if (outcome.commandId) run.commandId = outcome.commandId;
    if (outcome.error) run.error = outcome.error;
    return;
  }
  if (outcome.status === "skipped") {
    run.error = outcome.reason === "paused" ? "Paused before dispatch" : "Cancelled before dispatch";
    delete schedule.activeRunId;
    if (outcome.reason === "paused" && schedule.status === "paused") schedule.nextAt = run.scheduledAt;
    return;
  }
  if (outcome.status === "unknown") {
    run.error = outcome.error;
    // An unobserved submission blocks future occurrences until the owner resolves it.
    return;
  }
  delete schedule.activeRunId;
  if (schedule.nextAt === null && schedule.status === "active") schedule.status = "completed";
  run.result = structuredClone(outcome.result);
  const previousOutcome = schedule.lastOutcome;
  const fingerprint = outcome.result.fingerprint ?? createHash("sha256").update(outcome.result.text + "\0" + (outcome.result.error ?? "")).digest("hex");
  const same = schedule.lastOutcome === outcome.status && schedule.lastFingerprint === fingerprint;
  schedule.lastOutcome = outcome.status;
  schedule.lastFingerprint = fingerprint;
  const monitor = schedule.kind === "session" && schedule.monitor;
  const recovered = previousOutcome === "failed" && outcome.status === "completed";
  const meaningful = outcome.status === "failed" || recovered || outcome.result.meaningful !== false;
  const text = outcome.result.text.trim() || (outcome.status === "failed" ? outcome.result.error?.trim() : "");
  const expiresAt = run.scheduledAt + schedule.businessTtlMs;
  if (!text || !meaningful || (monitor && same) || expiresAt <= now) return;
  return {
    id: run.id, runId: run.id, scheduleId: schedule.id, chatId: schedule.chatId,
    kind: outcome.status === "failed" ? "failed" : recovered ? "recovered" : "completed",
    text, createdAt: now, expiresAt, status: "pending",
  };
}
