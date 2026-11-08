import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackgroundExecution } from "../../src/runtime/background.js";
import { ClaudeCliExecutor, type CodexWorkerRuntime, type WorkerExecutionRequest, type WorkerExecutorKind } from "../../src/background/worker/index.js";
import { CodexCliExecutor } from "../../src/background/worker/executor.js";
import { MemoryStore } from "../../src/store/memory.js";
import { NodeHub } from "../../src/nodes/hub.js";
import type { AutomationRepository } from "../../src/automations/contracts.js";
import type { BackgroundConfig } from "../../src/runtime/background-config.js";
import type { Config } from "../../src/runtime/config.js";
import type { LocalSettingsService } from "../../src/settings/local-service.js";

const sandbox = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../../src/background/worker/index.js", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/background/worker/index.js")>(), verifyClaudeSandbox: sandbox,
}));
const roots: string[] = [];
const executions: BackgroundExecution[] = [];
const codexCalls: WorkerExecutionRequest[] = [], claudeCalls: WorkerExecutionRequest[] = [];
const complete = async (request: WorkerExecutionRequest, calls: WorkerExecutionRequest[]) => {
  calls.push(request); await request.onThread(request.threadId ?? randomUUID());
  return JSON.stringify({ status: "completed", summary: "fixture complete", nextCheckAt: null, attachments: [] });
};
beforeEach(() => {
  sandbox.mockReset().mockResolvedValue(undefined);
  vi.spyOn(CodexCliExecutor.prototype, "execute").mockImplementation(request => complete(request, codexCalls));
  vi.spyOn(ClaudeCliExecutor.prototype, "execute").mockImplementation(request => complete(request, claudeCalls));
});
afterEach(async () => {
  await Promise.all(executions.splice(0).map(execution => execution.stop()));
  vi.restoreAllMocks(); codexCalls.length = 0; claudeCalls.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(background: Partial<BackgroundConfig> = {}, savedModel = "fixture") {
  const root = mkdtempSync(join(tmpdir(), "background-executor-")); roots.push(root);
  const config: Config = { port: 8790, host: "127.0.0.1", controllerToken: "fixture", nodeTokens: {}, tokenToNode: new Map(),
    allowedChatIds: new Set(), persistenceMode: "memory", commandTtlSeconds: 300,
    background: { executorKind: "codex", root: join(root, "workers"), artifactRoot: join(root, "artifacts"), model: "fixture",
      apiKey: "fixture", baseUrl: "http://127.0.0.1", codexPath: "unused", timeoutMs: 300_000, maxConcurrent: 2, ...background } };
  const settings = { capture: () => ({ model: () => ({ model: savedModel, reasoningEffort: "high" }), prompt: () => "fixture system" }) } as unknown as LocalSettingsService;
  const execution = new BackgroundExecution(config, {} as AutomationRepository, new NodeHub(new MemoryStore(), config.tokenToNode),
    undefined, Date.now, undefined, settings);
  executions.push(execution);
  const runtime = (execution as unknown as { runtime: CodexWorkerRuntime }).runtime;
  return { execution, async run(executorKind?: WorkerExecutorKind) {
    const workerId = randomUUID(), invocationId = randomUUID();
    await runtime.start({ workerId, invocationId, task: "fixture", input: {}, ...(executorKind ? { executorKind } : {}) });
    let receipt = await runtime.inspect(workerId, invocationId);
    await vi.waitFor(async () => {
      receipt = await runtime.inspect(workerId, invocationId);
      expect(["completed", "failed", "needs_attention"]).toContain(receipt.status);
    });
    return receipt;
  } };
}

describe("background executor selection", () => {
  it("keeps ordinary tasks on Codex even when a legacy Claude configuration is present", async () => {
    const f = fixture({ executorKind: "claude", claude: { path: "claude", apiKey: "key", privateRoots: [] } });
    await f.execution.initialize();
    expect(sandbox).not.toHaveBeenCalled();
    expect(await f.run()).toMatchObject({ status: "completed" });
    expect(codexCalls).toHaveLength(1); expect(claudeCalls).toHaveLength(0);
    expect(f.execution.executorKind).toBe("codex");
  });
  it("prepares Claude once when explicitly selected and keeps model families separate", async () => {
    const resolveClaude = vi.fn(() => ({ path: "claude", apiKey: "key", model: "opus", privateRoots: [] }));
    const f = fixture({ resolveClaude });
    await f.execution.initialize();
    expect(resolveClaude).not.toHaveBeenCalled();
    expect(await f.run("claude")).toMatchObject({ status: "completed" });
    expect(await f.run("claude")).toMatchObject({ status: "completed" });
    expect(await f.run()).toMatchObject({ status: "completed" });
    expect(resolveClaude).toHaveBeenCalledTimes(1); expect(sandbox).toHaveBeenCalledTimes(1);
    expect(claudeCalls.map(call => call.model)).toEqual(["opus", "opus"]);
    expect(claudeCalls[0].reasoningEffort).toBeNull();
    expect(codexCalls[0]).toMatchObject({ model: "fixture", reasoningEffort: "high" });
  });
  it("fails an explicit Claude task when preparation fails without falling back or blocking Codex", async () => {
    const f = fixture({ resolveClaude: () => { throw new Error("invalid Claude credential configuration"); } });
    await f.execution.initialize();
    expect(await f.run("claude")).toMatchObject({ status: "failed", error: "worker_executor_unavailable" });
    expect(claudeCalls).toHaveLength(0); expect(codexCalls).toHaveLength(0);
    expect(await f.run()).toMatchObject({ status: "completed" });
    expect(codexCalls).toHaveLength(1);
  });
  it.each(["configuration", "sandbox"])("retries a failed Claude %s preparation for later tasks", async failure => {
    const claude = { path: "claude", apiKey: "key", privateRoots: [] };
    const resolveClaude = vi.fn(() => claude);
    if (failure === "configuration") resolveClaude.mockImplementationOnce(() => { throw new Error("configuration unavailable"); });
    else sandbox.mockRejectedValueOnce(new Error("sandbox temporarily unavailable"));
    const f = fixture({ resolveClaude });
    expect(await f.run("claude")).toMatchObject({ status: "failed", error: "worker_executor_unavailable" });
    expect(claudeCalls).toHaveLength(0); expect(codexCalls).toHaveLength(0);
    const receipts = await Promise.all([f.run("claude"), f.run("claude")]);
    expect(receipts.map(receipt => receipt.status)).toEqual(["completed", "completed"]);
    expect(claudeCalls).toHaveLength(2); expect(codexCalls).toHaveLength(0);
    expect(resolveClaude).toHaveBeenCalledTimes(failure === "configuration" ? 2 : 1);
    expect(sandbox).toHaveBeenCalledTimes(failure === "sandbox" ? 2 : 1);
  });
  it.each(["opus", "claude-cli-default"])("does not pass saved Claude model %s to the default Codex executor", async model => {
    const f = fixture({}, model);
    expect(await f.run()).toMatchObject({ status: "completed" });
    expect(codexCalls[0]).toMatchObject({ model: "fixture", reasoningEffort: null });
  });
  it("refuses Claude when the local sandbox cannot start and still accepts Codex tasks", async () => {
    sandbox.mockRejectedValue(new Error("sandbox unavailable"));
    const f = fixture({ claude: { path: "claude", apiKey: "key", privateRoots: [] } });
    await f.execution.initialize();
    expect(sandbox).not.toHaveBeenCalled();
    expect(await f.run("claude")).toMatchObject({ status: "failed", error: "worker_executor_unavailable" });
    expect(claudeCalls).toHaveLength(0);
    expect(await f.run()).toMatchObject({ status: "completed" });
    expect(codexCalls).toHaveLength(1);
  });
});
