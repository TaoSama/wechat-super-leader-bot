import { UpdateBackgroundPromptSchema, type PromptUpdateAuthority, type Schedule, type UpdateBackgroundPrompt } from "./contracts.js";
import { AutomationConflictError, AutomationValidationError } from "./errors.js";
import { scheduleCreationFingerprint } from "./identity.js";

/** Run against the latest schedule while its repository write lock is held. */
export function applyPromptUpdate(schedule: Schedule, input: UpdateBackgroundPrompt,
  authority: PromptUpdateAuthority, now: number): Schedule {
  const parsed = UpdateBackgroundPromptSchema.parse(input);
  if (!authority.requestId.trim() || !["current_turn", "admin_api"].includes(authority.source)) {
    throw new AutomationValidationError("Prompt updates require a trusted authorization source and request ID");
  }
  if (schedule.kind !== "background") throw new AutomationValidationError("Only background schedule prompts can be edited");
  const receipt = schedule.latestPromptUpdate;
  const revision = receipt === undefined ? 0 : receipt.revision;
  if (!Number.isSafeInteger(revision) || revision < (receipt === undefined ? 0 : 1)) {
    throw new AutomationConflictError("Schedule prompt revision is invalid");
  }
  const sameRequest = receipt?.source === authority.source && receipt.requestId === authority.requestId;
  // A committed edit can be acknowledged again without changing an already claimed occurrence.
  if (sameRequest && parsed.expectedPromptRevision === revision - 1 && parsed.prompt === schedule.background.prompt) return schedule;
  if (sameRequest && authority.source === "admin_api") {
    throw new AutomationConflictError("Prompt update key conflicts with its last applied request");
  }
  if (schedule.status !== "active" && schedule.status !== "paused") {
    throw new AutomationConflictError("Finished schedule prompts cannot be edited");
  }
  if (schedule.activeRunId) throw new AutomationConflictError("A schedule occurrence is already active; retry after it finishes");
  if (parsed.expectedPromptRevision !== revision) throw new AutomationConflictError("Schedule prompt revision has changed");
  if (parsed.prompt === schedule.background.prompt) return schedule;
  if (revision === Number.MAX_SAFE_INTEGER) throw new AutomationConflictError("Schedule prompt revision is exhausted");
  return {
    ...schedule,
    creationFingerprint: schedule.creationFingerprint ?? scheduleCreationFingerprint(schedule),
    background: { ...schedule.background, prompt: parsed.prompt },
    latestPromptUpdate: { ...authority, revision: revision + 1, updatedAt: now },
    updatedAt: now,
  };
}
