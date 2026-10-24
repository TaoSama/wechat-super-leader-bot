import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReliabilityPostgresFixture } from "../../../tests/support/reliability-postgres.mjs";
import { createExecution } from "../../src/leader/plans/execution.js";
import { createTerminalNotification, normalizeNotification } from "../../src/notifications/contracts.js";
import { initExecutionTables } from "../../src/store/execution-postgres.js";
import { initGoalTables } from "../../src/store/goal-postgres.js";
import { initializeDatabase } from "../../src/store/migrations.js";

const NOW = 1_700_000_000_000;
const HOOK_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 20_000;
const HISTORY_SIZE = 205;
const suppliedDatabaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
if (suppliedDatabaseUrl) {
  const url = new URL(suppliedDatabaseUrl);
  if (url.hostname !== "127.0.0.1" || !url.pathname.startsWith("/versioned_migration_test"))
    throw new Error("MIGRATION_TEST_DATABASE_URL requires a disposable loopback versioned_migration_test database");
}
type Statement = { sql: string; returnedRows?: number };

describe.skipIf(process.env.RUN_POSTGRES_INTEGRATION !== "1" && !suppliedDatabaseUrl)("versioned startup migration in isolated PostgreSQL", () => {
  const fixtureEvents: string[] = [];
  const fixture = createReliabilityPostgresFixture({ env: process.env, evidence: (event: string) => { fixtureEvents.push(event); } });
  let databaseUrl: string;
  let admin: pg.Pool;
  beforeAll(async () => {
    databaseUrl = suppliedDatabaseUrl ?? await fixture.start();
    admin = new pg.Pool({ connectionString: databaseUrl });
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    try { await admin?.end(); }
    finally { if (!suppliedDatabaseUrl) await fixture.stop(); }
    if (!suppliedDatabaseUrl) expect(fixtureEvents.at(-1)).toBe("database-container-removed");
  }, HOOK_TIMEOUT_MS);

  async function withSchema(run: (pool: pg.Pool) => Promise<void>) {
    const schema = `notification_migration_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const scoped = new URL(databaseUrl); scoped.searchParams.set("options", `-c search_path=${schema}`);
    const pool = new pg.Pool({ connectionString: scoped.toString(), max: 2 });
    try { await run(pool); }
    finally {
      try { await pool.end(); }
      finally { await admin.query(`DROP SCHEMA ${schema} CASCADE`); }
    }
  }

  function traced(pool: pg.Pool, statements: Statement[]): pg.Pool {
    return { connect: async () => {
      const client = await pool.connect();
      return { release: () => client.release(), query: async (sql: string, values?: unknown[]) => {
        const statement: Statement = { sql: sql.replace(/\s+/g, " ").trim() }; statements.push(statement);
        const result = await client.query(sql, values); statement.returnedRows = result.rows.length;
        return result;
      } };
    } } as unknown as pg.Pool;
  }

  async function seedHistory(pool: pg.Pool, legacy: boolean) {
    const executions = Array.from({ length: HISTORY_SIZE }, (_, index) => ({
      ...createExecution("synthetic-migration-chat", {
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, expiresAt: NOW + 60_000,
        actions: [{ nodeId: "fixture", sessionId: "fixture", prompt: "synthetic", sendRoute: "control-socket" }],
      }, NOW), status: "failed" as const,
    }));
    const notifications = executions.map(execution => {
      const notification = createTerminalNotification(execution, NOW)!;
      if (!legacy) return notification;
      const { source, ...fields } = notification;
      return { ...fields, executionId: source.id };
    });
    await pool.query(`INSERT INTO leader_executions (id,chat_id,revision,status,data,created_at)
      SELECT data->>'id',data->>'chatId',(data->>'revision')::bigint,data->>'status',data,(data->>'createdAt')::bigint
      FROM jsonb_array_elements($1::jsonb) AS item(data)`, [JSON.stringify(executions)]);
    await pool.query(`INSERT INTO leader_notifications (id,execution_id,chat_id,kind,status,created_at,expires_at,data)
      SELECT data->>'id',COALESCE(data->>'executionId',data->'source'->>'id'),data->>'chatId',data->>'kind',data->>'status',
        (data->>'createdAt')::bigint,(data->>'expiresAt')::bigint,data
      FROM jsonb_array_elements($1::jsonb) AS item(data)`, [JSON.stringify(notifications)]);
    return notifications;
  }

  it("serializes concurrent first startup, then skips history and preserves index identities while recovering commands", async () => {
    await withSchema(async pool => {
      const statements: Statement[] = [], migrationPool = traced(pool, statements);
      await Promise.all([initializeDatabase(migrationPool), initializeDatabase(migrationPool)]);
      expect((await pool.query("SELECT version FROM controller_schema_migrations ORDER BY version")).rows).toEqual([{ version: 1 }, { version: 2 }]);
      expect(statements.filter(({ sql }) => sql.startsWith("CREATE TABLE IF NOT EXISTS leader_notifications"))).toHaveLength(1);
      await seedHistory(pool, false);
      const identities = () => pool.query(`SELECT relname,oid::text,relfilenode::text FROM pg_class
        WHERE relnamespace=current_schema()::regnamespace AND relkind='i' ORDER BY relname`);
      const before = (await identities()).rows;
      await pool.query(`INSERT INTO commands (command_id,node_id,session_id,action,status,expires_at,created_at,updated_at)
        VALUES ('synthetic-pending','fixture','fixture','send','pending',NOW()+INTERVAL '1 minute',NOW(),NOW())`);
      const start = statements.length; await initializeDatabase(migrationPool);
      const restarted = statements.slice(start).map(({ sql }) => sql);
      expect(restarted.filter(sql => sql.includes("leader_notifications"))).toEqual([]);
      expect(restarted.filter(sql => sql.includes("node_sessions") || sql.includes("known_sessions"))).toEqual([]);
      expect(restarted.filter(sql => /^(ALTER |DROP |CREATE (UNIQUE )?INDEX)/.test(sql))).toEqual([]);
      expect((await identities()).rows).toEqual(before);
      expect((await pool.query("SELECT status FROM commands WHERE command_id='synthetic-pending'")).rows[0].status).toBe("uncertain");
      expect((await pool.query("SELECT * FROM node_sessions")).rows).toEqual([]);
      expect((await pool.query("SELECT session_id FROM known_sessions")).rows).toEqual([]);
      expect((await pool.query("SELECT count(*)::int AS count FROM leader_notifications")).rows[0].count).toBe(HISTORY_SIZE);
    });
  }, TEST_TIMEOUT_MS);

  it("upgrades version 1 session identities once and rolls back observation DDL when backfill fails", async () => {
    await withSchema(async pool => {
      await initializeDatabase(pool);
      await pool.query("ALTER TABLE known_sessions DROP COLUMN observed_order");
      await pool.query("DELETE FROM controller_schema_migrations WHERE version=2");
      const retained = { id: "known", title: "retained identity" }, imported = { id: "inventory", title: "imported identity" };
      await pool.query(`INSERT INTO known_sessions(node_id,session_id,data,updated_at)
        VALUES ('fixture','known',$1,NOW())`, [JSON.stringify(retained)]);
      await pool.query(`INSERT INTO node_sessions(node_id,session_id,data,updated_at)
        VALUES ('fixture','known','{"id":"known","title":"stale inventory"}',NOW()),
          ('fixture','inventory',$1,NOW())`, [JSON.stringify(imported)]);
      await pool.query(`CREATE FUNCTION reject_session_backfill() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic observation backfill failure'; END $$`);
      await pool.query(`CREATE TRIGGER reject_session_backfill BEFORE INSERT ON known_sessions
        FOR EACH ROW EXECUTE FUNCTION reject_session_backfill()`);
      const statements: Statement[] = [], migrationPool = traced(pool, statements);
      await expect(initializeDatabase(migrationPool)).rejects.toThrow("synthetic observation backfill failure");
      expect((await pool.query("SELECT version FROM controller_schema_migrations ORDER BY version")).rows).toEqual([{ version: 1 }]);
      expect((await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema()
        AND table_name='known_sessions' AND column_name='observed_order'`)).rows).toEqual([]);
      expect((await pool.query("SELECT count(*)::int AS count FROM node_sessions")).rows[0].count).toBe(2);
      expect((await pool.query("SELECT data FROM known_sessions")).rows).toEqual([{ data: retained }]);
      await pool.query("DROP TRIGGER reject_session_backfill ON known_sessions");
      await pool.query("DROP FUNCTION reject_session_backfill()");
      statements.length = 0; await initializeDatabase(migrationPool);
      expect((await pool.query("SELECT version FROM controller_schema_migrations ORDER BY version")).rows).toEqual([{ version: 1 }, { version: 2 }]);
      expect((await pool.query("SELECT data FROM known_sessions ORDER BY session_id")).rows).toEqual([{ data: imported }, { data: retained }]);
      expect((await pool.query("SELECT count(*)::int AS count FROM known_sessions WHERE observed_order>0")).rows[0].count).toBe(2);
      expect((await pool.query("SELECT * FROM node_sessions")).rows).toEqual([]);
      expect(statements.filter(({ sql }) => sql.includes("leader_notifications"))).toEqual([]);
      const restart = statements.length; await initializeDatabase(migrationPool);
      expect(statements.slice(restart).filter(({ sql }) => sql.includes("known_sessions") || sql.includes("node_sessions"))).toEqual([]);
    });
  }, TEST_TIMEOUT_MS);

  it("upgrades paged legacy history atomically, rejects invalid data, then retries with enforced constraints", async () => {
    await withSchema(async pool => {
      const client = await pool.connect();
      try { await initExecutionTables(client); await initGoalTables(client); }
      finally { client.release(); }
      await pool.query(`CREATE TABLE leader_notifications (
        id VARCHAR(36) COLLATE "C" PRIMARY KEY,
        execution_id VARCHAR(36) COLLATE "C" NOT NULL UNIQUE REFERENCES leader_executions(id),
        chat_id VARCHAR(64) NOT NULL,kind VARCHAR(16) NOT NULL,status VARCHAR(16) NOT NULL,
        created_at BIGINT NOT NULL,expires_at BIGINT NOT NULL,data JSONB NOT NULL,CHECK(id=execution_id))`);
      const original = await seedHistory(pool, true), lastId = original.at(-1)!.id;
      await pool.query("UPDATE leader_notifications SET data=data || '{\"unexpected\":true}'::jsonb WHERE id=$1", [lastId]);
      const statements: Statement[] = [], migrationPool = traced(pool, statements);
      await expect(initializeDatabase(migrationPool)).rejects.toThrow();
      expect(statements.filter(({ sql }) => sql.startsWith("SELECT * FROM leader_notifications"))
        .map(({ returnedRows }) => returnedRows)).toEqual([100, 100, 5]);
      expect((await pool.query("SELECT to_regclass('controller_schema_migrations') AS ledger")).rows[0].ledger).toBeNull();
      expect((await pool.query(`SELECT column_name,is_nullable FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='leader_notifications' AND column_name IN ('execution_id','goal_id')`)).rows)
        .toEqual([{ column_name: "execution_id", is_nullable: "NO" }]);
      expect((await pool.query("SELECT count(*)::int AS count FROM leader_notifications WHERE data ? 'executionId'")).rows[0].count).toBe(HISTORY_SIZE);
      await pool.query("UPDATE leader_notifications SET data=data-'unexpected' WHERE id=$1", [lastId]);
      statements.length = 0; await initializeDatabase(migrationPool);
      expect(statements.filter(({ sql }) => sql.startsWith("SELECT * FROM leader_notifications"))
        .map(({ returnedRows }) => returnedRows)).toEqual([100, 100, 5, 0]);
      const migrated = (await pool.query("SELECT data FROM leader_notifications ORDER BY id")).rows;
      expect(migrated.map(({ data }) => normalizeNotification(data))).toEqual(original.map(record => {
        const { executionId, ...fields } = record as Record<string, unknown>;
        return { ...fields, source: { type: "plan", id: executionId } };
      }));
      await expect(pool.query("UPDATE leader_notifications SET execution_id=NULL WHERE id=$1", [lastId])).rejects.toMatchObject({ code: "23514" });
      expect((await pool.query("SELECT version FROM controller_schema_migrations ORDER BY version")).rows).toEqual([{ version: 1 }, { version: 2 }]);
    });
  }, TEST_TIMEOUT_MS);
});
