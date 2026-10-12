export const NOTIFICATION_LIMIT = 4;
export const NOTIFICATION_CHAT_LIMIT = 128;
export const NOTIFICATION_TEXT_LIMIT = 2000;
export const NOTIFICATION_TIMEOUT_MS = 10_000;
export const NOTIFICATION_RECEIPT_RETRIES = 2;
export const NOTIFICATION_RESPONSE_BYTES = 64 * 1024;
export const NOTIFICATION_ATTEMPT_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TIMESTAMP = 8_640_000_000_000_000;

export interface Notification {
  id: string;
  source: { type: "plan" | "goal"; id: string };
  chatId: string;
  kind: "completed" | "failed" | "blocked" | "expired";
  text: string;
  createdAt: number;
  expiresAt: number;
  status: "pending" | "claimed" | "accepted" | "uncertain" | "expired";
  attemptId?: string;
  attemptedAt?: number;
  attemptExpiresAt?: number;
}
export interface NotificationDeliverySummary { accepted: number; uncertain: number; skipped: number }
function invalid(): never { throw new Error("Controller notification response schema invalid"); }
export function notificationUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) return invalid();
  return value;
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
  const value = notificationObject(raw, ["id", "source", "chatId", "kind", "text", "createdAt", "expiresAt", "status", "attemptId", "attemptedAt", "attemptExpiresAt"]);
  const id = notificationUuid(value.id), source = notificationObject(value.source, ["type", "id"]);
  const sourceId = notificationUuid(source.id);
  if (source.type !== "plan" && source.type !== "goal") return invalid();
  const kinds = source.type === "plan" ? ["completed", "failed", "expired"] : ["completed", "blocked", "expired"];
  if (id !== sourceId || typeof value.chatId !== "string" || !value.chatId.trim() ||
      typeof value.text !== "string" || !value.text.trim() || value.text.length > NOTIFICATION_TEXT_LIMIT ||
      typeof value.kind !== "string" || !kinds.includes(value.kind) ||
      typeof value.status !== "string" || !["pending", "claimed", "accepted", "uncertain", "expired"].includes(value.status)) return invalid();
  const createdAt = timestamp(value.createdAt), expiresAt = timestamp(value.expiresAt);
  if (expiresAt <= createdAt) return invalid();
  const hasAttempt = value.attemptId !== undefined || value.attemptedAt !== undefined || value.attemptExpiresAt !== undefined;
  let attempt: Pick<Notification, "attemptId" | "attemptedAt" | "attemptExpiresAt"> = {};
  if (hasAttempt) {
    const attemptId = notificationUuid(value.attemptId), attemptedAt = timestamp(value.attemptedAt), attemptExpiresAt = timestamp(value.attemptExpiresAt);
    if (attemptedAt < createdAt || attemptExpiresAt <= attemptedAt || attemptExpiresAt > expiresAt ||
        attemptExpiresAt - attemptedAt > NOTIFICATION_ATTEMPT_MS) return invalid();
    attempt = { attemptId, attemptedAt, attemptExpiresAt };
  }
  if (["pending", "expired"].includes(value.status) ? hasAttempt : !hasAttempt) return invalid();
  return { id, source: { type: source.type, id: sourceId }, chatId: value.chatId, kind: value.kind as Notification["kind"], text: value.text,
    createdAt, expiresAt, status: value.status as Notification["status"], ...attempt };
}
export function sameNotification(a: Notification, b: Notification): boolean {
  return a.id === b.id && a.source.type === b.source.type && a.source.id === b.source.id && a.chatId === b.chatId && a.kind === b.kind &&
    a.text === b.text && a.createdAt === b.createdAt && a.expiresAt === b.expiresAt;
}
