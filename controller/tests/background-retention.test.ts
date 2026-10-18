import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { BackgroundService, BackgroundSpecSchema, MemoryBackgroundRepository, PostgresBackgroundRepository,
  initBackgroundTables, WORKER_LIFETIME_MS, type BackgroundRepository, type WorkerReceipt } from "../src/background/index.js";

const BASE = Date.parse("2026-10-18T01:00:00Z");
const secret = "private-task-body-37c136";
const artifact = { name: "report.txt", path: "/exports/report.txt", size: 10, sha256: "hash" };
function fixture(repository: BackgroundRepository) {
  let now = BASE;
  const runtime = {
    start: vi.fn(async (): Promise<WorkerReceipt> => ({ status: "completed", summary: secret, threadId: "thread" })),
    inspect: vi.fn(async (): Promise<WorkerReceipt> => ({ status: "failed", summary: secret, error: secret })),
    exportArtifacts: vi.fn(async () => [artifact]), cancel: vi.fn(async () => undefined), cleanup: vi.fn(async () => undefined),
  };
  const options = { repository, runtime, now: () => now, sources: { inspectAutomation: vi.fn(async (_node: string,
    request: { automationId: string; expectedAt: number; notAfter: number }) => ({ ...request, status: "completed" as const,
    sessionId: "source-session", turnId: "source-turn", text: secret, sources: [secret], observedAt: now })) },
    artifactLinks: vi.fn(async () => ["https://example.com/download"]),
    retainDiscardedArtifacts: vi.fn(async () => undefined), deliverSupplement: vi.fn(async () => undefined) };
  const service = new BackgroundService(options);
  const run = { id: randomUUID(), chatId: "chat", scheduleId: "schedule", scheduledAt: BASE };
  const spec = BackgroundSpecSchema.parse({ prompt: secret, preferences: [secret],
    sources: [{ nodeId: "node", automationId: "source", offsetMs: 0, windowMs: 60_000 }] });
  return { repository, runtime, options, service, run, spec, setTime: (time: number) => { now = time; },
    worker: () => repository.getByRun(run.id) };
}

function retentionContract(name: string, repository: () => BackgroundRepository) {
  describe(name, () => {
    it("erases execution bodies only after safe cleanup, retaining attachment ownership and creation identity", async () => {
      const f = fixture(repository());
      await f.service.start(f.run, f.spec); await f.service.acceptResult(f.run.id);
      const worker = (await f.worker())!;
      await f.service.enqueue(worker.id, "chat", secret, "followup");
      await f.service.maintenance(); await f.service.maintenance();
      expect(JSON.stringify(await f.worker())).toContain(secret);
      f.setTime(BASE + WORKER_LIFETIME_MS); await f.service.maintenance();
      const cleared = (await f.worker())!;
      expect(cleared.phase).toBe("cleaned"); expect(cleared.bodyClearedAt).toBe(BASE + WORKER_LIFETIME_MS);
      expect(JSON.stringify(cleared)).not.toContain(secret);
      expect(cleared.invocations).toHaveLength(2);
      for (const invocation of cleared.invocations) {
        expect(invocation.exported).toBe(true); expect(invocation.acceptedAt).toBe(BASE);
        expect(invocation.receipt?.artifacts).toEqual([artifact]);
      }
      expect(f.runtime.cleanup).toHaveBeenCalledWith(worker.id);
      expect((await f.service.register(f.run, f.spec)).id).toBe(worker.id);
      await expect(f.service.register(f.run, { ...f.spec, prompt: "different authorization" })).rejects.toThrow("conflicts");
    });
    it("retains every body if workspace cleanup fails and safely clears it on retry", async () => {
      const f = fixture(repository());
      await f.service.start(f.run, f.spec); await f.service.acceptResult(f.run.id);
      f.runtime.cleanup.mockRejectedValueOnce(new Error("filesystem unavailable"));
      f.setTime(BASE + WORKER_LIFETIME_MS);
      await expect(f.service.maintenance()).rejects.toThrow("durable state retained");
      const retained = (await f.worker())!;
      expect(retained.phase).toBe("cleaning"); expect(retained.bodyClearedAt).toBeUndefined();
      expect(retained.spec.prompt).toBe(secret); expect(retained.observations[0].text).toBe(secret);
      await f.service.maintenance(); expect((await f.worker())!.phase).toBe("cleaned");
      expect(JSON.stringify(await f.worker())).not.toContain(secret);
    });
  });
}

