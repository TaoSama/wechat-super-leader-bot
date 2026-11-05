import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { LeaderOrchestrator } from "../../../src/leader/orchestrator.js";
import { DirectCallSchema } from "../../../src/leader/direct-contracts.js";
import { MAX_ACTIVE_PLANS_PER_CHAT } from "../../../src/leader/contracts.js";
import { ExecutionScheduler } from "../../../src/leader/plans/scheduler.js";
import { listChatActivePlans } from "../../../src/leader/plans/active.js";
import { createExecution } from "../../../src/leader/plans/execution.js";
import { MemoryStore } from "../../../src/store/memory.js";
import type { CommandRecord, PostCommandRequest, ScopedSession, SendRoute } from "../../../src/types.js";

const CHAT_ID = "multi-plan-chat";
const SESSION_IDS = ["first", "second", "third", "fourth"];
const goal = { objective: "持续核查结果", criteria: ["取得最终结论"], targets: [{ nodeId: "air", sessionId: "first" }],
  constraints: "仅核查，不修改其他会话", maxActions: 3, maxDecisions: 5, durationMinutes: 30, shareResults: true };

function fixture() {
  const store = new MemoryStore();
  const now = Date.now();
  const sessions: ScopedSession[] = SESSION_IDS.map(id => ({ nodeId: "air", id, provider: "codex-app", title: `会话 ${id}`,
    status: "idle", loaded: true, capabilities: ["send", "read"], observedAt: new Date(now).toISOString() }));
  const hub = { getAllSessions: vi.fn(async () => sessions), getNodeStatusList: vi.fn(() => []), getAllSkills: () => [], getNodeSkills: () => [],
    isNodeConnected: () => true, getNodeSession: (node: string, id: string) => sessions.find(item => item.nodeId === node && item.id === id) ?? null,
    readHistory: vi.fn() };
  const commands = { submit: vi.fn(async (request: PostCommandRequest, _wait?: number, guard?: () => Promise<void>, route?: SendRoute) => {
    await guard?.();
    const record: CommandRecord = { ...request, commandId: randomUUID(), status: "accepted", turnId: randomUUID(), sendRoute: route,
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString() };
    return (await store.createCommandIfAbsent(record)).command;
  }) };
  const model = { complete: vi.fn(async () => { throw new Error("Synchronous model call forbidden"); }) };
  const executions = new ExecutionScheduler(store, commands, { now: () => now });
  const create = () => new LeaderOrchestrator(store, hub, commands, model, () => now, undefined, executions, undefined,
    undefined, undefined, { isAllowed: id => id === CHAT_ID });
  const call = (name: string, args: unknown = {}, intent = "query") => create().direct.call(DirectCallSchema.parse({
    chatId: CHAT_ID, messageId: `message-${randomUUID()}`, text: `调用 ${name}`, callId: randomUUID(), name, arguments: args,
    authorization: { intent } }));
  // Two ordered steps on distinct sessions; the second step unlocks only after the first completes.
  const plan = (first: string, second: string) => call("execute_plan", { actions: [
    { nodeId: "air", sessionId: first, prompt: `${first} 第一步` },
    { nodeId: "air", sessionId: second, prompt: `${second} 第二步`, dependsOn: [1] },
  ] }, "task");
  return { store, commands, executions, create, call, plan };
}

