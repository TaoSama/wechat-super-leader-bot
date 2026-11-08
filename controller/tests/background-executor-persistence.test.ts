import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BackgroundService, BackgroundSpecSchema, MemoryBackgroundRepository,
  type BackgroundRun, type WorkerInvocation, type WorkerReceipt } from "../src/background/index.js";
import { backgroundSpecFingerprint } from "../src/background/retention.js";

const NOW = Date.parse("2026-11-08T03:00:00Z");
function fixture() {
  const repository = new MemoryBackgroundRepository();
  const runtime = {
    start: vi.fn(async (_input: WorkerInvocation): Promise<WorkerReceipt> => ({ status: "completed", summary: "done" })),
    inspect: vi.fn(async (): Promise<WorkerReceipt> => ({ status: "running" })),
    exportArtifacts: vi.fn(async () => []), cancel: vi.fn(async () => undefined), cleanup: vi.fn(async () => undefined),
  };
  const options = { repository, runtime, sources: { inspectAutomation: vi.fn() },
    deliverSupplement: vi.fn(async () => undefined), now: () => NOW, onError: vi.fn() };
  const run: BackgroundRun = { id: randomUUID(), scheduleId: "daily", chatId: "chat", scheduledAt: NOW };
  const spec = BackgroundSpecSchema.parse({ prompt: "汇总结果" });
  return { repository, runtime, options, run, spec, service: new BackgroundService(options),
    worker: () => repository.getByRun(run.id) };
}

