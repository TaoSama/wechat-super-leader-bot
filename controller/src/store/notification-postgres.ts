import type pg from "pg";
import { normalizeNotification, readNotification, claimNotificationRecord, receiptNotificationRecord,
  NotificationIdSchema, NotificationReceiptStatusSchema, validateNotificationTime, NOTIFICATION_BATCH_LIMIT,
  terminalNotificationPartEligible, NOTIFICATION_PART_LIMIT,
  type Notification, type StoredNotification, type NotificationReceiptStatus } from "../notifications/contracts.js";
import { executionListQuery } from "./execution-list.js";
import { ConflictError } from "./interface.js";
import { lockNotificationSource } from "./notification-source-postgres.js";
import { progressNotificationEligible } from "../notifications/progress.js";

export interface NotificationRow {
  id: string; execution_id: string | null; goal_id: string | null; chat_id: string; kind: string; status: string;
  created_at: string | number; expires_at: string | number; data: unknown;
}

export function notificationFromRow(row: NotificationRow): StoredNotification {
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
    execution_id VARCHAR(36) COLLATE "C" REFERENCES leader_executions(id),
    goal_id VARCHAR(36) COLLATE "C" REFERENCES leader_goals(id),
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
  await client.query("ALTER TABLE leader_notifications DROP CONSTRAINT IF EXISTS leader_notifications_execution_id_key");
  await client.query("ALTER TABLE leader_notifications DROP CONSTRAINT IF EXISTS leader_notifications_goal_id_key");
  await client.query("DROP INDEX IF EXISTS leader_notifications_execution_id_key");
  await client.query("DROP INDEX IF EXISTS leader_notifications_goal_id_key");
  await client.query("ALTER TABLE leader_notifications DROP CONSTRAINT IF EXISTS leader_notifications_source_check");
  await client.query(`ALTER TABLE leader_notifications ADD CONSTRAINT leader_notifications_source_check
    CHECK ((execution_id IS NULL) <> (goal_id IS NULL) AND
      ((kind='progress' AND id<>COALESCE(execution_id,goal_id)) OR (kind<>'progress' AND
        ((COALESCE((data->'part'->>'index')::int,1)=1 AND id=COALESCE(execution_id,goal_id)) OR
         (COALESCE((data->'part'->>'index')::int,1)>1 AND id<>COALESCE(execution_id,goal_id))))))`);
  await client.query("ALTER TABLE leader_notifications DROP CONSTRAINT IF EXISTS leader_notifications_kind_check");
  await client.query(`ALTER TABLE leader_notifications ADD CONSTRAINT leader_notifications_kind_check
    CHECK ((execution_id IS NOT NULL AND kind IN ('progress','completed','failed','expired')) OR
           (goal_id IS NOT NULL AND kind IN ('progress','completed','blocked','expired')))`);
  await client.query("ALTER TABLE leader_notifications DROP CONSTRAINT IF EXISTS leader_notifications_progress_check");
  await client.query(`ALTER TABLE leader_notifications ADD CONSTRAINT leader_notifications_progress_check
    CHECK (kind<>'progress' OR COALESCE((data->'progress'->>'sequence' IN ('1','2','3') AND
      length(data->'progress'->>'eventKey') BETWEEN 1 AND 256),false))`);
  await client.query("ALTER TABLE leader_notifications DROP CONSTRAINT IF EXISTS leader_notifications_part_check");
  await client.query(`ALTER TABLE leader_notifications ADD CONSTRAINT leader_notifications_part_check
    CHECK (NOT (data ? 'part') OR (kind<>'progress' AND COALESCE(
      ((data->'part'->>'index')::int BETWEEN 1 AND (data->'part'->>'total')::int AND
       (data->'part'->>'total')::int BETWEEN 1 AND ${NOTIFICATION_PART_LIMIT}),false)))`);
  await client.query("ALTER TABLE leader_notifications DROP CONSTRAINT IF EXISTS leader_notifications_goal_id_fkey");
  await client.query("ALTER TABLE leader_notifications ADD CONSTRAINT leader_notifications_goal_id_fkey FOREIGN KEY (goal_id) REFERENCES leader_goals(id)");
  for (const column of ["execution_id", "goal_id"]) {
    await client.query(`DROP INDEX IF EXISTS leader_notifications_${column}_terminal_key`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS leader_notifications_${column}_terminal_key
      ON leader_notifications (${column},(COALESCE(data->'part'->>'index','1'))) WHERE kind<>'progress'`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS leader_notifications_${column}_progress_sequence_key
      ON leader_notifications (${column},(data->'progress'->>'sequence')) WHERE kind='progress'`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS leader_notifications_${column}_progress_event_key
      ON leader_notifications (${column},(data->'progress'->>'eventKey')) WHERE kind='progress'`);
  }
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
      AND (kind<>'progress' OR
        (execution_id IS NOT NULL AND EXISTS (SELECT 1 FROM leader_executions e WHERE e.id=execution_id AND e.status='active' AND (e.data->>'expiresAt')::bigint>$2)) OR
        (goal_id IS NOT NULL AND EXISTS (SELECT 1 FROM leader_goals g WHERE g.id=goal_id AND g.status='active' AND (g.data->>'expiresAt')::bigint>$2)))
      AND NOT EXISTS (SELECT 1 FROM generate_series(1,COALESCE((leader_notifications.data->'part'->>'index')::int,1)-1) AS preceding(part_index)
        WHERE NOT EXISTS (SELECT 1 FROM leader_notifications p
          WHERE p.execution_id IS NOT DISTINCT FROM leader_notifications.execution_id
            AND p.goal_id IS NOT DISTINCT FROM leader_notifications.goal_id AND p.kind=leader_notifications.kind
            AND (p.data->'part'->>'index')::int=preceding.part_index
            AND p.data->'part'->>'total'=leader_notifications.data->'part'->>'total' AND p.status='accepted'))
    ORDER BY (kind='progress') ASC,created_at ASC,COALESCE((data->'part'->>'index')::int,1) ASC,id ASC LIMIT $3`, [query.chatIds, now, NOTIFICATION_BATCH_LIMIT]);
  return result.rows.map(row => readNotification(notificationFromRow(row), now));
}

export async function pgGetNotification(pool: pg.Pool, id: string, now: number): Promise<Notification | null> {
  NotificationIdSchema.parse(id);
  validateNotificationTime(now);
  const result = await pool.query<NotificationRow>("SELECT * FROM leader_notifications WHERE id=$1", [id]);
  return result.rows.length ? readNotification(notificationFromRow(result.rows[0]), now) : null;
}

async function updateNotification(pool: pg.Pool, id: string, now: number,
  update: (current: StoredNotification) => StoredNotification,
  beforeLock?: (client: pg.PoolClient) => Promise<void>): Promise<Notification | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await beforeLock?.(client);
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
  const found = await pool.query<NotificationRow>("SELECT * FROM leader_notifications WHERE id=$1", [id]);
  if (!found.rows.length) return null;
  const snapshot = notificationFromRow(found.rows[0]);
  return updateNotification(pool, id, now, current => claimNotificationRecord(current, attemptId, query.chatIds, now),
    snapshot.kind === "progress" || snapshot.part && snapshot.part.index > 1 ? async client => {
      const record = await lockNotificationSource(client, snapshot.source);
      if (!record || !progressNotificationEligible(snapshot, record, now)) throw new ConflictError("Progress notification source is no longer active");
      if (snapshot.kind !== "progress") {
        const column = snapshot.source.type === "plan" ? "execution_id" : "goal_id";
        const previous = await client.query<NotificationRow>(`SELECT * FROM leader_notifications WHERE ${column}=$1 ORDER BY created_at ASC,id ASC`, [snapshot.source.id]);
        if (!terminalNotificationPartEligible(snapshot, previous.rows.map(notificationFromRow))) throw new ConflictError("Previous terminal notification part is not accepted");
      }
    } : undefined);
}

export async function pgRecordNotificationReceipt(pool: pg.Pool, id: string, attemptId: string, status: NotificationReceiptStatus, now: number): Promise<Notification | null> {
  NotificationIdSchema.parse(id);
  NotificationIdSchema.parse(attemptId);
  NotificationReceiptStatusSchema.parse(status);
  validateNotificationTime(now);
  return updateNotification(pool, id, now, current => receiptNotificationRecord(current, attemptId, status, now));
}