retentionContract("in-memory worker body retention", () => new MemoryBackgroundRepository());
const connectionString = process.env.AUTOMATION_TEST_DATABASE_URL;
(connectionString ? describe : describe.skip)("Postgres worker body retention", () => {
  const schema = `background_retention_test_${randomUUID().replaceAll("-", "")}`;
  let admin: pg.Pool, pool: pg.Pool;
  beforeAll(async () => {
    admin = new pg.Pool({ connectionString }); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` }); await initBackgroundTables(pool);
  });
  beforeEach(async () => { await pool.query("TRUNCATE background_workers"); });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });
  retentionContract("persisted lifecycle", () => new PostgresBackgroundRepository(pool));
  it("renews the database lease during source I/O and fences a competing controller", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const f = fixture(new PostgresBackgroundRepository(pool));
    let finishObservation!: (value: Awaited<ReturnType<typeof f.options.sources.inspectAutomation>>) => void;
    f.options.sources.inspectAutomation.mockImplementation(() => new Promise(resolve => { finishObservation = resolve; }));
    const starting = f.service.start(f.run, f.spec);
    try {
      await vi.waitFor(() => expect(f.options.sources.inspectAutomation).toHaveBeenCalledTimes(1));
      f.setTime(BASE + 20_000); await vi.advanceTimersByTimeAsync(20_000);
      await vi.waitFor(async () => expect((await f.worker())!.leaseUntil).toBe(BASE + 80_000));
      await new BackgroundService({ ...f.options, repository: new PostgresBackgroundRepository(pool) }).maintenance();
      expect(f.options.sources.inspectAutomation).toHaveBeenCalledTimes(1);
    } finally {
      finishObservation({ ...f.options.sources.inspectAutomation.mock.calls[0][1], status: "completed", sessionId: "s", turnId: "t",
        text: secret, sources: [], observedAt: BASE + 20_000 });
      await starting; vi.useRealTimers();
    }
    expect(f.runtime.start).toHaveBeenCalledTimes(1); expect((await f.worker())!.leaseUntil).toBe(0);
  });
});

describe("revoked worker lifecycle", () => {
  it("discards expired revoked results without notification, retaining artifacts and no private body", async () => {
    const f = fixture(new MemoryBackgroundRepository()); let allowed = true;
    f.runtime.start.mockResolvedValue({ status: "running" });
    const service = new BackgroundService({ ...f.options, isAllowed: () => allowed });
    await service.start(f.run, f.spec);
    const worker = (await f.worker())!;
    await service.enqueue(worker.id, "chat", secret, "pending"); allowed = false;
    await service.maintenance(); expect(f.runtime.cleanup).not.toHaveBeenCalled();
    f.setTime(BASE + WORKER_LIFETIME_MS); await service.maintenance();
    const cleared = (await f.worker())!;
    expect(cleared.phase).toBe("cleaned"); expect(cleared.initialAcceptedAt).toBeUndefined();
    expect(cleared.initialDiscardedAt).toBe(BASE + WORKER_LIFETIME_MS);
    expect(cleared.invocations[0].discardedAt).toBe(BASE + WORKER_LIFETIME_MS);
    expect(cleared.invocations[0].receipt?.artifacts).toEqual([artifact]);
    expect(f.options.retainDiscardedArtifacts).toHaveBeenCalledWith(expect.objectContaining({ id: worker.id }),
      expect.objectContaining({ kind: "initial" }), [artifact]);
    expect(f.options.deliverSupplement).not.toHaveBeenCalled();
    expect(JSON.stringify(cleared)).not.toContain(secret);
  });
  it("preserves revoked bodies and exports when artifact retention is unavailable", async () => {
    const f = fixture(new MemoryBackgroundRepository()); let allowed = true;
    f.runtime.start.mockResolvedValue({ status: "running" });
    const service = new BackgroundService({ ...f.options, isAllowed: () => allowed, retainDiscardedArtifacts: undefined });
    await service.start(f.run, f.spec); allowed = false; f.setTime(BASE + WORKER_LIFETIME_MS);
    await expect(service.maintenance()).rejects.toThrow("durable state retained");
    expect(f.runtime.cleanup).not.toHaveBeenCalled(); expect((await f.worker())!.bodyClearedAt).toBeUndefined();
  });
  it("quarantines a revoked worker when shutdown cannot be verified", async () => {
    const f = fixture(new MemoryBackgroundRepository()); let allowed = true;
    f.runtime.start.mockResolvedValue({ status: "running" });
    const service = new BackgroundService({ ...f.options, isAllowed: () => allowed });
    await service.start(f.run, f.spec); allowed = false; f.setTime(BASE + WORKER_LIFETIME_MS);
    f.runtime.inspect.mockResolvedValue({ status: "needs_attention", error: "worker_process_cleanup_unverified" });
    await service.maintenance(); await service.maintenance();
    expect((await f.worker())!.phase).toBe("quarantined");
    expect(f.runtime.cleanup).not.toHaveBeenCalled(); expect(f.runtime.exportArtifacts).not.toHaveBeenCalled();
  });
});

describe("dispatch lifecycle boundaries", () => {
  it("preserves a completed model result discovered after the shutdown grace instead of replacing it with expiry", async () => {
    const f = fixture(new MemoryBackgroundRepository());
    f.runtime.start.mockResolvedValue({ status: "running" });
    await f.service.start(f.run, f.spec);
    f.setTime(BASE + WORKER_LIFETIME_MS + 60_000);
    f.runtime.inspect.mockResolvedValue({ status: "completed", summary: secret });
    await f.service.maintenance();
    expect((await f.worker())!.initialOutcome).toMatchObject({ status: "completed", result: { text: expect.stringContaining(secret) } });
    expect(f.runtime.cancel).not.toHaveBeenCalled();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    await f.service.acceptResult(f.run.id); await f.service.maintenance();
    expect((await f.worker())!.phase).toBe("cleaned");
  });
  it("does not start a new turn if a slow source finishes after the retention deadline", async () => {
    const f = fixture(new MemoryBackgroundRepository());
    await f.service.register(f.run, f.spec); f.setTime(BASE + WORKER_LIFETIME_MS - 1_000);
    f.options.sources.inspectAutomation.mockImplementation(async (_node, request) => {
      f.setTime(BASE + WORKER_LIFETIME_MS);
      return { ...request, status: "completed", sessionId: "s", turnId: "t", text: secret, sources: [], observedAt: BASE };
    });
    await f.service.start(f.run, f.spec);
    expect(f.runtime.start).not.toHaveBeenCalled();
    await f.service.maintenance();
    expect((await f.worker())!.initialOutcome).toMatchObject({ status: "failed", result: { error: "worker_expired" } });
  });
  it("rechecks durable cancellation after awaiting the final schedule authorization lookup", async () => {
    const f = fixture(new MemoryBackgroundRepository());
    let resolveStatus!: (status: "active") => void;
    let lookupStarted!: () => void;
    const started = new Promise<void>(resolve => { lookupStarted = resolve; });
    let calls = 0;
    const service = new BackgroundService({ ...f.options, getScheduleStatus: async () => {
      if (++calls === 2) { lookupStarted(); return new Promise(resolve => { resolveStatus = resolve; }); }
      return "active";
    } });
    const launching = service.start(f.run, f.spec); await started;
    await service.cancel((await f.worker())!.id, "chat"); resolveStatus("active"); await launching;
    expect(f.runtime.start).not.toHaveBeenCalled();
    expect((await f.worker())!.invocations).toHaveLength(0);
    await service.maintenance(); expect((await f.worker())!.phase).toBe("cancelled");
  });
});

describe("background shutdown preserves authorization and continuation", () => {
  it("does not treat shutdown as revocation or discard expired results", async () => {
    const f = fixture(new MemoryBackgroundRepository()); let stopping = false;
    const service = new BackgroundService({ ...f.options, isStopping: () => stopping, isAllowed: () => !stopping });
    await service.start(f.run, f.spec); const before = (await f.worker())!;
    stopping = true; f.setTime(BASE + WORKER_LIFETIME_MS); await service.maintenance();
    const after = (await f.worker())!;
    expect(after.initialOutcome).toEqual(before.initialOutcome); expect(after.phase).toBe("completed");
    expect(after.suspendedAt).toBeUndefined(); expect(after.initialDiscardedAt).toBeUndefined();
    expect(after.bodyClearedAt).toBeUndefined(); expect(after.cancelRequestedAt).toBeUndefined();
    expect(f.runtime.cleanup).not.toHaveBeenCalled(); expect(f.runtime.cancel).not.toHaveBeenCalled();
  });
  it("stops after pending source inspection without launching or publishing a synthetic cancellation", async () => {
    const f = fixture(new MemoryBackgroundRepository()); let stopping = false;
    let finishSource!: (value: Awaited<ReturnType<typeof f.options.sources.inspectAutomation>>) => void;
    let sourceStarted!: () => void;
    const started = new Promise<void>(resolve => { sourceStarted = resolve; });
    f.options.sources.inspectAutomation.mockImplementation(() => new Promise(resolve => { finishSource = resolve; sourceStarted(); }));
    const service = new BackgroundService({ ...f.options, isStopping: () => stopping });
    const starting = service.start(f.run, f.spec); await started;
    stopping = true;
    finishSource({ ...f.options.sources.inspectAutomation.mock.calls[0][1], status: "completed", sessionId: "s", turnId: "t",
      text: secret, sources: [], observedAt: BASE });
    expect(await starting).toEqual({ status: "running" });
    expect(f.runtime.start).not.toHaveBeenCalled(); expect(f.runtime.cancel).not.toHaveBeenCalled();
    expect(f.options.deliverSupplement).not.toHaveBeenCalled();
    const worker = (await f.worker())!;
    expect(worker.initialOutcome).toBeUndefined(); expect(worker.initialDiscardedAt).toBeUndefined();
    expect(worker.cancelRequestedAt).toBeUndefined(); expect(worker.suspendedAt).toBeUndefined();
    expect(worker.invocations).toEqual([]); expect(worker.leaseUntil).toBe(0);
    stopping = false;
    f.options.sources.inspectAutomation.mockResolvedValue({ ...f.options.sources.inspectAutomation.mock.calls[0][1],
      status: "completed", sessionId: "s", turnId: "t", text: secret, sources: [], observedAt: BASE });
    await service.maintenance(); expect(f.runtime.start).toHaveBeenCalledTimes(1);
  });
  it("removes an unsubmitted invocation when shutdown begins during the final schedule lookup", async () => {
    const f = fixture(new MemoryBackgroundRepository()); let stopping = false; let calls = 0;
    let finishStatus!: (status: "active") => void;
    let statusStarted!: () => void;
    const started = new Promise<void>(resolve => { statusStarted = resolve; });
    const service = new BackgroundService({ ...f.options, isStopping: () => stopping, getScheduleStatus: async () => {
      if (++calls === 2) return new Promise(resolve => { finishStatus = resolve; statusStarted(); });
      return "active";
    } });
    const starting = service.start(f.run, f.spec); await started;
    stopping = true; finishStatus("active"); await starting;
    const worker = (await f.worker())!;
    expect(f.runtime.start).not.toHaveBeenCalled(); expect(worker.activeInvocationId).toBeUndefined();
    expect(worker.invocations).toEqual([]); expect(worker.phase).toBe("observing");
    expect(worker.cancelRequestedAt).toBeUndefined(); expect(worker.initialDiscardedAt).toBeUndefined();
    stopping = false; await service.maintenance(); expect(f.runtime.start).toHaveBeenCalledTimes(1);
  });
});
