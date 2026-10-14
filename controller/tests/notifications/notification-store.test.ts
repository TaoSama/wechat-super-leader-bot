import { expect, it, describe, vi } from "vitest";
import pg from "pg";
import { MemoryStore } from "../../src/store/memory.js";
import { PostgresStore } from "../../src/store/postgres.js";
import { ConflictError, type IStore } from "../../src/store/interface.js";
import { createExecution, type ExecutionRecord } from "../../src/leader/plans/execution.js";
import { normalizeNotification, NOTIFICATION_TTL_MS, NOTIFICATION_ATTEMPT_MS, type StoredNotification } from "../../src/notifications/contracts.js";

vi.mock("pg", () => ({ default: { Pool: vi.fn() } }));
const NOW = 1_700_000_000_000;
const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const attempt = uuid(99);
function execution(index = 1, chatId = "allowed", now = NOW): ExecutionRecord {
  return createExecution(chatId, { id: uuid(index), expiresAt: now + 600_000,
    actions: [{ nodeId: "node", sessionId: "session", prompt: "private prompt", sendRoute: "control-socket", dependsOn: [] }] }, now);
}
const executionRow = (record: ExecutionRecord) => ({ id: record.id, chat_id: record.chatId, revision: String(record.revision),
  status: record.status, created_at: String(record.createdAt), data: structuredClone(record) });
const notificationRow = (record: StoredNotification) => ({ id: record.id,
  execution_id: record.source.type === "plan" ? record.source.id : null,
  goal_id: record.source.type === "goal" ? record.source.id : null, chat_id: record.chatId,
  kind: record.kind, status: record.status, created_at: String(record.createdAt), expires_at: String(record.expiresAt), data: structuredClone(record) });
type ExecutionRow = ReturnType<typeof executionRow>;
type NotificationRow = ReturnType<typeof notificationRow>;

// SQL mock verifies production queries and transactional visibility, not real PG locks.
class NotificationPool {
  executions = new Map<string, ExecutionRow>();
  notifications = new Map<string, NotificationRow>();
  queries: string[] = [];
  failInsert = false;
  corruptUpdate = false;
  released = 0;
  private tail = Promise.resolve();
  private result(rows: (ExecutionRow | NotificationRow)[] = []) { return { rows: structuredClone(rows) }; }
  async query(sql: string, params: unknown[] = []) {
    const query = sql.replace(/\s+/g, " ").trim();
    this.queries.push(query);
    if (query.startsWith("SELECT pg_advisory_xact_lock(") || query.startsWith("SELECT id FROM leader_goals WHERE chat_id=$1")) return this.result();
    if (/^(CREATE |ALTER |DELETE FROM node_sessions|UPDATE commands)/.test(query)) return this.result();
    if (query === "SELECT * FROM leader_notifications ORDER BY id FOR UPDATE") return this.result([...this.notifications.values()]);
    if (query.startsWith("INSERT INTO leader_executions")) {
      const record = JSON.parse(params[4] as string) as ExecutionRecord;
      const row = executionRow(record);
      if (this.executions.has(record.id)) return this.result();
      this.executions.set(record.id, row);
      return this.result([row]);
    }
    if (query.startsWith("SELECT * FROM leader_executions WHERE id=$1")) {
      const row = this.executions.get(params[0] as string);
      return this.result(row ? [row] : []);
    }
    if (query.startsWith("SELECT * FROM leader_notifications WHERE id=$1")) {
      const row = this.notifications.get(params[0] as string);
      return this.result(row ? [row] : []);
    }
    if (query.startsWith("SELECT * FROM leader_notifications WHERE chat_id=ANY")) {
      expect(query).toContain("AND status='pending' AND expires_at>$2 ORDER BY created_at ASC,id ASC LIMIT $3");
      expect(params[2]).toBe(4);
      return this.result([...this.notifications.values()].filter(row => (params[0] as string[]).includes(row.chat_id) &&
        row.status === "pending" && Number(row.expires_at) > (params[1] as number))
        .sort((a, b) => Number(a.created_at) - Number(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, params[2] as number));
    }
    throw new Error(`Unexpected query: ${query}`);
  }
  async connect() {
    let unlock: (() => void) | undefined, stagedExecution: ExecutionRow | undefined, stagedNotification: NotificationRow | undefined;
    return {
      query: async (sql: string, params: unknown[] = []) => {
        const query = sql.replace(/\s+/g, " ").trim();
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(query)) {
          this.queries.push(query);
          if (query === "COMMIT") {
            if (stagedExecution) this.executions.set(stagedExecution.id, stagedExecution);
            if (stagedNotification) this.notifications.set(stagedNotification.id, stagedNotification);
          }
          if (query !== "BEGIN") { stagedExecution = undefined; stagedNotification = undefined; unlock?.(); }
          return this.result();
        }
        if ((query.endsWith("FOR UPDATE") || query.startsWith("SELECT pg_advisory_xact_lock(")) && !unlock) {
          const previous = this.tail;
          this.tail = new Promise<void>(resolve => { unlock = resolve; });
          await previous;
          return this.query(sql, params);
        }
        if (query.startsWith("INSERT INTO leader_executions")) {
          this.queries.push(query);
          const input = JSON.parse(params[4] as string) as ExecutionRecord;
          if (this.executions.has(input.id)) return this.result();
          stagedExecution = executionRow(input);
          return this.result([stagedExecution]);
        }
        if (query.startsWith("UPDATE leader_executions")) {
          this.queries.push(query);
          stagedExecution = executionRow(JSON.parse(params[3] as string));
          return this.result([stagedExecution]);
        }
        if (query.startsWith("INSERT INTO leader_notifications")) {
          this.queries.push(query);
          if (this.failInsert) throw new Error("Outbox INSERT failed");
          const record = normalizeNotification(JSON.parse(params[8] as string));
          expect(params[1]).toBe(record.source.type === "plan" ? record.source.id : null);
          expect(params[2]).toBe(record.source.type === "goal" ? record.source.id : null);
          if (this.notifications.has(record.id)) throw new Error("Duplicate outbox ID");
          stagedNotification = notificationRow(record);
          return this.result();
        }
        if (query.startsWith("UPDATE leader_notifications")) {
          this.queries.push(query);
          stagedNotification = notificationRow(normalizeNotification(JSON.parse(params[2] as string)));
          const returned = structuredClone(stagedNotification);
          if (this.corruptUpdate) returned.chat_id = "wrong-chat";
          return this.result([returned]);
        }
        return this.query(sql, params);
      },
      release: () => { this.released++; },
    };
  }
  async end() {}
}
function postgres() {
  const pool = new NotificationPool();
  vi.mocked(pg.Pool).mockImplementation(function () { return pool as unknown as pg.Pool; });
  return { store: new PostgresStore("postgresql://unused/notification-test"), pool };
}
async function terminal(store: IStore, index = 1, chatId = "allowed", status: ExecutionRecord["status"] = "completed", now = NOW) {
  const record = execution(index, chatId);
  await store.createExecutionIfAbsent(record);
  await store.compareAndSetExecution({ ...record, revision: 2, status }, 1, now);
  return record;
}

