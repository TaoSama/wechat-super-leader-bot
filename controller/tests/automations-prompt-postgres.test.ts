import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import {
  AutomationService, PostgresAutomationRepository, initAutomationTables,
  type AutomationRunner, type CreateSchedule,
} from "../src/automations/index.js";
import { AutomationConflictError } from "../src/automations/errors.js";

const connectionString = process.env.AUTOMATION_TEST_DATABASE_URL;
const integration = connectionString ? describe : describe.skip;
const start = Date.parse("2026-10-18T00:00:00Z");
const minute = 60_000;

async function waitForLock(locked: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([locked, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Repository did not reach its locking SELECT")), 2_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function settleTransactions(transactions: Promise<unknown>[]) {
  const results = await Promise.allSettled(transactions);
  for (const result of results) if (result.status === "rejected") throw result.reason;
}

/** Pause a real repository transaction after its locking SELECT returns. */
function holdLock(pool: pg.Pool, queryMarker: string) {
  let reached!: () => void, release!: () => void;
  const locked = new Promise<void>(resolve => { reached = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  let held = false;
  const gated = new Proxy(pool, {
    get(target, key) {
      if (key !== "connect") return Reflect.get(target, key);
      return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(connection, property) {
            if (property !== "query") return Reflect.get(connection, property);
            return async (...args: unknown[]) => {
              const result = await Reflect.apply(connection.query, connection, args);
              if (!held && typeof args[0] === "string" && args[0].includes(queryMarker)) {
                held = true;
                reached();
                await released;
              }
              return result;
            };
          },
        });
      };
    },
  });
  return { repository: new PostgresAutomationRepository(gated), locked, release };
}

integration("Postgres background prompt updates", () => {
  const schema = `automation_prompt_${randomUUID().replaceAll("-", "")}`;
  const applicationName = `prompt_wait_${randomUUID()}`;
  let admin: pg.Pool, pool: pg.Pool, editingPool: pg.Pool;
  let repository: PostgresAutomationRepository, editor: PostgresAutomationRepository;
  let now = start;
  const authority = { chatId: "prompt-chat", currentMessageId: "create-turn", explicitCurrentTurnAuthorization: true };
  const editAuthority = { source: "current_turn" as const, requestId: "edit-turn" };
  const runner: AutomationRunner = {
    start: async () => ({ status: "completed", result: { text: "original report" } }),
    inspect: async () => { throw new Error("No run should need inspection"); },
  };
  const input: CreateSchedule = {
    kind: "background", title: "monitor machines", timezone: "UTC",
    timing: { type: "cron", expression: "* * * * *" }, businessTtlMs: 86_400_000, retention: "retain",
    background: { prompt: "original prompt", sources: [], preferences: ["Chinese"], deadlineMs: 3_600_000, checkIntervalsMs: [120_000] },
  };
  const service = (selectedRunner = runner) => new AutomationService({
    repository, runner: selectedRunner, validateBackground: async () => {}, now: () => now,
  });
  const update = (id: string, prompt = "updated prompt", expectedPromptRevision = 0) => editor.updatePrompt(
    id, authority.chatId, { prompt, expectedPromptRevision }, editAuthority, now,
  );
  const rowVersion = async (id: string) => (await pool.query<{ version: string }>(
    "SELECT xmin::text AS version FROM automation_schedules WHERE id=$1", [id],
  )).rows[0].version;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
    editingPool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, application_name: applicationName });
    await initAutomationTables(pool);
    repository = new PostgresAutomationRepository(pool);
    editor = new PostgresAutomationRepository(editingPool);
  });
  beforeEach(async () => {
    now = start;
    await pool.query("TRUNCATE automation_outbox,automation_runs,automation_schedules CASCADE");
  });
  afterAll(async () => {
    await editingPool?.end();
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });

  async function waitForBlockedEdit() {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const result = await admin.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock'", [applicationName]);
      if (result.rowCount) return;
      await setImmediate();
    }
    throw new Error("Prompt edit did not wait on the schedule row lock");
  }

  it("allows only one concurrent CAS at the same timestamp across repositories", async () => {
    const schedule = await service().create(input, authority);
    const attempts = await Promise.allSettled([
      update(schedule.id, "first contender"),
      repository.updatePrompt(schedule.id, authority.chatId, { prompt: "second contender", expectedPromptRevision: 0 },
        { ...editAuthority, requestId: "other-turn" }, now),
    ]);
    expect(attempts.filter(item => item.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find(item => item.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toBeInstanceOf(AutomationConflictError);
    const persisted = await new PostgresAutomationRepository(pool).get(schedule.id, authority.chatId);
    expect(persisted?.latestPromptUpdate).toMatchObject({ revision: 1, updatedAt: start });
    expect(persisted?.updatedAt).toBe(schedule.updatedAt);
  });

  it("rechecks revoked authority after waiting for a row lock and leaves the row untouched", async () => {
    const schedule = await service().create(input, authority);
    const beforeVersion = await rowVersion(schedule.id);
    const blocker = await pool.connect();
    let allowed = true;
    let checks = 0;
    let attempted: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM automation_schedules WHERE id=$1 FOR UPDATE", [schedule.id]);
      const editingService = new AutomationService({ repository: editor, runner, now: () => now });
      attempted = Promise.allSettled([editingService.updatePrompt(schedule.id,
        { prompt: "must not commit", expectedPromptRevision: 0 }, {
          ...authority, currentMessageId: "revoked-edit", assertCurrentAuthority: async () => {
            checks += 1;
            if (!allowed) throw new Error("authorization revoked while waiting");
          },
        })]);
      await waitForBlockedEdit();
      expect(checks).toBeGreaterThanOrEqual(1);
      allowed = false;
    } finally {
      try { await blocker.query("ROLLBACK"); }
      finally { blocker.release(); }
      if (attempted) await attempted;
    }
    const [result] = await attempted!;
    expect(result.status).toBe("rejected");
    expect(result.status === "rejected" && result.reason).toEqual(new Error("authorization revoked while waiting"));
    expect(checks).toBeGreaterThanOrEqual(2);
    expect(await repository.get(schedule.id, authority.chatId)).toEqual(schedule);
    expect(await rowVersion(schedule.id)).toBe(beforeVersion);
  });

  it("preserves creation replay identity after editing, without accepting a forged frozen fingerprint", async () => {
    const creation = { ...authority, source: "admin_api" as const, idempotencyKey: "stable-create" };
    const original = await service().create(input, creation);
    const updated = await update(original.id);
    expect(updated?.creationFingerprint).toBeTruthy();
    expect(await service().create(input, creation)).toEqual(updated);
    await expect(service().create({ ...input, title: "different creation" }, creation)).rejects.toBeInstanceOf(AutomationConflictError);
    await expect(repository.create({ ...updated!, title: "forged inherited fingerprint" })).rejects.toBeInstanceOf(AutomationConflictError);
    expect(await repository.get(original.id, "different-chat")).toBeNull();
    expect(await editor.updatePrompt(original.id, "different-chat", { prompt: "cross-chat", expectedPromptRevision: 1 }, editAuthority, now)).toBeNull();
  });

  it("keeps a normalized no-op read-only and accepts the exact persisted retry after completion", async () => {
    const schedule = await service().create({ ...input, timing: { type: "at", at: new Date(start + minute).toISOString() } }, authority);
    now += 1_000;
    const originalVersion = await rowVersion(schedule.id);
    expect(await update(schedule.id, "  original prompt  ")).toEqual(schedule);
    expect(await rowVersion(schedule.id)).toBe(originalVersion);
    const updated = await update(schedule.id);
    now = start + minute;
    const [claim] = await repository.claimDue(now, "worker", 10);
    const claimed = await repository.get(schedule.id, authority.chatId);
    const claimedVersion = await rowVersion(schedule.id);
    expect(await update(schedule.id)).toEqual(claimed);
    expect(await rowVersion(schedule.id)).toBe(claimedVersion);
    await expect(update(schedule.id, "third prompt", 1)).rejects.toBeInstanceOf(AutomationConflictError);
    expect(await repository.finish(claim.run.id, "worker", { status: "completed", result: { text: "done" } }, now)).toBe(true);
    const completed = await repository.get(schedule.id, authority.chatId);
    expect(completed?.status).toBe("completed");
    const completedVersion = await rowVersion(schedule.id);
    expect(await update(schedule.id)).toEqual(completed);
    expect(await rowVersion(schedule.id)).toBe(completedVersion);
    expect(completed?.latestPromptUpdate).toEqual(updated?.latestPromptUpdate);
  });

  it("checks the committed claim after waiting for its row lock and cannot erase the active run", async () => {
    const schedule = await service().create(input, authority);
    now += minute;
    const gate = holdLock(pool, "FOR UPDATE SKIP LOCKED");
    const claiming = gate.repository.claimDue(now, "claim-owner", 10);
    let editing: Promise<unknown> | undefined;
    try {
      await waitForLock(gate.locked);
      editing = expect(update(schedule.id)).rejects.toBeInstanceOf(AutomationConflictError);
      await waitForBlockedEdit();
    } finally {
      gate.release();
      await settleTransactions([claiming, ...(editing ? [editing] : [])]);
    }
    const [claim] = await claiming;
    expect(await repository.get(schedule.id, authority.chatId)).toEqual(claim.schedule);
    expect((await repository.listRuns(schedule.id, authority.chatId))[0]).toEqual(claim.run);
  });

  it("edits the latest finished schedule while preserving history and dispatches the new prompt next time", async () => {
    const schedule = await service().create(input, authority);
    now += minute;
    const [claim] = await repository.claimDue(now, "finish-owner", 10);
    const gate = holdLock(pool, "FOR UPDATE OF s");
    const finishing = gate.repository.finish(claim.run.id, "finish-owner", { status: "completed", result: { text: "old report" } }, now);
    let editing: ReturnType<typeof update> | undefined;
    try {
      await waitForLock(gate.locked);
      editing = update(schedule.id);
      await waitForBlockedEdit();
    } finally {
      gate.release();
      await settleTransactions([finishing, ...(editing ? [editing] : [])]);
    }
    expect(await finishing).toBe(true);
    const edited = await editing;
    expect(edited?.activeRunId).toBeUndefined();
    expect(edited?.nextAt).toBe(start + 2 * minute);
    expect(edited?.lastOutcome).toBe("completed");
    const history = await repository.listRuns(schedule.id, authority.chatId);
    const reports = await repository.pendingOutbox(now);
    expect(history[0].result?.text).toBe("old report");
    expect(reports[0].text).toBe("old report");
    const observed: string[] = [];
    now += minute;
    await service({ ...runner, start: async (_run, current) => {
      if (current.kind !== "background") throw new Error("Expected background schedule");
      observed.push(current.background.prompt);
      return { status: "completed", result: { text: "new report" } };
    } }).tick();
    expect(observed).toEqual(["updated prompt"]);
    expect((await repository.listRuns(schedule.id, authority.chatId)).find(run => run.id === claim.run.id)).toEqual(history[0]);
    expect((await repository.pendingOutbox(now)).find(item => item.id === reports[0].id)).toEqual(reports[0]);
  });
});
