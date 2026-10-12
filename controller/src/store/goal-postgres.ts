import type pg from "pg";
import { normalizeGoal, assertGoalConfirmation, goalIsOpen, validateGoalUpdate,
  type GoalRecord, type GoalConfirmationAuthority, type CreateGoalResult } from "../leader/goal.js";
import { executionListQuery } from "./execution-list.js";
import { ConflictError } from "./interface.js";
import type { LeaderState } from "../leader/state.js";
import type { IStore } from "./interface.js";
import { validateGoalProofs } from "../leader/goal-view.js";
import { validateChatId, validateExpectedRevision } from "../leader/state.js";

export async function lockChatAuthorization(client: Pick<pg.PoolClient, "query">, chatId: string): Promise<void> {
  validateChatId(chatId);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`leader-authorization:${chatId}`]);
}
export async function initGoalTables(client: pg.PoolClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS leader_goals (
    id VARCHAR(36) COLLATE "C" PRIMARY KEY, chat_id VARCHAR(64) NOT NULL, revision BIGINT NOT NULL CHECK (revision>=1),
    status VARCHAR(16) NOT NULL CHECK (status IN ('active','blocked','completed','cancelled','expired')),
    created_at BIGINT NOT NULL, data JSONB NOT NULL)`);
  await client.query("CREATE UNIQUE INDEX IF NOT EXISTS leader_goals_open_chat_idx ON leader_goals(chat_id) WHERE status IN ('active','blocked')");
}
interface GoalRow { id: string; chat_id: string; revision: string | number; status: string; created_at: string | number; data: unknown }
function fromRow(row: GoalRow): GoalRecord {
  const goal = normalizeGoal(typeof row.data === "string" ? JSON.parse(row.data) : row.data);
  if (goal.id !== row.id || goal.chatId !== row.chat_id || goal.revision !== Number(row.revision) || goal.status !== row.status ||
    goal.createdAt !== Number(row.created_at)) throw new Error("Goal row metadata mismatch");
  return structuredClone(goal);
}
export async function pgGetGoal(pool: Pick<pg.Pool, "query">, id: string): Promise<GoalRecord | null> {
  const result = await pool.query<GoalRow>("SELECT * FROM leader_goals WHERE id=$1", [id]);
  return result.rows[0] ? fromRow(result.rows[0]) : null;
}
export async function pgConfirmGoal(pool: pg.Pool, record: GoalRecord, authority: GoalConfirmationAuthority, now = Date.now): Promise<CreateGoalResult> {
  const goal = structuredClone(normalizeGoal(record)), ownership = structuredClone(authority);
  if (goal.revision !== 1 || goal.status !== "active" || goal.actions.length || goal.decisions.length || goal.decisionAttempts || goal.lease) throw new ConflictError("Goal must be initial");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT chat_id,revision,data FROM leader_states WHERE chat_id=$1 FOR UPDATE", [goal.chatId]);
    const row = result.rows[0];
    const state: LeaderState | null = row ? { chatId: row.chat_id, revision: Number(row.revision),
      data: typeof row.data === "string" ? JSON.parse(row.data) : row.data, updatedAt: "" } : null;
    assertGoalConfirmation(goal, ownership, state, now());
    await lockChatAuthorization(client, goal.chatId);
    const existing = await pgGetGoal(client, goal.id);
    if (existing) {
      if (existing.chatId !== goal.chatId || JSON.stringify(existing.proposal) !== JSON.stringify(goal.proposal)) throw new ConflictError("Goal ID already used");
      assertGoalConfirmation(goal, ownership, state, now());
      await client.query("COMMIT");
      return { created: false, goal: existing };
    }
    const occupied = await client.query("SELECT id FROM leader_executions WHERE chat_id=$1 AND status='active' LIMIT 1", [goal.chatId]);
    const other = await client.query("SELECT id FROM leader_goals WHERE chat_id=$1 AND status IN ('active','blocked') LIMIT 1", [goal.chatId]);
    if (occupied.rows.length || other.rows.length) throw new ConflictError("Chat already has an open authorization");
    const inserted = await client.query<GoalRow>(`INSERT INTO leader_goals(id,chat_id,revision,status,created_at,data)
      VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`, [goal.id, goal.chatId, goal.revision, goal.status, goal.createdAt, JSON.stringify(goal)]);
    assertGoalConfirmation(goal, ownership, state, now());
    const saved = fromRow(inserted.rows[0]);
    await client.query("COMMIT");
    return { created: true, goal: saved };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
export async function pgCompareAndSetGoal(pool: pg.Pool, next: GoalRecord, revision: number,
  commandReader: (client: pg.PoolClient) => Pick<IStore, "findCommandByRequestId">, now = Date.now): Promise<GoalRecord | null> {
  validateExpectedRevision(revision);
  const input = structuredClone(normalizeGoal(next));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<GoalRow>("SELECT * FROM leader_goals WHERE id=$1 FOR UPDATE", [input.id]);
    const current = found.rows[0] && fromRow(found.rows[0]);
    if (!current || current.revision !== revision || !goalIsOpen(current)) { await client.query("COMMIT"); return null; }
    validateGoalUpdate(current, input, now());
    await validateGoalProofs(commandReader(client), current, input, now());
    const result = await client.query<GoalRow>("UPDATE leader_goals SET revision=$2,status=$3,data=$4::jsonb WHERE id=$1 AND revision=$5 RETURNING *",
      [input.id, input.revision, input.status, JSON.stringify(input), revision]);
    if (result.rows.length !== 1) throw new Error("Goal locked update lost record");
    validateGoalUpdate(current, input, now());
    const saved = fromRow(result.rows[0]);
    await client.query("COMMIT"); return saved;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
export async function pgGetLatestGoal(pool: pg.Pool, chatId: string): Promise<GoalRecord | null> {
  validateChatId(chatId);
  const result = await pool.query<GoalRow>("SELECT * FROM leader_goals WHERE chat_id=$1 ORDER BY (status IN ('active','blocked')) DESC,created_at DESC,id DESC LIMIT 1", [chatId]);
  return result.rows[0] ? fromRow(result.rows[0]) : null;
}
export async function pgListRunnableGoals(pool: pg.Pool, limit = 8, afterId = ""): Promise<GoalRecord[]> {
  executionListQuery([], limit);
  const result = await pool.query<GoalRow>("SELECT * FROM leader_goals WHERE status IN ('active','blocked') AND id>$1 ORDER BY id ASC LIMIT $2", [afterId, limit]);
  return result.rows.map(fromRow);
}
export async function pgListRecentGoals(pool: pg.Pool, chats: readonly string[], limit: number): Promise<GoalRecord[]> {
  const query = executionListQuery(chats, limit);
  if (!query.chatIds.length) return [];
  const result = await pool.query<GoalRow>("SELECT * FROM leader_goals WHERE chat_id=ANY($1::text[]) ORDER BY (status IN ('active','blocked')) DESC,created_at DESC,id DESC LIMIT $2", [query.chatIds, query.count]);
  return result.rows.map(fromRow);
}
