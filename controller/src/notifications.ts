import { z } from "zod";
import { ConflictError } from "./store/interface.js";
import { validateChatId } from "./leader/state.js";
import type { ExecutionRecord } from "./leader/execution.js";
import type { GoalRecord } from "./leader/goal.js";
import { MAX_PLAN_ACTIONS } from "./leader/contracts.js";

export const NOTIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export const NOTIFICATION_ATTEMPT_MS = 60_000;
export const NOTIFICATION_BATCH_LIMIT = 4;
export const NOTIFICATION_TEXT_LIMIT = 2000;
export const NotificationIdSchema = z.string().uuid();
export const NotificationReceiptStatusSchema = z.enum(["accepted", "uncertain"]);
const timestamp = z.number().int().nonnegative().refine(Number.isSafeInteger);
const PlanNotificationKindSchema = z.enum(["completed", "failed", "expired"]);
const GoalNotificationKindSchema = z.enum(["completed", "blocked", "expired"]);
const notificationFields = {
  id: NotificationIdSchema, chatId: z.string(), text: z.string().min(1).max(NOTIFICATION_TEXT_LIMIT),
  createdAt: timestamp, expiresAt: timestamp,
  status: z.enum(["pending", "claimed", "accepted", "uncertain"]),
  attemptId: NotificationIdSchema.optional(), attemptedAt: timestamp.optional(), attemptExpiresAt: timestamp.optional(),
};
export const StoredNotificationSchema = z.union([
  z.object({ ...notificationFields, source: z.object({ type: z.literal("plan"), id: NotificationIdSchema }).strict(), kind: PlanNotificationKindSchema }).strict(),
  z.object({ ...notificationFields, source: z.object({ type: z.literal("goal"), id: NotificationIdSchema }).strict(), kind: GoalNotificationKindSchema }).strict(),
]);
export type StoredNotification = z.infer<typeof StoredNotificationSchema>;
type ReadNotification<T> = T extends StoredNotification ? Omit<T, "status"> & { status: StoredNotification["status"] | "expired" } : never;
export type Notification = ReadNotification<StoredNotification>;
export type NotificationReceiptStatus = z.infer<typeof NotificationReceiptStatusSchema>;

export function validateNotificationTime(now: number): number { return timestamp.parse(now); }

function notificationText(id: string, kind: z.infer<typeof PlanNotificationKindSchema>, steps: number): string {
  const explanation = kind === "completed" ? "所有步骤已收到精确完成回执。" : kind === "failed" ?
    "计划失败，已停止后续派发；这不表示已运行的原会话任务停止，可查询计划进度核对。" :
    "计划授权已到期，已停止后续派发；这不表示已运行的原会话任务停止，可查询计划进度核对。";
  return `计划 ${id}（共 ${steps} 步）：${explanation}`;
}

const GOAL_NOTIFICATION_EXPLANATIONS = {
  completed: "模型根据精确完成记录判断条件已满足；这不是独立业务验收。可查询目标进展核对。",
  blocked: "已停止自动推进，需要处理。请查询目标进展核对当前状态；这不表示原会话任务停止。",
  expired: "授权已到期，已停止后续派发。请查询目标进展核对当前状态；这不表示原会话任务停止。",
} as const;
export function goalNotificationText(id: string, kind: z.infer<typeof GoalNotificationKindSchema>): string {
  return `持续目标 ${id}：${GOAL_NOTIFICATION_EXPLANATIONS[kind]}`;
}

export function normalizeNotification(value: unknown): StoredNotification {
  const notification = StoredNotificationSchema.parse(value);
  validateChatId(notification.chatId);
  const { attemptedAt, attemptExpiresAt, attemptId } = notification;
  const validText = notification.source.type === "plan" ? notification.kind !== "blocked" &&
    Array.from({ length: MAX_PLAN_ACTIONS }, (_, index) => notificationText(notification.id, notification.kind as z.infer<typeof PlanNotificationKindSchema>, index + 1)).includes(notification.text) :
    notification.kind !== "failed" && goalNotificationText(notification.id, notification.kind) === notification.text;
  if (notification.id !== notification.source.id || notification.expiresAt - notification.createdAt !== NOTIFICATION_TTL_MS || !validText ||
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
  const kind = execution.status as z.infer<typeof PlanNotificationKindSchema>;
  return normalizeNotification({ id: execution.id, source: { type: "plan", id: execution.id }, chatId: execution.chatId, kind,
    text: notificationText(execution.id, kind, execution.plan.actions.length),
    createdAt: now, expiresAt: now + NOTIFICATION_TTL_MS, status: "pending" });
}

export function createGoalNotification(current: GoalRecord, next: GoalRecord, now: number): StoredNotification | null {
  validateNotificationTime(now);
  if (current.status !== "active" || !["completed", "blocked", "expired"].includes(next.status)) return null;
  if (current.id !== next.id || current.chatId !== next.chatId || now < next.createdAt) throw new Error("Invalid goal notification transition");
  const kind = next.status as z.infer<typeof GoalNotificationKindSchema>;
  return normalizeNotification({ id: next.id, source: { type: "goal", id: next.id }, chatId: next.chatId, kind,
    text: goalNotificationText(next.id, kind), createdAt: now, expiresAt: now + NOTIFICATION_TTL_MS, status: "pending" });
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
