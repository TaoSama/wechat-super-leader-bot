import { z } from "zod";
import { ConflictError } from "./store/interface.js";
import { validateChatId } from "./leader/state.js";
import type { ExecutionRecord } from "./leader/execution.js";
import { MAX_PLAN_ACTIONS } from "./leader/contracts.js";

export const NOTIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export const NOTIFICATION_ATTEMPT_MS = 60_000;
export const NOTIFICATION_BATCH_LIMIT = 4;
export const NOTIFICATION_TEXT_LIMIT = 2000;
export const NotificationIdSchema = z.string().uuid();
export const NotificationReceiptStatusSchema = z.enum(["accepted", "uncertain"]);
const timestamp = z.number().int().nonnegative().refine(Number.isSafeInteger);
export const StoredNotificationSchema = z.object({
  id: NotificationIdSchema, executionId: NotificationIdSchema, chatId: z.string(),
  kind: z.enum(["completed", "failed", "expired"]), text: z.string().min(1).max(NOTIFICATION_TEXT_LIMIT),
  createdAt: timestamp, expiresAt: timestamp,
  status: z.enum(["pending", "claimed", "accepted", "uncertain"]),
  attemptId: NotificationIdSchema.optional(), attemptedAt: timestamp.optional(), attemptExpiresAt: timestamp.optional(),
}).strict();
export type StoredNotification = z.infer<typeof StoredNotificationSchema>;
export type Notification = Omit<StoredNotification, "status"> & { status: StoredNotification["status"] | "expired" };
export type NotificationReceiptStatus = z.infer<typeof NotificationReceiptStatusSchema>;

export function validateNotificationTime(now: number): number { return timestamp.parse(now); }

function notificationText(id: string, kind: StoredNotification["kind"], steps: number): string {
  const explanation = kind === "completed" ? "所有步骤已收到精确完成回执。" : kind === "failed" ?
    "计划失败，已停止后续派发；这不表示已运行的原会话任务停止，可查询计划进度核对。" :
    "计划授权已到期，已停止后续派发；这不表示已运行的原会话任务停止，可查询计划进度核对。";
  return `计划 ${id}（共 ${steps} 步）：${explanation}`;
}

export function normalizeNotification(value: unknown): StoredNotification {
  const notification = StoredNotificationSchema.parse(value);
  validateChatId(notification.chatId);
  const { attemptedAt, attemptExpiresAt, attemptId } = notification;
  if (notification.id !== notification.executionId || notification.expiresAt - notification.createdAt !== NOTIFICATION_TTL_MS ||
      !Array.from({ length: MAX_PLAN_ACTIONS }, (_, index) => notificationText(notification.id, notification.kind, index + 1)).includes(notification.text) ||
      (notification.status === "pending" ? attemptId !== undefined || attemptedAt !== undefined || attemptExpiresAt !== undefined :
        !attemptId || attemptedAt === undefined || attemptExpiresAt === undefined || attemptedAt < notification.createdAt ||
        attemptedAt >= notification.expiresAt || attemptExpiresAt !== Math.min(notification.expiresAt, attemptedAt + NOTIFICATION_ATTEMPT_MS))) {
    throw new Error("Invalid persisted notification identity or attempt");
  }
  return structuredClone(notification);
}

export function createTerminalNotification(execution: ExecutionRecord, now: number): StoredNotification | null {
  validateNotificationTime(now);
  if (!["completed", "failed", "expired"].includes(execution.status)) return null;
  if (now < execution.createdAt) throw new Error("Notification clock precedes execution creation");
  const kind = execution.status as StoredNotification["kind"];
  return normalizeNotification({ id: execution.id, executionId: execution.id, chatId: execution.chatId, kind,
    text: notificationText(execution.id, kind, execution.plan.actions.length),
    createdAt: now, expiresAt: now + NOTIFICATION_TTL_MS, status: "pending" });
}

export function readNotification(value: StoredNotification, now: number): Notification {
  validateNotificationTime(now);
  const notification = normalizeNotification(value);
  const status = notification.status === "pending" && notification.expiresAt <= now ? "expired" :
    notification.status === "claimed" && notification.attemptExpiresAt! <= now ? "uncertain" : notification.status;
  return { ...notification, status };
}

export function claimNotificationRecord(value: StoredNotification, attemptId: string, chatIds: readonly string[], now: number): StoredNotification {
  NotificationIdSchema.parse(attemptId);
  validateNotificationTime(now);
  const notification = normalizeNotification(value);
  if (notification.status !== "pending" || notification.expiresAt <= now || now < notification.createdAt || !chatIds.includes(notification.chatId)) {
    throw new ConflictError("Notification cannot be claimed");
  }
  return normalizeNotification({ ...notification, status: "claimed", attemptId, attemptedAt: now,
    attemptExpiresAt: Math.min(notification.expiresAt, now + NOTIFICATION_ATTEMPT_MS) });
}

export function receiptNotificationRecord(value: StoredNotification, attemptId: string, status: NotificationReceiptStatus, now: number): StoredNotification {
  NotificationIdSchema.parse(attemptId);
  NotificationReceiptStatusSchema.parse(status);
  validateNotificationTime(now);
  const notification = normalizeNotification(value);
  if (notification.status === "pending" || notification.attemptId !== attemptId || now < notification.attemptedAt!) {
    throw new ConflictError("Notification receipt does not match its permanent attempt");
  }
  return normalizeNotification({ ...notification, status: notification.status === "accepted" ? "accepted" : status });
}
