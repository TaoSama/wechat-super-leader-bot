import { afterEach, describe, expect, it, vi } from "vitest";
import { TaskNotifications } from "../src/runtime/task-notifications.js";
import { MemoryStore } from "../src/store/memory.js";
import { NodeHub } from "../src/nodes/hub.js";
import { CommandService } from "../src/commands/service.js";
import type { Config } from "../src/runtime/config.js";
import type { LeaderModel, ModelReply } from "../src/leader/model/contracts.js";

const START = Date.parse("2026-10-18T00:00:00Z");
const CHAT = "wechat-user";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(model?: LeaderModel, fallback = false) {
  const config: Config = { port: 8790, host: "localhost", controllerToken: "test", nodeTokens: {}, tokenToNode: new Map(),
    allowedChatIds: new Set([CHAT]), persistenceMode: "memory", commandTtlSeconds: 300,
    taskNotifications: { fileMaxBytes: 50 * 1024 * 1024, retentionMs: 7 * 24 * 60 * 60_000, tickMs: 5_000,
      ...(fallback ? { fallbackEndpointsJson: JSON.stringify({ [CHAT]: "http://localhost:9999/webhook" }) } : {}) } };
  const store = new MemoryStore();
  const hub = new NodeHub(store, config.tokenToNode);
  const runtime = new TaskNotifications(config, store, hub, new CommandService(store, hub, 300), model, Date.now, vi.fn());
  const reminder = (id: string, text: string, at: number) => runtime.automations.create({ kind: "reminder", title: id, text,
    timezone: "Asia/Shanghai", timing: { type: "at", at: new Date(at).toISOString() }, businessTtlMs: 600_000, retention: "latest" },
  { chatId: CHAT, currentMessageId: id, explicitCurrentTurnAuthorization: true });
  return { runtime, reminder };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("independent task notification workers", () => {
  it("suppresses an already queued fallback after WeChat accepts the result", async () => {
    vi.useFakeTimers(); vi.setSystemTime(START);
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const { runtime } = fixture(undefined, true);
    await runtime.initialize();
    const plan = await runtime.results.prepareResult({ key: "accepted", chatId: CHAT, text: "已保存的完整成果",
      source: { type: "task", id: "accepted" }, kind: "completed", createdAt: START, expiresAt: START + 600_000 });
    await runtime.results.repository.markChatWaiting(CHAT, "window_expired", START);
    const fallback = await runtime.fallback.enqueue({ key: "fallback-before-resume", chatId: CHAT, kind: "completed",
      title: "任务完成", text: "成果已保存", resultId: plan.id });
    await runtime.results.resumeChat(CHAT, "new-message");
    const attemptId = "9e5a2d54-450a-4a4b-86c4-7c8596a8e357";
    await runtime.results.repository.claim(plan.id, attemptId, START);
    await runtime.results.repository.recordReceipt(plan.id, "accepted", attemptId);
    await runtime.fallback.drain();
    expect(fetch).not.toHaveBeenCalled();
    expect((await runtime.snapshot()).fallbackDeliveries.find(item => item.id === fallback!.id))
      .toMatchObject({ status: "failed", outcome: "skipped_wechat_accepted" });
    await runtime.stop();
  });

  it("does not enqueue reserved catch-up sources on the fallback channel while their summary is preparing", async () => {
    vi.useFakeTimers(); vi.setSystemTime(START);
    const { runtime } = fixture({ complete: async () => { throw new Error("model temporarily unavailable"); } }, true);
    await runtime.initialize();
    for (const id of ["first", "second"]) await runtime.results.prepareResult({
      key: id, chatId: CHAT, text: id.repeat(1_300), source: { type: "task", id }, kind: "completed",
      createdAt: START, expiresAt: START + 600_000,
    });
    await runtime.results.repository.markChatWaiting(CHAT, "window_expired", START);
    await runtime.results.resumeChat(CHAT, "fresh-inbound");
    const enqueue = vi.spyOn(runtime.fallback, "enqueue");
    await runtime.tick();
    expect(enqueue).not.toHaveBeenCalled();
    expect((await runtime.results.repository.list([CHAT])).filter(plan => plan.catchupId)).toHaveLength(2);
    await runtime.stop();
  });

  it("executes due reminders while summary and webhook are blocked, never overlaps workers, and drains both before closing the pool", async () => {
    vi.useFakeTimers(); vi.setSystemTime(START);
    const summary = deferred<ModelReply>();
    const webhook = deferred<Response>();
    const complete = vi.fn(() => summary.promise);
    const fetch = vi.fn(() => webhook.promise);
    vi.stubGlobal("fetch", fetch);
    const { runtime, reminder } = fixture({ complete }, true);
    await runtime.initialize();
    const long = await reminder("long", "长".repeat(11_401), START + 1);
    const later = await reminder("later", "按时提醒", START + 15_000);
    await runtime.fallback.enqueue({ key: "initial", chatId: CHAT, kind: "reminder", title: "通知", text: "已完成" });
    const prepare = vi.spyOn(runtime.results, "prepareResult");
    runtime.start();
    expect(complete).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await runtime.automations.repository.listRuns(later.id, CHAT))[0]?.status).toBe("completed");
    expect((await runtime.automations.repository.listRuns(long.id, CHAT))).toHaveLength(1);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const manualPolls = Promise.all([runtime.tick(), runtime.tick()]);
    const end = vi.fn(async () => {});
    // The pool closure must wait for every worker, including two different blocked I/O paths.
    Object.assign(runtime, { pool: { end } });
    let stopped = false;
    const stop = runtime.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(stopped).toBe(false); expect(end).not.toHaveBeenCalled();
    summary.resolve({ content: "成果摘要", toolCalls: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false); expect(end).not.toHaveBeenCalled();
    webhook.resolve(new Response(null, { status: 204 }));
    await stop;
    await manualPolls;
    expect(end).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("bounds publication to eight records and lets later results pass a full failed batch", async () => {
    vi.useFakeTimers(); vi.setSystemTime(START);
    const { runtime, reminder } = fixture();
    await runtime.initialize();
    for (let index = 0; index < 10; index++) await reminder(`item-${index}`, `结果${index}`, START + 1);
    vi.setSystemTime(START + 1);
    await runtime.automations.tick();
    const original = runtime.results.prepareResult.bind(runtime.results);
    const prepare = vi.spyOn(runtime.results, "prepareResult");
    prepare.mockRejectedValueOnce(new Error("storage temporarily unavailable"));
    for (let index = 1; index < 8; index++) prepare.mockRejectedValueOnce(new Error("storage temporarily unavailable"));
    prepare.mockImplementation(original);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runtime.tick();
    expect(prepare).toHaveBeenCalledTimes(8);
    expect(warning).toHaveBeenCalledTimes(8);
    await runtime.tick();
    expect(prepare).toHaveBeenCalledTimes(10);
    expect(await runtime.results.repository.list([CHAT])).toHaveLength(2);
    expect(await runtime.automations.repository.pendingOutbox(Date.now())).toHaveLength(8);
    await runtime.stop();
  });

  it("retries a failed summary once per sixty seconds per result", async () => {
    vi.useFakeTimers(); vi.setSystemTime(START);
    const complete = vi.fn(async () => { throw new Error("provider unavailable"); });
    const { runtime, reminder } = fixture({ complete });
    await runtime.initialize();
    await reminder("long", "长".repeat(11_401), START + 1);
    vi.setSystemTime(START + 1);
    await runtime.automations.tick();
    await runtime.tick();
    expect(complete).toHaveBeenCalledTimes(1);
    vi.setSystemTime(START + 59_999);
    await runtime.tick();
    expect(complete).toHaveBeenCalledTimes(1);
    vi.setSystemTime(START + 60_001);
    await runtime.tick();
    expect(complete).toHaveBeenCalledTimes(2);
    await runtime.tick();
    expect(complete).toHaveBeenCalledTimes(2);
    await runtime.stop();
  });
});
