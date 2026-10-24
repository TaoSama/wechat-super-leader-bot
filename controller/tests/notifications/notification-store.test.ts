import { expect, it, describe, vi } from "vitest";
import pg from "pg";
import { MemoryStore } from "../../src/store/memory.js";
import { PostgresStore } from "../../src/store/postgres.js";
import { ConflictError, type IStore } from "../../src/store/interface.js";
import { PROGRESS_OUTPUT_LIMIT, progressOutputExcerpt } from "../../src/notifications/progress.js";
import { createExecution, executionRequestId, type ExecutionRecord } from "../../src/leader/plans/execution.js";
import type { CommandRecord } from "../../src/types.js";
import { normalizeNotification, NOTIFICATION_TTL_MS, NOTIFICATION_ATTEMPT_MS, NOTIFICATION_TEXT_LIMIT, type StoredNotification } from "../../src/notifications/contracts.js";

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
  on = vi.fn();
  executions = new Map<string, ExecutionRow>();
  notifications = new Map<string, NotificationRow>();
  commandRows = new Map<string, Record<string, unknown>>();
  queries: string[] = [];
  failInsert = false;
  corruptUpdate = false;
  released = 0;
  private tail = Promise.resolve();
  private result(rows: (ExecutionRow | NotificationRow)[] = []) { return { rows: structuredClone(rows) }; }
  async query(sql: string, params: unknown[] = []) {
    const query = sql.replace(/\s+/g, " ").trim();
    this.queries.push(query);
    if (query === "SELECT * FROM commands WHERE request_id = $1") {
      const row = this.commandRows.get(String(params[0]));
      return { rows: row ? [structuredClone(row)] : [] };
    }
    if (query.startsWith("SELECT ") && query.includes(" FROM commands WHERE request_id = $1")) {
      const row = this.commandRows.get(String(params[0]));
      if (query.includes("AND status IN ('accepted','completed')") && row && !["accepted", "completed"].includes(String(row.status))) return { rows: [] };
      const columns = query.slice("SELECT ".length, query.indexOf(" FROM commands")).split(",").map(column => column.trim());
      if (columns.includes("*")) return { rows: row ? [structuredClone(row)] : [] };
      return { rows: row ? [Object.fromEntries(columns.map(column => column.startsWith("CASE WHEN")
        ? ["output", row.status === "completed" && typeof row.output === "string" ? progressOutputExcerpt(row.output) : null]
        : [column, structuredClone(row[column])]))] : [] };
    }
    if (query.startsWith("SELECT pg_advisory_xact_lock(") || query.startsWith("SELECT id FROM leader_goals WHERE chat_id=$1")) return this.result();
    if (query === "SELECT version FROM controller_schema_migrations") return this.result();
    if (/^(CREATE |ALTER |DROP INDEX |INSERT INTO controller_schema_migrations|INSERT INTO known_sessions |DELETE FROM node_sessions|UPDATE commands)/.test(query)) return this.result();
    if (query === "SELECT * FROM leader_notifications WHERE ($1::text IS NULL OR id>$1) ORDER BY id LIMIT $2 FOR UPDATE") {
      return this.result([...this.notifications.values()].filter(row => params[0] === null || row.id > String(params[0]))
        .sort((a, b) => a.id.localeCompare(b.id)).slice(0, Number(params[1])));
    }
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
    if (query.startsWith("SELECT * FROM leader_notifications WHERE execution_id=$1")) {
      return this.result([...this.notifications.values()].filter(row => row.execution_id === params[0]));
    }
    if (query.startsWith("SELECT * FROM leader_notifications WHERE chat_id=ANY")) {
      expect(query).toContain("AND status='pending' AND expires_at>$2");
      expect(query).toContain("ORDER BY (kind='progress') ASC,created_at ASC,COALESCE((data->'part'->>'index')::int,1) ASC,id ASC LIMIT $3");
      expect(params[2]).toBe(1);
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

it("PostgresStore progress projects bounded completed output and excludes unfinished output/error bodies", async () => {
  const { store, pool } = postgres(), record = execution();
  await store.createExecutionIfAbsent(record);
  await store.compareAndSetExecution({ ...record, revision: 2, attempts: [{ token: attempt, startedAt: NOW, expiresAt: NOW + 15_000 }] }, 1, NOW);
  const stamp = new Date(NOW).toISOString();
  pool.commandRows.set(executionRequestId(record, 0), { command_id: "receipt", request_id: executionRequestId(record, 0),
    node_id: "node", session_id: "session", action: "send", prompt: "private prompt", status: "accepted", turn_id: "exact-turn",
    send_route: "control-socket", expires_at: new Date(NOW + 60_000).toISOString(), created_at: stamp, updated_at: stamp,
    output: "x".repeat(NOTIFICATION_TEXT_LIMIT), error: "private large error", authority: { type: "plan", id: record.id, chatId: record.chatId } });
  const source = { type: "plan" as const, id: record.id };
  const context = (await store.getProgressNotificationContext(source, NOW + 30_000))!;
  expect(context.evidence.every(item => item.output === undefined)).toBe(true);
  expect(await store.enqueueProgressNotification(source, NOW + 30_000, { eventKey: context.eventKey, text: "模型报告的真实进展" })).toMatchObject({ kind: "progress" });
  const queries = pool.queries.filter(query => query.includes(" FROM commands "));
  expect(queries).toHaveLength(2);
  const columns = queries[1].slice("SELECT ".length, queries[1].indexOf(" FROM commands")).split(",").map(column => column.trim());
  expect(columns).toEqual(["command_id", "request_id", "node_id", "session_id", "action", "prompt", "status", "expires_at", "created_at", "updated_at",
    "skills", "turn_id", "send_route", "input_receipt", "delivery_mode", "expected_turn_id", "authority", "queue_order",
    `CASE WHEN status='completed' THEN substring(output from 1 for ${PROGRESS_OUTPUT_LIMIT}) END AS output`]);
  expect(columns).not.toContain("output"); expect(columns).not.toContain("error"); expect(columns).not.toContain("*");
});

it.each(["x", "汉", "🙂"])("keeps PostgreSQL and memory completed evidence identical with bounded %s output", async character => {
  const { store, pool } = postgres(), memory = new MemoryStore(), record = execution();
  for (const target of [store, memory]) {
    await target.createExecutionIfAbsent(record);
    await target.compareAndSetExecution({ ...record, revision: 2,
      attempts: [{ token: attempt, startedAt: NOW, expiresAt: NOW + 15_000 }] }, 1, NOW);
  }
  const stamp = new Date(NOW).toISOString(), output = character.repeat(PROGRESS_OUTPUT_LIMIT + 10);
  const receipt: CommandRecord = { commandId: "completed-receipt", requestId: executionRequestId(record, 0), nodeId: "node",
    sessionId: "session", action: "send", prompt: "private prompt", status: "completed", turnId: "exact-turn",
    sendRoute: "control-socket", expiresAt: new Date(NOW + 60_000).toISOString(), createdAt: stamp, updatedAt: stamp, output };
  await memory.createCommandIfAbsent(receipt);
  pool.commandRows.set(receipt.requestId, { command_id: receipt.commandId, request_id: receipt.requestId, node_id: "node",
    session_id: "session", action: "send", prompt: receipt.prompt, status: receipt.status, turn_id: receipt.turnId,
    send_route: "control-socket", expires_at: receipt.expiresAt, created_at: stamp, updated_at: stamp, output });
  const source = { type: "plan" as const, id: record.id }, now = NOW + 30_000;
  const pgContext = await store.getProgressNotificationContext(source, now);
  expect(pgContext).toEqual(await memory.getProgressNotificationContext(source, now));
  expect(pgContext!.evidence[0].output).toBe(character.repeat(PROGRESS_OUTPUT_LIMIT));
  expect(pool.queries.filter(query => query.includes(" FROM commands ")).every(query =>
    query.includes(`CASE WHEN status='completed' THEN substring(output from 1 for ${PROGRESS_OUTPUT_LIMIT}) END AS output`))).toBe(true);
  expect(await store.enqueueProgressNotification(source, now, { eventKey: pgContext!.eventKey, text: "依据完成结果继续核查。" })).not.toBeNull();
});

it("PostgresStore includes durable queued authorization when rechecking model progress", async () => {
  const { store, pool } = postgres(), record = execution();
  await store.createExecutionIfAbsent(record);
  await store.compareAndSetExecution({ ...record, revision: 2, attempts: [{ token: attempt, startedAt: NOW, expiresAt: NOW + 15_000 }] }, 1, NOW);
  const stamp = new Date(NOW).toISOString();
  pool.commandRows.set(executionRequestId(record, 0), { command_id: "queued-receipt", request_id: executionRequestId(record, 0),
    node_id: "node", session_id: "session", action: "send", prompt: "private prompt", status: "queued",
    authority: { type: "plan", id: record.id, chatId: record.chatId }, send_route: "control-socket",
    expires_at: new Date(NOW + 60_000).toISOString(), created_at: stamp, updated_at: stamp });
  const source = { type: "plan" as const, id: record.id };
  const context = (await store.getProgressNotificationContext(source, NOW + 30_000))!;
  expect(context.evidence).toMatchObject([{ status: "queued" }]);
  expect(await store.enqueueProgressNotification(source, NOW + 30_000, { eventKey: context.eventKey, text: "任务已排队，等待会话可用。" })).toMatchObject({ kind: "progress" });
  expect(pool.queries.filter(query => query.includes(" FROM commands ")).at(-1)).toContain("authority,queue_order");
});

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
          expect(notification!.text).toContain("**任务**：private prompt");
          if (status !== "completed") expect(notification!.text).toContain("原会话中的任务可能仍在执行");
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
      expect(list.map(item => item.id)).toEqual([1].map(uuid));
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

    it("defers only the matching active attempt atomically and repeated release is idempotent", async () => {
      const store = factory(), record = await terminal(store);
      const original = await store.getNotification(record.id, NOW);
      await expect(store.deferNotification(record.id, attempt, "budget_exhausted", NOW)).rejects.toBeInstanceOf(ConflictError);
      await store.claimNotification(record.id, attempt, ["allowed"], NOW);
      const released = await Promise.all(Array.from({ length: 4 }, () =>
        store.deferNotification(record.id, attempt, "budget_exhausted", NOW + 1)));
      expect(released.every(value => JSON.stringify(value) === JSON.stringify(released[0]))).toBe(true);
      expect(released[0]).toEqual({ ...original, lastDeferredAttemptId: attempt, lastDeferReason: "budget_exhausted" });
      expect(released[0]).not.toHaveProperty("attemptId");
      expect((await store.listPendingNotifications(["allowed"], NOW + 2)).map(value => value.id)).toEqual([record.id]);
      await store.init();
      expect(await store.getNotification(record.id, NOW + 2)).toEqual(released[0]);
      await expect(store.deferNotification(record.id, attempt, "window_expired", NOW + 2)).rejects.toBeInstanceOf(ConflictError);
      await expect(store.claimNotification(record.id, attempt, ["allowed"], NOW + 2)).rejects.toBeInstanceOf(ConflictError);
      const next = await store.claimNotification(record.id, uuid(100), ["allowed"], NOW + 2);
      await expect(store.deferNotification(record.id, attempt, "budget_exhausted", NOW + 3)).rejects.toBeInstanceOf(ConflictError);
      await expect(store.recordNotificationReceipt(record.id, attempt, "accepted", NOW + 3)).rejects.toBeInstanceOf(ConflictError);
      expect(await store.getNotification(record.id, NOW + 3)).toEqual(next);
      const again = await store.deferNotification(record.id, uuid(100), "context_changed", NOW + 3);
      expect(again).toMatchObject({ status: "pending", lastDeferredAttemptId: uuid(100), lastDeferReason: "context_changed" });
      expect(again!.text).toBe(original!.text);
      expect(again!.expiresAt).toBe(original!.expiresAt);
      expect(await store.deferNotification(uuid(999), attempt, "budget_exhausted", NOW)).toBeNull();
    });

    it("never releases an expired lease, expired event, explicit uncertainty or accepted result", async () => {
      const store = factory();
      for (const [index, status] of (["claimed", "uncertain", "accepted"] as const).entries()) {
        const record = await terminal(store, index + 1);
        await store.claimNotification(record.id, attempt, ["allowed"], NOW);
        if (status !== "claimed") await store.recordNotificationReceipt(record.id, attempt, status, NOW + 1);
        const at = status === "claimed" ? NOW + NOTIFICATION_ATTEMPT_MS : NOW + 2;
        const before = await store.getNotification(record.id, at);
        await expect(store.deferNotification(record.id, attempt, "window_expired", at)).rejects.toBeInstanceOf(ConflictError);
        expect(await store.getNotification(record.id, at)).toEqual(before);
        expect(await store.listPendingNotifications(["allowed"], at)).toEqual([]);
      }
      const expired = await terminal(store, 10);
      await store.claimNotification(expired.id, attempt, ["allowed"], NOW + NOTIFICATION_TTL_MS - 1);
      await expect(store.deferNotification(expired.id, attempt, "window_expired", NOW + NOTIFICATION_TTL_MS)).rejects.toBeInstanceOf(ConflictError);
      const pending = await terminal(store, 11);
      await store.claimNotification(pending.id, uuid(200), ["allowed"], NOW);
      await store.deferNotification(pending.id, uuid(200), "budget_exhausted", NOW + 1);
      await expect(store.deferNotification(pending.id, uuid(200), "budget_exhausted", NOW + NOTIFICATION_TTL_MS)).rejects.toBeInstanceOf(ConflictError);
      expect((await store.getNotification(pending.id, NOW + NOTIFICATION_TTL_MS))!.status).toBe("expired");
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

it("rejects forged row metadata, invalid text and unknown fields without publishing", async () => {
  const { store, pool } = postgres();
  const record = await terminal(store);
  const row = pool.notifications.get(record.id)!;
  row.chat_id = "forged";
  await expect(store.getNotification(record.id, NOW)).rejects.toThrow("metadata");
  row.chat_id = "allowed";
  for (const invalid of [{ ...row.data, text: " " }, { ...row.data, text: "x".repeat(NOTIFICATION_TEXT_LIMIT + 1) }, { ...row.data, output: "secret" },
    { ...row.data, executionId: uuid(999) }, { ...row.data, attemptId: attempt },
    { ...row.data, lastDeferredAttemptId: attempt }, { ...row.data, lastDeferReason: "budget_exhausted" },
    { ...row.data, lastDeferredAttemptId: attempt, lastDeferReason: "retry" }]) expect(() => normalizeNotification(invalid)).toThrow();
  pool.corruptUpdate = true;
  await expect(store.claimNotification(record.id, attempt, ["allowed"], NOW)).rejects.toThrow("metadata");
  expect((await store.getNotification(record.id, NOW))!.status).toBe("pending");
  expect(pool.queries).toContain("ROLLBACK");
});

it("Postgres defer locks before checking ownership and rolls back a failed locked update", async () => {
  const { store, pool } = postgres(), record = await terminal(store);
  const claimed = await store.claimNotification(record.id, attempt, ["allowed"], NOW);
  pool.queries.length = 0;
  pool.corruptUpdate = true;
  await expect(store.deferNotification(record.id, attempt, "budget_exhausted", NOW + 1)).rejects.toThrow("metadata");
  expect(pool.queries[0]).toBe("BEGIN");
  expect(pool.queries[1]).toBe("SELECT * FROM leader_notifications WHERE id=$1 FOR UPDATE");
  expect(pool.queries.at(-1)).toBe("ROLLBACK");
  expect(pool.queries).not.toContain("COMMIT");
  expect(await store.getNotification(record.id, NOW + 1)).toEqual(claimed);
  pool.corruptUpdate = false;
  expect(await store.deferNotification(record.id, attempt, "budget_exhausted", NOW + 1)).toMatchObject({ status: "pending" });
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

it.each(["memory", "postgres"] as const)("%s terminal CAS captures only the bound command result in its outbox", async kind => {
  const sql = postgres(), memory = new MemoryStore(), store = kind === "memory" ? memory : sql.store;
  const record = execution();
  await store.createExecutionIfAbsent(record);
  const claimed = { ...record, revision: 2, attempts: [{ token: attempt, startedAt: NOW, expiresAt: NOW + 15_000 }] };
  await store.compareAndSetExecution(claimed, 1, NOW);
  const stamp = new Date(NOW).toISOString();
  const command: CommandRecord = { commandId: "result-command", requestId: executionRequestId(record, 0), nodeId: "node", sessionId: "session",
    prompt: "private prompt", action: "send", sendRoute: "control-socket", status: "pending", createdAt: stamp,
    updatedAt: stamp, expiresAt: new Date(NOW + 60_000).toISOString() };
  if (kind === "memory") {
    await store.createCommandIfAbsent(command);
    await store.updateCommandStatus(command.commandId, "accepted", undefined, undefined, "bound-turn");
    await store.updateCommandStatus(command.commandId, "completed", "核验结果：所有订单金额一致", undefined, "bound-turn");
  } else sql.pool.commandRows.set(command.requestId, { command_id: command.commandId, request_id: command.requestId,
    node_id: command.nodeId, session_id: command.sessionId, prompt: command.prompt, action: "send", send_route: command.sendRoute,
    status: "completed", turn_id: "bound-turn", output: "核验结果：所有订单金额一致", created_at: stamp, updated_at: stamp, expires_at: command.expiresAt });
  await store.compareAndSetExecution({ ...claimed, revision: 3, status: "completed" }, 2, NOW);
  const notification = (await store.getNotification(record.id, NOW))!;
  expect(notification.text).toContain("**任务**：private prompt");
  expect(notification.text).toContain("核验结果：所有订单金额一致");
  if (kind === "postgres") {
    const read = sql.pool.queries.lastIndexOf("SELECT * FROM commands WHERE request_id = $1");
    expect(read).toBeGreaterThan(sql.pool.queries.lastIndexOf("BEGIN"));
    expect(sql.pool.queries.findIndex((query, index) => index > read && query.startsWith("INSERT INTO leader_notifications"))).toBeGreaterThan(read);
  }
});

it("memory completion rechecks CAS after awaiting its result and does not override cancellation", async () => {
  const store = new MemoryStore(), record = execution();
  await store.createExecutionIfAbsent(record);
  const claimed = { ...record, revision: 2, attempts: [{ token: attempt, startedAt: NOW, expiresAt: NOW + 15_000 }] };
  await store.compareAndSetExecution(claimed, 1, NOW);
  let release!: () => void;
  const entered = new Promise<void>(resolve => {
    vi.spyOn(store, "findCommandByRequestId").mockImplementation(async () => {
      resolve(); await new Promise<void>(done => { release = done; }); return null;
    });
  });
  const completion = store.compareAndSetExecution({ ...claimed, revision: 3, status: "completed" }, 2, NOW);
  await entered;
  expect(await store.compareAndSetExecution({ ...claimed, revision: 3, status: "cancelled" }, 2, NOW)).not.toBeNull();
  release(); expect(await completion).toBeNull();
  expect((await store.getExecution(record.id))!.status).toBe("cancelled");
  expect(await store.getNotification(record.id, NOW)).toBeNull();
});
