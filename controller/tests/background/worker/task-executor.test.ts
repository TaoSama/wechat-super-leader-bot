import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexWorkerRuntime, type WorkerExecutor, type WorkerExecutorKind, type WorkerInput,
  type WorkerRuntimeOptions } from "../../../src/background/worker/index.js";
import { hash, WorkerStorage } from "../../../src/background/worker/storage.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const result = JSON.stringify({ status: "completed", summary: "done", nextCheckAt: null, attachments: [] });
function executor(kind: WorkerExecutorKind): WorkerExecutor {
  return { kind, execute: vi.fn(async request => { await request.onThread(randomUUID()); return result; }) };
}
function fixture(overrides: Partial<WorkerRuntimeOptions> = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "worker-task-executor-")); roots.push(directory);
  const codex = executor("codex"), claude = executor("claude");
  const options: WorkerRuntimeOptions = { root: path.join(directory, "workers"), artifactRoot: path.join(directory, "artifacts"),
    model: "synthetic-codex", executor: codex, executors: { claude }, onError: () => {}, ...overrides };
  const input: WorkerInput = { workerId: randomUUID(), invocationId: randomUUID(), task: "Read a result", input: {} };
  return { options, input, codex, claude, runtime: new CodexWorkerRuntime(options) };
}
async function terminal(runtime: CodexWorkerRuntime, input: WorkerInput) {
  let receipt = await runtime.inspect(input.workerId, input.invocationId);
  await vi.waitFor(async () => {
    receipt = await runtime.inspect(input.workerId, input.invocationId);
    expect(["queued", "running"]).not.toContain(receipt.status);
  });
  return receipt;
}

