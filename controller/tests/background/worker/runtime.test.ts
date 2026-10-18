import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { CodexWorkerRuntime, type WorkerExecutor, type WorkerInput, type WorkerRuntimeStatus } from "../../../src/background/worker/index.js";
import { hash } from "../../../src/background/worker/storage.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const threadId = "11111111-1111-4111-8111-111111111111";
function fixture(executor: WorkerExecutor, timeoutMs = 5000) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-runtime-test-")); roots.push(root);
  const options = { root: path.join(root, "runtime"), artifactRoot: path.join(root, "artifacts"), model: "test", executor, timeoutMs };
  const input: WorkerInput = { workerId: randomUUID(), invocationId: randomUUID(), task: "Read results and explain", input: { observation: "waiting" } };
  return { root, options, input, runtime: new CodexWorkerRuntime(options),
    dir: path.join(options.root, "workers", input.workerId) };
}
async function terminal(runtime: CodexWorkerRuntime, input: WorkerInput): Promise<WorkerRuntimeStatus> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = await runtime.inspect(input.workerId, input.invocationId);
    if (!["running", "queued"].includes(status.status)) return status;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Worker did not reach a terminal state");
}
const result = (extra: Record<string, unknown> = {}) => JSON.stringify({ status: "completed", summary: "已核对结果", nextCheckAt: null, attachments: [], ...extra });
function completing(): WorkerExecutor {
  return { execute: vi.fn(async request => { await request.onThread(threadId); return result(); }) };
}

