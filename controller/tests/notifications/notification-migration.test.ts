import pg from "pg";
import { expect, it, vi } from "vitest";
import { PostgresStore } from "../../src/store/postgres.js";
import { createExecution } from "../../src/leader/plans/execution.js";
import { createTerminalNotification, claimNotificationRecord, receiptNotificationRecord, normalizeNotification,
  NOTIFICATION_ATTEMPT_MS, type StoredNotification } from "../../src/notifications/contracts.js";

vi.mock("pg", () => ({ default: { Pool: vi.fn() } }));
const NOW = 1_700_000_000_000;
const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
type Row = { id: string; execution_id: string | null; goal_id?: string | null; chat_id: string; kind: string; status: string;
  created_at: string; expires_at: string; data: Record<string, unknown> };
function legacy(index: number, status: StoredNotification["status"] = "pending"): Row {
  const execution = createExecution("allowed", { id: uuid(index), expiresAt: NOW + 60_000,
    actions: [{ nodeId: "node", sessionId: "session", prompt: "private", sendRoute: "control-socket" }] }, NOW);
  let n = createTerminalNotification({ ...execution, status: "failed" }, NOW)!;
  n.text = `计划 ${execution.id}（共 1 步）：计划失败，已停止后续派发；这不表示已运行的原会话任务停止，可查询计划进度核对。`;
  if (status !== "pending") n = claimNotificationRecord(n, uuid(index + 100), ["allowed"], NOW + 1);
  if (status === "accepted" || status === "uncertain") n = receiptNotificationRecord(n, uuid(index + 100), status, NOW + 2);
  const { source, ...fields } = n;
  return { id: n.id, execution_id: n.id, chat_id: n.chatId, kind: n.kind, status: n.status,
    created_at: String(n.createdAt), expires_at: String(n.expiresAt), data: { ...fields, executionId: source.id } };
}

// Tracks transaction boundaries and the relevant DDL effects; actual constraints
// and DDL rollback are also verified in the isolated PostgreSQL integration test.
class MigrationPool {
  rows = new Map<string, Row>(); statements: string[] = []; executionRequired = true; goalColumn = false;
  released = 0; private snapshot?: { rows: Map<string, Row>; executionRequired: boolean; goalColumn: boolean };
  async connect() { return { query: this.query.bind(this), release: () => { this.released++; } }; }
  async query(raw: string, values: unknown[] = []) {
    const sql = raw.replace(/\s+/g, " ").trim(); this.statements.push(sql);
    if (sql === "BEGIN") {
      this.snapshot = structuredClone({ rows: this.rows, executionRequired: this.executionRequired, goalColumn: this.goalColumn });
      return { rows: [] };
    }
    if (sql === "COMMIT") { this.snapshot = undefined; return { rows: [] }; }
    if (sql === "ROLLBACK") {
      if (this.snapshot) Object.assign(this, this.snapshot); this.snapshot = undefined; return { rows: [] };
    }
    if (sql === "ALTER TABLE leader_notifications ALTER COLUMN execution_id DROP NOT NULL") this.executionRequired = false;
    if (sql.startsWith("ALTER TABLE leader_notifications ADD COLUMN IF NOT EXISTS goal_id")) {
      this.goalColumn = true; for (const row of this.rows.values()) row.goal_id ??= null;
    }
    if (sql === "SELECT * FROM leader_notifications ORDER BY id FOR UPDATE") {
      return { rows: structuredClone([...this.rows.values()].sort((a, b) => a.id.localeCompare(b.id))) };
    }
    if (sql === "UPDATE leader_notifications SET data=$2::jsonb WHERE id=$1 RETURNING *") {
      const row = this.rows.get(String(values[0])); if (!row) return { rows: [] };
      row.data = JSON.parse(String(values[1])); return { rows: [structuredClone(row)] };
    }
    if (sql.startsWith("SELECT * FROM leader_notifications WHERE chat_id=ANY")) {
      return { rows: structuredClone([...this.rows.values()].filter(r => (values[0] as string[]).includes(r.chat_id) &&
        r.status === "pending" && Number(r.expires_at) > Number(values[1])).slice(0, Number(values[2]))) };
    }
    if (sql.startsWith("SELECT * FROM leader_notifications WHERE id=$1")) {
      const row = this.rows.get(String(values[0])); return { rows: row ? [structuredClone(row)] : [] };
    }
    if (/^(CREATE |ALTER |DELETE FROM node_sessions|UPDATE commands)/.test(sql)) return { rows: [] };
    throw new Error(`Unexpected migration fixture SQL: ${sql}`);
  }
  async end() {}
}
function fixture(rows: Row[]) {
  const pool = new MigrationPool(); pool.rows = new Map(rows.map(r => [r.id, structuredClone(r)]));
  vi.mocked(pg.Pool).mockImplementation(function () { return pool as unknown as pg.Pool; });
  return { pool, store: new PostgresStore("postgresql://unused/isolated-migration") };
}

