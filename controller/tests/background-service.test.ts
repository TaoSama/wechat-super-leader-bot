import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { BackgroundService, BackgroundSpecSchema, MemoryBackgroundRepository, WORKER_LIFETIME_MS, WORKER_SHUTDOWN_GRACE_MS,
  type BackgroundRun, type BackgroundServiceOptions, type WorkerReceipt } from "../src/background/index.js";

const BASE = Date.parse("2026-10-18T01:00:00Z");
function setup() {
  let now = BASE;
  const repository = new MemoryBackgroundRepository();
  const runtime = {
    start: vi.fn(async (): Promise<WorkerReceipt> => ({ status: "running" })),
    inspect: vi.fn(async (): Promise<WorkerReceipt> => ({ status: "running" })),
    exportArtifacts: vi.fn(async () => []), cancel: vi.fn(async () => undefined), cleanup: vi.fn(async () => undefined),
  };
  const source = { inspectAutomation: vi.fn(async (_node: string, request: { automationId: string; expectedAt: number; notAfter: number }) => ({
    ...request, status: "waiting" as const, observedAt: now, sources: ["automation_runs"],
  })) };
  const deliverSupplement = vi.fn(async () => undefined);
  const options: BackgroundServiceOptions = { repository, runtime, sources: source, deliverSupplement, now: () => now };
  const service = new BackgroundService(options);
  const run: BackgroundRun = { id: randomUUID(), scheduleId: "daily", chatId: "chat", scheduledAt: BASE };
  const spec = BackgroundSpecSchema.parse({ prompt: "汇总跨机器任务结果" });
  return { service, options, run, spec, runtime, repository, source, deliverSupplement,
    setTime: (value: number) => { now = value; }, worker: () => repository.getByRun(run.id) };
}
const watched = (f: ReturnType<typeof setup>) => ({ ...f.spec, sources: [{ nodeId: "mini", automationId: "daily", offsetMs: -3_600_000, windowMs: 60_000 }] });

