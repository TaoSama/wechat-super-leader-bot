import { randomUUID } from "node:crypto";
import pg from "pg";
import { expect, it, vi } from "vitest";
import { PostgresStore } from "../../src/store/postgres.js";
import { MemoryStore } from "../../src/store/memory.js";
import { createExecution, executionRequestId } from "../../src/leader/plans/execution.js";
import { createGoal, goalRequestId } from "../../src/leader/goals/goal.js";
import { proposal, lease, commit, nextDecision } from "../fixtures/goals.js";
import { ModelProgressRunner } from "../../src/notifications/model-progress.js";
import { PROGRESS_OUTPUT_LIMIT } from "../../src/notifications/progress.js";
import { claimNotificationRecord, receiptNotificationRecord, normalizeNotification, LEGACY_NOTIFICATION_ATTEMPT_MS,
  type NotificationSource, type StoredNotification } from "../../src/notifications/contracts.js";
import type { LeaderModel } from "../../src/leader/model/contracts.js";
import type { CommandRecord } from "../../src/types.js";

const databaseUrl = process.env.NOTIFICATION_TEST_DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (url.hostname !== "127.0.0.1" || !url.pathname.startsWith("/notification_collector_test"))
    throw new Error("NOTIFICATION_TEST_DATABASE_URL requires a disposable loopback notification_collector_test database");
}
const NOW = 1_800_000_000_000;
const FIRST = NOW + 30_000;
const TIMEOUT_MS = 30_000;
async function inSchema(run: (store: PostgresStore, pool: pg.Pool, reopen: () => Promise<PostgresStore>) => Promise<void>) {
  const schema = `model_progress_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const scoped = new URL(databaseUrl!); scoped.searchParams.set("options", `-c search_path=${schema}`);
  const pool = new pg.Pool({ connectionString: scoped.toString() });
  const stores: PostgresStore[] = [];
  const reopen = async () => {
    const store = new PostgresStore(scoped.toString()); stores.push(store); await store.init(); return store;
  };
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await run(await reopen(), pool, reopen);
  } finally {
    await Promise.all(stores.map(store => store.close()));
    await pool.end();
    try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { await admin.end(); }
  }
}
function initial() {
  return createExecution("synthetic-chat", { id: randomUUID(), expiresAt: NOW + 60_000, actions: [
    { nodeId: "synthetic-node", sessionId: "synthetic-thread", prompt: "核查实际进展", sendRoute: "control-socket", dependsOn: [] },
  ] }, NOW);
}

it.skipIf(!databaseUrl).each(["plan", "goal"] as const)("preserves real PostgreSQL %s admission evidence through model generation and atomic enqueue", async kind => {
  await inSchema(async (store, pool) => {
    const memory = new MemoryStore(), stamp = new Date(NOW).toISOString();
    const attempt = { token: randomUUID(), startedAt: NOW, expiresAt: NOW + 15_000 };
    const base = { commandId: randomUUID(), action: "send" as const, status: "admitting" as const,
      authority: { type: "admin" as const }, createdAt: stamp, updatedAt: stamp,
      output: "unsent text is not a completed result", expiresAt: new Date(NOW + 600_000).toISOString() };
    let source: NotificationSource, receipt: CommandRecord;
    if (kind === "plan") {
      const record = initial();
      source = { type: kind, id: record.id };
      for (const backend of [store, memory]) {
        await backend.createExecutionIfAbsent(record);
        expect(await backend.compareAndSetExecution({ ...record, revision: 2, attempts: [attempt] }, 1, NOW)).not.toBeNull();
      }
      receipt = { ...base, requestId: executionRequestId(record, 0), ...record.plan.actions[0] };
    } else {
      const record = createGoal("synthetic-chat", proposal(NOW), NOW), leased = lease(record), decided = commit(leased, nextDecision());
      const claimed = structuredClone(decided); claimed.revision++; claimed.actions[0].attempt = attempt;
      source = { type: kind, id: record.id };
      for (const backend of [store, memory]) {
        const confirmation = await backend.compareAndSetLeaderState(record.chatId, 0, {
          inflight: { messageId: "confirm", inputHash: "hash", expiresAt: record.proposal.expiresAt, goal: record.proposal } });
        await backend.confirmGoal(record, { revision: confirmation!.revision, messageId: "confirm", inputHash: "hash" }, () => NOW);
        expect(await backend.compareAndSetGoal(leased, 1, () => NOW)).not.toBeNull();
        expect(await backend.compareAndSetGoal(decided, 2, () => NOW)).not.toBeNull();
        expect(await backend.compareAndSetGoal(claimed, 3, () => NOW)).not.toBeNull();
      }
      receipt = { ...base, requestId: goalRequestId(claimed, 0), ...record.proposal.targets[0], prompt: claimed.actions[0].input.prompt };
    }
    for (const backend of [store, memory]) await backend.createCommandIfAbsent(receipt);
    const context = (await store.getProgressNotificationContext(source, FIRST))!;
    expect(context).not.toBeNull();
    expect(context).toEqual(await memory.getProgressNotificationContext(source, FIRST));
    expect(context.evidence).toMatchObject([{ status: "claimed", commandId: receipt.commandId }]);
    expect(context.evidence[0]).not.toHaveProperty("output");
    expect((await store.getProgressNotificationContext(source, FIRST + 1))?.eventKey).toBe(context.eventKey);
    const reportText = "请求已经保存，尚未发送。";
    const complete = vi.fn<LeaderModel["complete"]>().mockImplementation(async messages => {
      if (messages.some(message => message.role === "tool")) return { content: "", toolCalls: [] };
      expect(JSON.parse(messages[1].content!).evidence).toMatchObject([{ status: "claimed", commandId: receipt.commandId }]);
      return { content: null, toolCalls: [{ id: randomUUID(), type: "function", function: {
        name: "report_progress", arguments: JSON.stringify({ text: reportText }),
      } }] };
    });
    const runner = new ModelProgressRunner(store, { complete }, () => FIRST);
    try { await runner.request(source); }
    finally { await runner.stop(); }
    expect(complete).toHaveBeenCalledTimes(2);
    const column = kind === "plan" ? "execution_id" : "goal_id";
    const rows = await pool.query(`SELECT data FROM leader_notifications WHERE ${column}=$1`, [source.id]);
    expect(rows.rows).toHaveLength(1);
    expect(normalizeNotification(rows.rows[0].data)).toMatchObject({ kind: "progress", text: reportText,
      progress: { sequence: 1, eventKey: context.eventKey } });
    expect((await store.getCommand(receipt.commandId))?.status).toBe("admitting");
    const nextTime = FIRST + 60_000;
    expect(await store.getProgressNotificationContext(source, nextTime)).toBeNull();
    expect(await store.admitCommand(receipt.commandId)).not.toBeNull();
    const next = (await store.getProgressNotificationContext(source, nextTime))!;
    expect(next.evidence[0].status).toBe("queued");
    expect(next.eventKey).not.toBe(context.eventKey);
    expect(await store.enqueueProgressNotification(source, nextTime, { eventKey: context.eventKey, text: "stale draft" })).toBeNull();
    expect(await store.enqueueProgressNotification(source, nextTime, { eventKey: next.eventKey, text: "current queued draft" }))
      .toMatchObject({ kind: "progress", progress: { sequence: 2, eventKey: next.eventKey } });
  });
}, TIMEOUT_MS);

it.skipIf(!databaseUrl)("uses real PostgreSQL bounded Unicode completion evidence, model tools, atomic claims and terminal rejection", async () => {
  await inSchema(async (store, pool, reopen) => {
    for (const character of ["x", "汉", "🙂"]) {
      const memory = new MemoryStore();
      const record = initial(), attempt = { token: randomUUID(), startedAt: NOW, expiresAt: NOW + 15_000 };
      const stamp = new Date(NOW).toISOString();
      const output = character.repeat(PROGRESS_OUTPUT_LIMIT + 100);
      const receipt: CommandRecord = { commandId: randomUUID(), requestId: executionRequestId(record, 0),
        nodeId: "synthetic-node", sessionId: "synthetic-thread", prompt: "核查实际进展", action: "send",
        sendRoute: "control-socket", status: "completed", turnId: "exact-turn", output,
        createdAt: stamp, updatedAt: stamp, expiresAt: new Date(NOW + 60_000).toISOString() };
      for (const target of [store, memory]) {
        await target.createExecutionIfAbsent(record);
        await target.compareAndSetExecution({ ...record, revision: 2, attempts: [attempt] }, 1, NOW);
        await target.createCommandIfAbsent(receipt);
      }
      const source = { type: "plan" as const, id: record.id };
      const context = (await store.getProgressNotificationContext(source, FIRST))!;
      expect(context).toEqual(await memory.getProgressNotificationContext(source, FIRST));
      expect(context.evidence[0].output).toBe(character.repeat(PROGRESS_OUTPUT_LIMIT));
      const projected = await pool.query("SELECT char_length(CASE WHEN status='completed' THEN substring(output from 1 for $1) END) AS length FROM commands WHERE command_id=$2",
        [PROGRESS_OUTPUT_LIMIT, receipt.commandId]);
      expect(projected.rows[0].length).toBe(PROGRESS_OUTPUT_LIMIT);
      const complete = vi.fn<LeaderModel["complete"]>().mockImplementation(async messages => {
        if (messages.some(message => message.role === "tool")) {
          expect(JSON.parse(messages.find(message => message.role === "tool")!.content!)).toEqual({ status: "queued", remaining: 2, limit: 3 });
          return { content: "", toolCalls: [] };
        }
        expect(JSON.parse(messages[1].content!).evidence[0].output).toBe(character.repeat(PROGRESS_OUTPUT_LIMIT));
        return { content: null, toolCalls: [{ id: randomUUID(), type: "function", function: {
          name: "report_progress", arguments: JSON.stringify({ text: `已核实这部分结果，正在继续检查 ${character}。` }),
        } }] };
      });
      const runner = new ModelProgressRunner(store, { complete }, () => FIRST);
      try { await runner.request(source); }
      finally { await runner.stop(); }
      expect(complete).toHaveBeenCalledTimes(2);
      const rows = await pool.query("SELECT data FROM leader_notifications WHERE execution_id=$1", [record.id]);
      const notification = normalizeNotification(rows.rows[0].data);
      expect(notification.text).toBe(`已核实这部分结果，正在继续检查 ${character}。`);
      expect(notification.kind).toBe("progress");
      expect(await store.enqueueProgressNotification(source, FIRST + 60_000, { eventKey: context.eventKey, text: "重复进度" })).toBeNull();
      const claims = await Promise.allSettled(Array.from({ length: 4 }, () => store.claimNotification(notification.id, randomUUID(), ["synthetic-chat"], FIRST)));
      const successes = claims.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<PostgresStore["claimNotification"]>>> => item.status === "fulfilled" && item.value !== null);
      expect(successes).toHaveLength(1);
      const claimed = successes[0].value!;
      await store.recordNotificationReceipt(claimed.id, claimed.attemptId!, "uncertain", FIRST + 1);
      const restarted = await reopen();
      expect((await restarted.getNotification(claimed.id, FIRST + 1))!.status).toBe("uncertain");
      const active = (await store.getExecution(record.id))!;
      await store.compareAndSetExecution({ ...active, revision: active.revision + 1, status: "completed" }, active.revision, FIRST + 2);
      expect(await store.enqueueProgressNotification(source, FIRST + 60_000, { eventKey: context.eventKey, text: "已过时的模型草稿" })).toBeNull();
    }
  });
}, TIMEOUT_MS);

it.skipIf(!databaseUrl)("migrates real legacy notification statuses without changing text or permanent attempts and preserves current progress on repeated startup", async () => {
  await inSchema(async (store, pool, reopen) => {
    const legacyRows: { id: string; data: Record<string, unknown>; notification: StoredNotification }[] = [];
    for (const status of ["pending", "claimed", "accepted", "uncertain"] as const) {
      const record = initial();
      await store.createExecutionIfAbsent(record);
      await store.compareAndSetExecution({ ...record, revision: 2, status: "failed" }, 1, NOW);
      const row = (await pool.query("SELECT data FROM leader_notifications WHERE id=$1", [record.id])).rows[0];
      let notification = normalizeNotification(row.data);
      notification.text = `完整保留历史正文：${status}。`;
      if (status !== "pending") {
        notification = claimNotificationRecord(notification, randomUUID(), ["synthetic-chat"], NOW + 1);
        notification.attemptExpiresAt = NOW + 1 + LEGACY_NOTIFICATION_ATTEMPT_MS;
      }
      if (status === "accepted" || status === "uncertain")
        notification = receiptNotificationRecord(notification, notification.attemptId!, status, NOW + 2);
      const { source, ...fields } = notification;
      legacyRows.push({ id: record.id, data: { ...fields, executionId: source.id }, notification });
    }
    await pool.query("DROP TABLE leader_notifications");
    await pool.query(`CREATE TABLE leader_notifications (
      id VARCHAR(36) COLLATE "C" PRIMARY KEY, execution_id VARCHAR(36) COLLATE "C" NOT NULL UNIQUE REFERENCES leader_executions(id),
      chat_id VARCHAR(64) NOT NULL, kind VARCHAR(16) NOT NULL, status VARCHAR(16) NOT NULL,
      created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, data JSONB NOT NULL)`);
    for (const previous of legacyRows) await pool.query(`INSERT INTO leader_notifications
      (id,execution_id,chat_id,kind,status,created_at,expires_at,data) VALUES ($1,$1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [previous.id, previous.notification.chatId, previous.notification.kind, previous.notification.status,
      previous.notification.createdAt, previous.notification.expiresAt, JSON.stringify(previous.data)]);
    const migrated = await reopen();
    for (const previous of legacyRows) {
      const persisted = (await pool.query("SELECT * FROM leader_notifications WHERE id=$1", [previous.id])).rows[0];
      expect(persisted.data).toEqual(previous.notification);
      expect(persisted.goal_id).toBeNull();
      expect(persisted.created_at).toBe(String(previous.notification.createdAt));
      expect(persisted.status).toBe(previous.notification.status);
      expect((await migrated.getNotification(previous.id, NOW + 2))!.attemptId).toBe(previous.notification.attemptId);
    }
    const record = initial(); await migrated.createExecutionIfAbsent(record);
    const source = { type: "plan" as const, id: record.id };
    const context = (await migrated.getProgressNotificationContext(source, FIRST))!;
    const progress = (await migrated.enqueueProgressNotification(source, FIRST, { eventKey: context.eventKey, text: "已经保存的模型进度正文。" }))!;
    const before = (await pool.query("SELECT * FROM leader_notifications ORDER BY id")).rows;
    const restarted = await reopen(); await restarted.init();
    expect((await pool.query("SELECT * FROM leader_notifications ORDER BY id")).rows).toEqual(before);
    expect((await restarted.getNotification(progress.id, FIRST))!.text).toBe(progress.text);
    expect(await restarted.enqueueProgressNotification(source, FIRST + 60_000, { eventKey: context.eventKey, text: "重启重复发送" })).toBeNull();
  });
}, TIMEOUT_MS);
