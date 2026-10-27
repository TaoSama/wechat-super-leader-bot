import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createReliabilityPostgresFixture } from "../../../tests/support/reliability-postgres.mjs";
import { createExecution } from "../../src/leader/plans/execution.js";
import { NOTIFICATION_ATTEMPT_MS } from "../../src/notifications/contracts.js";
import { ConflictError } from "../../src/store/interface.js";
import { PostgresStore } from "../../src/store/postgres.js";

const NOW = 1_700_000_000_000;
const HOOK_TIMEOUT_MS = 180_000;
const CHAT_ID = "deferred-notification-test";

describe.skipIf(process.env.RUN_POSTGRES_INTEGRATION !== "1")("notification defer in isolated PostgreSQL", () => {
  const fixtureEvents: string[] = [];
  const fixture = createReliabilityPostgresFixture({ env: process.env, evidence: (event: string) => { fixtureEvents.push(event); } });
  const stores: PostgresStore[] = [];
  let pool: pg.Pool;
  beforeAll(async () => {
    const url = await fixture.start();
    pool = new pg.Pool({ connectionString: url });
    stores.push(new PostgresStore(url), new PostgresStore(url));
    await stores[0].init();
  }, HOOK_TIMEOUT_MS);
  afterAll(async () => {
    const cleanup = await Promise.allSettled([...stores.map(store => store.close()), ...(pool ? [pool.end()] : [])]);
    await fixture.stop();
    for (const result of cleanup) if (result.status === "rejected") throw result.reason;
    expect(fixtureEvents.at(-1)).toBe("database-container-removed");
  }, HOOK_TIMEOUT_MS);

  async function claimed() {
    const record = createExecution(CHAT_ID, { id: randomUUID(), expiresAt: NOW + 600_000,
      actions: [{ nodeId: "fixture", sessionId: "session", prompt: "durable reply", sendRoute: "control-socket" }] }, NOW);
    await stores[0].createExecutionIfAbsent(record);
    await stores[0].compareAndSetExecution({ ...record, revision: 2, status: "completed" }, 1, NOW);
    const attemptId = randomUUID();
    const notification = await stores[0].claimNotification(record.id, attemptId, [CHAT_ID], NOW);
    return { id: record.id, attemptId, notification };
  }

  it("concurrent identical defers are idempotent and stale attempts cannot release a fresh claim", async () => {
    const { id, attemptId, notification } = await claimed();
    const results = await Promise.all(stores.map(store => store.deferNotification(id, attemptId, "budget_exhausted", NOW + 1)));
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ status: "pending", lastDeferredAttemptId: attemptId, lastDeferReason: "budget_exhausted",
      text: notification!.text, expiresAt: notification!.expiresAt });
    const nextId = randomUUID();
    const next = await stores[1].claimNotification(id, nextId, [CHAT_ID], NOW + 2);
    await expect(stores[0].deferNotification(id, attemptId, "budget_exhausted", NOW + 3)).rejects.toBeInstanceOf(ConflictError);
    expect(await stores[1].getNotification(id, NOW + 3)).toEqual(next);
    await expect(stores[0].deferNotification(id, nextId, "window_expired", NOW + 2 + NOTIFICATION_ATTEMPT_MS)).rejects.toBeInstanceOf(ConflictError);
    expect((await stores[1].getNotification(id, NOW + 2 + NOTIFICATION_ATTEMPT_MS))!.status).toBe("uncertain");
  });

  it("a concurrent defer and uncertain receipt has one winner and can never reopen uncertainty", async () => {
    const { id, attemptId } = await claimed();
    const results = await Promise.allSettled([
      stores[0].deferNotification(id, attemptId, "context_changed", NOW + 1),
      stores[1].recordNotificationReceipt(id, attemptId, "uncertain", NOW + 1),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason instanceof ConflictError).toBe(true);
    const saved = await stores[0].getNotification(id, NOW + 1);
    if (saved!.status === "uncertain") {
      await expect(stores[1].deferNotification(id, attemptId, "context_changed", NOW + 2)).rejects.toBeInstanceOf(ConflictError);
    } else {
      expect(saved!.status).toBe("pending");
      await expect(stores[1].recordNotificationReceipt(id, attemptId, "uncertain", NOW + 2)).rejects.toBeInstanceOf(ConflictError);
    }
  });

  it("rolls back a database failure and leaves the original claim intact", async () => {
    const { id, attemptId, notification } = await claimed();
    await pool.query("ALTER TABLE leader_notifications ADD CONSTRAINT reject_test_defer CHECK (NOT (data ? 'lastDeferredAttemptId')) NOT VALID");
    try {
      await expect(stores[0].deferNotification(id, attemptId, "budget_exhausted", NOW + 1)).rejects.toThrow();
      expect(await stores[1].getNotification(id, NOW + 1)).toEqual(notification);
    } finally {
      await pool.query("ALTER TABLE leader_notifications DROP CONSTRAINT reject_test_defer");
    }
    expect(await stores[1].deferNotification(id, attemptId, "budget_exhausted", NOW + 2)).toMatchObject({ status: "pending" });
  });
});
