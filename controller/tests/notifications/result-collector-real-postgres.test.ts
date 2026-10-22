import { randomUUID } from "node:crypto";
import pg from "pg";
import { expect, it, vi } from "vitest";
import { PostgresStore } from "../../src/store/postgres.js";
import { createExecution, executionRequestId, type ExecutionRecord } from "../../src/leader/plans/execution.js";
import { NotificationResultCollector } from "../../src/notifications/result-collector.js";
import { PostgresDeliveryRepository, initDeliveryTables } from "../../src/deliveries/postgres.js";
import { ResultDeliveryService } from "../../src/deliveries/service.js";

const databaseUrl = process.env.NOTIFICATION_TEST_DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (url.hostname !== "127.0.0.1" || !url.pathname.startsWith("/notification_collector_test"))
    throw new Error("NOTIFICATION_TEST_DATABASE_URL requires a disposable loopback notification_collector_test database");
}
const NOW = 1_800_000_000_000;
function initial(): ExecutionRecord {
  return createExecution("synthetic-chat", { id: randomUUID(), expiresAt: NOW + 60_000,
    actions: [{ nodeId: "synthetic-node", sessionId: "synthetic-thread", prompt: "Collect persisted evidence",
      sendRoute: "control-socket", dependsOn: [] }] }, NOW);
}

it.skipIf(!databaseUrl)("persists conversion markers without delivery-table coupling and keeps new progress ahead of converted history", async () => {
  const schema = `notification_collector_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const scoped = new URL(databaseUrl!); scoped.searchParams.set("options", `-c search_path=${schema}`);
  const pool = new pg.Pool({ connectionString: scoped.toString() });
  const store = new PostgresStore(scoped.toString());
  let reopened: PostgresStore | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await store.init();
    expect((await pool.query("SELECT to_regclass('result_deliveries') AS delivery_table")).rows[0].delivery_table).toBeNull();
    expect(await store.listNotificationCandidates(["synthetic-chat"], NOW)).toEqual([]);
    await initDeliveryTables(pool);
    const repository = new PostgresDeliveryRepository(pool);
    const complete = vi.fn(async () => ({ content: "Persisted model summary", toolCalls: [] }));
    const results = new ResultDeliveryService(repository, { model: { complete }, now: () => NOW,
      publicUrl: "https://synthetic.example", signingSecret: "synthetic-signing-key-at-least-32-characters" });
    const terminal = async (output?: string) => {
      const record = initial();
      await store.createExecutionIfAbsent(record);
      let active = record;
      if (output) {
        active = (await store.compareAndSetExecution({ ...record, revision: 2,
          attempts: [{ token: randomUUID(), startedAt: NOW, expiresAt: NOW + 15_000 }] }, 1, NOW))!;
        const stamp = new Date(NOW).toISOString();
        await store.createCommandIfAbsent({ commandId: randomUUID(), requestId: executionRequestId(active, 0),
          nodeId: "synthetic-node", sessionId: "synthetic-thread", action: "send", sendRoute: "control-socket",
          prompt: active.plan.actions[0].prompt, status: "completed", turnId: "synthetic-exact-turn", output,
          createdAt: stamp, updatedAt: stamp, expiresAt: new Date(NOW + 60_000).toISOString() });
      }
      await store.compareAndSetExecution({ ...active, revision: active.revision + 1, status: "completed" }, active.revision, NOW);
      return record.id;
    };
    for (let index = 0; index < 40; index++) await terminal();
    const collector = new NotificationResultCollector(store, results);
    while ((await collector.collect(["synthetic-chat"], NOW)).scanned) { /* exhaust bounded conversion pages */ }
    expect((await pool.query("SELECT count(*) FROM leader_notifications WHERE result_delivery_id IS NOT NULL")).rows[0].count).toBe("40");
    expect((await store.listPendingNotifications(["synthetic-chat"], NOW))[0].status).toBe("pending");
    const longId = await terminal("Complete immutable result\n".repeat(1_000));
    complete.mockRejectedValue(new Error("Synthetic model outage"));
    expect(await collector.collect(["synthetic-chat"], NOW)).toMatchObject({ prepared: 1, failures: [] });
    expect((await repository.get(longId, NOW))?.status).toBe("preparing");
    for (let tick = 0; tick < 10; tick++) expect(await collector.collect(["synthetic-chat"], NOW)).toMatchObject({ scanned: 0 });
    expect(complete).toHaveBeenCalledTimes(1);
    reopened = new PostgresStore(scoped.toString());
    await reopened.init();
    const restarted = new NotificationResultCollector(reopened, results);
    expect(await restarted.collect(["synthetic-chat"], NOW)).toMatchObject({ scanned: 0 });
    const running = initial(); await reopened.createExecutionIfAbsent(running);
    const active = (await reopened.compareAndSetExecution({ ...running, revision: 2,
      attempts: [{ token: randomUUID(), startedAt: NOW, expiresAt: NOW + 15_000 }] }, 1, NOW))!;
    const stamp = new Date(NOW).toISOString();
    await reopened.createCommandIfAbsent({ commandId: randomUUID(), requestId: executionRequestId(active, 0),
      nodeId: "synthetic-node", sessionId: "synthetic-thread", action: "send", sendRoute: "control-socket",
      prompt: active.plan.actions[0].prompt, status: "accepted", turnId: "synthetic-exact-progress",
      createdAt: stamp, updatedAt: stamp, expiresAt: new Date(NOW + 60_000).toISOString() });
    const progress = (await reopened.enqueueProgressNotification({ type: "plan", id: running.id }, NOW + 30_000, { eventKey: (await reopened.getProgressNotificationContext({ type: "plan", id: running.id }, NOW + 30_000))!.eventKey, text: "模型进展" }))!;
    expect(progress).not.toBeNull();
    expect(await restarted.collect(["synthetic-chat"], NOW + 30_000)).toMatchObject({ scanned: 1, prepared: 1, failures: [] });
    expect((await repository.get(progress.id, NOW + 30_000))?.kind).toBe("progress");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(await reopened.listNotificationCandidates(["synthetic-chat"], NOW + 30_000)).toEqual([]);
    await expect(reopened.markNotificationPrepared(progress.id, randomUUID())).rejects.toThrow("conflicts");
  } finally {
    await reopened?.close(); await store.close(); await pool.end();
    try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { await admin.end(); }
  }
}, 20_000);
