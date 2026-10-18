import type pg from "pg";
import { normalizeExecution, validateExecutionUpdate, executionPageLimit, EXECUTION_PAGE_SIZE,
  type CreateExecutionResult, type ExecutionRecord } from "../leader/plans/execution.js";
import { validateChatId, validateExpectedRevision } from "../leader/state.js";
import { ConflictError } from "./interface.js";
import { executionListQuery } from "./execution-list.js";
import { createTerminalNotifications, validateNotificationTime } from "../notifications/contracts.js";
import { insertTerminalNotification } from "./notification-postgres.js";
import { notificationCommands, planNotificationRequestIds, type NotificationCommandReader } from "../notifications/presentation.js";
import { lockChatAuthorization } from "./goal-postgres.js";
import { assertExecutionConfirmation, normalizeExecutionConfirmation,
  type ExecutionConfirmationAuthority } from "../leader/plans/confirmation.js";

type ExecutionQueryClient = Pick<pg.Pool, "query">;

interface ExecutionRow {
  id: string;
  chat_id: string;
  revision: string | number;
  status: string;
  data: unknown;
  created_at: string | number;
}

function executionFromRow(row: ExecutionRow): ExecutionRecord {
  const data = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
  const execution = normalizeExecution(data);
  if (execution.id !== row.id || execution.chatId !== row.chat_id || execution.revision !== Number(row.revision) ||
      execution.status !== row.status || execution.createdAt !== Number(row.created_at)) {
    throw new Error("Execution row metadata does not match its record");
  }
  return structuredClone(execution);
}

