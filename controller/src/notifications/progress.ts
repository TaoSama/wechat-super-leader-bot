import { randomUUID } from "node:crypto";
import { TurnIdSchema, type CommandRecord } from "../types.js";
import { matchesExecutionCommand, type ExecutionRecord } from "../leader/plans/execution.js";
import { matchesGoalCommand, type GoalRecord } from "../leader/goals/goal.js";
import { normalizeNotification, validateNotificationTime, NOTIFICATION_PROGRESS_LIMIT, NOTIFICATION_TTL_MS,
  type NotificationSource, type StoredNotification } from "./contracts.js";
import { notificationTaskTitle } from "./presentation.js";

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

/** Only exact, persisted command receipts establish a progress milestone. */
export function createProgressNotification(record: NotificationSourceRecord, commands: readonly CommandRecord[],
  notifications: readonly StoredNotification[], now: number): StoredNotification | null {
  if (!progressNotificationBudgetAvailable(record, notifications, now)) return null;
  const source = notificationSource(record);
  const progress = notifications.filter(item => item.kind === "progress" && sameNotificationSource(item.source, source));
  const isPlan = "plan" in record;
  const actions = isPlan ? record.plan.actions : record.actions;
  const receipts = actions.flatMap((_action, index) => {
    const attempted = isPlan ? record.attempts[index] : record.actions[index].attempt;
    const command = attempted && commands.find(item => isPlan ? matchesExecutionCommand(record, index, item) : matchesGoalCommand(record, index, item));
    if (!command || !["accepted", "completed"].includes(command.status) || !TurnIdSchema.safeParse(command.turnId).success ||
        command.inputReceipt || command.sendRoute === "terminal-pane" || command.sessionId.startsWith("terminal:")) return [];
    return [{ command, index, stamp: Date.parse(command.updatedAt) }];
  }).filter(item => Number.isFinite(item.stamp) && item.stamp <= now);
  receipts.sort((a, b) => b.stamp - a.stamp || b.index - a.index);
  const latest = receipts[0];
  if (!latest) return null;
  const eventKey = `${latest.command.commandId}:${latest.command.status}`;
  if (progress.some(item => item.kind === "progress" && item.progress.eventKey === eventKey)) return null;
  const objective = isPlan ? record.plan.actions[0].prompt : record.proposal.objective;
  const completed = receipts.filter(item => item.command.status === "completed").length;
  const state = latest.command.status === "completed" ? `已收到第 ${latest.index + 1} 项任务的精确完成回执，累计完成 ${completed}/${actions.length} 项。` :
    `第 ${latest.index + 1} 项任务已接收，正在等待精确完成回执。`;
  return normalizeNotification({ id: randomUUID(), source, chatId: record.chatId, kind: "progress",
    progress: { sequence: progress.length + 1, eventKey },
    text: `### 任务进展\n\n**任务**：${notificationTaskTitle(objective)}\n\n${state}`,
    status: "pending", createdAt: now, expiresAt: now + NOTIFICATION_TTL_MS });
}
