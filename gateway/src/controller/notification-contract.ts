export const NOTIFICATION_LIMIT = 1;
export const NOTIFICATION_CHAT_LIMIT = 128;
export const NOTIFICATION_TEXT_LIMIT = 8 * 1024 * 1024;
export const NOTIFICATION_TEXT_BYTES = 8 * 1024 * 1024;
export const NOTIFICATION_PROGRESS_LIMIT = 3;
export const NOTIFICATION_EVENT_KEY_LIMIT = 256;
export const NOTIFICATION_PART_LIMIT = 128;
export const NOTIFICATION_TIMEOUT_MS = 10_000;
export const NOTIFICATION_RECEIPT_RETRIES = 2;
const JSON_ESCAPE_BYTES = 6;
const NOTIFICATION_RESPONSE_METADATA_BYTES = 64 * 1024;
export const NOTIFICATION_RESPONSE_BYTES = NOTIFICATION_LIMIT * NOTIFICATION_TEXT_BYTES * JSON_ESCAPE_BYTES + NOTIFICATION_RESPONSE_METADATA_BYTES;
export const NOTIFICATION_ATTEMPT_MS = 30 * 60_000;
export const LEGACY_NOTIFICATION_ATTEMPT_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
export type NotificationDeferReason = "budget_exhausted" | "window_expired" | "context_changed";
const DEFER_REASONS: readonly NotificationDeferReason[] = ["budget_exhausted", "window_expired", "context_changed"];

export interface Notification {
  id: string;
  source: { type: "plan" | "goal"; id: string };
  chatId: string;
  kind: "completed" | "failed" | "blocked" | "expired" | "progress";
  progress?: { sequence: number; eventKey: string };
  part?: { index: number; total: number };
  text: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "claimed" | "accepted" | "uncertain" | "expired";
  attemptId?: string;
  attemptedAt?: number;
  attemptExpiresAt?: number;
  lastDeferredAttemptId?: string;
  lastDeferReason?: NotificationDeferReason;
}
export interface NotificationDeliverySummary { accepted: number; uncertain: number; skipped: number }
function invalid(): never { throw new Error("Controller notification response schema invalid"); }
export function notificationUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) return invalid();
  return value;
}
export function notificationDeferReason(value: unknown): NotificationDeferReason {
  if (typeof value !== "string" || !DEFER_REASONS.includes(value as NotificationDeferReason)) return invalid();
  return value as NotificationDeferReason;
}
export function notificationObject(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !fields.includes(key))) return invalid();
  return record;
}
function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_TIMESTAMP) return invalid();
  return value;
}
export function parseNotification(raw: unknown): Notification {
  const value = notificationObject(raw, ["id", "source", "chatId", "kind", "progress", "part", "text", "createdAt", "expiresAt", "status", "attemptId", "attemptedAt", "attemptExpiresAt", "lastDeferredAttemptId", "lastDeferReason"]);
  const id = notificationUuid(value.id), source = notificationObject(value.source, ["type", "id"]);
  const sourceId = notificationUuid(source.id);
  if (source.type !== "plan" && source.type !== "goal") return invalid();
  const kinds = source.type === "plan" ? ["completed", "failed", "expired", "progress"] : ["completed", "blocked", "expired", "progress"];
  if (typeof value.chatId !== "string" || !value.chatId.trim() ||
      typeof value.text !== "string" || !value.text.length || value.text.length > NOTIFICATION_TEXT_LIMIT || Buffer.byteLength(value.text, "utf8") > NOTIFICATION_TEXT_BYTES ||
      typeof value.kind !== "string" || !kinds.includes(value.kind) ||
      typeof value.status !== "string" || !["pending", "claimed", "accepted", "uncertain", "expired"].includes(value.status)) return invalid();
  let progress: Pick<Notification, "progress"> = {}, part: Pick<Notification, "part"> = {};
  if (value.kind === "progress") {
    if (id === sourceId || Object.hasOwn(value, "part")) return invalid();
    const details = notificationObject(value.progress, ["sequence", "eventKey"]);
    if (typeof details.sequence !== "number" || !Number.isInteger(details.sequence) || details.sequence < 1 || details.sequence > NOTIFICATION_PROGRESS_LIMIT ||
        typeof details.eventKey !== "string" || details.eventKey.length < 1 || details.eventKey.length > NOTIFICATION_EVENT_KEY_LIMIT) return invalid();
    progress = { progress: { sequence: details.sequence, eventKey: details.eventKey } };
  } else {
    if (Object.hasOwn(value, "progress")) return invalid();
    if (Object.hasOwn(value, "part")) {
      const details = notificationObject(value.part, ["index", "total"]);
      if (typeof details.index !== "number" || !Number.isInteger(details.index) || details.index < 1 ||
          typeof details.total !== "number" || !Number.isInteger(details.total) || details.total < 1 || details.total > NOTIFICATION_PART_LIMIT ||
          details.index > details.total) return invalid();
      part = { part: { index: details.index, total: details.total } };
    }
    if ((part.part?.index ?? 1) === 1 ? id !== sourceId : id === sourceId) return invalid();
  }
  if (!value.text.trim() && (value.kind === "progress" || (part.part?.total ?? 1) === 1)) return invalid();
  const createdAt = timestamp(value.createdAt), expiresAt = timestamp(value.expiresAt);
  if (expiresAt <= createdAt) return invalid();
  let deferred: Pick<Notification, "lastDeferredAttemptId" | "lastDeferReason"> = {};
  if (Object.hasOwn(value, "lastDeferredAttemptId") || Object.hasOwn(value, "lastDeferReason")) {
    deferred = { lastDeferredAttemptId: notificationUuid(value.lastDeferredAttemptId), lastDeferReason: notificationDeferReason(value.lastDeferReason) };
  }
  const hasAttempt = ["attemptId", "attemptedAt", "attemptExpiresAt"].some(field => Object.hasOwn(value, field));
  let attempt: Pick<Notification, "attemptId" | "attemptedAt" | "attemptExpiresAt"> = {};
  if (hasAttempt) {
    const attemptId = notificationUuid(value.attemptId), attemptedAt = timestamp(value.attemptedAt), attemptExpiresAt = timestamp(value.attemptExpiresAt);
    if (attemptId === deferred.lastDeferredAttemptId || attemptedAt < createdAt || attemptExpiresAt <= attemptedAt || attemptExpiresAt > expiresAt ||
        ![NOTIFICATION_ATTEMPT_MS, LEGACY_NOTIFICATION_ATTEMPT_MS].some(duration => attemptExpiresAt === Math.min(expiresAt, attemptedAt + duration))) return invalid();
    attempt = { attemptId, attemptedAt, attemptExpiresAt };
  }
  if (["pending", "expired"].includes(value.status) ? hasAttempt : !hasAttempt) return invalid();
  return { id, source: { type: source.type, id: sourceId }, chatId: value.chatId, kind: value.kind as Notification["kind"], text: value.text,
    createdAt, expiresAt, status: value.status as Notification["status"], ...progress, ...part, ...attempt, ...deferred };
}
export function sameNotification(a: Notification, b: Notification): boolean {
  return a.id === b.id && a.source.type === b.source.type && a.source.id === b.source.id && a.chatId === b.chatId && a.kind === b.kind &&
    a.text === b.text && a.createdAt === b.createdAt && a.expiresAt === b.expiresAt &&
    a.progress?.sequence === b.progress?.sequence && a.progress?.eventKey === b.progress?.eventKey &&
    (a.part?.index ?? 1) === (b.part?.index ?? 1) && (a.part?.total ?? 1) === (b.part?.total ?? 1);
}