describe("task-scoped background executor persistence", () => {
  it("does not materialize the default into legacy specs or change their creation fingerprints", () => {
    const f = fixture();
    expect(f.spec).not.toHaveProperty("executor");
    expect(backgroundSpecFingerprint(f.spec)).toBe(createHash("sha256").update(JSON.stringify({
      prompt: "汇总结果", sources: [], preferences: [], deadlineMs: 3_600_000,
      checkIntervalsMs: [120_000, 300_000, 600_000],
    })).digest("hex"));
    expect(BackgroundSpecSchema.parse({ prompt: "汇总", executor: "claude" }).executor).toBe("claude");
    expect(() => BackgroundSpecSchema.parse({ prompt: "汇总", executor: "other" })).toThrow();
  });

  it("routes ordinary and explicitly selected tasks independently through the same runtime", async () => {
    const f = fixture();
    await f.service.start(f.run, f.spec);
    const claudeRun = { ...f.run, id: randomUUID() };
    await f.service.start(claudeRun, { ...f.spec, executor: "claude" });
    expect(f.runtime.start.mock.calls.map(([input]) => input.executorKind)).toEqual(["codex", "claude"]);
    expect((await f.worker())?.executorKind).toBe("codex");
    expect((await f.repository.getByRun(claudeRun.id))?.executorKind).toBe("claude");
  });

  it("preserves a frozen Claude selection across restart, followup and the next scheduled occurrence", async () => {
    const f = fixture();
    const spec = { ...f.spec, executor: "claude" as const };
    await f.service.start(f.run, spec);
    await f.service.acceptResult(f.run.id);
    const worker = (await f.worker())!;
    const restarted = new BackgroundService(f.options);
    await restarted.enqueue(worker.id, f.run.chatId, "继续核对第二项", "followup");
    await restarted.maintenance();
    await restarted.start({ ...f.run, id: randomUUID(), scheduledAt: NOW + 86_400_000 }, spec);
    expect(f.runtime.start.mock.calls.map(([input]) => input.executorKind)).toEqual(["claude", "claude", "claude"]);
    const saved = (await f.worker())!;
    expect(saved.spec.executor).toBe("claude");
    expect(saved.invocations.map(invocation => invocation.executorKind)).toEqual(["claude", "claude"]);
    expect(saved.invocations[1].task).toBe("继续核对第二项");
    expect(f.runtime.start.mock.calls[1][0].workerId).toBe(worker.id);
    expect(f.runtime.start.mock.calls[2][0].workerId).not.toBe(worker.id);
    await expect(restarted.register(f.run, { ...spec, executor: "codex" })).rejects.toThrow("conflicts");
  });

  it("does not let later caller mutation change the executor of a registered task", async () => {
    const f = fixture();
    const spec = { ...f.spec, executor: "claude" as "codex" | "claude" };
    await f.service.register(f.run, spec);
    spec.executor = "codex";
    await f.service.inspect(f.run);
    expect(f.runtime.start.mock.calls[0][0].executorKind).toBe("claude");
  });

  it("updates a legacy active executor from runtime evidence while preserving queued and failed history", async () => {
    const f = fixture();
    f.runtime.start.mockResolvedValue({ status: "queued", executorKind: "codex" });
    await f.service.start(f.run, f.spec);
    const worker = (await f.worker())!;
    const historical = { id: randomUUID(), kind: "followup" as const, task: "旧检查", input: {}, createdAt: NOW - 1,
      status: "failed" as const, executorKind: "claude" as const, exported: true, acceptedAt: NOW - 1,
      receipt: { status: "failed" as const, executorKind: "claude" as const, error: "worker_authentication_failed" } };
    await f.repository.update(worker.id, current => {
      current.executorKind = "claude";
      delete current.invocations[0].executorKind;
      current.invocations.unshift(historical);
    });
    const restarted = new BackgroundService(f.options);
    f.runtime.inspect.mockResolvedValue({ status: "queued", executorKind: "codex" });
    await restarted.inspect(f.run);
    expect((await f.worker())?.executorKind).toBe("claude");
    expect((await f.worker())?.invocations[1].executorKind).toBeUndefined();

    f.runtime.inspect.mockResolvedValue({ status: "running", executorKind: "codex" });
    await restarted.inspect(f.run);
    expect((await f.worker())?.executorKind).toBe("codex");
    expect((await f.worker())?.invocations[1].executorKind).toBe("codex");
    f.runtime.inspect.mockResolvedValue({ status: "completed", executorKind: "codex", summary: "完成" });
    await restarted.inspect(f.run);
    expect((await f.worker())?.invocations[0]).toEqual(historical);
    expect(f.runtime.start).toHaveBeenCalledTimes(1);
  });

  it.each(["worker_executor_unavailable", "worker_cancelled_before_launch", "worker_cancelled", "worker_expired"])(
    "does not relabel legacy execution history for an unstarted invocation (%s)", async error => {
      const f = fixture();
      f.runtime.start.mockResolvedValue({ status: "queued", executorKind: "codex" });
      await f.service.start(f.run, f.spec);
      const worker = (await f.worker())!;
      await f.repository.update(worker.id, current => {
        current.executorKind = "claude";
        delete current.invocations[0].executorKind;
      });
      f.runtime.inspect.mockResolvedValue({ status: "failed", executorKind: "codex", error });
      await new BackgroundService(f.options).inspect(f.run);
      expect((await f.worker())?.executorKind).toBe("claude");
      expect((await f.worker())?.invocations[0].executorKind).toBeUndefined();
    });

  it("preserves legacy failed history and does not replay it when the default changes", async () => {
    const f = fixture();
    f.runtime.start.mockResolvedValue({ status: "failed", summary: "旧任务认证失败", error: "worker_authentication_failed" });
    await f.service.start(f.run, f.spec);
    await f.service.acceptResult(f.run.id);
    const worker = (await f.worker())!;
    await f.repository.update(worker.id, current => {
      current.executorKind = "claude";
      delete current.invocations[0].executorKind;
    });
    const before = await f.worker();
    const restarted = new BackgroundService(f.options);
    await restarted.register(f.run, f.spec);
    await restarted.inspect(f.run);
    await restarted.maintenance();
    expect(await f.worker()).toEqual(before);
    expect(f.runtime.start).toHaveBeenCalledTimes(1);
    expect(f.runtime.inspect).not.toHaveBeenCalled();

    f.runtime.start.mockResolvedValue({ status: "completed", summary: "新追问完成" });
    await restarted.enqueue(worker.id, f.run.chatId, "现在继续核对", "new-followup");
    await restarted.maintenance();
    const after = (await f.worker())!;
    expect(f.runtime.start.mock.calls[1][0].executorKind).toBe("codex");
    expect(after.invocations[0]).toEqual(before!.invocations[0]);
    expect(after.initialOutcome).toEqual(before!.initialOutcome);
    expect(after.invocations[1].executorKind).toBe("codex");
  });

  it("inspects the same ambiguous Claude submission after restart without choosing another executor", async () => {
    const f = fixture();
    f.runtime.start.mockRejectedValue(new Error("connection lost"));
    await f.service.start(f.run, { ...f.spec, executor: "claude" });
    const before = (await f.worker())!;
    await new BackgroundService(f.options).inspect(f.run);
    expect(f.runtime.start).toHaveBeenCalledTimes(1);
    expect(f.runtime.inspect).toHaveBeenCalledWith(before.id, before.activeInvocationId, expect.any(Object));
    expect((await f.worker())?.invocations[0].executorKind).toBe("claude");
  });
});
