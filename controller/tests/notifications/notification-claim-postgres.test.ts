import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReliabilityPostgresFixture } from "../../../tests/support/reliability-postgres.mjs";
import { createExecution } from "../../src/leader/plans/execution.js";
import { createGoal } from "../../src/leader/goals/goal.js";
import { claimNotificationRecord, normalizeNotification, receiptNotificationRecord, terminalNotificationPartEligible,
  NOTIFICATION_TTL_MS, type StoredNotification } from "../../src/notifications/contracts.js";
import { ConflictError } from "../../src/store/interface.js";
import { initNotificationTables, insertTerminalNotification, pgClaimNotification, pgGetNotification,
  pgRecordNotificationReceipt } from "../../src/store/notification-postgres.js";

const NOW = 1_700_000_000_000;
const HOOK_TIMEOUT_MS = 180_000;
const CHAT_ID = "terminal-claim-metadata-test";
const PART_COUNT = 3;
const PART_TEXT_BYTES = 64 * 1024;
type SourceType = "plan" | "goal";
interface QueryTrace { sql: string; fields: string[]; bytes: number }

function tracePool(pool: pg.Pool, statements: QueryTrace[]): pg.Pool {
  async function query(client: pg.Pool | pg.PoolClient, sql: string, values: unknown[] = []) {
    const result = await client.query(sql, values);
    statements.push({ sql: sql.replace(/\s+/g, " ").trim(), fields: result.fields.map(field => field.name),
      bytes: Buffer.byteLength(JSON.stringify(result.rows), "utf8") });
    return result;
  }
  return { query: (sql: string, values: unknown[]) => query(pool, sql, values), connect: async () => {
    const client = await pool.connect();
    return { query: (sql: string, values: unknown[]) => query(client, sql, values), release: () => client.release() };
  } } as unknown as pg.Pool;
}

function withStatus(notification: StoredNotification, status: StoredNotification["status"]): StoredNotification {
  if (status === "pending") return notification;
  const attemptId = randomUUID();
  const claimed = claimNotificationRecord(notification, attemptId, [CHAT_ID], NOW);
  return status === "claimed" ? claimed : receiptNotificationRecord(claimed, attemptId, status, NOW);
}

