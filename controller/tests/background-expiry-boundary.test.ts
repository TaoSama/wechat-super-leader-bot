import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundService, BackgroundSpecSchema, MemoryBackgroundRepository, WORKER_SHUTDOWN_GRACE_MS } from "../src/background/index.js";
import { CodexWorkerRuntime, type WorkerExecutionRequest, type WorkerExecutor, type WorkerInput } from "../src/background/worker/index.js";
import { hash, type Receipt, type WorkerStorage } from "../src/background/worker/storage.js";

const BASE = 1_800_000_000_000;
const TURN_TIMEOUT_MS = 5_000;
const DEAD_OWNER_PID = 2_147_483_647;
const fixtures: { runtime: CodexWorkerRuntime; root: string }[] = [];
const completed = () => JSON.stringify({ status: "completed", summary: "verified result", attachments: [], nextCheckAt: null });
const input = (bounds: Partial<WorkerInput> = {}): WorkerInput => ({ workerId: randomUUID(), invocationId: randomUUID(), task: "synthetic task", input: {}, ...bounds });

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.runtime.shutdown();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function flush(): Promise<void> { for (let index = 0; index < 30; index++) await Promise.resolve(); }
function fixture(executor: WorkerExecutor) {
  let now = BASE;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "worker-expiry-boundary-"));
  const runtime = new CodexWorkerRuntime({ root: path.join(root, "runtime"), artifactRoot: path.join(root, "artifacts"),
    model: "synthetic", maxConcurrent: 1, timeoutMs: TURN_TIMEOUT_MS, executor, onError: vi.fn() });
  fixtures.push({ runtime, root });
  const receiptPath = (value: Pick<WorkerInput, "workerId" | "invocationId">) => path.join(root, "runtime", "workers", value.workerId, "invocations", `${value.invocationId}.json`);
  return { root, runtime, receiptPath, now: () => now, setTime: (value: number) => { now = value; } };
}
function heldExecutor() {
  const releases: (() => void)[] = [];
  const executor: WorkerExecutor = { execute: vi.fn(async request => {
    await request.onThread(randomUUID());
    await new Promise<void>((resolve, reject) => {
      if (request.signal.aborted) { reject(new Error("synthetic abort")); return; }
      releases.push(resolve);
      request.signal.addEventListener("abort", () => reject(new Error("synthetic abort")), { once: true });
    });
    return completed();
  }) };
  return { executor, releases };
}
function serviceFixture(runtime: CodexWorkerRuntime, now: () => number) {
  const repository = new MemoryBackgroundRepository();
  const service = new BackgroundService({ repository, runtime, now,
    sources: { inspectAutomation: async () => { throw new Error("No sources expected"); } }, deliverSupplement: async () => undefined });
  const run = { id: randomUUID(), scheduleId: "synthetic", chatId: "synthetic", scheduledAt: now() };
  const spec = BackgroundSpecSchema.parse({ prompt: "synthetic task" });
  return { repository, service, run, spec };
}

