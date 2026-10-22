import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../src/store/memory.js";
import { createExecution, executionRequestId } from "../../src/leader/plans/execution.js";
import { createGoal } from "../../src/leader/goals/goal.js";
import { authorize, proposal } from "../fixtures/goals.js";
import { ModelProgressRunner } from "../../src/notifications/model-progress.js";
import type { LeaderModel, ModelMessage, ModelReply } from "../../src/leader/model/contracts.js";

const NOW = 1_700_000_000_000;
const FIRST = NOW + 30_000;
const text = "第一部分已经完成；另一部分已接收，仍在执行。";
const report = (content = text): ModelReply => ({ content: null, toolCalls: [{ id: randomUUID(), type: "function",
  function: { name: "report_progress", arguments: JSON.stringify({ text: content }) } }] });
const final: ModelReply = { content: "", toolCalls: [] };
async function setup(accepted = true) {
  const store = new MemoryStore();
  const initial = createExecution("chat", { id: randomUUID(), expiresAt: NOW + 60_000, actions: [
    { nodeId: "node", sessionId: "session", prompt: "处理真实任务", dependsOn: [], sendRoute: "control-socket" },
  ] }, NOW);
  await store.createExecutionIfAbsent(initial);
  const record = accepted ? (await store.compareAndSetExecution({ ...initial, revision: 2,
    attempts: [{ token: randomUUID(), startedAt: NOW, expiresAt: NOW + 15_000 }] }, 1, NOW))! : initial;
  if (accepted) await store.createCommandIfAbsent({ commandId: randomUUID(), requestId: executionRequestId(record, 0),
    nodeId: "node", sessionId: "session", prompt: "处理真实任务", action: "send", sendRoute: "control-socket",
    status: "accepted", turnId: "exact-turn", createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 60_000).toISOString() });
  return { store, record, source: { type: "plan" as const, id: record.id } };
}

describe("model-authored progress", () => {
  it("invokes the real model tool loop, preserves generated text and returns remaining slots to the model", async () => {
    const f = await setup();
    const calls: ModelMessage[][] = [];
    const complete = vi.fn<LeaderModel["complete"]>().mockImplementation(async messages => {
      calls.push(structuredClone(messages)); return calls.length === 1 ? report() : final;
    });
    const changed = vi.fn(), runner = new ModelProgressRunner(f.store, { complete }, () => FIRST, changed);
    await runner.request(f.source);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0][1][0].function.name).toBe("report_progress");
    expect(JSON.parse(calls[1].find(item => item.role === "tool")!.content!)).toEqual({ status: "queued", remaining: 2, limit: 3 });
    expect(await f.store.listPendingNotifications(["chat"], FIRST)).toMatchObject([{ text, kind: "progress" }]);
    expect(changed).toHaveBeenCalledOnce();
    await runner.request(f.source);
    expect(complete).toHaveBeenCalledTimes(2);
    await runner.stop();
  });
  it("offers persisted waiting evidence and does not repeatedly wake the model when it chooses silence", async () => {
    const f = await setup(false), complete = vi.fn<LeaderModel["complete"]>().mockResolvedValue(final);
    let now = FIRST - 1;
    const runner = new ModelProgressRunner(f.store, { complete }, () => now);
    await runner.request(f.source, NOW); expect(complete).not.toHaveBeenCalled();
    now++;
    await runner.request(f.source);
    const input = JSON.parse(complete.mock.calls[0][0][1].content!);
    expect(input.evidence).toMatchObject([{ status: "waiting", prompt: "处理真实任务" }]);
    now += 120_000;
    await runner.request(f.source);
    expect(complete).toHaveBeenCalledOnce();
    expect(await f.store.listPendingNotifications(["chat"], now)).toEqual([]);
    await runner.stop();
  });
  it("rejects a generated draft if the plan terminates while the model is thinking", async () => {
    const f = await setup();
    const complete = vi.fn<LeaderModel["complete"]>().mockImplementationOnce(async () => {
      await f.store.compareAndSetExecution({ ...f.record, revision: f.record.revision + 1, status: "completed" }, f.record.revision, FIRST);
      return report();
    }).mockResolvedValue(final);
    const runner = new ModelProgressRunner(f.store, { complete }, () => FIRST);
    await runner.request(f.source);
    const tool = complete.mock.calls[1][0].find(item => item.role === "tool")!;
    expect(JSON.parse(tool.content!).status).toBe("stale_or_budget_unavailable");
    expect((await f.store.listPendingNotifications(["chat"], FIRST)).every(item => item.kind !== "progress")).toBe(true);
    await runner.stop();
  });
  it("keeps plans running and inserts no fallback template when model generation fails", async () => {
    const f = await setup(), error = vi.fn();
    const runner = new ModelProgressRunner(f.store, { complete: vi.fn().mockRejectedValue(new Error("provider unavailable")) }, () => FIRST, vi.fn(), error);
    await expect(runner.request(f.source)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledOnce();
    expect((await f.store.getExecution(f.record.id))!.status).toBe("active");
    expect(await f.store.listPendingNotifications(["chat"], FIRST)).toEqual([]);
    await runner.stop();
  });
  it("revalidates the exact evidence hash so changed command facts cannot publish a stale draft", async () => {
    const f = await setup(), context = (await f.store.getProgressNotificationContext(f.source, FIRST))!;
    const command = (await f.store.findCommandByRequestId(executionRequestId(f.record, 0)))!;
    vi.useFakeTimers({ now: FIRST });
    try {
      await f.store.updateCommandStatus(command.commandId, "completed", "真实结果", undefined, "exact-turn");
      expect(await f.store.enqueueProgressNotification(f.source, FIRST, { eventKey: context.eventKey, text })).toBeNull();
    } finally { vi.useRealTimers(); }
  });
});


