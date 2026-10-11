import type pg from "pg";
import { normalizeNotification, readNotification, claimNotificationRecord, receiptNotificationRecord,
  NotificationIdSchema, NotificationReceiptStatusSchema, validateNotificationTime, NOTIFICATION_BATCH_LIMIT,
  type Notification, type StoredNotification, type NotificationReceiptStatus } from "../notifications.js";
import { executionListQuery } from "./execution-list.js";

interface NotificationRow {
  id: string; execution_id: string; chat_id: string; kind: string; status: string;
  created_at: string | number; expires_at: string | number; data: unknown;
}

function notificationFromRow(row: NotificationRow): StoredNotification {
  const notification = normalizeNotification(typeof row.data === "string" ? JSON.parse(row.data) : row.data);
  if (notification.id !== row.id || notification.executionId !== row.execution_id || notification.chatId !== row.chat_id ||
      notification.kind !== row.kind || notification.status !== row.status || notification.createdAt !== Number(row.created_at) ||
      notification.expiresAt !== Number(row.expires_at)) throw new Error("Notification row metadata does not match its record");
  return notification;
}

export async function initNotificationTables(client: pg.PoolClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS leader_notifications (
    id VARCHAR(36) COLLATE "C" PRIMARY KEY,
    execution_id VARCHAR(36) COLLATE "C" NOT NULL UNIQUE REFERENCES leader_executions(id),
    chat_id VARCHAR(64) NOT NULL,
    kind VARCHAR(16) NOT NULL CHECK (kind IN ('completed','failed','expired')),
    status VARCHAR(16) NOT NULL CHECK (status IN ('pending','claimed','accepted','uncertain')),
    created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, data JSONB NOT NULL,
    CHECK (id=execution_id)
  )`);
  await client.query("CREATE INDEX IF NOT EXISTS leader_notifications_pending_idx ON leader_notifications (chat_id, created_at, id) WHERE status='pending'");
}

export async function insertTerminalNotification(client: pg.PoolClient, value: StoredNotification): Promise<void> {
  const notification = normalizeNotification(value);
  await client.query(`INSERT INTO leader_notifications (id,execution_id,chat_id,kind,status,created_at,expires_at,data)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`, [notification.id, notification.executionId, notification.chatId,
    notification.kind, notification.status, notification.createdAt, notification.expiresAt, JSON.stringify(notification)]);
}

export async function pgListPendingNotifications(pool: pg.Pool, chatIds: readonly string[], now: number): Promise<Notification[]> {
  validateNotificationTime(now);
  const query = executionListQuery(chatIds, NOTIFICATION_BATCH_LIMIT);
  if (!query.chatIds.length) return [];
  const result = await pool.query<NotificationRow>(`SELECT * FROM leader_notifications
    WHERE chat_id=ANY($1::text[]) AND status='pending' AND expires_at>$2
    ORDER BY created_at ASC,id ASC LIMIT $3`, [query.chatIds, now, NOTIFICATION_BATCH_LIMIT]);
  return result.rows.map(row => readNotification(notificationFromRow(row), now));
}

export async function pgGetNotification(pool: pg.Pool, id: string, now: number): Promise<Notification | null> {
  NotificationIdSchema.parse(id);
  validateNotificationTime(now);
  const result = await pool.query<NotificationRow>("SELECT * FROM leader_notifications WHERE id=$1", [id]);
  return result.rows.length ? readNotification(notificationFromRow(result.rows[0]), now) : null;
}

async function updateNotification(pool: pg.Pool, id: string, now: number,
  update: (current: StoredNotification) => StoredNotification): Promise<Notification | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<NotificationRow>("SELECT * FROM leader_notifications WHERE id=$1 FOR UPDATE", [id]);
    if (!result.rows.length) { await client.query("COMMIT"); return null; }
    const next = update(notificationFromRow(result.rows[0]));
    const saved = await client.query<NotificationRow>("UPDATE leader_notifications SET status=$2,data=$3::jsonb WHERE id=$1 RETURNING *",
      [id, next.status, JSON.stringify(next)]);
    if (saved.rows.length !== 1) throw new Error("Notification locked update lost its record");
    const notification = readNotification(notificationFromRow(saved.rows[0]), now);
    await client.query("COMMIT");
    return notification;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function pgClaimNotification(pool: pg.Pool, id: string, attemptId: string, chatIds: readonly string[], now: number): Promise<Notification | null> {
  NotificationIdSchema.parse(id);
  NotificationIdSchema.parse(attemptId);
  validateNotificationTime(now);
  const query = executionListQuery(chatIds, NOTIFICATION_BATCH_LIMIT);
  return updateNotification(pool, id, now, current => claimNotificationRecord(current, attemptId, query.chatIds, now));
}

export async function pgRecordNotificationReceipt(pool: pg.Pool, id: string, attemptId: string, status: NotificationReceiptStatus, now: number): Promise<Notification | null> {
  NotificationIdSchema.parse(id);
  NotificationIdSchema.parse(attemptId);
  NotificationReceiptStatusSchema.parse(status);
  validateNotificationTime(now);
  return updateNotification(pool, id, now, current => receiptNotificationRecord(current, attemptId, status, now));
}
