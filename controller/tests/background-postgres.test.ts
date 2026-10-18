import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { AutomationService, CreateScheduleSchema, PostgresAutomationRepository, initAutomationTables } from "../src/automations/index.js";
import { BackgroundService, BackgroundSpecSchema, PostgresBackgroundRepository, initBackgroundTables,
  type BackgroundServiceOptions, type WorkerReceipt } from "../src/background/index.js";

const connectionString = process.env.AUTOMATION_TEST_DATABASE_URL;
const integration = connectionString ? describe : describe.skip;
integration("Postgres isolated worker persistence", () => {
  const schema = `background_test_${randomUUID().replaceAll("-", "")}`;
  const now = Date.parse("2026-10-18T01:00:00Z");
  let admin: pg.Pool, pool: pg.Pool;
  let repository: PostgresBackgroundRepository;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
    await initBackgroundTables(pool);
    await initAutomationTables(pool);
    repository = new PostgresBackgroundRepository(pool);
  });
  beforeEach(async () => { await pool.query("TRUNCATE background_workers,automation_outbox,automation_runs,automation_schedules CASCADE"); });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });
  function fixture() {
    const runtime = { start: vi.fn(async (): Promise<WorkerReceipt> => ({ status: "running" })),
      inspect: vi.fn(async (): Promise<WorkerReceipt> => ({ status: "completed", summary: "persisted outcome" })),
      cancel: vi.fn(async () => undefined), cleanup: vi.fn(async () => undefined), exportArtifacts: vi.fn(async () => []) };
    const options: BackgroundServiceOptions = { repository, runtime, sources: { inspectAutomation: async () => { throw new Error("unexpected source"); } },
      deliverSupplement: async () => undefined, now: () => now };
    const run = { id: randomUUID(), scheduleId: "daily", chatId: "chat", scheduledAt: now };
    return { runtime, options, run, spec: BackgroundSpecSchema.parse({ prompt: "汇总任务" }) };
  }
  it("atomically creates one binding and starts once across independent controllers", async () => {
    const f = fixture();
    const a = new BackgroundService(f.options);
    const b = new BackgroundService({ ...f.options, repository: new PostgresBackgroundRepository(pool) });
    await Promise.all([a.start(f.run, f.spec), b.start(f.run, f.spec)]);
    expect(await repository.list("chat")).toHaveLength(1);
    expect(f.runtime.start).toHaveBeenCalledTimes(1);
    const row = await repository.getByRun(f.run.id);
    expect(row!.invocations).toHaveLength(1);
    expect(row!.leaseUntil).toBe(0);
  });
  it("restores invocation, queued prompts and fixed expiry after service replacement", async () => {
    const f = fixture(); const a = new BackgroundService(f.options);
    await a.start(f.run, f.spec);
    const first = (await repository.getByRun(f.run.id))!;
    await a.enqueue(first.id, "chat", "follow up", "user-input");
    const b = new BackgroundService({ ...f.options, repository: new PostgresBackgroundRepository(pool) });
    expect(await b.inspect(f.run)).toMatchObject({ status: "completed", result: { text: "persisted outcome" } });
    const restored = (await b.get(first.id, "chat"))!;
    expect(restored.prompts).toHaveLength(1);
    expect(restored.expiresAt).toBe(first.expiresAt);
    expect(f.runtime.start).toHaveBeenCalledTimes(1);
    await b.acceptResult(f.run.id);
    await b.maintenance();
    expect(f.runtime.start).toHaveBeenCalledTimes(2);
  });
  it("does not lose concurrent followup inserts while updating worker state", async () => {
    const f = fixture(); const a = new BackgroundService(f.options);
    await a.start(f.run, f.spec); const worker = (await repository.getByRun(f.run.id))!;
    const b = new BackgroundService({ ...f.options, repository: new PostgresBackgroundRepository(pool) });
    await Promise.all([a.enqueue(worker.id, "chat", "first", "first"), b.enqueue(worker.id, "chat", "second", "second"), a.inspect(f.run)]);
    expect((await repository.get(worker.id))!.prompts.map(item => item.requestId).sort()).toEqual(["first", "second"]);
  });
  it("rolls back invalid mutations and never exposes another chat's worker", async () => {
    const f = fixture(); const a = new BackgroundService(f.options); await a.start(f.run, f.spec);
    const worker = (await repository.getByRun(f.run.id))!;
    await expect(repository.update(worker.id, row => { row.phase = "cleaned"; throw new Error("rollback required"); })).rejects.toThrow("rollback required");
    expect((await repository.get(worker.id))!.phase).toBe("executing");
    expect(await a.get(worker.id, "different-chat")).toBeNull();
  });
  it("commits unified run plus outbox before accepting the background result", async () => {
    const f = fixture();
    const background = new BackgroundService(f.options);
    const automations = new PostgresAutomationRepository(pool);
    const accepted = vi.fn(async (runId: string) => {
      expect((await automations.pendingOutbox(now))[0].text).toBe("persisted outcome");
      await background.acceptResult(runId);
    });
    const service = new AutomationService({ repository: automations, now: () => now, validateBackground: async () => undefined,
      runner: {
        start: async (run, schedule) => {
          if (schedule.kind !== "background") throw new Error("Expected background");
          return background.start(run, schedule.background);
        },
        inspect: async (run, schedule) => {
          if (schedule.kind !== "background") throw new Error("Expected background");
          return background.inspect(run, schedule.background);
        },
      },
      onFinished: async (run, _schedule, outcome) => { if (["completed", "failed"].includes(outcome.status)) await accepted(run.id); },
    });
    const schedule = await service.create(CreateScheduleSchema.parse({ kind: "background", title: "cross host watch", timing: { type: "at", at: new Date(now).toISOString() },
      timezone: "Asia/Shanghai", background: { prompt: "summarize" } }), { chatId: "chat", currentMessageId: "user-schedule", explicitCurrentTurnAuthorization: true });
    await service.tick(); await service.tick();
    const [run] = await automations.listRuns(schedule.id, "chat");
    expect(run.status).toBe("completed"); expect(accepted).toHaveBeenCalledTimes(1);
    expect((await repository.getByRun(run.id))!.initialAcceptedAt).toBe(now);
  });

  it("atomically deduplicates long supplements and validates ownership without modifying the active run", async () => {
    const automations = new PostgresAutomationRepository(pool);
    const service = new AutomationService({ repository: automations, now: () => now, validateBackground: async () => undefined,
      runner: { start: async () => ({ status: "running" }), inspect: async () => ({ status: "running" }) } });
    const schedule = await service.create(CreateScheduleSchema.parse({ kind: "background", title: "watch", timing: { type: "at", at: new Date(now).toISOString() },
      timezone: "UTC", background: { prompt: "observe" } }), { chatId: "chat", currentMessageId: "supplement-user", explicitCurrentTurnAuthorization: true });
    await service.tick();
    const [run] = await automations.listRuns(schedule.id, "chat");
    const input = { runId: run.id, scheduleId: schedule.id, chatId: "chat", invocationId: randomUUID(), kind: "completed" as const,
      text: "long-result".repeat(10_000), createdAt: now, expiresAt: now + 86_400_000 };
    const other = new PostgresAutomationRepository(pool);
    const items = await Promise.all([automations.publishSupplement(input), other.publishSupplement(input)]);
    expect(items[0].id).toBe(items[1].id);
    expect((await automations.pendingOutbox(now))).toHaveLength(1);
    expect((await automations.pendingOutbox(now))[0].text).toBe(input.text);
    expect((await automations.listRuns(schedule.id, "chat"))[0]).toEqual(run);
    await expect(other.publishSupplement({ ...input, text: "different" })).rejects.toThrow("conflicts");
    await expect(other.publishSupplement({ ...input, chatId: "other" })).rejects.toThrow("authorized");
    await service.tick(); expect((await automations.listRuns(schedule.id, "chat"))[0].status).toBe("running");
  });

});
