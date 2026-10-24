import pg from "pg";
import { expect, it, vi } from "vitest";
import { PostgresStore } from "../../src/store/postgres.js";
import { createExecution } from "../../src/leader/plans/execution.js";
import { createTerminalNotification, claimNotificationRecord, receiptNotificationRecord, normalizeNotification,
  NOTIFICATION_ATTEMPT_MS, LEGACY_NOTIFICATION_ATTEMPT_MS, type StoredNotification } from "../../src/notifications/contracts.js";

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
  if (status !== "pending") {
    n = claimNotificationRecord(n, uuid(index + 100), ["allowed"], NOW + 1);
    n.attemptExpiresAt = NOW + 1 + LEGACY_NOTIFICATION_ATTEMPT_MS;
  }
  if (status === "accepted" || status === "uncertain") n = receiptNotificationRecord(n, uuid(index + 100), status, NOW + 2);
  const { source, ...fields } = n;
  return { id: n.id, execution_id: n.id, chat_id: n.chatId, kind: n.kind, status: n.status,
    created_at: String(n.createdAt), expires_at: String(n.expiresAt), data: { ...fields, executionId: source.id } };
}

// Tracks transaction boundaries and the relevant DDL effects; actual constraints
// and DDL rollback are also verified in the isolated PostgreSQL integration test.
class MigrationPool {
  on = vi.fn();
  rows = new Map<string, Row>(); statements: string[] = []; executionRequired = true; goalColumn = false;
  versions = new Set<number>(); migrationPageSizes: number[] = [];
  released = 0; private snapshot?: { rows: Map<string, Row>; executionRequired: boolean; goalColumn: boolean; versions: Set<number> };
  async connect() { return { query: this.query.bind(this), release: () => { this.released++; } }; }
  async query(raw: string, values: unknown[] = []) {
    const sql = raw.replace(/\s+/g, " ").trim(); this.statements.push(sql);
    if (sql === "BEGIN") {
      this.snapshot = structuredClone({ rows: this.rows, executionRequired: this.executionRequired, goalColumn: this.goalColumn, versions: this.versions });
      return { rows: [] };
    }
    if (sql === "COMMIT") { this.snapshot = undefined; return { rows: [] }; }
    if (sql === "ROLLBACK") {
      if (this.snapshot) Object.assign(this, this.snapshot); this.snapshot = undefined; return { rows: [] };
    }
    if (sql.startsWith("SELECT pg_advisory_xact_lock(")) return { rows: [] };
    if (sql === "SELECT version FROM controller_schema_migrations") return { rows: [...this.versions].map(version => ({ version })) };
    if (sql === "INSERT INTO controller_schema_migrations(version) VALUES($1)") {
      this.versions.add(Number(values[0])); return { rows: [] };
    }
    if (sql === "ALTER TABLE leader_notifications ALTER COLUMN execution_id DROP NOT NULL") this.executionRequired = false;
    if (sql.startsWith("ALTER TABLE leader_notifications ADD COLUMN IF NOT EXISTS goal_id")) {
      this.goalColumn = true; for (const row of this.rows.values()) row.goal_id ??= null;
    }
    if (sql === "SELECT * FROM leader_notifications WHERE ($1::text IS NULL OR id>$1) ORDER BY id LIMIT $2 FOR UPDATE") {
      const rows = [...this.rows.values()].filter(row => values[0] === null || row.id > String(values[0]))
        .sort((a, b) => a.id.localeCompare(b.id)).slice(0, Number(values[1]));
      this.migrationPageSizes.push(rows.length);
      return { rows: structuredClone(rows) };
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
    if (/^(CREATE |ALTER |DROP INDEX |INSERT INTO known_sessions |DELETE FROM node_sessions|UPDATE commands)/.test(sql)) return { rows: [] };
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
  const first = JSON.stringify([...pool.rows]), restartIndex = pool.statements.length;
  await store.init(); expect(JSON.stringify([...pool.rows])).toBe(first);
  const restarted = pool.statements.slice(restartIndex);
  expect(restarted.filter(sql => sql.includes("leader_notifications"))).toEqual([]);
  expect(restarted.filter(sql => /^(ALTER |DROP INDEX |CREATE (UNIQUE )?INDEX)/.test(sql))).toEqual([]);
  expect(restarted.filter(sql => sql.includes("node_sessions") || sql.includes("known_sessions"))).toEqual([]);
  expect(restarted.some(sql => sql.startsWith("UPDATE commands SET status = 'uncertain'"))).toBe(true);
  expect(pool.versions).toEqual(new Set([1, 2]));
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

it("applies only the observation migration to version 1 and skips it on later startups", async () => {
  const { pool, store } = fixture([]); pool.versions.add(1);
  await store.init();
  expect(pool.versions).toEqual(new Set([1, 2]));
  expect(pool.statements.filter(sql => sql.includes("leader_notifications"))).toEqual([]);
  const alter = pool.statements.indexOf("ALTER TABLE known_sessions ADD COLUMN IF NOT EXISTS observed_order BIGSERIAL");
  const backfill = pool.statements.findIndex(sql => sql.startsWith("INSERT INTO known_sessions (node_id,session_id,data,updated_at)"));
  const clear = pool.statements.indexOf("DELETE FROM node_sessions;");
  const version = pool.statements.indexOf("INSERT INTO controller_schema_migrations(version) VALUES($1)");
  expect(alter).toBeGreaterThan(0); expect(alter).toBeLessThan(backfill);
  expect(backfill).toBeLessThan(clear); expect(clear).toBeLessThan(version);
  expect(pool.statements.at(-1)).toBe("COMMIT");
  const restart = pool.statements.length; await store.init();
  expect(pool.statements.slice(restart).filter(sql => sql.includes("known_sessions") || sql.includes("node_sessions"))).toEqual([]);
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
  expect(pool.versions.size).toBe(0);
  pool.rows.set(second.id, legacy(2)); await store.init();
  expect(pool.rows.get(first.id)!.data.source).toEqual({ type: "plan", id: first.id });
  expect(pool.rows.get(second.id)!.data.source).toEqual({ type: "plan", id: second.id });
});

it("pages legacy history and rolls back every page when a later record is invalid", async () => {
  const old = Array.from({ length: 205 }, (_, index) => legacy(index + 1));
  const invalid = structuredClone(old.at(-1)!); invalid.data.unexpected = true;
  const { pool, store } = fixture([...old.slice(0, -1), invalid]), before = structuredClone(pool.rows);
  await expect(store.init()).rejects.toThrow();
  expect(pool.migrationPageSizes).toEqual([100, 100, 5]);
  expect(pool.rows).toEqual(before); expect(pool.versions.size).toBe(0);
  pool.rows.set(old.at(-1)!.id, old.at(-1)!); pool.migrationPageSizes = [];
  await store.init();
  expect(pool.migrationPageSizes).toEqual([100, 100, 5, 0]);
  expect([...pool.rows.values()].every(row => Object.hasOwn(row.data, "source") && !Object.hasOwn(row.data, "executionId"))).toBe(true);
  const pages = pool.migrationPageSizes.slice(); await store.init(); expect(pool.migrationPageSizes).toEqual(pages);
});

it("does not skip invalid empty IDs on the first migration page", async () => {
  const row = legacy(1); row.id = "";
  const { pool, store } = fixture([row]);
  await expect(store.init()).rejects.toThrow("metadata");
  expect(pool.versions.size).toBe(0); expect(pool.statements.at(-1)).toBe("ROLLBACK");
});

it("strictly validates already-converted rows rather than accepting legacy aliases or repairing metadata", async () => {
  const old = legacy(1), { executionId, ...fields } = old.data;
  const converted = { ...old, goal_id: null, data: { ...fields, source: { type: "plan", id: executionId }, unexpected: true } };
  const { pool, store } = fixture([converted]);
  await expect(store.init()).rejects.toThrow(); expect(pool.rows.get(old.id)).toEqual(converted);
  expect(pool.statements.at(-1)).toBe("ROLLBACK");
});

it("preserves already-persisted progress and replaces source uniqueness with bounded sequence indexes", async () => {
  const old = legacy(1, "accepted"), { executionId, ...fields } = old.data;
  const progress = { ...old, id: uuid(20), goal_id: null, kind: "progress", data: { ...fields, id: uuid(20), kind: "progress",
    source: { type: "plan", id: executionId }, progress: { sequence: 1, eventKey: "exact:accepted" } } };
  const { pool, store } = fixture([progress]);
  await store.init();
  expect(pool.rows.get(progress.id)).toEqual(progress);
  const first = structuredClone(pool.rows); await store.init(); expect(pool.rows).toEqual(first);
  expect(pool.statements).toContain("ALTER TABLE leader_notifications DROP CONSTRAINT IF EXISTS leader_notifications_execution_id_key");
  expect(pool.statements).toContain("DROP INDEX IF EXISTS leader_notifications_goal_id_key");
  expect(pool.statements.some(sql => sql.includes("execution_id_progress_sequence_key") && sql.includes("WHERE kind='progress'"))).toBe(true);
  expect(pool.statements.some(sql => sql.includes("goal_id_terminal_key") && sql.includes("WHERE kind<>'progress'"))).toBe(true);
  expect((await store.getNotification(progress.id, NOW + 2))!.status).toBe("accepted");
  await expect(store.claimNotification(progress.id, uuid(99), ["allowed"], NOW + 2)).rejects.toThrow();
});
