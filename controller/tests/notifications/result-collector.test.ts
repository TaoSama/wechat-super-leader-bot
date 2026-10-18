import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../src/store/memory.js";
import { createExecution, executionRequestId, type ExecutionRecord } from "../../src/leader/plans/execution.js";
import { createTerminalNotifications, normalizeNotification, NOTIFICATION_TTL_MS,
  type StoredNotification } from "../../src/notifications/contracts.js";
import { NotificationResultCollector, notificationResultInput, PROGRESS_RESULT_TTL_MS,
  TERMINAL_RESULT_TTL_MS } from "../../src/notifications/result-collector.js";
import { MemoryDeliveryRepository } from "../../src/deliveries/memory.js";
import { ResultDeliveryService } from "../../src/deliveries/service.js";
import type { CommandRecord } from "../../src/types.js";

const NOW = 1_700_000_000_000;
afterEach(() => vi.useRealTimers());
const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
function execution(index = 1, chatId = "chat"): ExecutionRecord {
  return createExecution(chatId, { id: id(index), expiresAt: NOW + 60_000,
    actions: [{ nodeId: "node", sessionId: "thread", prompt: "调查并给出完整成果", sendRoute: "control-socket", dependsOn: [] }] }, NOW);
}
function command(record: ExecutionRecord, output = "结果"): CommandRecord {
  const stamp = new Date(NOW).toISOString();
  return { commandId: `cmd-${record.id}`, requestId: executionRequestId(record, 0), nodeId: "node", sessionId: "thread",
    prompt: record.plan.actions[0].prompt, action: "send", sendRoute: "control-socket", turnId: "exact-turn", status: "completed", output,
    createdAt: stamp, updatedAt: stamp, expiresAt: new Date(NOW + 60 * 60_000).toISOString() };
}
async function terminal(store: MemoryStore, index = 1, output = "成果", chatId = "chat") {
  const initial = execution(index, chatId);
  await store.createExecutionIfAbsent(initial);
  const active = (await store.compareAndSetExecution({ ...initial, revision: 2,
    attempts: [{ token: id(999), startedAt: NOW, expiresAt: NOW + 15_000 }] }, 1, NOW))!;
  const receipt = command(active, output);
  await store.createCommandIfAbsent(receipt);
  await store.compareAndSetExecution({ ...active, revision: 3, status: "completed" }, 2, NOW);
  return active;
}
function service(repository = new MemoryDeliveryRepository()) {
  const model = { complete: vi.fn(async () => ({ content: "模型根据真实成果生成的摘要", toolCalls: [] })) };
  return { repository, model, results: new ResultDeliveryService(repository, {
    model, now: () => NOW, publicUrl: "https://test.example", signingSecret: "x".repeat(32) }) };
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

describe("terminal immutable result collection", () => {
  it("assembles all persisted multipart bytes once, independently of later command mutations", async () => {
    const store = new MemoryStore(), f = service();
    const output = `开始😀\n${"完整 Markdown\n".repeat(180_000)}结束`;
    const record = await terminal(store, 1, output), source = { type: "plan" as const, id: record.id };
    const parts = await store.getNotificationParts(source);
    expect(parts.length).toBeGreaterThan(1);
    const expected = parts.map(part => part.text).join("");
    await store.updateCommandStatus(`cmd-${record.id}`, "completed", "后来被改写的内容", undefined, "exact-turn");
    const collector = new NotificationResultCollector(store, f.results);
    expect(await collector.collect(["chat"], NOW)).toMatchObject({ prepared: 1, failures: [] });
    const plan = (await f.repository.getByKey(`notification:plan:${record.id}`))!;
    expect(plan).toMatchObject({ mode: "attachment", messages: ["模型根据真实成果生成的摘要"], expiresAt: NOW + TERMINAL_RESULT_TTL_MS });
    const artifact = (await f.repository.getArtifact(plan.artifact.id))!;
    expect(hash(artifact.bytes.toString("utf8"))).toBe(hash(expected));
    expect(artifact.bytes.toString("utf8")).toContain(output);
    expect(await collector.collect(["chat"], NOW)).toMatchObject({ scanned: 0, existing: 0, prepared: 0 });
    expect(f.model.complete).toHaveBeenCalledTimes(1);
    expect(await store.getNotification(record.id, NOW)).toMatchObject({ status: "pending" });
    expect((await f.repository.list(["chat"]))).toHaveLength(1);
  });

  it("preserves exact newlines and whitespace across parts, validates every part before preparing", () => {
    const record = { ...execution(), status: "completed" as const,
      attempts: [{ token: id(99), startedAt: NOW, expiresAt: NOW + 15_000 }] };
    const parts = createTerminalNotifications(record, NOW, [command(record, "x".repeat(1_048_576) + "\n\n  😀尾部")]);
    expect(parts.length).toBeGreaterThan(1);
    expect(notificationResultInput(parts[0], parts.slice().reverse()).text).toBe(parts.map(part => part.text).join(""));
    for (const broken of [parts.slice(1), [...parts, parts[1]], [parts[0]],
      [parts[0], ...parts.slice(1).map(part => ({ ...part, createdAt: part.createdAt + 1, expiresAt: part.expiresAt + 1 }))]]) {
      expect(() => notificationResultInput(parts[0], broken)).toThrow("parts are missing");
    }
    expect(() => notificationResultInput(parts[1], parts)).toThrow("first part");
  });

  it("does not starve later sources after a bad multipart item and retries the bad item after cursor wrap", async () => {
    const store = new MemoryStore(), f = service();
    await terminal(store, 1); await terminal(store, 2); await terminal(store, 3);
    const original = store.getNotificationParts.bind(store);
    const readParts = vi.spyOn(store, "getNotificationParts").mockImplementation(async source => source.id === id(1) ? [] : original(source));
    const collector = new NotificationResultCollector(store, f.results, 2);
    expect(await collector.collect(["chat"], NOW)).toMatchObject({ scanned: 2, prepared: 1, failures: [{ id: id(1) }] });
    expect(await collector.collect(["chat"], NOW)).toMatchObject({ scanned: 1, prepared: 1 });
    expect(await collector.collect(["chat"], NOW)).toMatchObject({ scanned: 1, failures: [{ id: id(1) }] });
    readParts.mockImplementation(original);
    expect(await collector.collect(["chat"], NOW)).toMatchObject({ prepared: 1, failures: [] });
    expect(await f.repository.list(["chat"])).toHaveLength(3);
  });

  it("leaves persisted model failures to maintenance without retrying on every collector tick", async () => {
    const store = new MemoryStore(), f = service();
    await terminal(store, 1, "长成果".repeat(5_000));
    f.model.complete.mockRejectedValueOnce(new Error("temporarily unavailable"));
    const collector = new NotificationResultCollector(store, f.results);
    await collector.collect(["chat"], NOW);
    const first = (await f.repository.get(id(1)))!;
    expect(first.status).toBe("preparing");
    for (let tick = 0; tick < 10; tick++)
      expect(await collector.collect(["chat"], NOW)).toMatchObject({ scanned: 0, existing: 0 });
    expect(f.model.complete).toHaveBeenCalledTimes(1);
    expect((await f.repository.get(id(1)))?.status).toBe("preparing");
    await f.results.retryPreparation(id(1)); // maintenance owns the retry cadence
    expect(await f.repository.get(id(1))).toMatchObject({ status: "ready", artifact: { id: first.artifact.id } });
  });

  it("repairs a lost conversion marker after persistence without rerunning the failed summary", async () => {
    const store = new MemoryStore(), f = service();
    await terminal(store, 1, "长成果".repeat(5_000));
    f.model.complete.mockRejectedValue(new Error("temporarily unavailable"));
    vi.spyOn(store, "markNotificationPrepared").mockRejectedValueOnce(new Error("marker write failed"));
    const collector = new NotificationResultCollector(store, f.results);
    expect(await collector.collect(["chat"], NOW)).toMatchObject({ failures: [{ id: id(1) }] });
    expect(await collector.collect(["chat"], NOW)).toMatchObject({ existing: 1, prepared: 0, failures: [] });
    expect(f.model.complete).toHaveBeenCalledTimes(1);
    expect(await collector.collect(["chat"], NOW)).toMatchObject({ scanned: 0 });
  });

  it("exposes transient store failures and releases the tick lock for the next call", async () => {
    const store = new MemoryStore(), f = service();
    const query = vi.spyOn(store, "listNotificationCandidates").mockRejectedValueOnce(new Error("database unavailable"));
    const collector = new NotificationResultCollector(store, f.results);
    await expect(collector.collect(["chat"], NOW)).rejects.toThrow("database unavailable");
    expect(await collector.collect(["chat"], NOW)).toMatchObject({ scanned: 0 });
    expect(query).toHaveBeenCalledTimes(2);
  });
});

it("permanently excludes converted history so a new progress item is collected immediately after restart", async () => {
  const store = new MemoryStore(), f = service();
  for (let index = 1; index <= 80; index++) await terminal(store, index);
  const initialCollector = new NotificationResultCollector(store, f.results);
  while ((await initialCollector.collect(["chat"], NOW)).scanned) { /* exhaust the bounded conversion pages */ }
  expect(await store.listNotificationCandidates(["chat"], NOW)).toEqual([]);
  expect((await store.listPendingNotifications(["chat"], NOW))[0].status).toBe("pending");
  const initial = execution(999); await store.createExecutionIfAbsent(initial);
  const active = (await store.compareAndSetExecution({ ...initial, revision: 2,
    attempts: [{ token: id(900), startedAt: NOW, expiresAt: NOW + 15_000 }] }, 1, NOW))!;
  await store.createCommandIfAbsent({ ...command(active), status: "accepted", output: undefined });
  const progress = (await store.enqueueProgressNotification({ type: "plan", id: initial.id }, NOW + 30_000))!;
  const restarted = new NotificationResultCollector(store, f.results);
  expect(await restarted.collect(["chat"], NOW + 30_000)).toMatchObject({ scanned: 1, prepared: 1, failures: [] });
  expect(await f.repository.get(progress.id)).toMatchObject({ kind: "progress" });
  expect(await store.listNotificationCandidates(["chat"], NOW + 30_000)).toEqual([]);
});

describe("candidate store lifecycle", () => {
  it("pages first terminal parts by stable ID, filters chats and retains expired legacy TTL up to seven days", async () => {
    const store = new MemoryStore();
    await terminal(store, 3, "c"); await terminal(store, 1, "x".repeat(1_048_576));
    await terminal(store, 2, "b"); await terminal(store, 4, "private", "other");
    const page = await store.listNotificationCandidates(["chat"], NOW + NOTIFICATION_TTL_MS, "", 2);
    expect(page.map(item => item.id)).toEqual([id(1), id(2)]);
    expect(page[0].status).toBe("pending");
    page[0].text = "mutated";
    expect((await store.listNotificationCandidates(["chat"], NOW))[0].text).not.toBe("mutated");
    expect((await store.listNotificationCandidates(["chat"], NOW, id(2), 2)).map(item => item.id)).toEqual([id(3)]);
    expect(await store.listPendingNotifications(["chat"], NOW + NOTIFICATION_TTL_MS)).toEqual([]);
    expect(await store.listNotificationCandidates(["chat"], NOW + TERMINAL_RESULT_TTL_MS)).toEqual([]);
    expect(await store.listNotificationCandidates([], NOW)).toEqual([]);
    for (const [after, limit] of [["invalid", 8], ["", 0], ["", 65]] as const)
      await expect(store.listNotificationCandidates(["chat"], NOW, after, limit)).rejects.toThrow();
    await expect(store.getNotificationParts({ type: "plan", id: "invalid" })).rejects.toThrow();
  });

  it("never requeues accepted, claimed or uncertain legacy notifications", async () => {
    const store = new MemoryStore();
    for (let index = 1; index <= 3; index++) {
      await terminal(store, index);
      await store.claimNotification(id(index), id(100 + index), ["chat"], NOW);
      if (index < 3) await store.recordNotificationReceipt(id(index), id(100 + index), index === 1 ? "accepted" : "uncertain", NOW);
    }
    expect(await store.listNotificationCandidates(["chat"], NOW)).toEqual([]);
    expect(await store.getNotificationParts({ type: "plan", id: id(1) })).toMatchObject([{ status: "accepted" }]);
  });

  it("collects only latest active progress and removes stale or terminal progress", async () => {
    const store = new MemoryStore();
    const initial = execution(); await store.createExecutionIfAbsent(initial);
    const active = (await store.compareAndSetExecution({ ...initial, revision: 2,
      attempts: [{ token: id(99), startedAt: NOW, expiresAt: NOW + 15_000 }] }, 1, NOW))!;
    const receipt = { ...command(active), status: "accepted" as const, output: undefined };
    await store.createCommandIfAbsent(receipt);
    const first = (await store.enqueueProgressNotification({ type: "plan", id: initial.id }, NOW + 30_000))!;
    vi.useFakeTimers({ now: NOW + 90_000 });
    await store.updateCommandStatus(receipt.commandId, "completed", "真实结果", undefined, "exact-turn");
    const second = (await store.enqueueProgressNotification({ type: "plan", id: initial.id }, NOW + 90_000))!;
    expect(second.id).not.toBe(first.id);
    expect((await store.listNotificationCandidates(["chat"], NOW + 90_000)).map(item => item.id)).toEqual([second.id]);
    const input = notificationResultInput(normalizeNotification(second), []);
    expect(input).toMatchObject({ key: `notification:progress:${second.id}`, expiresAt: second.createdAt + PROGRESS_RESULT_TTL_MS });
    expect(await store.listNotificationCandidates(["chat"], second.createdAt + PROGRESS_RESULT_TTL_MS)).toEqual([]);
    await store.compareAndSetExecution({ ...active, revision: 3, status: "completed" }, 2, NOW + 100_000);
    const terminal = await store.listNotificationCandidates(["chat"], NOW + 100_000);
    expect(terminal).toHaveLength(1); expect(terminal[0].kind).toBe("completed");
  });
});
