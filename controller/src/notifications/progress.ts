import { createHash, randomUUID } from "node:crypto";
import { TurnIdSchema, type CommandRecord } from "../types.js";
import { matchesExecutionCommand, type ExecutionRecord } from "../leader/plans/execution.js";
import { matchesGoalCommand, type GoalRecord } from "../leader/goals/goal.js";
import { normalizeNotification, validateNotificationTime, NOTIFICATION_PROGRESS_LIMIT, NOTIFICATION_TTL_MS,
  type NotificationSource, type StoredNotification } from "./contracts.js";

export const NOTIFICATION_PROGRESS_INITIAL_DELAY_MS = 30_000;
export const NOTIFICATION_PROGRESS_INTERVAL_MS = 60_000;
export type NotificationSourceRecord = ExecutionRecord | GoalRecord;

export function notificationSource(record: NotificationSourceRecord): NotificationSource {
  return { type: "plan" in record ? "plan" : "goal", id: record.id };
}

export function sameNotificationSource(a: NotificationSource, b: NotificationSource): boolean {
  return a.type === b.type && a.id === b.id;
}

export function progressNotificationEligible(notification: StoredNotification, record: NotificationSourceRecord, now: number): boolean {
  return notification.kind !== "progress" || record.status === "active" && record.expiresAt > now &&
    record.chatId === notification.chatId && sameNotificationSource(notification.source, notificationSource(record));
}

/** Check cheap source and permanent-budget facts before reading command evidence. */
export function progressNotificationBudgetAvailable(record: NotificationSourceRecord,
  notifications: readonly StoredNotification[], now: number): boolean {
  validateNotificationTime(now);
  if (record.status !== "active" || record.expiresAt <= now || now < record.createdAt + NOTIFICATION_PROGRESS_INITIAL_DELAY_MS) return false;
  const source = notificationSource(record);
  const existing = notifications.filter(item => sameNotificationSource(item.source, source));
  if (existing.some(item => item.kind !== "progress")) return false;
  const progress = existing.filter(item => item.kind === "progress");
  return progress.length < NOTIFICATION_PROGRESS_LIMIT && progress.every(item => now >= item.createdAt + NOTIFICATION_PROGRESS_INTERVAL_MS);
}

export interface ProgressDraft { eventKey: string; text: string }
export interface ProgressContext {
  source: NotificationSource;
  chatId: string;
  eventKey: string;
  remaining: number;
  objective: string;
  evidence: { step?: number; prompt: string; status: string; output?: string }[];
}
export const PROGRESS_TEXT_LIMIT = 2000;
export const PROGRESS_OUTPUT_LIMIT = 4000;

export function progressOutputExcerpt(output: string): string {
  let excerpt = "", length = 0;
  for (const character of output) {
    if (length++ >= PROGRESS_OUTPUT_LIMIT) break;
    excerpt += character;
  }
  return excerpt;
}

/** Waiting is persisted authorization; execution claims require exact matching command evidence. */
export function progressNotificationContext(record: NotificationSourceRecord, commands: readonly CommandRecord[],
  notifications: readonly StoredNotification[], now: number): ProgressContext | null {
  if (!progressNotificationBudgetAvailable(record, notifications, now)) return null;
  const source = notificationSource(record);
  const progress = notifications.filter(item => item.kind === "progress" && sameNotificationSource(item.source, source));
  const isPlan = "plan" in record;
  const actions = isPlan ? record.plan.actions : record.actions;
  const evidence: ProgressContext["evidence"] = actions.flatMap((action, index) => {
    const attempted = isPlan ? record.attempts[index] : record.actions[index].attempt;
    if (!attempted) return [{ step: index + 1, prompt: action.prompt, status: "waiting" }];
    const command = commands.find(item => isPlan ? matchesExecutionCommand(record, index, item) : matchesGoalCommand(record, index, item));
    if (!command || command.inputReceipt || command.sendRoute === "terminal-pane" || command.sessionId.startsWith("terminal:") ||
      !Number.isFinite(Date.parse(command.updatedAt)) || Date.parse(command.updatedAt) > now) return [];
    if (["accepted", "completed"].includes(command.status) && !TurnIdSchema.safeParse(command.turnId).success) return [];
    if (!["pending", "queued", "claimed", "accepted", "completed"].includes(command.status)) return [];
    return [{ step: index + 1, prompt: action.prompt, status: command.status,
      ...(command.status === "completed" && command.output ? { output: progressOutputExcerpt(command.output) } : {}),
      commandId: command.commandId }];
  });
  if (!isPlan && !actions.length) evidence.push({ prompt: record.proposal.objective,
    status: record.lease ? "deciding_next_action" : "waiting_for_decision" });
  if (!evidence.length) return null;
  const eventKey = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
  if (progress.some(item => item.kind === "progress" && item.progress.eventKey === eventKey)) return null;
  return { source, chatId: record.chatId, eventKey, remaining: NOTIFICATION_PROGRESS_LIMIT - progress.length,
    objective: isPlan ? record.plan.actions[0].prompt : record.proposal.objective,
    evidence };
}

/** Model text is committed only while its original exact milestone is still current. */
export function createProgressNotification(record: NotificationSourceRecord, commands: readonly CommandRecord[],
  notifications: readonly StoredNotification[], now: number, draft?: ProgressDraft): StoredNotification | null {
  if (!draft || typeof draft.text !== "string" || !draft.text.trim() || draft.text.length > PROGRESS_TEXT_LIMIT) return null;
  const context = progressNotificationContext(record, commands, notifications, now);
  if (!context || draft.eventKey !== context.eventKey) return null;
  return normalizeNotification({ id: randomUUID(), source: context.source, chatId: record.chatId, kind: "progress",
    progress: { sequence: NOTIFICATION_PROGRESS_LIMIT - context.remaining + 1, eventKey: context.eventKey },
    text: draft.text.trim(), status: "pending", createdAt: now, expiresAt: now + NOTIFICATION_TTL_MS });
}
