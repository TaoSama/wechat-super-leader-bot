import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { AutomationService, MemoryAutomationRepository, PostgresAutomationRepository, initAutomationTables, type AutomationRepository, type RunnerOutcome } from "../src/automations/index.js";

const databaseUrl = process.env.AUTOMATION_TEST_DATABASE_URL;
for (const backend of ["memory", "postgres"] as const) {
  const suite = backend === "postgres" && !databaseUrl ? describe.skip : describe;
  suite(`automation body retention (${backend})`, () => {
    const schema = `automations_retention_${randomUUID().replaceAll("-", "")}`;
    let admin: pg.Pool | undefined, pool: pg.Pool | undefined, repository: AutomationRepository;
    let now = Date.parse("2026-10-18T00:00:00Z");
    const start = now;
    const authority = { chatId: "retention-user", currentMessageId: "msg", explicitCurrentTurnAuthorization: true };
    beforeAll(async () => {
      if (backend !== "postgres") return;
      admin = new pg.Pool({ connectionString: databaseUrl }); await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` }); await initAutomationTables(pool);
    });
    beforeEach(async () => {
      now = start;
      if (pool) { await pool.query("TRUNCATE automation_outbox,automation_runs,automation_schedules CASCADE"); repository = new PostgresAutomationRepository(pool); }
      else repository = new MemoryAutomationRepository();
    });
    afterAll(async () => {
      await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
    });
    it("clears old terminal bodies while retaining deduplication metadata and protecting active, unknown and pending", async () => {
      const outcome = (title: string): RunnerOutcome => title === "unknown" ? { status: "unknown", error: "uncertain submission detail" }
        : title === "running" ? { status: "running", commandId: "active-command", error: "active observation detail" }
        : title === "failed" ? { status: "failed", result: { text: "failure body", error: "sensitive failure trace", fingerprint: "failure-state" } }
        : { status: "completed", result: { text: `full report ${title}`, fingerprint: title } };
      const service = new AutomationService({ repository, now: () => now, resolveTarget: async (nodeId, sessionId) => ({ nodeId, sessionId, sendRoute: "control-socket" }),
        runner: { start: async (_run, schedule) => outcome(schedule.title), inspect: async (_run, schedule) => outcome(schedule.title) } });
      const created = await Promise.all(["published", "pending", "expired", "unknown", "running", "failed"].map(title => service.create({
        kind: "session", title, prompt: "inspect", nodeId: "n", sessionId: "s", monitor: false,
        timing: { type: "at", at: new Date(start + 60_000).toISOString() }, timezone: "UTC", retention: "retain", businessTtlMs: title === "expired" ? 1_000 : 86_400_000,
      }, authority)));
      now += 60_000; await service.tick();
      const pending = await repository.pendingOutbox(now);
      const protectedPendingId = pending.find(item => item.text === "full report pending")!.id;
      const publishedIds = pending.filter(item => item.text === "full report published" || item.text === "failure body").map(item => item.id);
      for (const id of publishedIds) await repository.markPublished(id);
      const original = await repository.listRuns(created.find(item => item.title === "published")!.id, authority.chatId);
      now += 500; expect(await repository.cleanupBodies(now, 1_000)).toEqual({ runs: 0, outbox: 0 });
      now += 1_500; expect(await repository.cleanupBodies(now, 1_000)).toEqual({ runs: 3, outbox: 3 });
      const cleared = (await repository.listRuns(original[0].scheduleId, authority.chatId))[0];
      expect(cleared.result?.text).toBe(""); expect(cleared.bodyClearedAt).toBe(now);
      expect(cleared.id).toBe(original[0].id); expect(cleared.status).toBe(original[0].status); expect(cleared.updatedAt).toBe(original[0].updatedAt);
      expect(cleared.scheduledAt).toBe(original[0].scheduledAt); expect(cleared.result?.fingerprint).toBe("published");
      for (const title of ["unknown", "running", "pending"]) {
        const [run] = await repository.listRuns(created.find(item => item.title === title)!.id, authority.chatId);
        expect(run.bodyClearedAt).toBeUndefined();
        if (title === "pending") expect(run.result?.text).toBe("full report pending"); else expect(run.error).toContain("detail");
      }
      const [failure] = await repository.listRuns(created.find(item => item.title === "failed")!.id, authority.chatId);
      expect(failure.result?.error).toBeUndefined();
      expect((await repository.pendingOutbox(now)).map(item => item.id)).toEqual([protectedPendingId]);
      expect(await repository.cleanupBodies(now + 100, 1_000)).toEqual({ runs: 0, outbox: 0 });
      expect(await repository.pendingOutbox(now, 100, [protectedPendingId])).toEqual([]);
      if (pool) {
        const outbox = await pool.query("SELECT data FROM automation_outbox WHERE id = ANY($1::text[])", [publishedIds]);
        expect(outbox.rows.every(row => row.data.text === "" && row.data.bodyClearedAt === now)).toBe(true);
      }
    });
    it("validates retention inputs before mutating persistent state", async () => {
      await expect(repository.cleanupBodies(now, 0.5)).rejects.toThrow("retention");
      await expect(repository.cleanupBodies(now, -1)).rejects.toThrow("retention");
      await expect(repository.cleanupBodies(Number.NaN, 1_000)).rejects.toThrow("retention");
    });
  });
}
