import type pg from "pg";
import { NotificationIdSchema, NotificationSourceSchema, validateNotificationTime,
  type NotificationSource, type StoredNotification } from "../notifications/contracts.js";
import { TERMINAL_RESULT_TTL_MS, PROGRESS_RESULT_TTL_MS, RESULT_COLLECTOR_BATCH_SIZE } from "../notifications/result-collector.js";
import { executionListQuery } from "./execution-list.js";
import { notificationFromRow, type NotificationRow } from "./notification-postgres.js";
import { ConflictError } from "./interface.js";

/** Conversion markers belong to the original outbox and need no delivery tables. */
export async function initNotificationCandidateState(pool: Pick<pg.PoolClient, "query">): Promise<void> {
  await pool.query("ALTER TABLE leader_notifications ADD COLUMN IF NOT EXISTS result_delivery_id UUID");
  await pool.query(`CREATE INDEX IF NOT EXISTS leader_notifications_unprepared_idx ON leader_notifications (chat_id,id)
    WHERE status='pending' AND result_delivery_id IS NULL`);
}

export async function pgListNotificationCandidates(pool: pg.Pool, chatIds: readonly string[], now: number,
  afterId = "", limit = RESULT_COLLECTOR_BATCH_SIZE): Promise<StoredNotification[]> {
  validateNotificationTime(now);
  if (afterId) NotificationIdSchema.parse(afterId);
  const query = executionListQuery(chatIds, limit);
  if (!query.chatIds.length) return [];
  const result = await pool.query<NotificationRow>(`SELECT n.* FROM leader_notifications n
    WHERE n.chat_id=ANY($1::text[]) AND n.status='pending' AND n.id>$3 AND n.created_at<=$2 AND n.result_delivery_id IS NULL
      AND ((n.kind<>'progress' AND COALESCE((n.data->'part'->>'index')::int,1)=1 AND n.created_at>$5)
        OR (n.kind='progress' AND n.created_at>$6 AND n.expires_at>$2
          AND ((n.execution_id IS NOT NULL AND EXISTS (SELECT 1 FROM leader_executions e
            WHERE e.id=n.execution_id AND e.chat_id=n.chat_id AND e.status='active' AND (e.data->>'expiresAt')::bigint>$2))
            OR (n.goal_id IS NOT NULL AND EXISTS (SELECT 1 FROM leader_goals g
              WHERE g.id=n.goal_id AND g.chat_id=n.chat_id AND g.status='active' AND (g.data->>'expiresAt')::bigint>$2)))
          AND NOT EXISTS (SELECT 1 FROM leader_notifications p WHERE p.kind='progress' AND p.status='pending'
            AND p.execution_id IS NOT DISTINCT FROM n.execution_id AND p.goal_id IS NOT DISTINCT FROM n.goal_id
            AND (p.created_at>n.created_at OR (p.created_at=n.created_at AND p.id>n.id)) AND p.created_at<=$2)))
    ORDER BY n.id ASC LIMIT $4`, [query.chatIds, now, afterId, query.count,
    now - TERMINAL_RESULT_TTL_MS, now - PROGRESS_RESULT_TTL_MS]);
  return result.rows.map(notificationFromRow);
}

export async function pgMarkNotificationPrepared(pool: pg.Pool, id: string, resultId: string): Promise<void> {
  NotificationIdSchema.parse(id); NotificationIdSchema.parse(resultId);
  const marked = await pool.query(`UPDATE leader_notifications SET result_delivery_id=$2
    WHERE id=$1 AND (result_delivery_id IS NULL OR result_delivery_id=$2) RETURNING id`, [id, resultId]);
  if (marked.rowCount !== 1) throw new ConflictError("Notification result marker conflicts with its persisted source");
}

export async function pgGetNotificationParts(pool: pg.Pool, source: NotificationSource): Promise<StoredNotification[]> {
  const parsed = NotificationSourceSchema.parse(source);
  const column = parsed.type === "plan" ? "execution_id" : "goal_id";
  const result = await pool.query<NotificationRow>(`SELECT * FROM leader_notifications WHERE ${column}=$1 AND kind<>'progress'
    ORDER BY COALESCE((data->'part'->>'index')::int,1) ASC,id ASC`, [parsed.id]);
  return result.rows.map(notificationFromRow);
}
