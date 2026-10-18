import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { AutomationService, PostgresAutomationRepository, initAutomationTables, CLAIM_LEASE_MS, type AutomationRunner } from "../src/automations/index.js";

const connectionString = process.env.AUTOMATION_TEST_DATABASE_URL;
const integration = connectionString ? describe : describe.skip;
integration("Postgres automation persistence", () => {
  const schema = `automations_test_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool, pool: pg.Pool, repository: PostgresAutomationRepository;
  const start = Date.parse("2026-10-18T00:00:00Z");
  let now = start;
  const runner: AutomationRunner = { start: async () => ({ status: "completed", result: { text: "full persisted result" } }), inspect: async () => ({ status: "completed", result: { text: "inspected" } }) };
  const authority = { chatId: "pg-user", currentMessageId: "pg-user-turn", explicitCurrentTurnAuthorization: true };
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
    await initAutomationTables(pool);
    await pool.query("CREATE TABLE command_receipts (request_id TEXT PRIMARY KEY, output TEXT NOT NULL)");
    repository = new PostgresAutomationRepository(pool);
  });
  beforeEach(async () => { now = start; await pool.query("TRUNCATE command_receipts,automation_outbox,automation_runs,automation_schedules CASCADE"); });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });
  const service = () => new AutomationService({ repository, runner, now: () => now, resolveTarget: async (nodeId, sessionId) => ({ nodeId, sessionId, sendRoute: "control-socket" }) });
  async function create() {
    return service().create({ kind: "session", title: "persistent task", prompt: "work", nodeId: "n", sessionId: "s", monitor: false,
      timing: { type: "cron", expression: "* * * * *" }, timezone: "Asia/Shanghai", retention: "latest", businessTtlMs: 86_400_000 }, authority);
  }
  it("makes concurrent same-message creation idempotent and rejects a conflicting raw identity", async () => {
    const created = await Promise.all([create(), create()]);
    expect(created[0].id).toBe(created[1].id);
    expect(await repository.list(authority.chatId)).toHaveLength(1);
    await expect(repository.create({ ...created[0], title: "other input" })).rejects.toThrow("conflicts");
  });
  it("resumes a paused before-dispatch one-shot without creating another occurrence", async () => {
    const schedule = await service().create({ kind: "reminder", title: "paused reminder", text: "test", timezone: "UTC",
      timing: { type: "at", at: new Date(start + 60_000).toISOString() }, retention: "latest", businessTtlMs: 86_400_000 }, authority);
    now += 60_000;
    const [claimed] = await repository.claimDue(now, "before-pause", 20);
    await repository.setStatus(schedule.id, authority.chatId, "paused", now);
    await repository.finish(claimed.run.id, "before-pause", { status: "skipped", reason: "paused" }, now);
    await repository.setStatus(schedule.id, authority.chatId, "active", now);
    await service().tick();
    const runs = await repository.listRuns(schedule.id, authority.chatId);
    expect(runs).toHaveLength(1); expect(runs[0].status).toBe("completed");
    expect((await repository.pendingOutbox(now))[0].text).toBe("test");
  });
  it("claims an occurrence once across independent repository instances and commits output plus outbox", async () => {
    const schedule = await create(); now += 60_000;
    const other = new PostgresAutomationRepository(pool);
    const claims = await Promise.all([repository.claimDue(now, "worker-a", 20), other.claimDue(now, "worker-b", 20)]);
    const claimed = claims.flat(); expect(claimed).toHaveLength(1);
    const { run } = claimed[0];
    expect(await other.finish(run.id, "wrong-worker", { status: "completed", result: { text: "wrong" } }, now)).toBe(false);
    expect(await repository.finish(run.id, run.claimOwner, { status: "completed", result: { text: "exact result" } }, now)).toBe(true);
    const restored = new PostgresAutomationRepository(pool);
    expect((await restored.listRuns(schedule.id, authority.chatId))[0].result?.text).toBe("exact result");
    expect((await restored.pendingOutbox(now))[0].text).toBe("exact result");
    expect((await restored.get(schedule.id, authority.chatId))?.activeRunId).toBeUndefined();
  });
  it("persists unknown dispatch after a process disappears and does not claim another occurrence", async () => {
    const schedule = await create(); now += 60_000;
    await repository.claimDue(now, "disappeared-process", 20); now += CLAIM_LEASE_MS + 1;
    const restarted = new PostgresAutomationRepository(pool);
    const [inspection] = await restarted.claimRunning(now, "new-process", 20);
    expect(inspection.run.status).toBe("dispatching");
    await restarted.finish(inspection.run.id, "new-process", { status: "unknown", error: "No command receipt exists" }, now);
    now += 10 * 60_000;
    expect(await restarted.claimDue(now, "new-process", 20)).toEqual([]);
    expect((await restarted.listRuns(schedule.id, authority.chatId))[0].status).toBe("unknown");
  });
  it("recovers a real durable command receipt after a crash without dispatching again", async () => {
    const schedule = await service().create({ kind: "session", title: "recover once", prompt: "work", nodeId: "n", sessionId: "s", monitor: false,
      timing: { type: "at", at: new Date(start + 60_000).toISOString() }, timezone: "Asia/Shanghai", retention: "latest", businessTtlMs: 86_400_000 }, authority);
    now += 60_000;
    const [claimed] = await repository.claimDue(now, "crashed-before-finish", 20);
    await pool.query("INSERT INTO command_receipts(request_id,output) VALUES($1,$2)", [claimed.run.id, "durable command answer"]);
    now += CLAIM_LEASE_MS + 1;
    const recovering = new AutomationService({ repository: new PostgresAutomationRepository(pool), now: () => now, runner: {
      start: async () => { throw new Error("Recovery must never dispatch"); },
      inspect: async run => {
        const found = await pool.query("SELECT output FROM command_receipts WHERE request_id=$1", [run.id]);
        return found.rows[0] ? { status: "completed", result: { text: found.rows[0].output } } : { status: "unknown", error: "No durable command" };
      },
    } });
    await recovering.tick();
    const runs = await repository.listRuns(schedule.id, authority.chatId);
    expect(runs).toHaveLength(1); expect(runs[0].status).toBe("completed");
    expect((await repository.pendingOutbox(now))[0].text).toBe("durable command answer");
  });
  it("rejects expired leases and late writes from a replaced owner", async () => {
    await create(); now += 60_000;
    const [claimed] = await repository.claimDue(now, "old-owner", 20); now += CLAIM_LEASE_MS;
    expect(await repository.finish(claimed.run.id, "old-owner", { status: "completed", result: { text: "late result" } }, now)).toBe(false);
    const [reclaimed] = await repository.claimRunning(now, "new-owner", 20); expect(reclaimed.run.id).toBe(claimed.run.id);
    expect(await repository.finish(claimed.run.id, "old-owner", { status: "completed", result: { text: "old result" } }, now)).toBe(false);
    expect(await repository.finish(claimed.run.id, "new-owner", { status: "completed", result: { text: "inspected result" } }, now)).toBe(true);
    expect((await repository.pendingOutbox(now))[0].text).toBe("inspected result");
  });
  it("supersedes old pending reports atomically and expires stale outbox without rerunning", async () => {
    const schedule = await create(); now += 60_000; await service().tick(); now += 60_000; await service().tick();
    const outbox = await repository.pendingOutbox(now); expect(outbox).toHaveLength(1);
    expect(await repository.listRuns(schedule.id, authority.chatId)).toHaveLength(2);
    await repository.setStatus(schedule.id, authority.chatId, "paused", now);
    now += 86_400_000;
    expect(await repository.pendingOutbox(now)).toEqual([]);
    expect(await repository.listRuns(schedule.id, authority.chatId)).toHaveLength(2);
  });
});
