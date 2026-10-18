import { randomUUID } from "node:crypto";
import pg from "pg";
import { expect, it, vi } from "vitest";
import { initDeliveryTables, PostgresDeliveryRepository } from "../../src/deliveries/postgres.js";
import { ResultDeliveryService } from "../../src/deliveries/service.js";
import { MAX_CATCHUP_SOURCES } from "../../src/deliveries/contracts.js";

const databaseUrl = process.env.RESULT_TEST_DATABASE_URL;
const NOW = 1_800_000_000_000;
const config = { publicUrl: "https://result.example", signingSecret: "catchup-test-signing-secret-at-least-32-chars", now: () => NOW };

it.skipIf(!databaseUrl)("atomically activates complete catch-up artifacts and persists generation receipts across workers and restart", async () => {
  const schema = `result_catchup_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const connection = await pool.connect();
    try { await initDeliveryTables(connection); }
    finally { connection.release(); }
    const repository = new PostgresDeliveryRepository(pool);
    let release!: (value: { content: string; toolCalls: [] }) => void;
    const complete = vi.fn(() => new Promise<{ content: string; toolCalls: [] }>(resolve => { release = resolve; }));
    const service = new ResultDeliveryService(repository, { ...config, model: { complete } });
    const create = (chatId: string, text: string) => service.prepareResult({ key: randomUUID(), chatId, text,
      source: { type: "plan", id: randomUUID() }, kind: "completed", createdAt: NOW, expiresAt: NOW + 3_600_000 });
    const originals = [await create("catchup", "完整成果 A\n" + "甲".repeat(6000)), await create("catchup", "完整成果 B\n" + "乙".repeat(6000))];
    await repository.markChatWaiting("catchup", "window_closed", NOW);
    const operation = service.resumeChat("catchup", "inbound-a");
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    expect(await repository.listPending(["catchup"], NOW)).toEqual([]);
    expect(await repository.resumeChat("catchup", NOW)).toBe(0);
    for (const original of originals) expect(await repository.get(original.id, NOW)).toMatchObject({ status: "waiting_for_user", catchupId: expect.any(String) });
    const restarted = new ResultDeliveryService(new PostgresDeliveryRepository(pool), { ...config, model: { complete } });
    expect(await restarted.resumeChat("catchup", "inbound-a")).toBe(1);
    release({ content: "两项研究成果已完成，完整正文见附件。", toolCalls: [] });
    expect(await operation).toBe(1);
    const pending = await repository.listPending(["catchup"], NOW);
    expect(pending).toHaveLength(1);
    expect(pending[0].mode).toBe("attachment");
    const combined = (await repository.getArtifact(pending[0].artifact.id))!.bytes.toString("utf8");
    for (const original of originals) {
      expect((await repository.get(original.id, NOW))?.status).toBe("superseded");
      expect(combined).toContain((await repository.getArtifact(original.artifact.id))!.bytes.toString("utf8"));
    }
    const newer = await create("catchup", "后来新增的成果");
    await repository.markChatWaiting("catchup", "window_closed", NOW);
    expect(await restarted.resumeChat("catchup", "inbound-a")).toBe(1);
    expect((await repository.get(newer.id, NOW))?.status).toBe("waiting_for_user");
    expect(complete).toHaveBeenCalledTimes(1);
    await restarted.retryPreparation(pending[0].id);
    expect(complete).toHaveBeenCalledTimes(1);

    const bounded = [];
    for (let index = 0; index < MAX_CATCHUP_SOURCES + 2; index++) bounded.push(await create("bounded", `完整小成果 ${index}`));
    await repository.markChatWaiting("bounded", "no_context", NOW);
    const workers = await Promise.all(Array.from({ length: 6 }, () => restarted.resumeChat("bounded", "inbound-b")));
    expect(workers.every(count => count === 1)).toBe(true);
    const smallPending = await repository.listPending(["bounded"], NOW);
    expect(smallPending).toHaveLength(1);
    expect(smallPending[0].catchupSourceIds).toHaveLength(MAX_CATCHUP_SOURCES);
    const oldStates = await Promise.all(bounded.map(plan => repository.get(plan.id, NOW)));
    expect(oldStates.filter(plan => plan?.status === "superseded")).toHaveLength(MAX_CATCHUP_SOURCES);
    expect(oldStates.filter(plan => plan?.status === "waiting_for_user")).toHaveLength(2);

    const failingModel = vi.fn().mockRejectedValueOnce(new Error("model unavailable"))
      .mockResolvedValueOnce({ content: "恢复后的真实成果摘要", toolCalls: [] });
    const failureService = new ResultDeliveryService(repository, { ...config, model: { complete: failingModel } });
    const failedOriginals = [await create("retry", "A".repeat(6000)), await create("retry", "B".repeat(6000))];
    await repository.markChatWaiting("retry", "no_context", NOW);
    expect(await failureService.resumeChat("retry", "inbound-c")).toBe(1);
    const preparation = (await repository.listMaintenance(["retry"], NOW)).find(plan => plan.source.type === "catchup")!;
    expect(preparation.status).toBe("preparing");
    for (const original of failedOriginals) expect((await repository.get(original.id, NOW))?.status).toBe("waiting_for_user");
    const afterFailureRestart = new ResultDeliveryService(new PostgresDeliveryRepository(pool), { ...config, model: { complete: failingModel } });
    expect(await afterFailureRestart.resumeChat("retry", "inbound-c")).toBe(1);
    expect(failingModel).toHaveBeenCalledTimes(1);
    expect((await afterFailureRestart.retryPreparation(preparation.id))?.status).toBe("ready");
    expect(failingModel).toHaveBeenCalledTimes(2);
    for (const original of failedOriginals) expect((await repository.get(original.id, NOW))?.status).toBe("superseded");
  } finally {
    await pool.end();
    try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { await admin.end(); }
  }
}, 20_000);