describe("task-scoped worker executor", () => {
  it("keeps Codex as the default and only selects Claude for an explicit task", async () => {
    const f = fixture();
    const claudeInput = { ...f.input, workerId: randomUUID(), invocationId: randomUUID(), executorKind: "claude" as const };
    await f.runtime.start(f.input); await f.runtime.start(claudeInput);
    expect(await terminal(f.runtime, f.input)).toMatchObject({ status: "completed", executorKind: "codex" });
    expect(await terminal(f.runtime, claudeInput)).toMatchObject({ status: "completed", executorKind: "claude" });
    expect(f.codex.execute).toHaveBeenCalledOnce(); expect(f.claude.execute).toHaveBeenCalledOnce();
    await expect(f.runtime.start({ ...f.input, executorKind: "claude" })).rejects.toThrow("conflicts");
  });

  it("shares one concurrency limit between Codex and Claude", async () => {
    let release!: () => void;
    const codex: WorkerExecutor = { kind: "codex", execute: vi.fn(async request => {
      await request.onThread(randomUUID()); await new Promise<void>(resolve => { release = resolve; }); return result;
    }) };
    const f = fixture({ maxConcurrent: 1, executor: codex });
    const claudeInput = { ...f.input, workerId: randomUUID(), invocationId: randomUUID(), executorKind: "claude" as const };
    await f.runtime.start(f.input); await f.runtime.start(claudeInput);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(await f.runtime.inspect(claudeInput.workerId, claudeInput.invocationId)).toMatchObject({ status: "queued", executorKind: "claude" });
    expect(f.claude.execute).not.toHaveBeenCalled();
    release();
    await terminal(f.runtime, f.input); await terminal(f.runtime, claudeInput);
    expect(codex.execute).toHaveBeenCalledOnce(); expect(f.claude.execute).toHaveBeenCalledOnce();
  });

  it.each(["codex", "claude"] as const)("restores a durable %s queue without consulting the runtime default", async kind => {
    const codex = executor("codex"), claude = executor("claude");
    const f = fixture({ executor: claude, executors: { codex, claude } });
    const input = { ...f.input, executorKind: kind };
    const storage = new WorkerStorage(f.options.root, f.options.artifactRoot);
    const dir = storage.worker(input.workerId, true)!;
    storage.claim(dir, input.invocationId);
    storage.save(dir, { workerId: input.workerId, invocationId: input.invocationId, executorKind: kind,
      inputHash: hash(JSON.stringify(input)), ownerPid: 2147483647, status: "queued", summary: "queued", attachments: [],
      pendingInput: input, launchDeadlineAt: Date.now() + 60_000 });
    expect(await terminal(new CodexWorkerRuntime(f.options), input)).toMatchObject({ status: "completed", executorKind: kind });
    expect(codex.execute).toHaveBeenCalledTimes(kind === "codex" ? 1 : 0);
    expect(claude.execute).toHaveBeenCalledTimes(kind === "claude" ? 1 : 0);
  });

  it("treats a legacy queued input with no executor as Codex", async () => {
    const codex = executor("codex"), claude = executor("claude");
    const f = fixture({ executor: claude, executors: { codex, claude } });
    const storage = new WorkerStorage(f.options.root, f.options.artifactRoot), dir = storage.worker(f.input.workerId, true)!;
    storage.claim(dir, f.input.invocationId);
    storage.save(dir, { workerId: f.input.workerId, invocationId: f.input.invocationId,
      inputHash: hash(JSON.stringify(f.input)), ownerPid: 2147483647, status: "queued", summary: "queued", attachments: [],
      pendingInput: f.input, launchDeadlineAt: Date.now() + 60_000 });
    expect(await terminal(f.runtime, f.input)).toMatchObject({ status: "completed", executorKind: "codex" });
    expect(codex.execute).toHaveBeenCalledOnce(); expect(claude.execute).not.toHaveBeenCalled();
  });

  it("rejects an executor changed independently of its durable input", async () => {
    const f = fixture(), storage = new WorkerStorage(f.options.root, f.options.artifactRoot);
    const input = { ...f.input, executorKind: "codex" as const }, dir = storage.worker(input.workerId, true)!;
    storage.save(dir, { workerId: input.workerId, invocationId: input.invocationId, executorKind: "claude",
      inputHash: hash(JSON.stringify(input)), ownerPid: process.pid, status: "queued", summary: "queued", attachments: [],
      pendingInput: input, launchDeadlineAt: Date.now() + 60_000 });
    await expect(f.runtime.inspect(input.workerId, input.invocationId)).rejects.toThrow("queued worker input");
    expect(f.codex.execute).not.toHaveBeenCalled(); expect(f.claude.execute).not.toHaveBeenCalled();
  });

  it("fails an unavailable Claude task without falling back or replaying", async () => {
    const f = fixture({ executors: {} });
    const input = { ...f.input, executorKind: "claude" as const };
    await f.runtime.start(input);
    const status = await terminal(f.runtime, input);
    expect(status).toMatchObject({ status: "failed", error: "worker_executor_unavailable", executorKind: "claude" });
    expect(status.summary).toContain("没有自动改用其他执行器");
    expect(await f.runtime.start(input)).toEqual(status);
    expect(f.codex.execute).not.toHaveBeenCalled();
  });

  it("resolves settings after the selected executor's local preflight", async () => {
    const events: string[] = [];
    const f = fixture({ beforeExecute: async kind => { events.push(`verify:${kind}`); }, runtimeSettings: kind => {
      events.push(`settings:${kind}`);
      return { model: `${kind}-configured-model`, reasoningEffort: "high", systemPrompt: "scoped prompt" };
    } });
    await f.runtime.start({ ...f.input, executorKind: "claude" });
    await terminal(f.runtime, f.input);
    expect(events).toEqual(["verify:claude", "settings:claude"]);
    expect(f.claude.execute).toHaveBeenCalledWith(expect.objectContaining({ model: "claude-configured-model", reasoningEffort: "high" }));
    expect(f.codex.execute).not.toHaveBeenCalled();
  });

  it("never launches after cancellation during local preflight", async () => {
    let release!: () => void;
    const f = fixture({ beforeExecute: async () => new Promise<void>(resolve => { release = resolve; }) });
    await f.runtime.start({ ...f.input, executorKind: "claude" });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const cancelled = f.runtime.cancel(f.input.workerId, f.input.invocationId);
    release(); await cancelled;
    expect(await terminal(f.runtime, f.input)).toMatchObject({ status: "needs_attention", error: "worker_interrupted" });
    expect(f.claude.execute).not.toHaveBeenCalled(); expect(f.codex.execute).not.toHaveBeenCalled();
  });

  it("does not use execution grace to launch a task whose preflight crossed its launch deadline", async () => {
    const now = Date.now(), clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const beforeExecute = vi.fn(async () => { clock.mockReturnValue(now + 200); });
    const f = fixture({ beforeExecute });
    const input = { ...f.input, executorKind: "claude" as const, launchDeadlineAt: now + 100, executionDeadlineAt: now + 1_000 };
    try {
      await f.runtime.start(input);
      expect(await terminal(f.runtime, input)).toMatchObject({ status: "failed", error: "worker_expired" });
      expect(beforeExecute).toHaveBeenCalledOnce();
      expect(f.claude.execute).not.toHaveBeenCalled(); expect(f.codex.execute).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });
});