it("independently checks long-running sources at thirty seconds without a scheduler callback", async () => {
  const f = await setup(false);
  vi.useFakeTimers({ now: NOW });
  const complete = vi.fn<LeaderModel["complete"]>().mockResolvedValue(final);
  const runner = new ModelProgressRunner(f.store, { complete });
  try {
    runner.start();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(complete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(complete).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(complete).toHaveBeenCalledOnce();
  } finally { await runner.stop(); vi.useRealTimers(); }
});


it("reports a goal waiting for its first decision through the same model tool and atomic outbox", async () => {
  const store = new MemoryStore(), goal = createGoal("chat", proposal(NOW), NOW);
  await store.confirmGoal(goal, await authorize(store, goal), () => NOW);
  const complete = vi.fn<LeaderModel["complete"]>().mockResolvedValueOnce(report("目标已经保存，当前正在确定首个行动。" )).mockResolvedValue(final);
  const runner = new ModelProgressRunner(store, { complete }, () => FIRST);
  await runner.request({ type: "goal", id: goal.id });
  expect(await store.listPendingNotifications(["chat"], FIRST)).toMatchObject([{
    source: { type: "goal", id: goal.id }, kind: "progress", text: "目标已经保存，当前正在确定首个行动。",
  }]);
  expect(JSON.parse(complete.mock.calls[1][0].find(message => message.role === "tool")!.content!)).toMatchObject({ remaining: 2 });
  await runner.stop();
});


it("coalesces checks, skips the cooldown and permanently stops source reads after three submissions", async () => {
  const f = await setup(false);
  let now = FIRST;
  vi.useFakeTimers({ now });
  const complete = vi.fn<LeaderModel["complete"]>().mockImplementation(async messages =>
    messages.some(message => message.role === "tool") ? final : report());
  const contexts = vi.spyOn(f.store, "getProgressNotificationContext");
  const runner = new ModelProgressRunner(f.store, { complete }, () => now);
  try {
    await Promise.all([runner.request(f.source), runner.request(f.source)]);
    expect(contexts).toHaveBeenCalledOnce();
    now += 59_999;
    await runner.request(f.source);
    expect(contexts).toHaveBeenCalledOnce();
    now++;
    const active = (await f.store.compareAndSetExecution({ ...f.record, revision: 2,
      attempts: [{ token: randomUUID(), startedAt: now, expiresAt: now + 15_000 }] }, 1, now))!;
    const receipt = { commandId: randomUUID(), requestId: executionRequestId(active, 0), nodeId: "node", sessionId: "session",
      prompt: "处理真实任务", action: "send" as const, sendRoute: "control-socket" as const, status: "pending" as const,
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), expiresAt: new Date(now + 600_000).toISOString() };
    await f.store.createCommandIfAbsent(receipt);
    await runner.request(f.source);
    expect(contexts).toHaveBeenCalledTimes(2);
    now += 60_000;
    vi.setSystemTime(now);
    await f.store.updateCommandStatus(receipt.commandId, "accepted", undefined, undefined, "exact-turn");
    await runner.request(f.source);
    expect(contexts).toHaveBeenCalledTimes(3);
    now += 3_600_000;
    await runner.request(f.source);
    expect(contexts).toHaveBeenCalledTimes(3);
    expect(complete).toHaveBeenCalledTimes(6);
  } finally { await runner.stop(); vi.useRealTimers(); }
});

it("detects changed evidence within the next two-second check when the model previously chose silence", async () => {
  const f = await setup(false);
  let now = FIRST;
  const complete = vi.fn<LeaderModel["complete"]>().mockResolvedValue(final);
  const runner = new ModelProgressRunner(f.store, { complete }, () => now);
  await runner.request(f.source);
  await f.store.compareAndSetExecution({ ...f.record, revision: 2,
    attempts: [{ token: randomUUID(), startedAt: now, expiresAt: now + 15_000 }] }, 1, now);
  const stamp = new Date(now).toISOString();
  await f.store.createCommandIfAbsent({ commandId: randomUUID(), requestId: executionRequestId(f.record, 0), nodeId: "node",
    sessionId: "session", prompt: "处理真实任务", action: "send", sendRoute: "control-socket", status: "accepted",
    turnId: "changed-turn", createdAt: stamp, updatedAt: stamp, expiresAt: new Date(now + 60_000).toISOString() });
  now += 1999;
  await runner.request(f.source); expect(complete).toHaveBeenCalledOnce();
  now++;
  await runner.request(f.source); expect(complete).toHaveBeenCalledTimes(2);
  await runner.stop();
});