describe.skipIf(process.env.RUN_POSTGRES_INTEGRATION !== "1")("terminal claim metadata in isolated PostgreSQL", () => {
  const fixtureEvents: string[] = [];
  const fixture = createReliabilityPostgresFixture({ env: process.env, evidence: (event: string) => { fixtureEvents.push(event); } });
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: await fixture.start() });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const table of ["leader_executions", "leader_goals"]) {
        await client.query(`CREATE TABLE ${table} (id VARCHAR(36) COLLATE "C" PRIMARY KEY, chat_id VARCHAR(64),
          revision BIGINT, status VARCHAR(16), created_at BIGINT, data JSONB)`);
      }
      await initNotificationTables(client);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    try { await pool?.end(); } finally { await fixture.stop(); }
    expect(fixtureEvents.at(-1)).toBe("database-container-removed");
  }, HOOK_TIMEOUT_MS);

  async function parts(type: SourceType): Promise<StoredNotification[]> {
    const id = randomUUID();
    const record = type === "plan" ? { ...createExecution(CHAT_ID, { id, expiresAt: NOW + 60_000,
      actions: [{ nodeId: "fixture", sessionId: "session", prompt: "durable result", sendRoute: "control-socket" }] }, NOW),
      status: "completed" } : { ...createGoal(CHAT_ID, { id, expiresAt: NOW + 60_000, objective: "durable result",
      criteria: ["complete"], targets: [{ nodeId: "fixture", sessionId: "session", sendRoute: "control-socket" }],
      constraints: "", maxActions: 1, maxDecisions: 1, durationMinutes: 1, shareResults: true }, NOW),
      status: "blocked", blockedReason: "fixture result" };
    const table = type === "plan" ? "leader_executions" : "leader_goals";
    await pool.query(`INSERT INTO ${table} (id,chat_id,revision,status,created_at,data) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [id, record.chatId, record.revision, record.status, record.createdAt, JSON.stringify(record)]);
    return Array.from({ length: PART_COUNT }, (_, index) => normalizeNotification({ id: index === 0 ? id : randomUUID(),
      source: { type, id }, chatId: CHAT_ID, kind: record.status, text: "x".repeat(PART_TEXT_BYTES),
      part: { index: index + 1, total: PART_COUNT }, createdAt: NOW, expiresAt: NOW + NOTIFICATION_TTL_MS, status: "pending" }));
  }

  async function insert(notifications: StoredNotification[]): Promise<void> {
    const client = await pool.connect();
    try { for (const notification of notifications) await insertTerminalNotification(client, notification); }
    finally { client.release(); }
  }

  it.each(["plan", "goal"] as const)("%s continuation checks return only one boolean without predecessor bodies", async type => {
    const notifications = await parts(type);
    notifications[0] = withStatus(notifications[0], "accepted");
    await insert(notifications);
    const statements: QueryTrace[] = [];
    const traced = tracePool(pool, statements);
    for (const notification of notifications.slice(1)) {
      const attemptId = randomUUID();
      expect(await pgClaimNotification(traced, notification.id, attemptId, [CHAT_ID], NOW)).toMatchObject({ status: "claimed", attemptId });
      await pgRecordNotificationReceipt(pool, notification.id, attemptId, "accepted", NOW);
    }
    const checks = statements.filter(statement => statement.sql.includes("FROM leader_notifications") &&
      statement.sql.startsWith("SELECT") && !statement.sql.includes("WHERE id=$1"));
    expect(checks).toHaveLength(PART_COUNT - 1);
    for (const check of checks) {
      expect(check.fields).toEqual(["eligible"]);
      expect(check.bytes).toBeLessThan(PART_TEXT_BYTES);
      const index = statements.indexOf(check);
      expect(statements[index - 1].sql).toBe(`SELECT * FROM ${type === "plan" ? "leader_executions" : "leader_goals"} WHERE id=$1 FOR UPDATE`);
      expect(statements[index + 1].sql).toBe("SELECT * FROM leader_notifications WHERE id=$1 FOR UPDATE");
    }
  });

  const deniedCases = ["missing", "missing-first", "pending", "claimed", "uncertain", "different-total", "different-kind", "different-source"] as const;
  describe.each(["plan", "goal"] as const)("%s predecessor eligibility", type => {
    it.each(deniedCases)("refuses a %s predecessor and rolls back the claim", async reason => {
      const notifications = await parts(type);
      notifications[0] = withStatus(notifications[0], "accepted");
      notifications[1] = withStatus(notifications[1], "accepted");
      if (["pending", "claimed", "uncertain"].includes(reason)) {
        notifications[1] = withStatus(normalizeNotification({ ...notifications[1], status: "pending",
          attemptId: undefined, attemptedAt: undefined, attemptExpiresAt: undefined }), reason as StoredNotification["status"]);
      } else if (reason === "different-total") {
        notifications[1] = normalizeNotification({ ...notifications[1], part: { index: 2, total: PART_COUNT + 1 } });
      } else if (reason === "different-kind") {
        notifications[1] = normalizeNotification({ ...notifications[1], kind: "expired" });
      } else if (reason === "different-source") {
        const other = await parts(type);
        notifications[1] = normalizeNotification({ ...notifications[1], source: other[1].source });
      }
      const stored = reason === "missing" ? [notifications[0], notifications[2]] :
        reason === "missing-first" ? notifications.slice(1) : notifications;
      expect(terminalNotificationPartEligible(notifications[2], stored)).toBe(false);
      await insert(stored);
      const statements: QueryTrace[] = [];
      await expect(pgClaimNotification(tracePool(pool, statements), notifications[2].id, randomUUID(), [CHAT_ID], NOW))
        .rejects.toBeInstanceOf(ConflictError);
      expect((await pgGetNotification(pool, notifications[2].id, NOW))?.status).toBe("pending");
      expect(statements.at(-1)?.sql).toBe("ROLLBACK");
      expect(statements.some(statement => statement.sql.startsWith("UPDATE"))).toBe(false);
    });
  });

  it.each(["plan", "goal"] as const)("%s preserves a single winning claim and idempotent accepted receipts", async type => {
    const notifications = await parts(type);
    notifications[0] = withStatus(notifications[0], "accepted");
    notifications[1] = withStatus(notifications[1], "accepted");
    await insert(notifications);
    const current = notifications[2], attempts = [randomUUID(), randomUUID()];
    const claims = await Promise.allSettled(attempts.map(attempt => pgClaimNotification(pool, current.id, attempt, [CHAT_ID], NOW)));
    expect(claims.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = claims.find(result => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason instanceof ConflictError).toBe(true);
    const claimed = await pgGetNotification(pool, current.id, NOW);
    const accepted = await pgRecordNotificationReceipt(pool, current.id, claimed!.attemptId!, "accepted", NOW);
    expect(await pgRecordNotificationReceipt(pool, current.id, claimed!.attemptId!, "accepted", NOW)).toEqual(accepted);
  });
});
