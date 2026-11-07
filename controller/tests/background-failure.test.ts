import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundService, BackgroundSpecSchema, MemoryBackgroundRepository, WORKER_LIFETIME_MS,
  WORKER_SHUTDOWN_GRACE_MS, type WorkerReceipt } from "../src/background/index.js";
import { BackgroundWorkerFailure } from "../src/background/failure.js";

const BASE = Date.parse("2026-11-07T02:00:00Z");
afterEach(() => vi.restoreAllMocks());
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

  it("classifies an active invocation cancelled through the service without claiming it never started", async () => {
    const f = fixture(); await f.service.start(f.run, f.spec);
    const worker = (await f.repository.getByRun(f.run.id))!;
    f.runtime.inspect.mockResolvedValue({ status: "needs_attention", summary: "Execution interrupted; effects unverified",
      error: "worker_interrupted" });
    await f.service.cancel(worker.id, f.run.chatId);
    expect(await f.service.inspect(f.run)).toMatchObject({ status: "failed", result: { error: "worker_cancelled" } });
    expect(f.runtime.cancel).toHaveBeenCalledWith(worker.id, worker.activeInvocationId);
    const report = f.reports.find(item => item.error instanceof BackgroundWorkerFailure)!;
    expect((report.error as BackgroundWorkerFailure).diagnostic).toMatchObject({
      category: "cancelled", executionEvidence: "unverified",
    });
    expect((await f.repository.getByRun(f.run.id))?.phase).toBe("cancelled");
  });

  it("finishes cancellation and preserves a committed receipt when the failure hook throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fixture(); await f.service.start(f.run, f.spec);
    const worker = (await f.repository.getByRun(f.run.id))!;
    await f.service.enqueue(worker.id, f.run.chatId, "pending followup", "followup-request");
    f.options.onError = vi.fn(() => { throw new Error("private-hook-secret"); });
    f.runtime.inspect.mockResolvedValue({ status: "needs_attention", summary: "Execution interrupted; effects unverified",
      error: "worker_interrupted" });
    await f.service.cancel(worker.id, f.run.chatId);
    await expect(f.service.inspect(f.run)).resolves.toMatchObject({ status: "failed", result: { error: "worker_cancelled" } });
    const saved = (await f.repository.getByRun(f.run.id))!;
    expect(saved.phase).toBe("cancelled");
    expect(saved.invocations[0]).toMatchObject({ status: "failed", receipt: { error: "worker_cancelled" }, discardedAt: BASE });
    expect(saved.prompts[0].cancelledAt).toBe(BASE);
    expect(saved.activeInvocationId).toBeUndefined();
    await f.service.inspect(f.run);
    expect(f.runtime.start).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toEqual([["Background service error reporting failed"]]);
  });

  it("persists an uncertain submission and resumes observation when the failure hook throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fixture();
    f.options.onError = vi.fn(() => { throw new Error("private-hook-secret"); });
    f.runtime.start.mockRejectedValueOnce(new Error("private-provider-secret"));
    await expect(f.service.start(f.run, f.spec)).resolves.toMatchObject({ status: "running" });
    const worker = (await f.repository.getByRun(f.run.id))!;
    expect(worker.invocations[0]).toMatchObject({ status: "running", receipt: { status: "unknown" } });
    expect(worker.activeInvocationId).toBe(worker.invocations[0].id);
    f.runtime.inspect.mockResolvedValue({ status: "completed", summary: "observed completion" });
    await expect(f.service.inspect(f.run)).resolves.toMatchObject({ status: "completed", result: { text: "observed completion" } });
    expect(f.runtime.start).toHaveBeenCalledTimes(1);
    expect(log.mock.calls).toEqual([["Background service error reporting failed"]]);
  });

  it("retains all maintenance failures and recovers both workers when the failure hook throws", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fixture(); await f.service.start(f.run, f.spec);
    const anotherRun = { ...f.run, id: randomUUID(), scheduleId: randomUUID() };
    await f.service.start(anotherRun, f.spec);
    const providerError = new Error("private-provider-secret");
    const reporter = vi.fn(() => { throw new Error("private-hook-secret"); });
    f.options.onError = reporter;
    f.runtime.inspect.mockRejectedValue(providerError);
    await expect(f.service.maintenance()).rejects.toMatchObject({ name: "AggregateError", errors: [providerError, providerError] });
    expect(reporter).toHaveBeenCalledTimes(2);
    expect(log.mock.calls).toEqual(Array.from({ length: 2 }, () => ["Background service error reporting failed"]));
    f.runtime.inspect.mockResolvedValue({ status: "completed", summary: "observed completion" });
    await expect(f.service.maintenance()).resolves.toBeUndefined();
    for (const run of [f.run, anotherRun]) expect((await f.repository.getByRun(run.id))?.initialOutcome?.status).toBe("completed");
    expect(f.runtime.start).toHaveBeenCalledTimes(2);
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
