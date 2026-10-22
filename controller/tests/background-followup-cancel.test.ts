import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationService, CreateScheduleSchema, MemoryAutomationRepository, PostgresAutomationRepository,
  initAutomationTables, type AutomationRepository } from "../src/automations/index.js";
import { AutomationConflictError } from "../src/automations/errors.js";
import { createAutomationRouter } from "../src/automations/routes.js";
import { executeAutomationTool } from "../src/automations/tools.js";
import { BackgroundService, MemoryBackgroundRepository } from "../src/background/index.js";
import { createBackgroundRouter } from "../src/background/routes.js";

const NOW = Date.parse("2026-10-23T01:00:00Z");
const CHAT = "owner";
const authority = { chatId: CHAT, currentMessageId: "human-turn", explicitCurrentTurnAuthorization: true };
const databaseUrl = process.env.AUTOMATION_TEST_DATABASE_URL;
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  })));
});
async function listen(app: express.Express) {
  const server = app.listen(0, "127.0.0.1"); servers.push(server);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test HTTP address");
  return `http://127.0.0.1:${address.port}`;
}
const backgroundInput = () => CreateScheduleSchema.parse({ kind: "background", title: "retained task",
  timing: { type: "at", at: new Date(NOW).toISOString() }, timezone: "UTC", background: { prompt: "initial task" } });

for (const backend of ["memory", "postgres"] as const) {
  const suite = backend === "postgres" && !databaseUrl ? describe.skip : describe;
  suite(`completed background cancellation (${backend})`, () => {
    const schema = `followup_cancel_${randomUUID().replaceAll("-", "")}`;
    let admin: pg.Pool | undefined, pool: pg.Pool | undefined, repository: AutomationRepository;
    beforeAll(async () => {
      if (backend !== "postgres") return;
      admin = new pg.Pool({ connectionString: databaseUrl });
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
      await initAutomationTables(pool);
    });
    beforeEach(async () => {
      if (pool) await pool.query("TRUNCATE automation_outbox,automation_runs,automation_schedules CASCADE");
      repository = pool ? new PostgresAutomationRepository(pool) : new MemoryAutomationRepository();
    });
    afterAll(async () => {
      await pool?.end();
      if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    });

    it.each(["completed", "failed"] as const)("permits only cancellation after the initial %s result", async status => {
      const service = new AutomationService({ repository, now: () => NOW, validateBackground: async () => undefined,
        runner: { start: async () => ({ status, result: { text: "initial result" } }), inspect: async () => ({ status: "running" }) } });
      const schedule = await service.create(backgroundInput(), authority);
      await service.tick();
      expect((await repository.get(schedule.id, CHAT))?.status).toBe("completed");
      for (const forbidden of ["active", "paused"] as const) {
        await expect(repository.setStatus(schedule.id, CHAT, forbidden, NOW + 1)).rejects.toBeInstanceOf(AutomationConflictError);
      }
      expect(await repository.setStatus(schedule.id, "other", "cancelled", NOW + 1)).toBeNull();
      expect((await repository.setStatus(schedule.id, CHAT, "cancelled", NOW + 1))?.status).toBe("cancelled");
      expect(await repository.pendingOutbox(NOW + 1)).toEqual([]);
      await expect(repository.setStatus(schedule.id, CHAT, "active", NOW + 2)).rejects.toBeInstanceOf(AutomationConflictError);
      expect(await repository.claimDue(NOW + 2, "new-worker", 1)).toEqual([]);
      expect((await repository.listRuns(schedule.id, CHAT))[0].status).toBe(status);
    });
  });
}

async function fixture() {
  const repository = new MemoryAutomationRepository();
  const workers = new MemoryBackgroundRepository();
  const runtime = {
    start: vi.fn(async () => ({ status: "running" as "running" | "completed", summary: "initial result" }))
      .mockResolvedValueOnce({ status: "completed", summary: "initial result" }),
    inspect: vi.fn(async () => ({ status: "failed" as const, summary: "cancelled", error: "worker_cancelled" })),
    cancel: vi.fn(async () => undefined), cleanup: vi.fn(async () => undefined), exportArtifacts: vi.fn(async () => []),
  };
  const background = new BackgroundService({ repository: workers, runtime, now: () => NOW,
    getScheduleStatus: async (id, chatId) => (await repository.get(id, chatId))?.status,
    sources: { inspectAutomation: async () => { throw new Error("Unexpected source I/O"); } },
    deliverSupplement: vi.fn(async () => undefined) });
  const service = new AutomationService({ repository, now: () => NOW, validateBackground: async () => undefined,
    runner: { start: async (run, schedule) => {
      if (schedule.kind !== "background") throw new Error("Expected background schedule");
      return background.start(run, schedule.background);
    }, inspect: run => background.inspect(run) }, onFinished: async run => { await background.acceptResult(run.id); } });
  const schedule = await service.create(backgroundInput(), authority);
  await service.tick();
  const [run] = await repository.listRuns(schedule.id, CHAT);
  const worker = (await workers.getByRun(run.id))!;
  expect((await repository.get(schedule.id, CHAT))?.status).toBe("completed");
  return { repository, workers, runtime, background, service, schedule, run, worker };
}

