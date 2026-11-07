import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BackgroundService, BackgroundSpecSchema, MemoryBackgroundRepository, WORKER_LIFETIME_MS,
  WORKER_SHUTDOWN_GRACE_MS, type WorkerReceipt } from "../src/background/index.js";
import { BackgroundWorkerFailure } from "../src/background/failure.js";

const BASE = Date.parse("2026-11-07T02:00:00Z");
function fixture() {
  let now = BASE;
  const repository = new MemoryBackgroundRepository();
  const runtime = { start: vi.fn(async (): Promise<WorkerReceipt> => ({ status: "running" })),
    inspect: vi.fn(async (): Promise<WorkerReceipt> => ({ status: "running" })),
    cancel: vi.fn(async () => {}), cleanup: vi.fn(async () => {}), exportArtifacts: vi.fn(async () => []) };
  const reports: { error: unknown; durable: ReturnType<typeof repository.getByRun> }[] = [];
  const run = { id: randomUUID(), scheduleId: randomUUID(), chatId: "fixture", scheduledAt: BASE };
  const source = vi.fn(async (_node: string, request: { automationId: string; expectedAt: number; notAfter: number }) => ({
    ...request, status: "completed" as const, sessionId: "source", turnId: "exact-turn", text: "completed report",
    sources: ["synthetic-receipt"], observedAt: now,
  }));
  const options = { repository, runtime, now: () => now, sources: { inspectAutomation: source },
    deliverSupplement: vi.fn(async () => {}),
    onError: (error: unknown) => { reports.push({ error, durable: repository.getByRun(run.id) }); } };
  const service = new BackgroundService(options);
  const spec = BackgroundSpecSchema.parse({ prompt: "monitor completed report", sources: [{ nodeId: "node", automationId: "daily" }] });
  return { repository, runtime, reports, run, source, options, service, spec, setTime: (value: number) => { now = value; } };
}

describe("safe background failure correlation", () => {
  it("logs a persisted authentication outcome without changing completed source evidence or replaying", async () => {
    const f = fixture(); await f.service.start(f.run, f.spec);
    f.runtime.inspect.mockResolvedValue({ status: "needs_attention", summary: "后台执行器认证失败，外部影响尚未核实。",
      error: "worker_authentication_failed", failureDiagnostic: { category: "authentication_failed", executionEvidence: "unverified" } });
    expect(await f.service.inspect(f.run)).toMatchObject({ status: "failed", result: { error: "worker_authentication_failed" } });
    const worker = (await f.repository.getByRun(f.run.id))!;
    const report = f.reports.find(item => item.error instanceof BackgroundWorkerFailure)!;
    expect((report.error as BackgroundWorkerFailure).diagnostic).toEqual({ event: "background_worker_failed",
      runId: f.run.id, workerId: worker.id, invocationId: worker.invocations[0].id,
      category: "authentication_failed", executionEvidence: "unverified" });
    expect((await report.durable)?.initialOutcome?.status).toBe("failed");
    expect(worker.observations[0]).toMatchObject({ status: "completed", text: "completed report", turnId: "exact-turn" });
    const restarted = new BackgroundService(f.options);
    await restarted.inspect(f.run); await restarted.maintenance();
    expect(f.runtime.start).toHaveBeenCalledTimes(1);
    expect(f.source).toHaveBeenCalledTimes(1);
  });

  it("does not claim a durable failure when the terminal update fails", async () => {
    const f = fixture(); await f.service.start(f.run, f.spec);
    f.runtime.inspect.mockResolvedValue({ status: "failed", summary: "safe failure", error: "worker_execution_unverified" });
    const original = f.repository.update.bind(f.repository);
    vi.spyOn(f.repository, "update").mockImplementation((id, mutate) => original(id, current => {
      mutate(current);
      if (current.initialOutcome?.status === "failed") throw new Error("storage unavailable");
    }));
    await expect(f.service.inspect(f.run)).rejects.toThrow("storage unavailable");
    expect(f.reports.some(item => item.error instanceof BackgroundWorkerFailure)).toBe(false);
    expect((await f.repository.getByRun(f.run.id))?.initialOutcome).toBeUndefined();
  });

  it("keeps an active invocation stopped at retention expiry unverified", async () => {
    const f = fixture(); await f.service.start(f.run, f.spec);
    f.setTime(BASE + WORKER_LIFETIME_MS + WORKER_SHUTDOWN_GRACE_MS);
    await f.service.inspect(f.run);
    expect(f.runtime.cancel).toHaveBeenCalledTimes(1);
    const report = f.reports.find(item => item.error instanceof BackgroundWorkerFailure)!;
    expect((report.error as BackgroundWorkerFailure).diagnostic).toMatchObject({ category: "expired", executionEvidence: "unverified" });
    expect((await f.repository.getByRun(f.run.id))?.initialOutcome?.result?.error).toBe("worker_expired");
  });

  it.each(["worker_cancelled_before_launch", "worker_process_cleanup_unverified", "untrusted-provider-text"])(
    "only logs allowlisted categories (%s)", async code => {
      const f = fixture(); await f.service.start(f.run, f.spec);
      f.runtime.inspect.mockResolvedValue({ status: "needs_attention", summary: "safe failure", error: code });
      await f.service.inspect(f.run);
      const report = f.reports.find(item => item.error instanceof BackgroundWorkerFailure)!;
      const diagnostic = (report.error as BackgroundWorkerFailure).diagnostic;
      expect(diagnostic).toMatchObject(code === "worker_cancelled_before_launch" ? { category: "not_started", executionEvidence: "not_started" }
        : { category: code === "worker_process_cleanup_unverified" ? "cleanup_unverified" : "execution_unverified", executionEvidence: "unverified" });
      expect(JSON.stringify(diagnostic)).not.toContain("untrusted-provider-text");
    });
});
