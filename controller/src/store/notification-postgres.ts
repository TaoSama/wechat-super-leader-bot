import type pg from "pg";
import { normalizeNotification, readNotification, claimNotificationRecord, receiptNotificationRecord,
  NotificationIdSchema, NotificationReceiptStatusSchema, validateNotificationTime, NOTIFICATION_BATCH_LIMIT,
  type Notification, type StoredNotification, type NotificationReceiptStatus } from "../notifications.js";
import { executionListQuery } from "./execution-list.js";

interface NotificationRow {
  id: string; execution_id: string | null; goal_id: string | null; chat_id: string; kind: string; status: string;
  created_at: string | number; expires_at: string | number; data: unknown;
}

function notificationFromRow(row: NotificationRow): StoredNotification {
  const notification = normalizeNotification(typeof row.data === "string" ? JSON.parse(row.data) : row.data);
  const executionId = notification.source.type === "plan" ? notification.source.id : null;
  const goalId = notification.source.type === "goal" ? notification.source.id : null;
  if (notification.id !== row.id || executionId !== row.execution_id || goalId !== row.goal_id || notification.chatId !== row.chat_id ||
      notification.kind !== row.kind || notification.status !== row.status || notification.createdAt !== Number(row.created_at) ||
      notification.expiresAt !== Number(row.expires_at)) throw new Error("Notification row metadata does not match its record");
  return notification;
}

export async function initNotificationTables(client: pg.PoolClient): Promise<void> {
  // The caller owns the initialization transaction and creates both source
  // tables first. Unqualified names respect that connection's search_path.
  await client.query(`CREATE TABLE IF NOT EXISTS leader_notifications (
    id VARCHAR(36) COLLATE "C" PRIMARY KEY,
    execution_id VARCHAR(36) COLLATE "C" UNIQUE REFERENCES leader_executions(id),
    goal_id VARCHAR(36) COLLATE "C" UNIQUE REFERENCES leader_goals(id),
    chat_id VARCHAR(64) NOT NULL,
    kind VARCHAR(16) NOT NULL,
    status VARCHAR(16) NOT NULL CHECK (status IN ('pending','claimed','accepted','uncertain')),
    created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, data JSONB NOT NULL
  )`);
  await client.query("ALTER TABLE leader_notifications ALTER COLUMN execution_id DROP NOT NULL");
  await client.query('ALTER TABLE leader_notifications ADD COLUMN IF NOT EXISTS goal_id VARCHAR(36) COLLATE "C"');
  // Validate before conversion, never silently discard an unknown field or
  // repair forged metadata. Any invalid row aborts the whole caller transaction.
  const existing = await client.query<NotificationRow>("SELECT * FROM leader_notifications ORDER BY id FOR UPDATE");
  for (const row of existing.rows) {
    const data: unknown = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
    if (data !== null && typeof data === "object" && !Array.isArray(data) && Object.hasOwn(data, "executionId")) {
      const legacy = data as Record<string, unknown>;
      if (Object.hasOwn(legacy, "source")) throw new Error("Mixed legacy notification source");
      const { executionId, ...retained } = legacy;
      const converted = { ...retained, source: { type: "plan", id: executionId } };
      notificationFromRow({ ...row, data: converted });
      const saved = await client.query<NotificationRow>("UPDATE leader_notifications SET data=$2::jsonb WHERE id=$1 RETURNING *",
        [row.id, JSON.stringify(converted)]);
      if (saved.rows.length !== 1) throw new Error("Notification migration lost its locked record");
      notificationFromRow(saved.rows[0]);
    } else {
      notificationFromRow(row);
    }
  }
  await client.query("ALTER TABLE leader_notifications DROP CONSTRAINT IF EXISTS leader_notifications_check");
  await client.query("ALTER TABLE leader_notifications DROP CONSTRAINT IF EXISTS leader_notifications_source_check");
  await client.query(`ALTER TABLE leader_notifications ADD CONSTRAINT leader_notifications_source_check
    CHECK ((execution_id IS NULL) <> (goal_id IS NULL) AND id=COALESCE(execution_id,goal_id))`);
  await client.query("ALTER TABLE leader_notifications DROP CONSTRAINT IF EXISTS leader_notifications_kind_check");
  await client.query(`ALTER TABLE leader_notifications ADD CONSTRAINT leader_notifications_kind_check
    CHECK ((execution_id IS NOT NULL AND kind IN ('completed','failed','expired')) OR
           (goal_id IS NOT NULL AND kind IN ('completed','blocked','expired')))`);
  await client.query("ALTER TABLE leader_notifications DROP CONSTRAINT IF EXISTS leader_notifications_goal_id_fkey");
  await client.query("ALTER TABLE leader_notifications ADD CONSTRAINT leader_notifications_goal_id_fkey FOREIGN KEY (goal_id) REFERENCES leader_goals(id)");
  await client.query("CREATE UNIQUE INDEX IF NOT EXISTS leader_notifications_goal_id_key ON leader_notifications (goal_id)");
  await client.query("CREATE INDEX IF NOT EXISTS leader_notifications_pending_idx ON leader_notifications (chat_id, created_at, id) WHERE status='pending'");
}

export async function insertTerminalNotification(client: pg.PoolClient, value: StoredNotification): Promise<void> {
  const notification = normalizeNotification(value);
  await client.query(`INSERT INTO leader_notifications (id,execution_id,goal_id,chat_id,kind,status,created_at,expires_at,data)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`, [notification.id,
    notification.source.type === "plan" ? notification.source.id : null,
    notification.source.type === "goal" ? notification.source.id : null, notification.chatId,
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