for (const [name, factory] of [["memory", () => new MemoryStore()], ["postgres SQL", () => postgres().store]] as const) {
  describe(`${name} notification lifecycle`, () => {
    it("creates one unique bounded terminal outbox; active and cancelled produce none", async () => {
      const store = factory();
      for (const [index, status] of (["completed", "failed", "expired", "cancelled"] as const).entries()) {
        const record = await terminal(store, index + 1, `allowed-${index}`, status);
        const notification = await store.getNotification(record.id, NOW);
        if (status === "cancelled") expect(notification).toBeNull();
        else {
          expect(notification).toMatchObject({ id: record.id, source: { type: "plan", id: record.id }, chatId: record.chatId, kind: status,
            status: "pending", createdAt: NOW, expiresAt: NOW + NOTIFICATION_TTL_MS });
          expect(notification!.text.length).toBeLessThanOrEqual(2000);
          expect(notification!.text).not.toContain("private prompt");
          if (status !== "completed") expect(notification!.text).toContain("不表示已运行的原会话任务停止");
          await expect(store.compareAndSetExecution({ ...record, revision: 2, status }, 1, NOW + 1)).resolves.toBeNull();
          expect(await store.getNotification(record.id, NOW)).toEqual(notification);
        }
      }
      const active = execution(10, "active");
      await store.createExecutionIfAbsent(active);
      expect(await store.getNotification(active.id, NOW)).toBeNull();
      await store.init();
      expect(await store.getNotification(active.id, NOW)).toBeNull();
    });

    it("filters requested allowed chats before fixed limit, orders oldest/id first and clones", async () => {
      const store = factory();
      for (const index of [8, 5, 2, 4, 1, 3, 6, 7]) await terminal(store, index, index <= 5 ? "allowed" : "forbidden", "completed", NOW + (index <= 5 ? 10 : 0));
      const list = await store.listPendingNotifications(["allowed"], NOW + 20);
      expect(list.map(item => item.id)).toEqual([1, 2, 3, 4].map(uuid));
      list[0].text = "changed output";
      expect((await store.getNotification(uuid(1), NOW + 20))!.text).not.toBe("changed output");
      expect(await store.listPendingNotifications([], NOW + 20)).toEqual([]);
      expect(await store.listPendingNotifications(["allowed"], NOW + 10 + NOTIFICATION_TTL_MS)).toEqual([]);
    });

    it("has a single atomic claim winner and permanently rejects every repeat including same attempt", async () => {
      const store = factory();
      const record = await terminal(store);
      const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => store.claimNotification(record.id, uuid(index + 100), ["allowed"], NOW)));
      expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
      for (const result of results) if (result.status === "rejected") expect(result.reason).toBeInstanceOf(ConflictError);
      const claimed = await store.getNotification(record.id, NOW);
      expect(claimed).toMatchObject({ status: "claimed", attemptedAt: NOW, attemptExpiresAt: NOW + NOTIFICATION_ATTEMPT_MS });
      await expect(store.claimNotification(record.id, claimed!.attemptId!, ["allowed"], NOW)).rejects.toBeInstanceOf(ConflictError);
      expect(await store.listPendingNotifications(["allowed"], NOW)).toEqual([]);
      expect(await store.getNotification(record.id, NOW + NOTIFICATION_ATTEMPT_MS)).toMatchObject({ status: "uncertain", attemptId: claimed!.attemptId });
      await expect(store.claimNotification(record.id, attempt, ["allowed"], NOW + NOTIFICATION_ATTEMPT_MS)).rejects.toBeInstanceOf(ConflictError);
      await store.init();
      expect(await store.listPendingNotifications(["allowed"], NOW + NOTIFICATION_ATTEMPT_MS)).toEqual([]);
    });

    it("revoked or expired pending claims conflict; unknown IDs are null and deadlines clip at event expiry", async () => {
      const store = factory();
      const record = await terminal(store);
      await expect(store.claimNotification(record.id, attempt, [], NOW)).rejects.toBeInstanceOf(ConflictError);
      await expect(store.claimNotification(record.id, attempt, ["allowed"], NOW + NOTIFICATION_TTL_MS)).rejects.toBeInstanceOf(ConflictError);
      expect(await store.getNotification(record.id, NOW + NOTIFICATION_TTL_MS)).toMatchObject({ status: "expired" });
      const claimed = await store.claimNotification(record.id, attempt, ["allowed"], NOW + NOTIFICATION_TTL_MS - 1);
      expect(claimed!.attemptExpiresAt).toBe(NOW + NOTIFICATION_TTL_MS);
      expect(await store.getNotification(uuid(999), NOW)).toBeNull();
      expect(await store.claimNotification(uuid(999), attempt, ["allowed"], NOW)).toBeNull();
      expect(await store.recordNotificationReceipt(uuid(999), attempt, "accepted", NOW)).toBeNull();
    });

    it("accepts only the same attempt, preserves late evidence and accepted is irreversible", async () => {
      const store = factory();
      const record = await terminal(store);
      await expect(store.recordNotificationReceipt(record.id, attempt, "accepted", NOW)).rejects.toBeInstanceOf(ConflictError);
      await store.claimNotification(record.id, attempt, ["allowed"], NOW);
      await expect(store.recordNotificationReceipt(record.id, uuid(98), "accepted", NOW)).rejects.toBeInstanceOf(ConflictError);
      const uncertain = await store.recordNotificationReceipt(record.id, attempt, "uncertain", NOW + NOTIFICATION_ATTEMPT_MS);
      expect(await store.recordNotificationReceipt(record.id, attempt, "uncertain", NOW + NOTIFICATION_ATTEMPT_MS)).toEqual(uncertain);
      const accepted = await store.recordNotificationReceipt(record.id, attempt, "accepted", NOW + NOTIFICATION_TTL_MS + 1);
      expect(accepted!.status).toBe("accepted");
      expect(await store.recordNotificationReceipt(record.id, attempt, "uncertain", NOW + NOTIFICATION_TTL_MS + 2)).toEqual(accepted);
      expect(await store.recordNotificationReceipt(record.id, attempt, "accepted", NOW + NOTIFICATION_TTL_MS + 2)).toEqual(accepted);
      expect(await store.listPendingNotifications([], NOW + NOTIFICATION_TTL_MS + 2)).toEqual([]);
    });

    it("validates UUIDs, chat IDs and clocks before touching records", async () => {
      const store = factory();
      for (const now of [-1, NaN, 1.5]) await expect(store.listPendingNotifications(["allowed"], now)).rejects.toThrow();
      await expect(store.listPendingNotifications([" bad-chat"], NOW)).rejects.toThrow();
      await expect(store.getNotification("not-uuid", NOW)).rejects.toThrow();
      await expect(store.claimNotification(uuid(1), "not-uuid", ["allowed"], NOW)).rejects.toThrow();
      const record = execution();
      await store.createExecutionIfAbsent(record);
      await expect(store.compareAndSetExecution({ ...record, revision: 2, status: "completed" }, 1, NOW - 1)).rejects.toThrow();
      expect(await store.getExecution(record.id)).toEqual(record);
      expect(await store.getNotification(record.id, NOW)).toBeNull();
    });

    it("concurrent competing terminal CAS creates exactly the winning kind, never a second event", async () => {
      const store = factory();
      const record = execution();
      await store.createExecutionIfAbsent(record);
      const results = await Promise.all((["completed", "failed", "expired"] as const).map(status =>
        store.compareAndSetExecution({ ...record, revision: 2, status }, 1, NOW)));
      expect(results.filter(Boolean)).toHaveLength(1);
      const saved = await store.getExecution(record.id);
      const list = await store.listPendingNotifications(["allowed"], NOW);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: record.id, kind: saved!.status });
    });

    it("concurrent accepted and uncertain receipts cannot downgrade explicit success", async () => {
      const store = factory();
      const record = await terminal(store);
      const claimed = await store.claimNotification(record.id, attempt, ["allowed"], NOW);
      claimed!.attemptId = uuid(999);
      expect((await store.getNotification(record.id, NOW))!.attemptId).toBe(attempt);
      await Promise.all(["uncertain", "accepted", "uncertain", "accepted"].map(status =>
        store.recordNotificationReceipt(record.id, attempt, status as "accepted" | "uncertain", NOW)));
      expect((await store.getNotification(record.id, NOW))!.status).toBe("accepted");
    });
  });
}

