import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { AutomationService, MemoryAutomationRepository, PostgresAutomationRepository, initAutomationTables,
  type AutomationRepository, type CreateSchedule } from "../../src/automations/index.js";
import { AutomationConflictError } from "../../src/automations/errors.js";

const START = Date.parse("2026-10-18T00:00:00Z");
const DUE = START + 60_000;
const authority = { chatId: "user", currentMessageId: "user-turn", explicitCurrentTurnAuthorization: true };
const databaseUrl = process.env.AUTOMATION_TEST_DATABASE_URL;

for (const backend of ["memory", "postgres"] as const) {
  const suite = backend === "postgres" && !databaseUrl ? describe.skip : describe;
  suite(`automation terminal state contract (${backend})`, () => {
    const schema = `automation_terminal_${randomUUID().replaceAll("-", "")}`;
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
    const create = (timing: CreateSchedule["timing"] = { type: "at", at: new Date(DUE).toISOString() }, auth = authority) =>
      new AutomationService({ repository, now: () => START, runner: {
        start: async () => ({ status: "unknown", error: "unused" }), inspect: async () => ({ status: "unknown", error: "unused" }),
      } }).create({ kind: "reminder", title: "one shot", text: "result", timezone: "UTC", timing, businessTtlMs: 86_400_000, retention: "latest" }, auth);

    it.each(["completed", "failed"] as const)("finishes a paused in-flight one-shot after %s and rejects resuming it", async status => {
      const schedule = await create();
      const [{ run }] = await repository.claimDue(DUE, "worker", 1);
      await repository.setStatus(schedule.id, authority.chatId, "paused", DUE);
      expect(await repository.finish(run.id, "worker", { status, result: { text: "observed result" } }, DUE + 1)).toBe(true);
      const finished = await repository.get(schedule.id, authority.chatId);
      expect(finished?.status).toBe("completed");
      expect(finished?.nextAt).toBeNull();
      expect(finished?.activeRunId).toBeUndefined();
      await expect(repository.setStatus(schedule.id, authority.chatId, "active", DUE + 2)).rejects.toBeInstanceOf(AutomationConflictError);
      expect(await repository.claimDue(DUE + 2, "new-worker", 1)).toEqual([]);
    });

    it("preserves cancellation when an already running one-shot completes and emits no notification", async () => {
      const schedule = await create();
      const [{ run }] = await repository.claimDue(DUE, "worker", 1);
      await repository.setStatus(schedule.id, authority.chatId, "cancelled", DUE);
      await repository.finish(run.id, "worker", { status: "completed", result: { text: "late result" } }, DUE + 1);
      expect((await repository.get(schedule.id, authority.chatId))?.status).toBe("cancelled");
      expect(await repository.pendingOutbox(DUE + 1)).toEqual([]);
    });

    it("keeps a paused recurring schedule resumable when future occurrences remain", async () => {
      const schedule = await create({ type: "cron", expression: "* * * * *" });
      const [{ run }] = await repository.claimDue(DUE, "worker", 1);
      await repository.setStatus(schedule.id, authority.chatId, "paused", DUE);
      await repository.finish(run.id, "worker", { status: "completed", result: { text: "result" } }, DUE + 1);
      const paused = await repository.get(schedule.id, authority.chatId);
      expect(paused?.status).toBe("paused");
      expect(paused?.nextAt).toBe(DUE + 60_000);
      expect((await repository.setStatus(schedule.id, authority.chatId, "active", DUE + 2))?.status).toBe("active");
    });

    it("uses one HTTP key for one payload while model tools can create different tasks in one turn", async () => {
      const auth = { ...authority, idempotencyKey: "http-key" };
      const first = await create(undefined, auth);
      const repeated = await Promise.all([create(undefined, auth), create(undefined, auth)]);
      expect(repeated.every(item => item.id === first.id)).toBe(true);
      await expect(create({ type: "at", at: new Date(DUE + 1).toISOString() }, auth)).rejects.toBeInstanceOf(AutomationConflictError);
      const toolTasks = await Promise.all([create(), create({ type: "at", at: new Date(DUE + 1).toISOString() })]);
      expect(toolTasks[0].id).not.toBe(toolTasks[1].id);
      expect(await repository.list(authority.chatId)).toHaveLength(3);
    });
  });
}