describe("multiple active plans in one chat", () => {
  it("advances concurrent plans independently and rejects the plan beyond the cap", async () => {
    const f = fixture();
    await f.plan("first", "second");
    await f.plan("third", "fourth");
    const active = await listChatActivePlans(f.store, CHAT_ID);
    expect(active).toHaveLength(2);
    expect(f.commands.submit.mock.calls.map(([request]) => request.sessionId).sort()).toEqual(["first", "third"]);
    for (const [request] of f.commands.submit.mock.calls) {
      const command = (await f.store.findCommandByRequestId(request.requestId!))!;
      await f.store.updateCommandStatus(command.commandId, "completed", "完成", undefined, command.turnId);
    }
    for (const execution of active) await f.executions.advance(execution.id);
    expect(f.commands.submit.mock.calls.map(([request]) => request.sessionId).sort()).toEqual(["first", "fourth", "second", "third"]);

    for (let index = active.length; index < MAX_ACTIVE_PLANS_PER_CHAT; index++) await f.plan("first", "second");
    expect(await listChatActivePlans(f.store, CHAT_ID)).toHaveLength(MAX_ACTIVE_PLANS_PER_CHAT);
    const submitted = f.commands.submit.mock.calls.length;
    const rejected = await f.plan("third", "fourth");
    expect(JSON.stringify(rejected)).toContain(`已有 ${MAX_ACTIVE_PLANS_PER_CHAT} 个进行中的计划，已达上限`);
    expect(f.commands.submit).toHaveBeenCalledTimes(submitted);
    expect(await listChatActivePlans(f.store, CHAT_ID)).toHaveLength(MAX_ACTIVE_PLANS_PER_CHAT);
  });

  it("reports the store cap in Chinese when a preview is confirmed after the slots fill", async () => {
    const f = fixture();
    for (let index = 1; index < MAX_ACTIVE_PLANS_PER_CHAT; index++) await f.plan("first", "second");
    await f.call("propose_plan", { actions: [{ nodeId: "air", sessionId: "third", prompt: "待确认任务" }] }, "preview");
    // Another confirmation path takes the last slot while this preview waits for the user.
    await f.store.createExecutionIfAbsent(createExecution(CHAT_ID, { id: randomUUID(), expiresAt: Date.now() + 60_000,
      actions: [{ nodeId: "air", sessionId: "fourth", prompt: "并发确认", sendRoute: "control-socket", dependsOn: [] }] }, Date.now()));
    const confirmed = await f.create().direct.call(DirectCallSchema.parse({ chatId: CHAT_ID, messageId: "confirm", text: "确认",
      callId: randomUUID(), name: "confirm_pending", arguments: {}, authorization: { intent: "task" } }));
    expect(confirmed.reply?.text).toContain("已达上限，没有新增派发");
    expect(await listChatActivePlans(f.store, CHAT_ID)).toHaveLength(MAX_ACTIVE_PLANS_PER_CHAT);
  });

  it("summarizes every active plan for progress and requires a plan ID to cancel among several", async () => {
    const f = fixture();
    await f.plan("first", "second");
    await f.plan("third", "fourth");
    const [newer, older] = await listChatActivePlans(f.store, CHAT_ID);
    const progress = (await f.call("get_plan_progress")).result as { activePlans: { id: string }[] };
    expect(progress.activePlans.map(plan => plan.id).sort()).toEqual([newer.id, older.id].sort());
    const single = (await f.call("get_plan_progress", { planId: older.id })).result as { id: string; steps: unknown[] };
    expect(single).toMatchObject({ id: older.id, steps: expect.any(Array) });

    const ambiguous = await f.call("cancel_plan", {}, "task");
    expect(ambiguous.reply?.text).toContain("当前有 2 个进行中的计划，没有停止任何计划");
    for (const plan of [newer, older]) expect(ambiguous.reply?.text).toContain(plan.id);
    expect(await listChatActivePlans(f.store, CHAT_ID)).toHaveLength(2);

    const missing = await f.call("cancel_plan", { planId: randomUUID() }, "task");
    expect(missing.reply?.text).toContain("没有该ID的进行中计划");
    const cancelled = await f.call("cancel_plan", { planId: older.id }, "task");
    expect(cancelled.reply?.text).toContain("已取消计划后续派发");
    expect((await f.store.getExecution(older.id))?.status).toBe("cancelled");
    expect((await listChatActivePlans(f.store, CHAT_ID)).map(plan => plan.id)).toEqual([newer.id]);
    const remaining = (await f.call("get_plan_progress")).result as { id: string };
    expect(remaining.id).toBe(newer.id);
  });

  it("asks which plan to cancel in rules mode and cancels the one named by its ID", async () => {
    const f = fixture();
    await f.plan("first", "second");
    await f.plan("third", "fourth");
    const [newer, older] = await listChatActivePlans(f.store, CHAT_ID);
    const asked = await f.create().handle(CHAT_ID, "rules-cancel", "取消计划");
    expect(asked.text).toContain("请回复“取消计划 <计划ID>”");
    expect(await listChatActivePlans(f.store, CHAT_ID)).toHaveLength(2);
    const named = await f.create().handle(CHAT_ID, "rules-cancel-id", `取消计划 ${newer.id.toUpperCase()}`);
    expect(named.text).toContain("以下已确认计划停止后续派发");
    expect((await listChatActivePlans(f.store, CHAT_ID)).map(plan => plan.id)).toEqual([older.id]);
    const last = await f.create().handle(CHAT_ID, "rules-cancel-last", "取消计划");
    expect(last.text).toContain("以下已确认计划停止后续派发");
    expect(await listChatActivePlans(f.store, CHAT_ID)).toEqual([]);
  });

  it("keeps plans and persistent goals mutually exclusive", async () => {
    const f = fixture();
    await f.plan("first", "second");
    await expect(f.call("execute_goal", goal, "goal")).resolves.toMatchObject({ result: expect.objectContaining({ error: expect.anything() }) });
    expect(await f.store.getLatestGoal(CHAT_ID)).toBeNull();
    await f.call("cancel_plan", {}, "task");
    expect((await f.call("execute_goal", goal, "goal")).reply?.text).toContain("目标已确认");
    const blocked = await f.plan("third", "fourth");
    expect(JSON.stringify(blocked)).toContain("goal already exists");
    expect(await listChatActivePlans(f.store, CHAT_ID)).toEqual([]);
  });
});
