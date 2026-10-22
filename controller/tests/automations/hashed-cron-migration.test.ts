import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AutomationRepository, Schedule } from "../../src/automations/contracts.js";
import { MemoryAutomationRepository } from "../../src/automations/memory.js";
import { initAutomationTables, PostgresAutomationRepository } from "../../src/automations/postgres.js";
import { alignHashedCronNextAt, validateTiming } from "../../src/automations/timing.js";

const START = Date.parse("2026-10-23T00:00:00Z");
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const connectionString = process.env.AUTOMATION_TEST_DATABASE_URL;
const OWNER = "migration-worker";
function legacySchedule(expression = "H * * * *"): Schedule {
  return { id: "legacy-hashed-schedule", chatId: "migration-user", authorizedMessageId: "migration-turn",
    kind: "reminder", title: "Legacy reminder", text: "hello", status: "active", timezone: "UTC",
    timing: { type: "cron", expression }, businessTtlMs: 24 * HOUR_MS, retention: "latest",
    nextAt: START, createdAt: START, updatedAt: START };
}
const firstSeeded = (schedule: Schedule) => validateTiming(schedule, START, schedule.id);

for (const backend of ["memory", "postgres"] as const) {
  const suite = backend === "postgres" && !connectionString ? describe.skip : describe;
  suite(`hashed cron upgrade migration (${backend})`, () => {
    const schema = `hashed_cron_${randomUUID().replaceAll("-", "")}`;
    let admin: pg.Pool | undefined, pool: pg.Pool | undefined, repository: AutomationRepository;
    beforeAll(async () => {
      if (backend !== "postgres") return;
      admin = new pg.Pool({ connectionString });
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
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
    async function restart(schedule: Schedule): Promise<void> {
      if (pool) {
        await pool.end();
        pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
        repository = new PostgresAutomationRepository(pool);
      }
      else {
        const saved = await repository.get(schedule.id, schedule.chatId);
        repository = new MemoryAutomationRepository();
        await repository.create(JSON.parse(JSON.stringify(saved)) as Schedule);
      }
    }

    it.each(["H * * * *", "H/15 * * * *", "H H * * *"])("aligns legacy %s before claiming and retains its first legal point across restart", async expression => {
      const schedule = legacySchedule(expression);
      const first = firstSeeded(schedule);
      schedule.nextAt = first - MINUTE_MS;
      await repository.create(schedule);
      expect(await repository.claimDue(schedule.nextAt, OWNER, 20)).toEqual([]);
      expect((await repository.get(schedule.id, schedule.chatId))?.nextAt).toBe(first);
      expect(await repository.listRuns(schedule.id, schedule.chatId)).toHaveLength(0);
      await restart(schedule);
      expect(await repository.claimDue(first - 1, OWNER, 20)).toEqual([]);
      const claims = await repository.claimDue(first, OWNER, 20);
      expect(claims).toHaveLength(1);
      expect(claims[0].run.scheduledAt).toBe(first);
      expect(await repository.finish(claims[0].run.id, OWNER, { status: "completed", result: { text: "done" } }, first)).toBe(true);
      expect(await repository.claimDue(first + 1, OWNER, 20)).toEqual([]);
      expect(await repository.listRuns(schedule.id, schedule.chatId)).toHaveLength(1);
    });

    it("moves a legacy point after the hashed minute to the next legal point without an early dispatch", async () => {
      const schedule = legacySchedule();
      const first = firstSeeded(schedule);
      schedule.nextAt = first + MINUTE_MS;
      await repository.create(schedule);
      expect(await repository.claimDue(schedule.nextAt, OWNER, 20)).toEqual([]);
      expect((await repository.get(schedule.id, schedule.chatId))?.nextAt).toBe(first + HOUR_MS);
      await restart(schedule);
      const claims = await repository.claimDue(first + HOUR_MS, OWNER, 20);
      expect(claims).toHaveLength(1);
      expect(claims[0].run.scheduledAt).toBe(first + HOUR_MS);
    });

    it("coalesces an overdue legacy point to the newest legal occurrence", async () => {
      const schedule = legacySchedule();
      const first = firstSeeded(schedule);
      schedule.nextAt = first - MINUTE_MS;
      await repository.create(schedule);
      const claims = await repository.claimDue(first + 3 * HOUR_MS + MINUTE_MS, OWNER, 20);
      expect(claims).toHaveLength(1);
      expect(claims[0].run.scheduledAt).toBe(first + 3 * HOUR_MS);
      expect((await repository.get(schedule.id, schedule.chatId))?.nextAt).toBe(first + 4 * HOUR_MS);
    });

    it("preserves an in-flight occurrence and does not claim a second run", async () => {
      const schedule = legacySchedule();
      const first = firstSeeded(schedule);
      schedule.nextAt = first;
      await repository.create(schedule);
      const [claimed] = await repository.claimDue(first, OWNER, 20);
      if (pool) await restart(schedule);
      expect(await repository.claimDue(first + 3 * HOUR_MS, "other-worker", 20)).toEqual([]);
      const saved = await repository.get(schedule.id, schedule.chatId);
      expect(saved?.activeRunId).toBe(claimed.run.id);
      expect(saved?.nextAt).toBe(first + HOUR_MS);
      const runs = await repository.listRuns(schedule.id, schedule.chatId);
      expect(runs).toHaveLength(1);
      expect(runs[0].scheduledAt).toBe(first);
    });
  });
}

describe("hashed cron alignment boundaries", () => {
  it("is idempotent at a legal seeded point and leaves in-flight or fixed cron untouched", () => {
    const schedule = legacySchedule();
    const first = firstSeeded(schedule);
    schedule.nextAt = first;
    expect(alignHashedCronNextAt(schedule, START + 1)).toBe(false);
    expect(schedule.updatedAt).toBe(START);
    schedule.nextAt = first - MINUTE_MS;
    schedule.activeRunId = "in-flight";
    expect(alignHashedCronNextAt(schedule, START + 1)).toBe(false);
    expect(schedule.nextAt).toBe(first - MINUTE_MS);
    const fixed = legacySchedule("0 * * * *");
    expect(alignHashedCronNextAt(fixed, START + 1)).toBe(false);
    expect(fixed.nextAt).toBe(START);
  });
});