describe("absolute background execution boundaries", () => {
  it("does not execute an expired queue when another turn releases capacity, including duplicate starts", async () => {
    const held = heldExecutor();
    const f = fixture(held.executor);
    const first = input();
    const queued = input({ launchDeadlineAt: BASE + 100, executionDeadlineAt: BASE + 200 });
    await f.runtime.start(first); await f.runtime.start(queued); await flush();
    f.setTime(BASE + 101); held.releases[0](); await flush();
    expect(await f.runtime.inspect(queued.workerId, queued.invocationId)).toMatchObject({ status: "failed", error: "worker_expired" });
    expect(await f.runtime.start(queued)).toMatchObject({ status: "failed", error: "worker_expired" });
    expect(held.executor.execute).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(f.receiptPath(queued), "utf8")).pendingInput).toBeUndefined();
  });

  it("checks the deadline again after persisting running and before invoking the executor", async () => {
    const executor = { execute: vi.fn(async (request: WorkerExecutionRequest) => { await request.onThread(randomUUID()); return completed(); }) };
    const f = fixture(executor);
    const store = (f.runtime as unknown as { store: WorkerStorage }).store;
    const save = store.save.bind(store);
    vi.spyOn(store, "save").mockImplementation((dir, receipt) => {
      save(dir, receipt);
      if (receipt.status === "running") f.setTime(BASE + 100);
    });
    const value = input({ launchDeadlineAt: BASE + 100, executionDeadlineAt: BASE + 200 });
    await f.runtime.start(value); await flush();
    expect(await f.runtime.inspect(value.workerId, value.invocationId)).toMatchObject({ status: "failed", error: "worker_expired" });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("holds legacy queues until the caller restores durable bounds without changing the input hash", async () => {
    const held = heldExecutor();
    const f = fixture(held.executor);
    const first = input(); const queued = input();
    await f.runtime.start(first); await f.runtime.start(queued); await flush();
    const receipt = JSON.parse(fs.readFileSync(f.receiptPath(queued), "utf8")) as Receipt;
    receipt.ownerPid = DEAD_OWNER_PID;
    delete receipt.launchDeadlineAt; delete receipt.executionDeadlineAt;
    fs.writeFileSync(f.receiptPath(queued), JSON.stringify(receipt));
    held.releases[0](); await flush();
    expect(await f.runtime.inspect(queued.workerId, queued.invocationId)).toMatchObject({ status: "queued", summary: expect.stringContaining("等待恢复绝对执行期限") });
    expect(held.executor.execute).toHaveBeenCalledTimes(1);
    await f.runtime.inspect(queued.workerId, queued.invocationId, { launchDeadlineAt: BASE + 100, executionDeadlineAt: BASE + 200 });
    await flush();
    const migrated = JSON.parse(fs.readFileSync(f.receiptPath(queued), "utf8")) as Receipt;
    expect(migrated).toMatchObject({ inputHash: receipt.inputHash, launchDeadlineAt: BASE + 100, executionDeadlineAt: BASE + 200 });
    expect(held.executor.execute).toHaveBeenCalledTimes(2);
    held.releases[1](); await flush();
  });

  it.each([0, WORKER_SHUTDOWN_GRACE_MS + 1])("cancels an expired legacy queue without draining capacity (%i ms after expiry)", async afterExpiry => {
    const executor = { execute: vi.fn(async (request: WorkerExecutionRequest) => { await request.onThread(randomUUID()); return completed(); }) };
    const f = fixture(executor);
    const s = serviceFixture(f.runtime, f.now);
    const worker = await s.service.register(s.run, s.spec);
    await s.repository.update(worker.id, current => { current.expiresAt = BASE + 100; });
    const slot = path.join(f.root, "runtime", "slots", "0.json");
    fs.writeFileSync(slot, JSON.stringify({ ownerPid: process.pid, token: randomUUID() }));
    await s.service.inspect(s.run);
    const active = (await s.repository.get(worker.id))!.activeInvocationId!;
    const value = { workerId: worker.id, invocationId: active };
    const receipt = JSON.parse(fs.readFileSync(f.receiptPath(value), "utf8")) as Receipt;
    delete receipt.pendingInput!.launchDeadlineAt; delete receipt.pendingInput!.executionDeadlineAt;
    delete receipt.launchDeadlineAt; delete receipt.executionDeadlineAt;
    receipt.inputHash = hash(JSON.stringify(receipt.pendingInput)); receipt.ownerPid = DEAD_OWNER_PID;
    fs.writeFileSync(f.receiptPath(value), JSON.stringify(receipt));
    fs.unlinkSync(slot);
    const inspect = vi.spyOn(f.runtime, "inspect");
    f.setTime(BASE + 100 + afterExpiry);
    await s.service.maintenance(); await flush();
    expect(executor.execute).not.toHaveBeenCalled();
    expect(inspect.mock.calls.every(call => call[2]?.resumeQueued === false)).toBe(true);
    expect((await s.repository.get(worker.id))!.initialOutcome).toMatchObject({ status: "failed", result: { error: "worker_expired" } });
  });

  it("allows an already running turn to finish within its shutdown grace", async () => {
    const held = heldExecutor(); const f = fixture(held.executor);
    const s = serviceFixture(f.runtime, f.now);
    const worker = await s.service.register(s.run, s.spec);
    await s.repository.update(worker.id, current => { current.expiresAt = BASE + 100; });
    await s.service.inspect(s.run); await flush();
    const cancel = vi.spyOn(f.runtime, "cancel");
    f.setTime(BASE + 101); await s.service.maintenance();
    expect(cancel).not.toHaveBeenCalled();
    expect((await s.repository.get(worker.id))!.activeInvocationId).toBeDefined();
    held.releases[0](); await flush(); await s.service.maintenance();
    expect((await s.repository.get(worker.id))!.initialOutcome).toMatchObject({ status: "completed", result: { text: "verified result" } });
  });

  it("preserves an already completed result discovered after the grace without cancellation", async () => {
    const executor = { execute: vi.fn(async (request: WorkerExecutionRequest) => { await request.onThread(randomUUID()); return completed(); }) };
    const f = fixture(executor); const s = serviceFixture(f.runtime, f.now);
    const worker = await s.service.register(s.run, s.spec);
    await s.repository.update(worker.id, current => { current.expiresAt = BASE + 100; });
    await s.service.inspect(s.run); await flush();
    const cancel = vi.spyOn(f.runtime, "cancel");
    f.setTime(BASE + 100 + WORKER_SHUTDOWN_GRACE_MS); await s.service.maintenance();
    expect(cancel).not.toHaveBeenCalled();
    expect((await s.repository.get(worker.id))!.initialOutcome).toMatchObject({ status: "completed", result: { text: "verified result" } });
  });

  it("subtracts queue delay from the absolute shutdown budget of an active turn", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const held = heldExecutor(); const f = fixture(held.executor);
    const first = input(); const queued = input({ timeoutMs: TURN_TIMEOUT_MS, launchDeadlineAt: BASE + 100, executionDeadlineAt: BASE + 200 });
    await f.runtime.start(first); await f.runtime.start(queued); await flush();
    f.setTime(BASE + 99); held.releases[0](); await flush();
    const request = vi.mocked(held.executor.execute).mock.calls[1][0];
    f.setTime(BASE + 199); await vi.advanceTimersByTimeAsync(100);
    expect(request.signal.aborted).toBe(false);
    f.setTime(BASE + 200); await vi.advanceTimersByTimeAsync(1); await flush();
    expect(request.signal.aborted).toBe(true);
    expect(await f.runtime.inspect(queued.workerId, queued.invocationId)).toMatchObject({ status: "needs_attention", error: "worker_interrupted" });
  });
});