it("atomically converts all legacy statuses without changing text, timestamps or permanent attempts; repeated init is identical", async () => {
  const old = (["pending", "claimed", "accepted", "uncertain"] as const).map((s, i) => legacy(i + 1, s));
  const { pool, store } = fixture(old); await store.init();
  expect(pool.executionRequired).toBe(false); expect(pool.goalColumn).toBe(true);
  for (const previous of old) {
    const { executionId, ...fields } = previous.data, converted = pool.rows.get(previous.id)!;
    expect(converted).toEqual({ ...previous, goal_id: null, data: { ...fields, source: { type: "plan", id: executionId } } });
    expect(normalizeNotification(converted.data)).not.toHaveProperty("executionId");
  }
  const first = JSON.stringify([...pool.rows]); await store.init(); expect(JSON.stringify([...pool.rows])).toBe(first);
  expect(pool.statements.filter(s => s.startsWith("UPDATE leader_notifications SET data="))).toHaveLength(4);
  expect((await store.listPendingNotifications(["allowed"], NOW + NOTIFICATION_ATTEMPT_MS)).map(n => n.id)).toEqual([old[0].id]);
  expect((await store.getNotification(old[1].id, NOW + NOTIFICATION_ATTEMPT_MS + 1))!.status).toBe("uncertain");
  expect(pool.statements.some(s => /public\./.test(s))).toBe(false);
  const execution = pool.statements.findIndex(s => s.startsWith("CREATE TABLE IF NOT EXISTS leader_executions"));
  const goal = pool.statements.findIndex(s => s.startsWith("CREATE TABLE IF NOT EXISTS leader_goals"));
  const notification = pool.statements.findIndex(s => s.startsWith("CREATE TABLE IF NOT EXISTS leader_notifications"));
  expect(execution).toBeLessThan(goal); expect(goal).toBeLessThan(notification);
  expect(pool.statements[0]).toBe("BEGIN"); expect(pool.statements.at(-1)).toBe("SELECT * FROM leader_notifications WHERE id=$1");
  expect(pool.released).toBe(2);
});

it.each([
  ["mixed source", (r: Row) => { r.data.source = { type: "plan", id: r.id }; }],
  ["mismatched legacy ID", (r: Row) => { r.data.executionId = uuid(999); }],
  ["unknown field", (r: Row) => { r.data.output = "private"; }],
  ["invalid text", (r: Row) => { r.data.text = " "; }],
  ["pending attempt", (r: Row) => { r.data.attemptId = uuid(99); }],
  ["wrong metadata chat", (r: Row) => { r.chat_id = "forbidden"; }],
  ["wrong metadata source", (r: Row) => { r.execution_id = uuid(999); }],
  ["wrong source kind", (r: Row) => { r.kind = "blocked"; r.data.kind = "blocked"; }],
] as const)("invalid legacy %s rolls back earlier conversion and DDL, then corrected retry succeeds", async (_name, corrupt) => {
  const first = legacy(1), second = legacy(2); corrupt(second);
  const { pool, store } = fixture([first, second]), before = structuredClone(pool.rows);
  await expect(store.init()).rejects.toThrow();
  expect(pool.statements).toContain("UPDATE leader_notifications SET data=$2::jsonb WHERE id=$1 RETURNING *");
  expect(pool.statements.at(-1)).toBe("ROLLBACK"); expect(pool.statements).not.toContain("COMMIT");
  expect(pool.rows).toEqual(before); expect(pool.executionRequired).toBe(true); expect(pool.goalColumn).toBe(false);
  pool.rows.set(second.id, legacy(2)); await store.init();
  expect(pool.rows.get(first.id)!.data.source).toEqual({ type: "plan", id: first.id });
  expect(pool.rows.get(second.id)!.data.source).toEqual({ type: "plan", id: second.id });
});

it("strictly validates already-converted rows rather than accepting legacy aliases or repairing metadata", async () => {
  const old = legacy(1), { executionId, ...fields } = old.data;
  const converted = { ...old, goal_id: null, data: { ...fields, source: { type: "plan", id: executionId }, unexpected: true } };
  const { pool, store } = fixture([converted]);
  await expect(store.init()).rejects.toThrow(); expect(pool.rows.get(old.id)).toEqual(converted);
  expect(pool.statements.at(-1)).toBe("ROLLBACK");
});
