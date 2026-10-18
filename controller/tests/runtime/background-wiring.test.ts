import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskNotifications } from "../../src/runtime/task-notifications.js";
import { CodexWorkerRuntime } from "../../src/background/worker/index.js";
import { BackgroundSpecSchema } from "../../src/background/contracts.js";
import { MemoryStore } from "../../src/store/memory.js";
import { NodeHub } from "../../src/nodes/hub.js";
import { CommandService } from "../../src/commands/service.js";
import type { Config } from "../../src/runtime/config.js";

const START = Date.parse("2026-10-18T00:00:00Z");
const CHAT = "background-test";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "background-wiring-")); roots.push(root);
  let now = START;
  const config: Config = { port: 8790, host: "127.0.0.1", controllerToken: "fixture", nodeTokens: {}, tokenToNode: new Map(),
    allowedChatIds: new Set([CHAT]), persistenceMode: "memory", commandTtlSeconds: 300,
    background: { root: join(root, "workers"), artifactRoot: join(root, "artifacts"), model: "fixture",
      apiKey: "fixture", baseUrl: "http://127.0.0.1", codexPath: "unused", timeoutMs: 300_000, maxConcurrent: 2 } };
  const store = new MemoryStore(); const hub = new NodeHub(store, config.tokenToNode);
  const commands = new CommandService(store, hub, 300); const submit = vi.spyOn(commands, "submit");
  const start = vi.spyOn(CodexWorkerRuntime.prototype, "start").mockImplementation(async input => ({
    workerId: input.workerId, invocationId: input.invocationId, status: "completed", threadId: "fixture-thread",
    summary: input.task, attachments: [],
  }));
  vi.spyOn(CodexWorkerRuntime.prototype, "exportArtifacts").mockResolvedValue([]);
  const runtime = new TaskNotifications(config, store, hub, commands, undefined, () => now, vi.fn());
  const create = (messageId = "create") => runtime.automations.create({ kind: "background", title: "独立任务",
    timing: { type: "at", at: new Date(START).toISOString() }, timezone: "Asia/Shanghai", businessTtlMs: 86_400_000,
    retention: "retain", background: BackgroundSpecSchema.parse({ prompt: "首轮完成" }) },
  { chatId: CHAT, currentMessageId: messageId, explicitCurrentTurnAuthorization: true });
  return { runtime, hub, create, start, submit, setNow: (value: number) => { now = value; } };
}

describe("unified background execution wiring", () => {
  it("does not launch a registered background task after its schedule is cancelled", async () => {
    const { runtime, create, start } = fixture();
    try {
      await runtime.initialize(); const schedule = await create();
      await runtime.automations.tick();
      await runtime.automations.repository.setStatus(schedule.id, CHAT, "cancelled", START);
      await runtime.tick(); await runtime.tick();
      expect(start).not.toHaveBeenCalled();
      expect((await runtime.background!.list(CHAT))[0].cancelRequestedAt).toBe(START);
      expect(await runtime.results.repository.list([CHAT])).toHaveLength(0);
    } finally { await runtime.stop(); }
  });

  it("keeps due reminders moving while an existing background source read is blocked", async () => {
    const { runtime, hub, start, setNow } = fixture();
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(hub, "listAutomations").mockResolvedValue([{ id: "source", name: "source", kind: "heartbeat", status: "ACTIVE", prompt: "", rrule: "" }]);
    const read = vi.spyOn(hub, "inspectAutomation").mockImplementation(async (_nodeId, request) => {
      await blocked;
      return { ...request, status: "running", sources: [], observedAt: START };
    });
    let maintenance: Promise<void> | undefined;
    try {
      await runtime.initialize();
      await runtime.automations.create({ kind: "background", title: "watch", timezone: "UTC", retention: "retain", businessTtlMs: 86_400_000,
        timing: { type: "at", at: new Date(START).toISOString() }, background: BackgroundSpecSchema.parse({ prompt: "汇总",
          sources: [{ nodeId: "node", automationId: "source" }] }) },
      { chatId: CHAT, currentMessageId: "watch", explicitCurrentTurnAuthorization: true });
      const reminder = await runtime.automations.create({ kind: "reminder", title: "reminder", text: "按时提醒", timezone: "UTC",
        retention: "retain", businessTtlMs: 60_000, timing: { type: "at", at: new Date(START + 1).toISOString() } },
      { chatId: CHAT, currentMessageId: "reminder", explicitCurrentTurnAuthorization: true });
      await runtime.automations.tick();
      maintenance = runtime.background!.maintenance();
      await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      setNow(START + 1);
      await runtime.automations.tick();
      expect((await runtime.automations.repository.listRuns(reminder.id, CHAT))[0].status).toBe("completed");
      expect(start).not.toHaveBeenCalled();
    } finally { release(); await maintenance; await runtime.stop(); }
  });

  it("commits the first result before accepting the worker and sends follow-ups through the same durable result service", async () => {
    const { runtime, create, start, submit, setNow } = fixture();
    try {
      await runtime.initialize(); const schedule = await create();
      await runtime.automations.tick();
      expect(start).not.toHaveBeenCalled();
      await runtime.background!.maintenance();
      await runtime.automations.tick();
      const run = (await runtime.automations.repository.listRuns(schedule.id, CHAT))[0];
      const worker = (await runtime.background!.list(CHAT))[0];
      expect(run.status).toBe("completed"); expect(worker.initialAcceptedAt).toBe(START);
      expect(await runtime.automations.repository.pendingOutbox(START)).toHaveLength(1);
      await runtime.tick();
      expect((await runtime.results.repository.list([CHAT])).map(item => item.source)).toEqual([{ type: "automation", id: schedule.id }]);
      setNow(START + 1000);
      await runtime.background!.enqueue(worker.id, CHAT, "接着分析", "followup-1");
      await runtime.tick(); await runtime.tick(); await runtime.tick();
      const delivered = await runtime.results.repository.list([CHAT]);
      expect(delivered).toHaveLength(2);
      expect(delivered.some(item => item.business?.category === "background-result")).toBe(true);
      expect(start).toHaveBeenCalledTimes(2); expect(submit).not.toHaveBeenCalled();
      await runtime.tick(); expect(await runtime.results.repository.list([CHAT])).toHaveLength(2);
    } finally { await runtime.stop(); }
  });

  it("recovers a lost post-commit acceptance without starting the model again", async () => {
    const { runtime, create, start } = fixture();
    try {
      await runtime.initialize(); await create();
      const accept = vi.spyOn(runtime.background!, "acceptResult").mockRejectedValueOnce(new Error("storage unavailable"));
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await runtime.automations.tick();
      await runtime.background!.maintenance();
      await runtime.automations.tick();
      expect((await runtime.background!.list(CHAT))[0].initialAcceptedAt).toBeUndefined();
      await runtime.tick();
      expect((await runtime.background!.list(CHAT))[0].initialAcceptedAt).toBe(START);
      expect(start).toHaveBeenCalledTimes(1); expect(accept).toHaveBeenCalledTimes(2);
    } finally { await runtime.stop(); }
  });
});