it("rolls back execution and outbox together when INSERT fails, then creates both once", async () => {
  const { store, pool } = postgres();
  const record = execution();
  await store.createExecutionIfAbsent(record);
  pool.queries.length = 0;
  pool.released = 0;
  pool.failInsert = true;
  await expect(store.compareAndSetExecution({ ...record, revision: 2, status: "completed" }, 1, NOW)).rejects.toThrow("Outbox INSERT failed");
  expect(await store.getExecution(record.id)).toEqual(record);
  expect(await store.getNotification(record.id, NOW)).toBeNull();
  expect(pool.queries).not.toContain("COMMIT");
  expect(pool.queries).toContain("ROLLBACK");
  expect(pool.released).toBe(1);
  pool.failInsert = false;
  await store.compareAndSetExecution({ ...record, revision: 2, status: "completed" }, 1, NOW);
  expect((await store.getExecution(record.id))!.status).toBe("completed");
  expect((await store.getNotification(record.id, NOW))!.status).toBe("pending");
});

it("rejects forged row metadata, arbitrary text and unknown fields without publishing", async () => {
  const { store, pool } = postgres();
  const record = await terminal(store);
  const row = pool.notifications.get(record.id)!;
  row.chat_id = "forged";
  await expect(store.getNotification(record.id, NOW)).rejects.toThrow("metadata");
  row.chat_id = "allowed";
  for (const invalid of [{ ...row.data, text: "raw secret output" }, { ...row.data, output: "secret" },
    { ...row.data, executionId: uuid(999) }, { ...row.data, attemptId: attempt }]) expect(() => normalizeNotification(invalid)).toThrow();
  pool.corruptUpdate = true;
  await expect(store.claimNotification(record.id, attempt, ["allowed"], NOW)).rejects.toThrow("metadata");
  expect((await store.getNotification(record.id, NOW))!.status).toBe("pending");
  expect(pool.queries).toContain("ROLLBACK");
});

it("startup and stale CAS never backfill notifications for pre-existing terminal records", async () => {
  const sql = postgres();
  const memory = new MemoryStore();
  for (const store of [memory, sql.store]) {
    const record = await terminal(store);
    if (store === memory) (memory as unknown as { notifications: Map<string, StoredNotification> }).notifications.clear();
    else sql.pool.notifications.clear();
    await store.init();
    expect((await store.getExecution(record.id))!.status).toBe("completed");
    expect(await store.getNotification(record.id, NOW)).toBeNull();
    expect(await store.compareAndSetExecution({ ...record, revision: 2, status: "completed" }, 1, NOW)).toBeNull();
    expect(await store.getNotification(record.id, NOW)).toBeNull();
  }
});
