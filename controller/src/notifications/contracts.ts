import { z } from "zod";
import { randomUUID } from "node:crypto";
import { ConflictError } from "../store/interface.js";
import { validateChatId } from "../leader/state.js";
import type { ExecutionRecord } from "../leader/plans/execution.js";
import type { GoalRecord } from "../leader/goals/goal.js";
import type { CommandRecord } from "../types.js";
import { planNotificationChunks, goalResultNotificationChunks } from "./presentation.js";
import { splitNotificationTextChunks, NOTIFICATION_TEXT_LIMIT, NOTIFICATION_TEXT_BYTES, NOTIFICATION_PART_LIMIT } from "./parts.js";
export { NOTIFICATION_TEXT_LIMIT, NOTIFICATION_TEXT_BYTES, NOTIFICATION_PART_LIMIT } from "./parts.js";

export const NOTIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
export const NOTIFICATION_ATTEMPT_MS = 30 * 60_000;
export const LEGACY_NOTIFICATION_ATTEMPT_MS = 60_000;
export const NOTIFICATION_BATCH_LIMIT = 1;
export const NOTIFICATION_PROGRESS_LIMIT = 3;
export const NotificationIdSchema = z.string().uuid();
export const NotificationSourceSchema = z.object({ type: z.enum(["plan", "goal"]), id: NotificationIdSchema }).strict();
export type NotificationSource = z.infer<typeof NotificationSourceSchema>;
export const NotificationReceiptStatusSchema = z.enum(["accepted", "uncertain"]);
export const NotificationDeferReasonSchema = z.enum(["budget_exhausted", "window_expired", "context_changed"]);
const timestamp = z.number().int().nonnegative().refine(Number.isSafeInteger);
const PlanNotificationKindSchema = z.enum(["completed", "failed", "expired"]);
const GoalNotificationKindSchema = z.enum(["completed", "blocked", "expired"]);
const part = z.object({ index: z.number().int().min(1).max(NOTIFICATION_PART_LIMIT),
  total: z.number().int().min(1).max(NOTIFICATION_PART_LIMIT) }).strict().optional();
const notificationFields = {
  id: NotificationIdSchema, chatId: z.string(), text: z.string().min(1).max(NOTIFICATION_TEXT_LIMIT),
  createdAt: timestamp, expiresAt: timestamp,
  status: z.enum(["pending", "claimed", "accepted", "uncertain"]),
  attemptId: NotificationIdSchema.optional(), attemptedAt: timestamp.optional(), attemptExpiresAt: timestamp.optional(),
  lastDeferredAttemptId: NotificationIdSchema.optional(), lastDeferReason: NotificationDeferReasonSchema.optional(),
};
export const StoredNotificationSchema = z.union([
  z.object({ ...notificationFields, source: z.object({ type: z.literal("plan"), id: NotificationIdSchema }).strict(), kind: PlanNotificationKindSchema, part }).strict(),
  z.object({ ...notificationFields, source: z.object({ type: z.literal("goal"), id: NotificationIdSchema }).strict(), kind: GoalNotificationKindSchema, part }).strict(),
  z.object({ ...notificationFields, source: NotificationSourceSchema, kind: z.literal("progress"),
    progress: z.object({ sequence: z.number().int().min(1).max(NOTIFICATION_PROGRESS_LIMIT),
      eventKey: z.string().min(1).max(256) }).strict() }).strict(),
]);
export type StoredNotification = z.infer<typeof StoredNotificationSchema>;
type ReadNotification<T> = T extends StoredNotification ? Omit<T, "status"> & { status: StoredNotification["status"] | "expired" } : never;
export type Notification = ReadNotification<StoredNotification>;
export type NotificationReceiptStatus = z.infer<typeof NotificationReceiptStatusSchema>;
export type NotificationDeferReason = z.infer<typeof NotificationDeferReasonSchema>;

export function validateNotificationTime(now: number): number { return timestamp.parse(now); }

export function normalizeNotification(value: unknown): StoredNotification {
  const notification = StoredNotificationSchema.parse(value);
  validateChatId(notification.chatId);
  const { attemptedAt, attemptExpiresAt, attemptId } = notification;
  const firstPart = notification.kind !== "progress" && (notification.part?.index ?? 1) === 1;
  if ((firstPart ? notification.id !== notification.source.id : notification.id === notification.source.id) ||
      notification.kind !== "progress" && notification.part && notification.part.index > notification.part.total ||
      notification.expiresAt - notification.createdAt !== NOTIFICATION_TTL_MS ||
      (!notification.text.trim() && (notification.kind === "progress" || !notification.part || notification.part.total === 1)) ||
      Buffer.byteLength(notification.text, "utf8") > NOTIFICATION_TEXT_BYTES ||
      (notification.lastDeferredAttemptId === undefined) !== (notification.lastDeferReason === undefined) ||
      notification.attemptId !== undefined && notification.attemptId === notification.lastDeferredAttemptId ||
      (notification.status === "pending" ? attemptId !== undefined || attemptedAt !== undefined || attemptExpiresAt !== undefined :
        !attemptId || attemptedAt === undefined || attemptExpiresAt === undefined || attemptedAt < notification.createdAt ||
        attemptedAt >= notification.expiresAt || ![NOTIFICATION_ATTEMPT_MS, LEGACY_NOTIFICATION_ATTEMPT_MS]
          .some(duration => attemptExpiresAt === Math.min(notification.expiresAt, attemptedAt + duration)))) {
    throw new Error("Invalid persisted notification identity or attempt");
  }
  // Schema parsing creates fresh nested objects; immutable text must not be copied again.
  return notification;
}

