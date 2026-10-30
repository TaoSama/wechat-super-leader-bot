import { randomUUID } from "node:crypto";
import pg from "pg";
import { expect, it, vi } from "vitest";
import { initDeliveryTables, PostgresDeliveryRepository } from "../../src/deliveries/postgres.js";
import { ResultDeliveryService } from "../../src/deliveries/service.js";
import { DELIVERY_ATTEMPT_MS, type DeliveryPlan } from "../../src/deliveries/contracts.js";

const databaseUrl = process.env.RESULT_TEST_DATABASE_URL;
it.skipIf(!databaseUrl)("persists artifacts and cached summaries across process repositories with atomic worker claims", async () => {
  const schema = `result_delivery_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const client = await pool.connect();
    try { await initDeliveryTables(client); await initDeliveryTables(client); }
    finally { client.release(); }
    const repository = new PostgresDeliveryRepository(pool);
    const complete = vi.fn(async () => ({ content: "真实模型生成的任务摘要", toolCalls: [] }));
    const now = 1_800_000_000_000;
    const options = { publicUrl: "https://results.example", signingSecret: "test-signing-secret-with-at-least-32-characters", model: { complete }, now: () => now };
    const service = new ResultDeliveryService(repository, options);
    const result = { key: randomUUID(), chatId: "allowed", text: "😀完整Markdown\n".repeat(2000),
      source: { type: "plan", id: randomUUID() }, kind: "completed", createdAt: now, expiresAt: now + 3_600_000 };
    const plans = await Promise.all(Array.from({ length: 8 }, () => service.prepareResult(result)));
    expect(new Set(plans.map(plan => plan.id)).size).toBe(1);
    const restarted = new ResultDeliveryService(new PostgresDeliveryRepository(pool), options);
    const plan = await restarted.prepareResult(result);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(plan.status).toBe("ready");
    expect((await repository.getArtifact(plan.artifact.id))?.bytes.toString("utf8")).toBe(result.text);
    expect(await repository.listPending(["forbidden"], now)).toEqual([]);
    expect(await repository.listPending(["allowed"], now)).toHaveLength(1);
    const claims = await Promise.all(Array.from({ length: 6 }, () => repository.claim(plan.id, randomUUID(), now)));
    expect(claims.filter(Boolean)).toHaveLength(1);
    const attempt = claims.find(Boolean)!.attemptId!;
    expect((await repository.defer(plan.id, attempt, "window_closed", now))?.status).toBe("waiting_for_user");
    expect(await repository.resumeChat("allowed", now)).toBe(1);
    const nextAttempt = randomUUID();
    expect(await repository.claim(plan.id, nextAttempt, now)).not.toBeNull();
    expect(await repository.recordReceipt(plan.id, "accepted", "wrong")).toBeNull();
    expect((await repository.recordReceipt(plan.id, "accepted", nextAttempt))?.status).toBe("accepted");
    expect((await repository.claim(plan.id, nextAttempt, now))?.status).toBe("accepted");
    await expect(service.prepareResult({ ...result, text: "different" })).rejects.toThrow("idempotency");
    expect((await repository.getArtifact(plan.artifact.id))?.bytes.toString("utf8")).toBe(result.text);
    expect(await repository.prune(plan.retainedUntil)).toBe(1);
    expect(await repository.get(plan.id)).toBeNull();
    expect(await repository.getArtifact(plan.artifact.id)).toBeNull();
    const source = { type: "plan", id: randomUUID() };
    const milestone = await service.prepareResult({ ...result, key: randomUUID(), source, kind: "progress", text: "进度一" });
    await service.prepareResult({ ...result, key: randomUUID(), source, text: "最终成果", createdAt: now + 1 });
    expect((await repository.get(milestone.id))?.status).toBe("superseded");
    const business = { supersedes: "daily-weather" };
    const oldWeather = await service.prepareResult({ ...result, key: randomUUID(), text: "昨天", business });
    await service.prepareResult({ ...result, key: randomUUID(), text: "今天", business, createdAt: now + 1 });
    expect((await repository.get(oldWeather.id))?.status).toBe("superseded");
    const expected = new Set<string>();
    for (let index = 0; index < 105; index++) {
      const id = randomUUID(), artifactId = randomUUID();
      const artifact = { ...plan.artifact, id: artifactId, bytes: Buffer.from("retained content") };
      const pending: DeliveryPlan = { ...plan, id, key: randomUUID(), source: { type: "plan", id },
        artifact: { ...plan.artifact, id: artifactId }, status: index % 2 ? "preparing" : "waiting_for_user",
        messages: [], createdAt: now - 1000 };
      delete pending.attemptId; delete pending.attemptedAt; delete pending.attemptExpiresAt;
      await repository.createIfAbsent(pending, artifact); expected.add(id);
    }
    const seen: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await repository.listMaintenance(["allowed"], now, after, 20);
      if (!page.length) break;
      seen.push(...page.map(item => item.id)); after = page.at(-1)!.id;
    }
    expect(new Set(seen)).toEqual(expected);
    expect(seen).toHaveLength(105);
    expect(await repository.hasActiveDelivery("allowed", now)).toBe(true);
    expect(await repository.listMaintenance(["forbidden"], now)).toEqual([]);
    expect(await repository.listMaintenance(["allowed"], now + 3_600_000)).toEqual([]);
    expect(await repository.hasActiveDelivery("allowed", now + 3_600_000)).toBe(false);
    const timeout = await service.prepareResult({ ...result, key: randomUUID(), text: "must not retry unknown" });
    const timeoutAttempt = randomUUID();
    await repository.claim(timeout.id, timeoutAttempt, now);
    expect((await repository.get(timeout.id, now + DELIVERY_ATTEMPT_MS))?.status).toBe("uncertain");
    expect(await repository.claim(timeout.id, randomUUID(), now + DELIVERY_ATTEMPT_MS)).toBeNull();
    const blocked = await service.prepareResult({ ...result, key: randomUUID(), text: "no-context result" });
    expect(await repository.markChatWaiting("allowed", "no_context", now)).toBeGreaterThanOrEqual(1);
    expect(await repository.markChatWaiting("allowed", "no_context", now)).toBe(0);
    expect((await repository.get(blocked.id, now))?.status).toBe("waiting_for_user");
    expect((await repository.get(timeout.id, now))?.status).toBe("uncertain");
    const oldPreparing = (await repository.listMaintenance(["allowed"], now, undefined, 100)).find(item => item.status === "preparing");
    expect(oldPreparing).toBeDefined();
    for (const reason of ["not_submitted", "artifact_unavailable", "reply_pending", "attempt_expired"]) {
      const retryable = await service.prepareResult({ ...result, key: randomUUID(), text: `known unsubmitted ${reason}` });
      const oldAttempt = randomUUID(), freshAttempt = randomUUID();
      await repository.claim(retryable.id, oldAttempt, now);
      expect(await repository.defer(retryable.id, oldAttempt, reason, now, 1)).toMatchObject({ status: "ready", submittedMessages: 1 });
      expect((await repository.claim(retryable.id, freshAttempt, now))?.status).toBe("claimed");
      expect(await repository.defer(retryable.id, oldAttempt, reason, now, 1)).toMatchObject({ status: "claimed", attemptId: freshAttempt });
      await repository.recordReceipt(retryable.id, "uncertain", freshAttempt);
      expect(await repository.defer(retryable.id, freshAttempt, reason, now, 1)).toBeNull();
      expect((await repository.get(retryable.id, now))?.status).toBe("uncertain");
    }
  } finally {
    await pool.end();
    try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { await admin.end(); }
  }
}, 20_000);