describe("24-hour isolated background workers", () => {
  it.each([undefined, 2 * 3_600_000])("starts partial analysis at the default one-hour or explicit deadline (%s)", async deadlineMs => {
    const f = setup();
    const spec = BackgroundSpecSchema.parse({ prompt: "汇总跨机器任务结果", sources: watched(f).sources, deadlineMs });
    const duration = deadlineMs ?? 3_600_000;
    await f.service.start(f.run, spec);
    expect((await f.worker())!.deadlineAt).toBe(BASE + duration);
    expect((await f.worker())!.expiresAt).toBe(BASE + WORKER_LIFETIME_MS);
    f.setTime(BASE + duration - 1); await f.service.inspect(f.run);
    expect(f.runtime.start).not.toHaveBeenCalled();
    f.setTime(BASE + duration); await f.service.inspect(f.run);
    expect(f.runtime.start).toHaveBeenCalledTimes(1);
    expect(f.runtime.start.mock.calls[0]).toMatchObject([{ input: { deadlineReached: true, missing: [{ status: "waiting" }] } }]);
  });
  it("creates one worker per run, keeps expiry fixed, and starts a new worker for the next run", async () => {
    const f = setup();
    await f.service.start(f.run, f.spec);
    const first = (await f.worker())!;
    f.setTime(BASE + 1_000);
    await f.service.start(f.run, f.spec);
    expect((await f.worker())!.id).toBe(first.id);
    expect((await f.worker())!.expiresAt).toBe(BASE + WORKER_LIFETIME_MS);
    expect(f.runtime.start).toHaveBeenCalledTimes(1);
    await f.service.start({ ...f.run, id: randomUUID(), scheduledAt: BASE + WORKER_LIFETIME_MS }, f.spec);
    expect((await f.service.list("chat"))).toHaveLength(2);
    expect(new Set((await f.service.list("chat")).map(item => item.id)).size).toBe(2);
  });
  it("waits with 2/5/10-minute backoff and uses precise source occurrence offsets", async () => {
    const f = setup();
    await f.service.start(f.run, watched(f));
    expect(f.source.inspectAutomation).toHaveBeenCalledWith("mini", { automationId: "daily", expectedAt: BASE - 3_600_000, notAfter: BASE - 3_540_000 });
    expect((await f.worker())!.nextCheckAt).toBe(BASE + 120_000);
    expect(f.runtime.start).not.toHaveBeenCalled();
    f.setTime(BASE + 119_000); await f.service.inspect(f.run);
    expect(f.source.inspectAutomation).toHaveBeenCalledTimes(1);
    f.setTime(BASE + 120_000); await f.service.inspect(f.run);
    expect((await f.worker())!.nextCheckAt).toBe(BASE + 420_000);
    f.setTime(BASE + 420_000); await f.service.inspect(f.run);
    expect((await f.worker())!.nextCheckAt).toBe(BASE + 1_020_000);
  });
  it("treats offline as unknown and analyzes partial results at deadline", async () => {
    const f = setup();
    f.source.inspectAutomation.mockRejectedValue(new Error("node_offline"));
    await f.service.start(f.run, { ...watched(f), deadlineMs: 300_000 });
    expect((await f.worker())!.observations[0].status).toBe("unknown");
    expect(f.runtime.start).not.toHaveBeenCalled();
    f.setTime(BASE + 300_000); await f.service.inspect(f.run);
    expect(f.runtime.start).toHaveBeenCalledTimes(1);
    const input = f.runtime.start.mock.calls[0] as unknown[];
    expect(input[0]).toMatchObject({ input: { deadlineReached: true, missing: [{ status: "unknown" }] } });
  });
  it("rejects yesterday's receipt and completed output without exact run evidence", async () => {
    const f = setup();
    f.source.inspectAutomation.mockImplementation(async (_node, request) => ({ ...request, expectedAt: request.expectedAt - WORKER_LIFETIME_MS,
      status: "completed" as never, sessionId: "old", turnId: "old", text: "yesterday", observedAt: BASE, sources: [] }));
    await f.service.start(f.run, watched(f));
    expect((await f.worker())!.observations[0].reason).toBe("source_identity_mismatch");
    expect(f.runtime.start).not.toHaveBeenCalled();
    f.source.inspectAutomation.mockImplementation(async (_node, request) => ({ ...request, status: "completed" as never, observedAt: BASE, sources: [] }));
    f.setTime(BASE + 120_000); await f.service.inspect(f.run);
    expect((await f.worker())!.observations[0].reason).toBe("completion_receipt_or_result_missing");
  });
  it("collects exact completion and passes source evidence to the isolated worker", async () => {
    const f = setup();
    f.source.inspectAutomation.mockImplementation(async (_node, request) => ({ ...request, status: "completed" as never,
      sessionId: "session", turnId: "turn", text: "today", observedAt: BASE, sources: ["receipt"] }));
    await f.service.start(f.run, watched(f));
    expect(f.runtime.start).toHaveBeenCalledTimes(1);
    expect((await f.worker())!.observations[0].text).toBe("today");
  });
  it("resumes the same invocation after controller restart without redispatch", async () => {
    const f = setup();
    await f.service.start(f.run, f.spec);
    const initial = (await f.worker())!;
    const restarted = new BackgroundService(f.options);
    f.runtime.inspect.mockResolvedValue({ status: "completed", summary: "done", threadId: "same-thread" });
    expect(await restarted.inspect(f.run)).toMatchObject({ status: "completed", result: { text: "done" } });
    expect(f.runtime.inspect).toHaveBeenCalledWith(initial.id, initial.activeInvocationId);
    expect(f.runtime.start).toHaveBeenCalledTimes(1);
    expect(f.runtime.exportArtifacts).toHaveBeenCalledTimes(1);
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
  });
  it("retains completed worker until expiry and requires durable result acceptance before cleanup", async () => {
    const f = setup();
    f.runtime.start.mockResolvedValue({ status: "completed", summary: "result" });
    await f.service.start(f.run, f.spec);
    await f.service.maintenance(); expect(f.runtime.cleanup).not.toHaveBeenCalled();
    f.setTime(BASE + WORKER_LIFETIME_MS); await f.service.maintenance();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
    await f.service.acceptResult(f.run.id); await f.service.maintenance();
    expect(f.runtime.cleanup).toHaveBeenCalledTimes(1);
    expect((await f.worker())!.phase).toBe("cleaned");
  });
  it("serializes queued followups, reuses worker and only delivers results through the outbox callback", async () => {
    const f = setup();
    f.runtime.start.mockResolvedValueOnce({ status: "completed", summary: "initial" }).mockResolvedValue({ status: "running" });
    await f.service.start(f.run, f.spec); await f.service.acceptResult(f.run.id);
    const worker = (await f.worker())!;
    await f.service.enqueue(worker.id, "chat", "check again", "user-1");
    await f.service.enqueue(worker.id, "chat", "explain", "user-2");
    await f.service.maintenance(); await f.service.maintenance();
    expect(f.runtime.start).toHaveBeenCalledTimes(2);
    f.runtime.inspect.mockResolvedValueOnce({ status: "completed", summary: "followup done" });
    await f.service.maintenance();
    expect(f.deliverSupplement).toHaveBeenCalledTimes(1);
    expect(f.runtime.start).toHaveBeenCalledTimes(3);
    expect((f.runtime.start.mock.calls[1] as unknown[])[0]).toMatchObject({ workerId: worker.id, task: "check again" });
    expect((f.runtime.start.mock.calls[2] as unknown[])[0]).toMatchObject({ workerId: worker.id, task: "explain" });
  });
  it("queues an immediate user followup while source monitoring is waiting", async () => {
    const f = setup(); await f.service.start(f.run, watched(f));
    await f.service.enqueue((await f.worker())!.id, "chat", "核对当前进展", "user-1");
    await f.service.maintenance();
    expect(f.runtime.start).toHaveBeenCalledTimes(1);
    f.runtime.inspect.mockResolvedValue({ status: "completed", summary: "仍在等待" });
    await f.service.maintenance();
    expect(f.deliverSupplement).toHaveBeenCalledTimes(1);
    expect((await f.worker())!.initialOutcome).toBeUndefined();
  });
  it("deduplicates user prompts and refuses unauthorized chats or conflicting request IDs", async () => {
    const f = setup(); await f.service.start(f.run, f.spec);
    const worker = (await f.worker())!;
    await f.service.enqueue(worker.id, "chat", "check", "key");
    await f.service.enqueue(worker.id, "chat", "check", "key");
    expect((await f.worker())!.prompts).toHaveLength(1);
    await expect(f.service.enqueue(worker.id, "chat", "different", "key")).rejects.toThrow("reused");
    await expect(f.service.enqueue(worker.id, "other-chat", "check", "key2")).rejects.toThrow("does not belong");
    expect(await f.service.get(worker.id, "other-chat")).toBeNull();
  });
  it("does not let automatic checks extend TTL, but permits explicit bounded extension", async () => {
    const f = setup(); await f.service.start(f.run, watched(f));
    f.setTime(BASE + 3_600_000); await f.service.inspect(f.run);
    const worker = (await f.worker())!;
    expect(worker.expiresAt).toBe(BASE + WORKER_LIFETIME_MS);
    await f.service.extend(worker.id, "chat", BASE + WORKER_LIFETIME_MS + 3_600_000);
    expect((await f.worker())!.expiresAt).toBe(BASE + WORKER_LIFETIME_MS + 3_600_000);
    await expect(f.service.extend(worker.id, "chat", BASE + 3 * WORKER_LIFETIME_MS)).rejects.toThrow("24 hours");
  });
  it("lets an active turn finish inside its expiry grace and cancels after the bound", async () => {
    const f = setup(); await f.service.start(f.run, f.spec);
    f.setTime(BASE + WORKER_LIFETIME_MS); await f.service.maintenance();
    expect(f.runtime.cancel).not.toHaveBeenCalled(); expect(f.runtime.cleanup).not.toHaveBeenCalled();
    f.setTime(BASE + WORKER_LIFETIME_MS + WORKER_SHUTDOWN_GRACE_MS); await f.service.maintenance();
    expect(f.runtime.cancel).toHaveBeenCalledTimes(1); expect(f.runtime.cleanup).not.toHaveBeenCalled();
    expect((await f.worker())!.initialOutcome).toMatchObject({ status: "failed", result: { error: "worker_expired" } });
  });
  it("does not replay an ambiguous dispatch", async () => {
    const f = setup(); f.runtime.start.mockRejectedValue(new Error("connection lost"));
    await f.service.start(f.run, f.spec); await f.service.inspect(f.run);
    expect(f.runtime.start).toHaveBeenCalledTimes(1); expect(f.runtime.inspect).toHaveBeenCalledTimes(1);
  });
  it("preserves the same worker when runtime asks to check later", async () => {
    const f = setup();
    f.runtime.start.mockResolvedValueOnce({ status: "waiting", summary: "等文件出现", nextCheckAt: new Date(BASE + 120_000).toISOString() }).mockResolvedValue({ status: "completed", summary: "文件已就绪" });
    expect(await f.service.start(f.run, f.spec)).toEqual({ status: "running" });
    const worker = (await f.worker())!;
    f.setTime(BASE + 120_000);
    expect(await f.service.inspect(f.run)).toMatchObject({ status: "completed" });
    expect((await f.worker())!.id).toBe(worker.id);
    expect(f.runtime.start).toHaveBeenCalledTimes(2);
  });
  it("fences parallel service instances so a worker starts only once", async () => {
    const f = setup();
    const second = new BackgroundService(f.options);
    await Promise.all([f.service.start(f.run, f.spec), second.start(f.run, f.spec)]);
    expect(f.runtime.start).toHaveBeenCalledTimes(1);
  });
  it("keeps followup receipts until outbox persistence succeeds", async () => {
    const f = setup(); f.runtime.start.mockResolvedValue({ status: "completed", summary: "done" });
    await f.service.start(f.run, f.spec); await f.service.acceptResult(f.run.id);
    await f.service.enqueue((await f.worker())!.id, "chat", "followup", "id");
    f.deliverSupplement.mockRejectedValueOnce(new Error("db down"));
    await f.service.maintenance(); await expect(f.service.maintenance()).rejects.toThrow("Background maintenance failed");
    expect((await f.worker())!.invocations[1].acceptedAt).toBeUndefined();
    await f.service.maintenance();
    expect((await f.worker())!.invocations[1].acceptedAt).toBe(BASE);
    expect(f.runtime.start).toHaveBeenCalledTimes(2);
  });
  it("keeps queued runtime receipts pending and cancels them only at bounded expiry", async () => {
    const f = setup(); f.runtime.start.mockResolvedValue({ status: "queued", summary: "queued" });
    f.runtime.inspect.mockResolvedValue({ status: "queued", summary: "queued" });
    expect(await f.service.start(f.run, f.spec)).toEqual({ status: "running" });
    expect(await f.service.inspect(f.run)).toEqual({ status: "running" });
    expect(f.runtime.exportArtifacts).not.toHaveBeenCalled();
    f.setTime(BASE + WORKER_LIFETIME_MS + WORKER_SHUTDOWN_GRACE_MS); await f.service.maintenance();
    expect(f.runtime.cancel).toHaveBeenCalledTimes(1);
  });
  it("passes exported artifacts through signed link generation before persisting results", async () => {
    const f = setup();
    f.runtime.start.mockResolvedValue({ status: "completed", summary: "report ready" });
    const artifacts = [{ name: "report.txt", path: "/private/export/report.txt", size: 6, sha256: "hash" }];
    f.runtime.exportArtifacts.mockResolvedValue(artifacts as never);
    const artifactLinks = vi.fn(async () => ["[report.txt](https://bot.example/artifact/signed)"]);
    const service = new BackgroundService({ ...f.options, artifactLinks });
    const outcome = await service.start(f.run, f.spec);
    expect(outcome).toMatchObject({ status: "completed", result: { text: "report ready\n\n[report.txt](https://bot.example/artifact/signed)" } });
    expect(artifactLinks).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(outcome)).not.toContain("/private/export");
  });
  it("retains exported files and retries when artifact URL generation fails", async () => {
    const f = setup(); f.runtime.start.mockResolvedValue({ status: "completed", summary: "ready" });
    f.runtime.exportArtifacts.mockResolvedValue([{ name: "report", path: "/export/report", size: 6, sha256: "h" }] as never);
    await expect(f.service.start(f.run, f.spec)).rejects.toThrow("Artifact delivery links");
    expect((await f.worker())!.activeInvocationId).toBeDefined();
    expect(f.runtime.cleanup).not.toHaveBeenCalled();
  });
  it("recovers a pre-dispatch run with no worker binding when its authorized spec is available", async () => {
    const f = setup();
    expect(await f.service.inspect(f.run, f.spec)).toEqual({ status: "running" });
    expect(f.runtime.start).toHaveBeenCalledTimes(1);
    expect(await f.worker()).not.toBeNull();
  });

  it("resumes waiting followups in the same worker and delivers only the final answer", async () => {
    const f = setup();
    f.runtime.start.mockResolvedValueOnce({ status: "completed", summary: "initial" })
      .mockResolvedValueOnce({ status: "waiting", summary: "稍后核对", nextCheckAt: new Date(BASE + 120_000).toISOString() })
      .mockResolvedValueOnce({ status: "completed", summary: "追问最终结果" });
    await f.service.start(f.run, f.spec); await f.service.acceptResult(f.run.id);
    const worker = (await f.worker())!;
    await f.service.enqueue(worker.id, "chat", "追问并等待结果", "followup");
    await f.service.maintenance(); await f.service.maintenance();
    expect(f.deliverSupplement).not.toHaveBeenCalled();
    expect(f.runtime.start).toHaveBeenCalledTimes(2);
    f.setTime(BASE + 120_000); await f.service.maintenance(); await f.service.maintenance();
    expect(f.runtime.start).toHaveBeenCalledTimes(3);
    expect(f.deliverSupplement).toHaveBeenCalledTimes(1);
    expect((await f.worker())!.id).toBe(worker.id);
    expect((await f.worker())!.prompts[0].deliveredAt).toBe(BASE + 120_000);
  });

  it("keeps unknown runtime inspections pending and later accepts the same invocation's result", async () => {
    const f = setup(); await f.service.start(f.run, f.spec);
    f.runtime.inspect.mockResolvedValueOnce({ status: "unknown", error: "temporarily unreachable" })
      .mockResolvedValueOnce({ status: "completed", summary: "recovered" });
    expect(await f.service.inspect(f.run)).toEqual({ status: "running" });
    expect((await f.worker())!.activeInvocationId).toBeDefined();
    expect(await f.service.inspect(f.run)).toMatchObject({ status: "completed", result: { text: "recovered" } });
    expect(f.runtime.start).toHaveBeenCalledTimes(1);
  });
  it("rejects extension after an atomic cleanup claim rather than deleting an extended workspace", async () => {
    const f = setup(); f.runtime.start.mockResolvedValue({ status: "completed", summary: "done" });
    await f.service.start(f.run, f.spec); await f.service.acceptResult(f.run.id);
    const worker = (await f.worker())!;
    let finishCleanup!: () => void;
    let cleanupStarted!: () => void;
    const started = new Promise<void>(resolve => { cleanupStarted = resolve; });
    f.runtime.cleanup.mockImplementation(async () => { cleanupStarted(); await new Promise<void>(resolve => { finishCleanup = resolve; }); });
    f.setTime(BASE + WORKER_LIFETIME_MS);
    const maintenance = f.service.maintenance(); await started;
    await expect(f.service.extend(worker.id, "chat", BASE + WORKER_LIFETIME_MS + 60_000)).rejects.toThrow("cannot be resumed");
    await expect(f.service.enqueue(worker.id, "chat", "new", "new")).rejects.toThrow("expired");
    finishCleanup(); await maintenance;
    expect((await f.worker())!.phase).toBe("cleaned");
  });

  it("reports source failure while continuing to collect the remaining sources", async () => {
    const f = setup();
    let finished = false;
    f.source.inspectAutomation.mockImplementation(async (_node, request) => ({ ...request,
      status: (request.automationId === "bad" ? "failed" : finished ? "completed" : "running") as never,
      sessionId: "session", turnId: "turn", text: "source result", observedAt: BASE, sources: ["receipt"] }));
    await f.service.start(f.run, { ...f.spec, sources: [{ nodeId: "a", automationId: "bad", offsetMs: 0, windowMs: 60_000 },
      { nodeId: "b", automationId: "good", offsetMs: 0, windowMs: 60_000 }] });
    expect(f.deliverSupplement).toHaveBeenCalledTimes(1);
    expect(f.runtime.start).not.toHaveBeenCalled();
    finished = true; f.setTime(BASE + 120_000); await f.service.inspect(f.run);
    expect(f.runtime.start).toHaveBeenCalledTimes(1);
    expect((await f.worker())!.observations.find(item => item.automationId === "good")!.status).toBe("completed");
  });
  it("closes a pre-launch crash with a missing runtime receipt at expiry without fabricating artifacts", async () => {
    const f = setup(); f.runtime.start.mockRejectedValue(new Error("controller stopped before runtime submit"));
    f.runtime.inspect.mockResolvedValue({ status: "unknown", receiptMissing: true });
    await f.service.start(f.run, f.spec);
    f.setTime(BASE + WORKER_LIFETIME_MS + WORKER_SHUTDOWN_GRACE_MS);
    await f.service.maintenance();
    expect((await f.worker())!.initialOutcome).toMatchObject({ status: "failed", result: { error: "worker_expired" } });
    expect(f.runtime.exportArtifacts).not.toHaveBeenCalled();
    await f.service.acceptResult(f.run.id); await f.service.maintenance();
    expect((await f.worker())!.phase).toBe("cleaned");
  });

  it("hands off new attachments from an otherwise waiting turn without losing its continuation", async () => {
    const f = setup();
    f.runtime.start.mockResolvedValueOnce({ status: "waiting", summary: "中间报告", nextCheckAt: new Date(BASE + 120_000).toISOString() })
      .mockResolvedValueOnce({ status: "completed", summary: "最终结论" });
    f.runtime.exportArtifacts.mockResolvedValueOnce([{ name: "partial.txt", path: "/export/partial", size: 1, sha256: "h" }] as never);
    const service = new BackgroundService({ ...f.options, artifactLinks: async () => ["https://bot.example/partial"] });
    await service.start(f.run, f.spec); await service.maintenance();
    expect(f.deliverSupplement).toHaveBeenCalledTimes(1);
    expect((await f.worker())!.invocations[0].acceptedAt).toBe(BASE);
    expect((await f.worker())!.initialOutcome).toBeUndefined();
    f.setTime(BASE + 120_000);
    expect(await service.inspect(f.run)).toMatchObject({ status: "completed", result: { text: "最终结论" } });
    expect(f.runtime.start).toHaveBeenCalledTimes(2);
  });

  it("cancels an active worker after authorization revocation and retains its result without delivery", async () => {
    const f = setup(); let allowed = true;
    const service = new BackgroundService({ ...f.options, isAllowed: () => allowed });
    await service.start(f.run, f.spec);
    allowed = false; await service.maintenance(); await service.maintenance();
    expect(f.runtime.cancel).toHaveBeenCalledTimes(1);
    expect(f.runtime.inspect).not.toHaveBeenCalled();
    expect(f.deliverSupplement).not.toHaveBeenCalled();
    expect((await f.worker())!.activeInvocationId).toBeDefined();
    allowed = true; f.runtime.inspect.mockResolvedValue({ status: "failed", summary: "已停止", error: "cancelled" });
    expect(await service.inspect(f.run)).toMatchObject({ status: "failed", result: { text: "已停止" } });
  });
  it("does not inspect sources or start new model turns while authorization is revoked", async () => {
    const f = setup(); let allowed = true;
    const service = new BackgroundService({ ...f.options, isAllowed: () => allowed });
    await service.start(f.run, watched(f)); allowed = false;
    f.setTime(BASE + 120_000); await service.maintenance();
    expect(f.source.inspectAutomation).toHaveBeenCalledTimes(1);
    expect(f.runtime.start).not.toHaveBeenCalled();
    allowed = true; await service.maintenance();
    expect(f.source.inspectAutomation).toHaveBeenCalledTimes(2);
  });
  it("rechecks authorization before launching a model after asynchronous source inspection", async () => {
    const f = setup(); let allowed = true;
    f.source.inspectAutomation.mockImplementation(async (_node, request) => {
      allowed = false;
      return { ...request, status: "completed" as never, sessionId: "session", turnId: "turn", text: "result", observedAt: BASE, sources: ["receipt"] };
    });
    const service = new BackgroundService({ ...f.options, isAllowed: () => allowed });
    await service.start(f.run, watched(f)); expect(f.runtime.start).not.toHaveBeenCalled();
    allowed = true; await service.maintenance(); expect(f.runtime.start).toHaveBeenCalledTimes(1);
  });
  it("uses the configured per-turn budget within the remaining lifecycle bound", async () => {
    const f = setup();
    const service = new BackgroundService({ ...f.options, turnTimeoutMs: 600_000 });
    await service.start(f.run, f.spec);
    expect((f.runtime.start.mock.calls[0] as unknown[])[0]).toMatchObject({ timeoutMs: 600_000 });
    expect(() => new BackgroundService({ ...f.options, turnTimeoutMs: WORKER_LIFETIME_MS })).toThrow("one hour");
  });

  it("registers a run without source or model I/O so the shared schedule tick stays responsive", async () => {
    const f = setup();
    const worker = await f.service.register(f.run, watched(f));
    expect(worker.runId).toBe(f.run.id);
    expect(f.source.inspectAutomation).not.toHaveBeenCalled(); expect(f.runtime.start).not.toHaveBeenCalled();
    await f.service.maintenance(); expect(f.source.inspectAutomation).toHaveBeenCalledTimes(1);
  });
  it("renews its durable lease during slow source I/O and fences a second controller", async () => {
    vi.useFakeTimers();
    const f = setup(); let resolveObservation!: (value: any) => void;
    f.source.inspectAutomation.mockImplementation((_node, request) => new Promise(resolve => { resolveObservation = resolve; }));
    const start = f.service.start(f.run, watched(f));
    try {
      await vi.waitFor(() => expect(f.source.inspectAutomation).toHaveBeenCalledTimes(1));
      for (const elapsed of [20_000, 40_000, 60_000]) {
        f.setTime(BASE + elapsed); await vi.advanceTimersByTimeAsync(20_000);
        expect((await f.worker())!.leaseUntil).toBe(BASE + elapsed + 60_000);
      }
      await new BackgroundService(f.options).maintenance();
      expect(f.source.inspectAutomation).toHaveBeenCalledTimes(1);
      const request = f.source.inspectAutomation.mock.calls[0][1];
      resolveObservation({ ...request, status: "waiting", sources: [], observedAt: BASE + 60_000 });
      await start; expect((await f.worker())!.leaseUntil).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("refuses model dispatch after losing ownership while source I/O is pending", async () => {
    vi.useFakeTimers();
    const f = setup(); let resolveObservation!: (value: any) => void;
    f.source.inspectAutomation.mockImplementation((_node, request) => new Promise(resolve => { resolveObservation = resolve; }));
    const start = f.service.start(f.run, watched(f));
    try {
      await vi.waitFor(() => expect(f.source.inspectAutomation).toHaveBeenCalledTimes(1));
      await f.repository.update((await f.worker())!.id, worker => { worker.leaseOwner = "replacement"; worker.leaseUntil = BASE + 180_000; });
      f.setTime(BASE + 20_000); await vi.advanceTimersByTimeAsync(20_000);
      const request = f.source.inspectAutomation.mock.calls[0][1];
      resolveObservation({ ...request, status: "completed", sessionId: "s", turnId: "t", text: "ready", sources: [], observedAt: BASE + 20_000 });
      await expect(start).rejects.toThrow("lease lost"); expect(f.runtime.start).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("hands off an unverified process shutdown without exporting, restarting or cleaning its workspace", async () => {
    const f = setup(); f.runtime.start.mockResolvedValue({ status: "needs_attention", summary: "需要核对残留进程", error: "worker_process_cleanup_unverified" });
    expect(await f.service.start(f.run, f.spec)).toMatchObject({ status: "failed", result: { text: "需要核对残留进程" } });
    expect(f.runtime.exportArtifacts).not.toHaveBeenCalled();
    expect((await f.worker())!.phase).toBe("quarantined");
    await f.service.acceptResult(f.run.id);
    f.setTime(BASE + 2 * WORKER_LIFETIME_MS); await f.service.maintenance();
    expect(f.runtime.cleanup).not.toHaveBeenCalled(); expect(f.runtime.start).toHaveBeenCalledTimes(1);
    await expect(f.service.enqueue((await f.worker())!.id, "chat", "retry", "retry")).rejects.toThrow("expired");
  });
  it("cancels the current worker for a cancelled schedule but continues paused and completed ones", async () => {
    const f = setup(); let status: "active" | "paused" | "cancelled" | "completed" = "paused";
    const service = new BackgroundService({ ...f.options, getScheduleStatus: async () => status });
    await service.start(f.run, f.spec); expect(f.runtime.start).toHaveBeenCalledTimes(1);
    status = "completed"; await service.maintenance(); expect(f.runtime.cancel).not.toHaveBeenCalled();
    status = "cancelled"; f.runtime.inspect.mockResolvedValue({ status: "failed", summary: "cancelled", error: "worker_cancelled" });
    await service.maintenance();
    expect(f.runtime.cancel).toHaveBeenCalledTimes(1); expect((await f.worker())!.phase).toBe("cancelled");
    await expect(service.enqueue((await f.worker())!.id, "chat", "again", "again")).rejects.toThrow("expired");
    await service.maintenance(); expect(f.runtime.start).toHaveBeenCalledTimes(1);
  });
  it("explicit cancellation stops queued followups and permits cleanup after the retained cancellation result is accepted", async () => {
    const f = setup(); f.runtime.start.mockResolvedValue({ status: "completed", summary: "initial" });
    await f.service.start(f.run, f.spec); await f.service.acceptResult(f.run.id);
    const worker = (await f.worker())!;
    await f.service.enqueue(worker.id, "chat", "pending followup", "pending");
    await f.service.cancel(worker.id, "chat"); await f.service.maintenance();
    expect((await f.worker())!.prompts[0].cancelledAt).toBe(BASE);
    expect(f.runtime.start).toHaveBeenCalledTimes(1); expect(f.deliverSupplement).not.toHaveBeenCalled();
    f.setTime(BASE + WORKER_LIFETIME_MS); await f.service.maintenance();
    expect((await f.worker())!.phase).toBe("cleaned");
  });

});