export function createTerminalNotification(execution: ExecutionRecord, now: number, commands: readonly CommandRecord[] = []): StoredNotification | null {
  const notifications = createTerminalNotifications(execution, now, commands);
  if (notifications.length > 1) throw new Error("Multipart terminal notifications require atomic array publication");
  return notifications[0] ?? null;
}

function terminalParts(source: NotificationSource, chatId: string, kind: string, chunks: Iterable<string>, now: number): StoredNotification[] {
  const parts = splitNotificationTextChunks(chunks);
  return parts.map((text, index) => normalizeNotification({ id: index === 0 ? source.id : randomUUID(), source, chatId, kind, text,
    ...(parts.length > 1 ? { part: { index: index + 1, total: parts.length } } : {}),
    createdAt: now, expiresAt: now + NOTIFICATION_TTL_MS, status: "pending" }));
}

export function createTerminalNotifications(execution: ExecutionRecord, now: number, commands: readonly CommandRecord[] = []): StoredNotification[] {
  validateNotificationTime(now);
  if (!["completed", "failed", "expired"].includes(execution.status)) return [];
  if (now < execution.createdAt) throw new Error("Notification clock precedes execution creation");
  const kind = execution.status as z.infer<typeof PlanNotificationKindSchema>;
  return terminalParts({ type: "plan", id: execution.id }, execution.chatId, kind, planNotificationChunks(execution, commands), now);
}

export function createGoalNotifications(current: GoalRecord, next: GoalRecord, now: number, commands: readonly CommandRecord[] = []): StoredNotification[] {
  validateNotificationTime(now);
  if (current.status !== "active" || !["completed", "blocked", "expired"].includes(next.status)) return [];
  if (current.id !== next.id || current.chatId !== next.chatId || now < next.createdAt) throw new Error("Invalid goal notification transition");
  const kind = next.status as z.infer<typeof GoalNotificationKindSchema>;
  return terminalParts({ type: "goal", id: next.id }, next.chatId, kind, goalResultNotificationChunks(next, commands), now);
}

export function terminalNotificationPartEligible(notification: StoredNotification, notifications: readonly StoredNotification[]): boolean {
  if (notification.kind === "progress" || !notification.part || notification.part.index === 1) return true;
  for (let index = 1; index < notification.part.index; index++) {
    if (!notifications.some(previous => previous.source.type === notification.source.type && previous.source.id === notification.source.id &&
      previous.kind !== "progress" && previous.kind === notification.kind && previous.part?.index === index &&
      previous.part.total === notification.part!.total && previous.status === "accepted")) return false;
  }
  return true;
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
  if (notification.status !== "pending" || notification.expiresAt <= now || now < notification.createdAt ||
      notification.lastDeferredAttemptId === attemptId || !chatIds.includes(notification.chatId)) {
    throw new ConflictError("Notification cannot be claimed");
  }
  return normalizeNotification({ ...notification, status: "claimed", attemptId, attemptedAt: now,
    attemptExpiresAt: Math.min(notification.expiresAt, now + NOTIFICATION_ATTEMPT_MS) });
}

/** A gateway may release only a known idle attempt; unknown delivery outcomes remain permanent. */
export function deferNotificationRecord(value: StoredNotification, attemptId: string, reason: NotificationDeferReason,
  now: number): StoredNotification {
  NotificationIdSchema.parse(attemptId);
  NotificationDeferReasonSchema.parse(reason);
  validateNotificationTime(now);
  const notification = normalizeNotification(value);
  if (notification.expiresAt <= now || now < notification.createdAt) throw new ConflictError("Notification cannot be deferred");
  if (notification.status === "pending" && notification.lastDeferredAttemptId === attemptId && notification.lastDeferReason === reason) {
    return notification;
  }
  if (notification.status !== "claimed" || notification.attemptId !== attemptId ||
      now < notification.attemptedAt! || notification.attemptExpiresAt! <= now) {
    throw new ConflictError("Notification defer does not match an active attempt");
  }
  const { attemptId: _attemptId, attemptedAt: _attemptedAt, attemptExpiresAt: _attemptExpiresAt, ...retained } = notification;
  return normalizeNotification({ ...retained, status: "pending", lastDeferredAttemptId: attemptId, lastDeferReason: reason });
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