describe("retained follow-up product cancellation", () => {
  it("uses current human authorization to cancel a running follow-up through update_automation", async () => {
    const f = await fixture();
    await f.background.enqueue(f.worker.id, CHAT, "running followup", "running");
    await f.background.maintenance();
    expect(f.runtime.start).toHaveBeenCalledTimes(2);
    const mutation = { id: f.schedule.id, status: "cancelled" };
    await expect(executeAutomationTool(f.service, "update_automation", mutation,
      { ...authority, explicitCurrentTurnAuthorization: false }, NOW)).rejects.toThrow("authorization");
    const assertCurrentAuthority = vi.fn(async () => undefined);
    await executeAutomationTool(f.service, "update_automation", mutation, { ...authority, assertCurrentAuthority }, NOW);
    expect(assertCurrentAuthority).toHaveBeenCalledTimes(1);
    await f.background.maintenance();
    expect(f.runtime.cancel).toHaveBeenCalledWith(f.worker.id, expect.any(String));
    expect((await f.workers.get(f.worker.id))?.phase).toBe("cancelled");
    expect((await f.workers.get(f.worker.id))?.prompts[0].cancelledAt).toBe(NOW);
    await expect(f.background.enqueue(f.worker.id, CHAT, "restart", "restart")).rejects.toThrow("expired");
    await f.background.maintenance();
    expect(f.runtime.start).toHaveBeenCalledTimes(2);
  });

  it("cancels a queued follow-up through the authorized schedule status HTTP route", async () => {
    const f = await fixture();
    await f.background.enqueue(f.worker.id, CHAT, "queued followup", "queued");
    let authorized = false;
    const app = express(); app.use(express.json());
    app.use(createAutomationRouter(f.service, { now: () => NOW, allowed: () => new Set([CHAT, "other"]),
      authority: async (_req, chatId) => authorized ? { ...authority, chatId } : null }));
    const origin = await listen(app);
    const post = (chatId: string) => fetch(`${origin}/${f.schedule.id}/status`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatId, status: "cancelled" }) });
    expect((await post(CHAT)).status).toBe(403);
    authorized = true;
    expect((await post("other")).status).toBe(404);
    expect((await post(CHAT)).status).toBe(200);
    await f.background.maintenance();
    expect(f.runtime.start).toHaveBeenCalledTimes(1);
    expect((await f.workers.get(f.worker.id))?.prompts[0].cancelledAt).toBe(NOW);
  });

  it("offers run-only HTTP cancellation with allowlist, ownership and strict input checks", async () => {
    const f = await fixture();
    await f.background.enqueue(f.worker.id, CHAT, "queued followup", "queued");
    const app = express(); app.use(express.json());
    app.use(createBackgroundRouter(f.background, () => new Set([CHAT, "other"])));
    const origin = await listen(app);
    const post = (body: unknown) => fetch(`${origin}/${f.run.id}/cancel`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await post({ chatId: "blocked" })).status).toBe(403);
    expect((await post({ chatId: "other" })).status).toBe(404);
    expect((await post({ chatId: CHAT, authorized: true })).status).toBe(400);
    expect((await f.workers.get(f.worker.id))?.cancelRequestedAt).toBeUndefined();
    const response = await post({ chatId: CHAT });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ cancellationRequested: true, task: { runId: f.run.id } });
    await f.background.maintenance();
    expect(f.runtime.start).toHaveBeenCalledTimes(1);
    expect((await f.workers.get(f.worker.id))?.phase).toBe("cancelled");
    expect((await f.repository.get(f.schedule.id, CHAT))?.status).toBe("completed");
  });
});
