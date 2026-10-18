import type pg from "pg";
import { normalizeExecution } from "../leader/plans/execution.js";
import { normalizeGoal } from "../leader/goals/goal.js";
import { NotificationSourceSchema, type NotificationSource } from "../notifications/contracts.js";
import type { NotificationSourceRecord } from "../notifications/progress.js";

/** Use the same source-first lock order as terminal outbox publication. */
export async function lockNotificationSource(client: pg.PoolClient, source: NotificationSource): Promise<NotificationSourceRecord | null> {
  NotificationSourceSchema.parse(source);
  const table = source.type === "plan" ? "leader_executions" : "leader_goals";
  const result = await client.query<{ id: string; chat_id: string; revision: string | number; status: string;
    created_at: string | number; data: unknown }>(`SELECT * FROM ${table} WHERE id=$1 FOR UPDATE`, [source.id]);
  const row = result.rows[0];
  if (!row) return null;
  const data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
  const record = source.type === "plan" ? normalizeExecution(data) : normalizeGoal(data);
  if (record.id !== row.id || record.chatId !== row.chat_id || record.revision !== Number(row.revision) ||
      record.status !== row.status || record.createdAt !== Number(row.created_at)) throw new Error("Notification source row metadata mismatch");
  return record;
}