describe("isolated resumable worker runtime", () => {
  it.each(["invalid-name", "missing-state", "missing-invocations", "malformed-state", "worker-symlink", "dangling-symlink",
    "receipt-json", "receipt-identity", "receipt-input", "receipt-shape", "receipt-symlink", "receipt-hash"])(
    "keeps healthy workers dispatching while retaining damaged metadata (%s) for inspection", async kind => {
      const f = fixture(completing());
      const diagnostics: Error[] = [];
      const runtime = new CodexWorkerRuntime({ ...f.options, onError: error => diagnostics.push(error) });
      const badId = kind === "invalid-name" ? "untrusted-private-text\nworker" : f.input.workerId;
      const badDir = path.join(f.options.root, "workers", badId);
      const store = (runtime as any).store;
      const external = path.join(f.root, "untouched-external");
      fs.mkdirSync(external);
      if (kind === "invalid-name" || kind === "missing-state") fs.mkdirSync(badDir);
      else if (kind === "worker-symlink" || kind === "dangling-symlink") {
        fs.symlinkSync(kind === "worker-symlink" ? external : path.join(external, "absent"), badDir);
      }
      else {
        store.worker(badId, true);
        if (kind === "missing-invocations") fs.rmdirSync(path.join(badDir, "invocations"));
        else if (kind === "malformed-state") fs.writeFileSync(path.join(badDir, "state.json"), "{private-state");
        else {
          const receiptFile = path.join(badDir, "invocations", `${f.input.invocationId}.json`);
          const receipt = { ...f.input, workerId: badId, inputHash: hash(JSON.stringify(f.input)), ownerPid: process.pid,
            status: "queued", summary: "private-receipt", attachments: [], pendingInput: f.input };
          if (kind === "receipt-json") fs.writeFileSync(receiptFile, "{private-receipt");
          else if (kind === "receipt-symlink") {
            fs.writeFileSync(path.join(external, "receipt.json"), JSON.stringify(receipt));
            fs.symlinkSync(path.join(external, "receipt.json"), receiptFile);
          } else {
            if (kind === "receipt-identity") receipt.workerId = randomUUID();
            if (kind === "receipt-input") receipt.pendingInput = { ...f.input, invocationId: randomUUID() };
            if (kind === "receipt-hash") receipt.pendingInput = { ...f.input, task: "tampered task" };
            fs.writeFileSync(receiptFile, JSON.stringify(kind === "receipt-shape" ? { status: "queued" } : receipt));
          }
        }
      }
      const healthy = { ...f.input, workerId: randomUUID(), invocationId: randomUUID() };
      await runtime.start(healthy);
      expect((await terminal(runtime, healthy)).status).toBe("completed");
      expect(f.options.executor.execute).toHaveBeenCalledTimes(1);
      expect(diagnostics.length).toBeGreaterThan(0);
      expect(diagnostics.every(error => error.message.includes("retained for inspection"))).toBe(true);
      expect(JSON.stringify(diagnostics.map(error => error.message))).not.toMatch(/private|untrusted/);
      await expect(runtime.inspect(badId, f.input.invocationId)).rejects.toThrow();
      expect(fs.lstatSync(badDir)).toBeDefined();
      if (kind === "missing-invocations") expect(fs.existsSync(path.join(badDir, "invocations"))).toBe(false);
      if (kind === "worker-symlink") expect(fs.readdirSync(external)).toEqual([]);
    });
  it("returns immediately, persists receipts, deduplicates starts and resumes the same workspace and thread", async () => {
    const executor = completing();
    const f = fixture(executor);
    const first = await f.runtime.start(f.input);
    expect(first.status).toBe("queued");
    expect((await terminal(f.runtime, f.input)).status).toBe("completed");
    expect(await f.runtime.start(f.input)).toMatchObject({ status: "completed", threadId });
    expect(executor.execute).toHaveBeenCalledTimes(1);
    const next = { ...f.input, invocationId: randomUUID(), input: { observation: "new result" } };
    const restarted = new CodexWorkerRuntime(f.options);
    await restarted.start(next); await terminal(restarted, next);
    const calls = vi.mocked(executor.execute).mock.calls;
    expect(calls[0][0].threadId).toBeUndefined();
    expect(calls[1][0].threadId).toBe(threadId);
    expect(calls[0][0].workspace).toBe(calls[1][0].workspace);
    expect(calls[1][0].prompt).toContain("new result");
    expect(calls[1][0].prompt).not.toContain("task.md");
    await expect(restarted.start({ ...next, task: "different authorization" })).rejects.toThrow("conflicts");
  });
  it("prevents overlapping invocations even across runtime instances, and cancellation does not replay effects", async () => {
    const executor: WorkerExecutor = { execute: vi.fn(request => new Promise((_, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("interrupted")), { once: true });
    })) };
    const f = fixture(executor);
    await f.runtime.start(f.input);
    await expect(new CodexWorkerRuntime(f.options).start({ ...f.input, invocationId: randomUUID() })).rejects.toThrow();
    await expect(f.runtime.cleanup(f.input.workerId)).rejects.toThrow("active");
    await f.runtime.cancel(f.input.workerId, f.input.invocationId);
    expect(await f.runtime.start(f.input)).toMatchObject({ status: "needs_attention", error: "worker_interrupted" });
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });
  it("permanently cancels an invocation before its first start without cancelling other rounds", async () => {
    const f = fixture(completing());
    const other = new CodexWorkerRuntime(f.options);
    await other.cancel(f.input.workerId, f.input.invocationId);
    expect(await f.runtime.start(f.input)).toMatchObject({ status: "failed", error: "worker_cancelled_before_launch" });
    expect(await other.start({ ...f.input, task: "changed input cannot revive cancellation" })).toMatchObject({ status: "failed" });
    await other.cancel(f.input.workerId, f.input.invocationId);
    const next = { ...f.input, invocationId: randomUUID() };
    await f.runtime.start(next);
    expect((await terminal(other, next)).status).toBe("completed");
    expect(f.options.executor.execute).toHaveBeenCalledTimes(1);
    await other.exportArtifacts(f.input.workerId, f.input.invocationId);
    await other.exportArtifacts(next.workerId, next.invocationId);
    await other.cleanup(f.input.workerId);
  });
  it("fences a real separate-process cancellation while start has ownership but no receipt yet", async () => {
    const f = fixture(completing());
    const store = (f.runtime as any).store;
    const originalSave = store.save.bind(store);
    let interrupted = false;
    store.save = (dir: string, receipt: { status: string }) => {
      if (!interrupted && receipt.status === "queued") {
        interrupted = true;
        const script = `
          import { CodexWorkerRuntime } from ${JSON.stringify(new URL("../../../src/background/worker/runtime.ts", import.meta.url).href)};
          const runtime = new CodexWorkerRuntime(${JSON.stringify({ ...f.options, executor: undefined })});
          await runtime.cancel(${JSON.stringify(f.input.workerId)}, ${JSON.stringify(f.input.invocationId)});
          console.log(JSON.stringify(await runtime.inspect(${JSON.stringify(f.input.workerId)}, ${JSON.stringify(f.input.invocationId)})));
        `;
        const cancelled = JSON.parse(execFileSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", script], { encoding: "utf8", timeout: 5000 }));
        expect(cancelled).toMatchObject({ status: "failed", error: "worker_cancelled_before_launch" });
      }
      return originalSave(dir, receipt);
    };
    expect(await f.runtime.start(f.input)).toMatchObject({ status: "failed", error: "worker_cancelled_before_launch" });
    expect(interrupted).toBe(true);
    expect(await terminal(f.runtime, f.input)).toMatchObject({ status: "failed", error: "worker_cancelled_before_launch" });
    expect(f.options.executor.execute).not.toHaveBeenCalled();
    expect(await new CodexWorkerRuntime(f.options).start(f.input)).toMatchObject({ status: "failed" });
    const next = { ...f.input, invocationId: randomUUID() };
    await f.runtime.start(next);
    expect((await terminal(f.runtime, next)).status).toBe("completed");
    expect(f.options.executor.execute).toHaveBeenCalledTimes(1);
  });
  it("reconciles a lost owner as uncertain and refuses automatic replay", async () => {
    const f = fixture(completing());
    await f.runtime.start(f.input); await terminal(f.runtime, f.input);
    const file = path.join(f.dir, "invocations", `${f.input.invocationId}.json`);
    const receipt = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...receipt, status: "running", ownerPid: 2147483647 }));
    const restarted = new CodexWorkerRuntime(f.options);
    expect(await restarted.inspect(f.input.workerId, f.input.invocationId)).toMatchObject({ status: "needs_attention", error: "worker_owner_lost" });
    expect((await restarted.start(f.input)).status).toBe("needs_attention");
    expect(f.options.executor.execute).toHaveBeenCalledTimes(1);
  });
  it("accepts waiting with a future check, and marks malformed completion as uncertain", async () => {
    const executor = { execute: vi.fn(async request => {
      await request.onThread(threadId);
      return result({ status: "waiting", nextCheckAt: new Date(Date.now() + 60_000).toISOString() });
    }) } satisfies WorkerExecutor;
    const f = fixture(executor);
    await f.runtime.start(f.input);
    expect(await terminal(f.runtime, f.input)).toMatchObject({ status: "waiting", nextCheckAt: expect.any(String) });
    executor.execute.mockImplementation(async () => "not JSON");
    const next = { ...f.input, invocationId: randomUUID() };
    await f.runtime.start(next);
    expect(await terminal(f.runtime, next)).toMatchObject({ status: "needs_attention", error: "worker_execution_unverified" });
  });
  it("times out a waiting execution, leaving a receipt that cannot be retried", async () => {
    const executor: WorkerExecutor = { execute: vi.fn(request => new Promise((_, reject) => {
      request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) };
    const f = fixture(executor, 20);
    await f.runtime.start(f.input);
    expect(await terminal(f.runtime, f.input)).toMatchObject({ status: "needs_attention", error: "worker_interrupted" });
    expect((await f.runtime.start(f.input)).status).toBe("needs_attention");
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });
  it("exports final artifacts before cleanup, preserves the export, and forbids reuse of a cleaned worker", async () => {
    const f = fixture({ execute: async request => {
      await request.onThread(threadId);
      fs.writeFileSync(path.join(request.workspace, "report.txt"), "evidence");
      return result({ attachments: ["report.txt"] });
    } });
    await f.runtime.start(f.input); await terminal(f.runtime, f.input);
    await expect(f.runtime.cleanup(f.input.workerId)).rejects.toThrow("Export");
    const artifacts = await f.runtime.exportArtifacts(f.input.workerId, f.input.invocationId);
    expect(artifacts[0]).toMatchObject({ name: "report.txt", size: 8, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(artifacts[0].path), "result.json"), "utf8"));
    expect(Object.keys(manifest).sort()).toEqual(["artifacts", "invocationId", "workerId"]);
    await f.runtime.cleanup(f.input.workerId);
    await f.runtime.cleanup(f.input.workerId);
    await f.runtime.cancel(f.input.workerId, f.input.invocationId);
    expect(fs.existsSync(f.dir)).toBe(false);
    expect(fs.readFileSync(artifacts[0].path, "utf8")).toBe("evidence");
    await expect(f.runtime.start(f.input)).rejects.toThrow("cleaned up");
  });
  it("records a result without attachments without creating permanent export files", async () => {
    const f = fixture(completing());
    await f.runtime.start(f.input); await terminal(f.runtime, f.input);
    const destination = path.join(f.options.artifactRoot, f.input.workerId, f.input.invocationId);
    expect(fs.existsSync(destination)).toBe(false);
    expect(await f.runtime.exportArtifacts(f.input.workerId, f.input.invocationId)).toEqual([]);
    expect(fs.existsSync(destination)).toBe(false);
    // Interrupted atomic metadata writes must not prevent eventual TTL cleanup.
    for (const kind of ["json", "launch"]) {
      fs.writeFileSync(path.join(f.dir, "invocations", `${f.input.invocationId}.${kind}.${randomUUID()}.tmp`), "");
    }
    await f.runtime.cleanup(f.input.workerId);
    expect(fs.existsSync(f.dir)).toBe(false);
  });
  it.each(["../outside.txt", "/etc/passwd", "linked.txt", "nested/secret.txt", "hard.txt"])("rejects unsafe attachment %s", async attachment => {
    const f = fixture({ execute: async request => {
      await request.onThread(threadId);
      const external = path.join(f.root, "outside.txt"); fs.writeFileSync(external, "secret");
      fs.symlinkSync(external, path.join(request.workspace, "linked.txt"));
      fs.symlinkSync(f.root, path.join(request.workspace, "nested"));
      fs.linkSync(external, path.join(request.workspace, "hard.txt"));
      return result({ attachments: [attachment] });
    } });
    await f.runtime.start(f.input);
    expect(await terminal(f.runtime, f.input)).toMatchObject({ status: "needs_attention", error: "worker_artifact_invalid", attachments: [] });
    expect(fs.existsSync(path.join(f.options.artifactRoot, f.input.workerId))).toBe(false);
    await expect(f.runtime.cleanup(f.input.workerId)).rejects.toThrow("Export");
    expect(await f.runtime.exportArtifacts(f.input.workerId, f.input.invocationId)).toEqual([]);
    await f.runtime.cleanup(f.input.workerId);
    expect(fs.readFileSync(path.join(f.root, "outside.txt"), "utf8")).toBe("secret");
  });
  it("discards a partial artifact snapshot when a later attachment fails validation", async () => {
    const f = fixture({ execute: async request => {
      await request.onThread(threadId);
      fs.writeFileSync(path.join(request.workspace, "report.txt"), "safe evidence");
      return result({ attachments: ["report.txt", "../unsafe.txt"] });
    } });
    await f.runtime.start(f.input);
    expect(await terminal(f.runtime, f.input)).toMatchObject({ status: "needs_attention", error: "worker_artifact_invalid" });
    expect(fs.existsSync(path.join(f.options.artifactRoot, f.input.workerId))).toBe(false);
    await f.runtime.exportArtifacts(f.input.workerId, f.input.invocationId);
    await f.runtime.cleanup(f.input.workerId);
  });
  it("refuses user paths and worker symlinks", async () => {
    const f = fixture(completing());
    await expect(f.runtime.start({ ...f.input, workerId: "../user" })).rejects.toThrow("UUID");
    const external = path.join(f.root, "external"); fs.mkdirSync(external);
    fs.symlinkSync(external, f.dir);
    await expect(f.runtime.start(f.input)).rejects.toThrow("Unsafe");
    expect(fs.existsSync(external)).toBe(true);
  });
  it("bounds capacity across runtime instances, queues durably, and cancels queued work without executing", async () => {
    const pending: (() => void)[] = [];
    let executing = 0;
    let peak = 0;
    const executor: WorkerExecutor = { execute: vi.fn(async request => {
      executing++; peak = Math.max(peak, executing);
      await request.onThread(threadId);
      await new Promise<void>(resolve => pending.push(resolve));
      executing--; return result();
    }) };
    const f = fixture(executor);
    const second = { ...f.input, workerId: randomUUID(), invocationId: randomUUID() };
    const third = { ...f.input, workerId: randomUUID(), invocationId: randomUUID() };
    const otherRuntime = new CodexWorkerRuntime(f.options);
    await f.runtime.start(f.input); await otherRuntime.start(second); await otherRuntime.start(third);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect((await otherRuntime.inspect(third.workerId, third.invocationId)).status).toBe("queued");
    await otherRuntime.cancel(third.workerId, third.invocationId);
    expect(await terminal(otherRuntime, third)).toMatchObject({ status: "failed", error: "worker_cancelled_before_launch" });
    for (const finish of pending) finish();
    await terminal(f.runtime, f.input); await terminal(otherRuntime, second);
    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(peak).toBe(2);
    await otherRuntime.exportArtifacts(third.workerId, third.invocationId);
    await otherRuntime.cleanup(third.workerId);
  });
  it("starts queued work as capacity frees and persists input until its safe launch boundary", async () => {
    let release!: () => void;
    const executor: WorkerExecutor = { execute: vi.fn(async request => {
      await request.onThread(threadId);
      if (vi.mocked(executor.execute).mock.calls.length === 1) await new Promise<void>(resolve => { release = resolve; });
      return result();
    }) };
    const f = fixture(executor);
    const runtime = new CodexWorkerRuntime({ ...f.options, maxConcurrent: 1 });
    const next = { ...f.input, workerId: randomUUID(), invocationId: randomUUID(), input: { evidence: "queued-input" } };
    await runtime.start(f.input); await runtime.start(next);
    const receiptPath = path.join(f.options.root, "workers", next.workerId, "invocations", `${next.invocationId}.json`);
    expect(JSON.parse(fs.readFileSync(receiptPath, "utf8"))).toMatchObject({ status: "queued", pendingInput: { input: { evidence: "queued-input" } } });
    release();
    await terminal(runtime, f.input); await terminal(runtime, next);
    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(vi.mocked(executor.execute).mock.calls[1][0].prompt).toContain("queued-input");
    expect(JSON.parse(fs.readFileSync(receiptPath, "utf8")).pendingInput).toBeUndefined();
  });
  it("shutdown cancels owned work, stops accepting starts, and preserves queued receipts without dispatch", async () => {
    const executor: WorkerExecutor = { execute: vi.fn(request => new Promise((_, reject) => {
      if (request.signal.aborted) return reject(new Error("aborted"));
      request.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) };
    const f = fixture(executor);
    const runtime = new CodexWorkerRuntime({ ...f.options, maxConcurrent: 1 });
    const queued = { ...f.input, workerId: randomUUID(), invocationId: randomUUID() };
    await runtime.start(f.input); await runtime.start(queued);
    await runtime.shutdown();
    expect((await runtime.inspect(f.input.workerId, f.input.invocationId)).status).toBe("needs_attention");
    expect((await runtime.inspect(queued.workerId, queued.invocationId)).status).toBe("queued");
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(f.dir)).toBe(true);
    await expect(runtime.start({ ...f.input, invocationId: randomUUID() })).rejects.toThrow("shutting down");
  });
  it("snapshots an earlier result before a later turn overwrites its source file", async () => {
    let round = 0;
    const f = fixture({ execute: async request => {
      await request.onThread(threadId); round++;
      fs.writeFileSync(path.join(request.workspace, "report.txt"), String(round));
      return result({ attachments: ["report.txt"] });
    } });
    await f.runtime.start(f.input); await terminal(f.runtime, f.input);
    const next = { ...f.input, invocationId: randomUUID() };
    await f.runtime.start(next); await terminal(f.runtime, next);
    const earlier = await f.runtime.exportArtifacts(f.input.workerId, f.input.invocationId);
    const later = await f.runtime.exportArtifacts(f.input.workerId, next.invocationId);
    expect(fs.readFileSync(earlier[0].path, "utf8")).toBe("1");
    expect(fs.readFileSync(later[0].path, "utf8")).toBe("2");
  });
  it("does not dispatch an old queue snapshot after another caller successfully cancels it", async () => {
    let release!: () => void;
    const executor: WorkerExecutor = { execute: vi.fn(async request => {
      await request.onThread(threadId);
      await new Promise<void>(resolve => { release = resolve; });
      return result();
    }) };
    const f = fixture(executor);
    const runtime = new CodexWorkerRuntime({ ...f.options, maxConcurrent: 1 });
    const queued = { ...f.input, workerId: randomUUID(), invocationId: randomUUID() };
    await runtime.start(f.input); await runtime.start(queued);
    const store = (runtime as any).store;
    const originalSlot = store.slot.bind(store);
    let cancellation: Promise<void> | undefined;
    store.slot = (...args: any[]) => {
      if (args[1] === queued.workerId && !cancellation) cancellation = runtime.cancel(queued.workerId, queued.invocationId);
      return originalSlot(...args);
    };
    release();
    await terminal(runtime, f.input); await cancellation;
    expect((await terminal(runtime, queued)).status).toBe("failed");
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });
  it("holds worker ownership throughout cleanup so a concurrent start cannot lose its workspace", async () => {
    const f = fixture(completing());
    await f.runtime.start(f.input); await terminal(f.runtime, f.input);
    await f.runtime.exportArtifacts(f.input.workerId, f.input.invocationId);
    const store = (f.runtime as any).store;
    const originalRemove = store.remove.bind(store);
    let startRejected = false;
    let attempt: Promise<unknown> | undefined;
    store.remove = (...args: any[]) => {
      attempt = f.runtime.start({ ...f.input, invocationId: randomUUID() }).catch(() => { startRejected = true; });
      return originalRemove(...args);
    };
    await f.runtime.cleanup(f.input.workerId); await attempt;
    expect(startRejected).toBe(true);
    expect(f.options.executor.execute).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(f.dir)).toBe(false);
  });
});