export async function initExecutionTables(client: pg.PoolClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS leader_executions (
    id VARCHAR(36) COLLATE "C" PRIMARY KEY,
    chat_id VARCHAR(64) NOT NULL,
    revision BIGINT NOT NULL CHECK (revision >= 1),
    status VARCHAR(16) NOT NULL CHECK (status IN ('active','completed','failed','cancelled','expired')),
    data JSONB NOT NULL,
    created_at BIGINT NOT NULL
  )`);
  await client.query("ALTER TABLE leader_executions ADD COLUMN IF NOT EXISTS console_hidden_at TIMESTAMPTZ");
  await client.query("CREATE UNIQUE INDEX IF NOT EXISTS leader_executions_active_chat_idx ON leader_executions (chat_id) WHERE status='active'");
  await client.query("CREATE INDEX IF NOT EXISTS leader_executions_active_id_idx ON leader_executions (id) WHERE status='active'");
  await client.query("CREATE INDEX IF NOT EXISTS leader_executions_chat_recent_idx ON leader_executions (chat_id, (status='active') DESC, created_at DESC, id DESC)");
}

export async function pgConfirmExecution(pool: pg.Pool, record: ExecutionRecord,
  authority: ExecutionConfirmationAuthority, now = Date.now): Promise<CreateExecutionResult> {
  const input = normalizeExecutionConfirmation(record, authority);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ chat_id: string; revision: number; data: unknown }>(
      "SELECT chat_id,revision,data FROM leader_states WHERE chat_id=$1 FOR UPDATE", [input.record.chatId]);
    const row = result.rows[0];
    let data: unknown = row?.data;
    if (typeof data === "string") {
      try { data = JSON.parse(data); }
      catch { throw new ConflictError("Invalid persisted execution confirmation authority"); }
    }
    const state = row ? { chatId: row.chat_id, revision: Number(row.revision), data: data as Record<string, unknown> } : null;
    assertExecutionConfirmation(input.record, input.authority, state, now());
    const created = await pgCreateExecutionIfAbsent(client, input.record);
    // INSERT/unique-index waits can outlive the claim while the state row stays locked.
    // Recheck before issuing COMMIT; expired inserts remain invisible and roll back.
    assertExecutionConfirmation(input.record, input.authority, state, now());
    await client.query("COMMIT");
    return created;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function pgCreateExecutionIfAbsent(pool: ExecutionQueryClient, record: ExecutionRecord): Promise<CreateExecutionResult> {
  const normalized = structuredClone(normalizeExecution(record));
  if (normalized.revision !== 1 || normalized.status !== "active" || normalized.attempts.some(attempt => attempt !== null)) {
    throw new Error("New executions must be active, unclaimed revision one records");
  }
  await lockChatAuthorization(pool, normalized.chatId);
  const previous = await pgGetExecution(pool, normalized.id);
  if (previous) {
    if (previous.chatId !== normalized.chatId || JSON.stringify(previous.plan) !== JSON.stringify(normalized.plan)) {
      throw new ConflictError("Execution ID already used with different chat or plan");
    }
    return { created: false, execution: previous };
  }
  const occupied = await pool.query("SELECT id FROM leader_goals WHERE chat_id=$1 AND status IN ('active','blocked') LIMIT 1", [normalized.chatId]);
  if (occupied.rows.length) throw new ConflictError("Chat already has an open goal");
  const result = await pool.query<ExecutionRow>(`INSERT INTO leader_executions
    (id,chat_id,revision,status,data,created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6)
    ON CONFLICT DO NOTHING RETURNING *`,
  [normalized.id, normalized.chatId, normalized.revision, normalized.status, JSON.stringify(normalized), normalized.createdAt]);
  if (result.rows.length) return { created: true, execution: executionFromRow(result.rows[0]) };
  const existing = await pgGetExecution(pool, normalized.id);
  if (!existing) throw new ConflictError("Chat already has an active execution");
  if (existing.chatId !== normalized.chatId || JSON.stringify(existing.plan) !== JSON.stringify(normalized.plan)) {
    throw new ConflictError("Execution ID already used with different chat or plan");
  }
  return { created: false, execution: existing };
}

export async function pgCreateLockedExecution(pool: pg.Pool, record: ExecutionRecord): Promise<CreateExecutionResult> {
  const snapshot = structuredClone(record), client = await pool.connect();
  try { await client.query("BEGIN"); const result = await pgCreateExecutionIfAbsent(client, snapshot); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function pgGetExecution(pool: ExecutionQueryClient, id: string): Promise<ExecutionRecord | null> {
  const result = await pool.query<ExecutionRow>("SELECT * FROM leader_executions WHERE id=$1", [id]);
  return result.rows.length ? executionFromRow(result.rows[0]) : null;
}

export async function pgGetLatestExecution(pool: pg.Pool, chatId: string): Promise<ExecutionRecord | null> {
  validateChatId(chatId);
  const result = await pool.query<ExecutionRow>(`SELECT * FROM leader_executions WHERE chat_id=$1
    ORDER BY (status='active') DESC, created_at DESC, id DESC LIMIT 1`, [chatId]);
  return result.rows.length ? executionFromRow(result.rows[0]) : null;
}

export async function pgCompareAndSetExecution(pool: pg.Pool, next: ExecutionRecord, expectedRevision: number, now = Date.now(),
  commandReader?: (client: pg.PoolClient) => NotificationCommandReader): Promise<ExecutionRecord | null> {
  validateNotificationTime(now);
  validateExpectedRevision(expectedRevision);
  const normalized = structuredClone(normalizeExecution(next));
  if (normalized.revision !== expectedRevision + 1) throw new Error("Execution revision must increment by one");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<ExecutionRow>("SELECT * FROM leader_executions WHERE id=$1 FOR UPDATE", [normalized.id]);
    const current = result.rows.length ? executionFromRow(result.rows[0]) : null;
    if (!current || current.revision !== expectedRevision || current.status !== "active") {
      await client.query("COMMIT");
      return null;
    }
    validateExecutionUpdate(current, normalized);
    const updated = await client.query<ExecutionRow>(`UPDATE leader_executions SET revision=$2,status=$3,data=$4::jsonb
      WHERE id=$1 AND revision=$5 RETURNING *`,
    [normalized.id, normalized.revision, normalized.status, JSON.stringify(normalized), expectedRevision]);
    const execution = updated.rows.length ? executionFromRow(updated.rows[0]) : null;
    const commands = execution && commandReader && ["completed", "failed", "expired"].includes(execution.status) ?
      await notificationCommands(commandReader(client), planNotificationRequestIds(execution)) : [];
    const notifications = execution ? createTerminalNotifications(execution, now, commands) : [];
    for (const notification of notifications) await insertTerminalNotification(client, notification);
    await client.query("COMMIT");
    return execution;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function pgListActiveExecutions(pool: pg.Pool, limit = EXECUTION_PAGE_SIZE, afterId = ""): Promise<ExecutionRecord[]> {
  const result = await pool.query<ExecutionRow>(`SELECT * FROM leader_executions
    WHERE status='active' AND id>$1 ORDER BY id ASC LIMIT $2`, [afterId, executionPageLimit(limit)]);
  return result.rows.map(executionFromRow);
}

export async function pgListRecentExecutions(pool: pg.Pool, chatIds: readonly string[], limit: number): Promise<ExecutionRecord[]> {
  const query = executionListQuery(chatIds, limit);
  if (!query.chatIds.length) return [];
  const result = await pool.query<ExecutionRow>(`SELECT * FROM leader_executions WHERE chat_id=ANY($1::text[])
    AND (console_hidden_at IS NULL OR status NOT IN ('completed','failed','cancelled','expired'))
    ORDER BY (status='active') DESC, created_at DESC, id DESC LIMIT $2`, [query.chatIds, query.count]);
  return result.rows.map(executionFromRow);
}
