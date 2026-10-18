import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { BackgroundService, BackgroundSpecSchema, MemoryBackgroundRepository, WORKER_LIFETIME_MS } from "../src/background/index.js";
import { CodexWorkerRuntime } from "../src/background/worker/index.js";
import type { WorkerExecutionRequest } from "../src/background/worker/contracts.js";

it("runs the scheduler against the actual runtime, resumes its thread, exports results and cleans only the workspace", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "background-integration-"));
  let now = Date.now();
  const startedAt = now;
  const threadId = randomUUID();
  const executor = { execute: vi.fn(async (request: WorkerExecutionRequest) => {
    await request.onThread(request.threadId ?? threadId);
    await writeFile(path.join(request.workspace, "report.txt"), "verified report");
    return JSON.stringify({ status: "completed", summary: request.threadId ? "followup" : "initial", nextCheckAt: null, attachments: ["report.txt"] });
  }) };
  const runtime = new CodexWorkerRuntime({ root: path.join(temp, "workers"), artifactRoot: path.join(temp, "artifacts"), model: "test-model", executor });
  const repository = new MemoryBackgroundRepository();
  const deliverSupplement = vi.fn(async () => undefined);
  const artifactLinks = vi.fn(async () => ["[report](https://bot.example/artifacts/signed)"]);
  const service = new BackgroundService({ repository, runtime, sources: { inspectAutomation: async () => { throw new Error("No sources expected"); } },
    deliverSupplement, artifactLinks, now: () => now });
  const run = { id: randomUUID(), scheduleId: "daily", chatId: "chat", scheduledAt: now };
  try {
    await service.start(run, BackgroundSpecSchema.parse({ prompt: "create report" }));
    await vi.waitFor(async () => { expect(await service.inspect(run)).toMatchObject({ status: "completed", result: { text: "initial\n\n[report](https://bot.example/artifacts/signed)" } }); });
    await service.acceptResult(run.id);
    const worker = (await repository.getByRun(run.id))!;
    expect(worker.invocations[0].receipt?.threadId).toBe(threadId);
    await service.enqueue(worker.id, "chat", "follow up", "user-followup");
    await service.maintenance();
    await vi.waitFor(async () => { await service.maintenance(); expect(deliverSupplement).toHaveBeenCalledTimes(1); });
    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(executor.execute.mock.calls[1][0].threadId).toBe(threadId);
    const artifact = (await repository.getByRun(run.id))!.invocations[0].receipt!.artifacts![0];
    expect(await readFile(artifact.path, "utf8")).toBe("verified report");
    now = startedAt + WORKER_LIFETIME_MS;
    await service.maintenance();
    expect((await repository.getByRun(run.id))!.phase).toBe("cleaned");
    expect(await readFile(artifact.path, "utf8")).toBe("verified report");
  } finally { await rm(temp, { recursive: true, force: true }); }
});
