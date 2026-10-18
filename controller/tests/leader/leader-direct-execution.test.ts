import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CLAIM_TTL_MS, type GoalRequest } from "../../src/leader/contracts.js";
import { GoalScheduler } from "../../src/leader/goals/scheduler.js";
import type { GoalDecision } from "../../src/leader/goals/goal.js";
import { LeaderOrchestrator } from "../../src/leader/orchestrator.js";
import { ExecutionScheduler } from "../../src/leader/plans/scheduler.js";
import type { LeaderModel, ModelMessage, ModelReply } from "../../src/leader/model/contracts.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { CommandRecord, PostCommandRequest, ScopedSession, SendRoute } from "../../src/types.js";

const CHAT_ID = "direct-chat";
const TERMINAL_SESSION_ID = `terminal:${"a".repeat(43)}`;
const tool = (name: string, args: unknown): ModelReply => ({ content: null,
  toolCalls: [{ id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const final = (content = "已核查，没有新增派发"): ModelReply => ({ content, toolCalls: [] });
const actions = [{ nodeId: "air", sessionId: "original", prompt: "只读检查测试结果" }];
const goalRequest = (): GoalRequest => ({ objective: "依据结果持续完成核查", criteria: ["取得有证据的最终核查结果"],
  targets: [{ nodeId: "air", sessionId: "original" }], constraints: "只读核查，不改文件或外发",
  maxActions: 3, maxDecisions: 5, durationMinutes: 30, shareResults: true });

class ScriptedModel implements LeaderModel {
  calls: ModelMessage[][] = [];
  constructor(private replies: ModelReply[]) {}
  async complete(messages: ModelMessage[]) {
    this.calls.push(structuredClone(messages));
    const reply = this.replies.shift();
    if (!reply) throw new Error("Missing direct execution fixture response");
    return reply;
  }
}

function fixture(replies: ModelReply[] = []) {
  const store = new MemoryStore();
  let clock = Date.now();
  const sessions: ScopedSession[] = [{ nodeId: "air", id: "original", provider: "codex-app", title: "既有会话",
    cwd: "/fixture", status: "idle", loaded: true, capabilities: ["send", "read"], observedAt: new Date(clock).toISOString() }];
  const skills = [{ id: "a".repeat(64), digest: "b".repeat(64), name: "核查技能", path: "/fixture/SKILL.md", description: "只读" }];
  const hub = { getAllSessions: async () => sessions, getNodeStatusList: () => [], getAllSkills: () => [],
    getNodeSkills: () => skills, isNodeConnected: (nodeId: string) => nodeId === "air",
    getNodeSession: (nodeId: string, id: string) => sessions.find(item => item.nodeId === nodeId && item.id === id) ?? null,
    readHistory: vi.fn() };
  const dispatched = vi.fn();
  const commands = { submit: vi.fn(async (request: PostCommandRequest, _wait?: number, guard?: () => Promise<void>, route?: SendRoute) => {
    await guard?.();
    dispatched();
    const timestamp = new Date(clock).toISOString();
    const terminal = route === "terminal-pane";
    const record: CommandRecord = { ...request, commandId: randomUUID(), status: terminal ? "input-written" : "accepted",
      ...(terminal ? { inputReceipt: { kind: "terminal-input-written" as const, sessionId: request.sessionId,
        requestId: randomUUID(), promptSHA256: "a".repeat(64), responseRevision: 0, observedRevision: 1 } } : { turnId: randomUUID() }),
      sendRoute: route, createdAt: timestamp, updatedAt: timestamp, expiresAt: new Date(clock + 60000).toISOString() };
    return (await store.createCommandIfAbsent(record)).command;
  }) };
  const decide = vi.fn(async (): Promise<GoalDecision> => ({ type: "blocked", reason: "需要补充证据" }));
  const executions = new ExecutionScheduler(store, commands, { now: () => clock });
  const goals = new GoalScheduler(store, commands, decide, { now: () => clock });
  const model = new ScriptedModel(replies);
  const create = (nextModel: LeaderModel = model) => new LeaderOrchestrator(store, hub, commands, nextModel, () => clock, undefined, executions, goals);
  return { store, sessions, skills, hub, commands, dispatched, decide, executions, goals, model, create,
    now: () => clock, tick: (ms: number) => { clock += ms; },
    refresh: () => { for (const session of sessions) session.observedAt = new Date(clock).toISOString(); } };
}

function deferredModel() {
  let release!: (reply: ModelReply) => void;
  const model: LeaderModel = { complete: vi.fn()
    .mockImplementationOnce(() => new Promise<ModelReply>(resolve => { release = resolve; }))
    .mockResolvedValue(final()) };
  return { model, reply: (value: ModelReply) => release(value), ready: () => vi.waitFor(() => expect(release).toBeDefined()) };
}

describe("Leader direct execution", () => {
  it("freezes and dispatches an explicit plan in the same request, then deduplicates receipts across restart", async () => {
    const f = fixture([tool("execute_plan", { actions })]);
    const confirmed = vi.spyOn(f.store, "confirmExecution");
    const leader = f.create();
    const text = "让 Air 的既有会话只读检查测试结果，直接执行";
    const reply = await leader.handle(CHAT_ID, "execute", text);
    expect(f.dispatched).toHaveBeenCalledTimes(1);
    expect(confirmed).toHaveBeenCalledTimes(1);
    const execution = (await f.store.getLatestExecution(CHAT_ID))!;
    expect(execution).toMatchObject({ status: "active", plan: { actions: [{ ...actions[0], sendRoute: "control-socket", dependsOn: [] }] } });
    expect(f.commands.submit.mock.calls[0][3]).toBe("control-socket");
    expect(reply.text).toContain("已接收");
    expect(reply.text).toContain("不代表工作完成");
    expect(reply.text).not.toMatch(/回复[“「]?确认|尚未派发|待确认/);
    expect((await f.store.getLeaderState(CHAT_ID))?.data.pending).toBeUndefined();
    expect(await leader.handle(CHAT_ID, "execute", text)).toEqual(reply);
    expect(await f.create().handle(CHAT_ID, "execute", text)).toEqual(reply);
    expect(f.model.calls).toHaveLength(1);
    expect(confirmed).toHaveBeenCalledTimes(1);
    expect(f.dispatched).toHaveBeenCalledTimes(1);
    expect(await f.store.listRecentExecutions([CHAT_ID], 10)).toHaveLength(1);
    await expect(f.create().handle(CHAT_ID, "execute", "替换原指令")).rejects.toThrow("different text");
  });

  it("shares a concurrent replay of one direct request without a second model call or dispatch", async () => {
    const f = fixture(), deferred = deferredModel(), leader = f.create(deferred.model);
    const text = "直接让既有会话检查测试结果";
    const first = leader.handle(CHAT_ID, "same-message", text);
    const replay = leader.handle(CHAT_ID, "same-message", text);
    await deferred.ready();
    deferred.reply(tool("execute_plan", { actions }));
    expect(await first).toEqual(await replay);
    expect(deferred.model.complete).toHaveBeenCalledTimes(1);
    expect(f.dispatched).toHaveBeenCalledTimes(1);
  });

  it.each(["propose_plan", "propose_goal"])("keeps %s as a preview with no authorization or dispatch", async name => {
    const f = fixture([tool(name, name === "propose_plan" ? { actions } : goalRequest())]);
    const confirmPlan = vi.spyOn(f.store, "confirmExecution"), confirmGoal = vi.spyOn(f.store, "confirmGoal");
    const reply = await f.create().handle(CHAT_ID, "preview", "先给我看方案，不要执行");
    expect(reply.text).toContain("尚未派发");
    const state = (await f.store.getLeaderState(CHAT_ID))!.data;
    expect(name === "propose_plan" ? state.pending : state.pendingGoal).toBeDefined();
    expect(confirmPlan).not.toHaveBeenCalled();
    expect(confirmGoal).not.toHaveBeenCalled();
    expect(f.dispatched).not.toHaveBeenCalled();
    expect(await f.store.getLatestExecution(CHAT_ID)).toBeNull();
    expect(await f.store.getLatestGoal(CHAT_ID)).toBeNull();
  });

  it("leaves status queries read-only even when both execution tools are available", async () => {
    const f = fixture([tool("list_sessions", {}), tool("get_plan_progress", {}), tool("get_goal_progress", {}), final("当前没有活动任务")]);
    expect((await f.create().handle(CHAT_ID, "query", "看看现在的任务状态")).text).toBe("当前没有活动任务");
    expect(f.model.calls).toHaveLength(4);
    expect(f.dispatched).not.toHaveBeenCalled();
    expect(await f.store.getLatestExecution(CHAT_ID)).toBeNull();
    expect(await f.store.getLatestGoal(CHAT_ID)).toBeNull();
  });

  it.each(["execute_plan", "execute_goal"])("rejects %s returned after its original claim expires", async name => {
    const f = fixture(), deferred = deferredModel();
    const outcome = f.create(deferred.model).handle(CHAT_ID, "expired", "在明确范围和预算内直接执行")
      .then(reply => ({ reply }), error => ({ error }));
    await deferred.ready();
    f.tick(CLAIM_TTL_MS + 1);
    f.refresh();
    deferred.reply(tool(name, name === "execute_plan" ? { actions } : goalRequest()));
    await outcome;
    expect(f.dispatched).not.toHaveBeenCalled();
    expect(await f.store.getLatestExecution(CHAT_ID)).toBeNull();
    expect(await f.store.getLatestGoal(CHAT_ID)).toBeNull();
  });

  it.each(["execute_plan", "execute_goal"])("cannot revive %s after another instance cancels while the model is delayed", async name => {
    const f = fixture(), deferred = deferredModel();
    const outcome = f.create(deferred.model).handle(CHAT_ID, "delayed", "在明确范围和预算内直接执行")
      .then(reply => ({ reply }), error => ({ error }));
    await deferred.ready();
    f.tick(CLAIM_TTL_MS + 1);
    f.refresh();
    await f.create().handle(CHAT_ID, "cancel", name === "execute_plan" ? "取消计划" : "取消目标");
    deferred.reply(tool(name, name === "execute_plan" ? { actions } : goalRequest()));
    await outcome;
    expect(f.dispatched).not.toHaveBeenCalled();
    expect(await f.store.getLatestExecution(CHAT_ID)).toBeNull();
    expect(await f.store.getLatestGoal(CHAT_ID)).toBeNull();
    expect((await f.store.getLeaderState(CHAT_ID))?.data.receipts).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: "cancel" }),
    ]));
  });

  it.each(["execute_plan", "execute_goal"])("cannot use a stale revision for %s after ownership changes during the model call", async name => {
    const f = fixture(), deferred = deferredModel();
    const outcome = f.create(deferred.model).handle(CHAT_ID, "old-owner", "在明确范围和预算内直接执行")
      .then(reply => ({ reply }), error => ({ error }));
    await deferred.ready();
    const current = (await f.store.getLeaderState(CHAT_ID))!;
    expect(await f.store.compareAndSetLeaderState(CHAT_ID, current.revision, { ...current.data, inflight: undefined })).not.toBeNull();
    deferred.reply(tool(name, name === "execute_plan" ? { actions } : goalRequest()));
    await outcome;
    expect(f.dispatched).not.toHaveBeenCalled();
    expect(await f.store.getLatestExecution(CHAT_ID)).toBeNull();
    expect(await f.store.getLatestGoal(CHAT_ID)).toBeNull();
  });

  it.each(["route", "skill"])("revalidates the frozen direct plan's %s before confirmation", async change => {
    const f = fixture(), skill = { id: f.skills[0].id, digest: f.skills[0].digest };
    const model = new ScriptedModel([tool("execute_plan", { actions: [{ ...actions[0], skills: [skill] }] }), final()]);
    const save = f.store.compareAndSetLeaderState.bind(f.store);
    let changed = false;
    vi.spyOn(f.store, "compareAndSetLeaderState").mockImplementation(async (...args) => {
      const result = await save(...args);
      if (result && args[2].inflight?.plan && !changed) {
        changed = true;
        if (change === "route") f.sessions[0].status = "active";
        else f.skills[0].digest = "c".repeat(64);
      }
      return result;
    });
    await f.create(model).handle(CHAT_ID, "changed", "直接使用指定技能检查结果");
    expect(changed).toBe(true);
    expect(f.dispatched).not.toHaveBeenCalled();
    expect(await f.store.getLatestExecution(CHAT_ID)).toBeNull();
  });

  it("retains the real store's atomic authority check when direct plan confirmation is delayed past cancellation", async () => {
    const f = fixture([tool("execute_plan", { actions })]);
    const confirm = f.store.confirmExecution.bind(f.store);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const delayed = vi.spyOn(f.store, "confirmExecution").mockImplementationOnce(async (...args) => {
      await barrier;
      return confirm(...args);
    });
    const outcome = f.create().handle(CHAT_ID, "execute", "直接检查测试结果")
      .then(reply => ({ reply }), error => ({ error }));
    await vi.waitFor(() => expect(delayed).toHaveBeenCalledTimes(1));
    f.tick(CLAIM_TTL_MS + 1);
    f.refresh();
    await f.create().handle(CHAT_ID, "cancel", "取消计划");
    release();
    await outcome;
    expect(f.dispatched).not.toHaveBeenCalled();
    expect(await f.store.listActiveExecutions()).toEqual([]);
  });

  it("persists a direct goal as active once and leaves decisions and sends to the background scheduler", async () => {
    const request = goalRequest(), f = fixture([tool("execute_goal", request)]);
    const confirm = vi.spyOn(f.store, "confirmGoal");
    const text = "在 Air 既有会话只读核查，最多3次任务、5轮决策、30分钟，持续到最终核查有证据，直接开始";
    const reply = await f.create().handle(CHAT_ID, "goal", text);
    const goal = (await f.store.getLatestGoal(CHAT_ID))!;
    expect(goal).toMatchObject({ status: "active", actions: [], decisionAttempts: 0,
      proposal: { ...request, targets: [{ ...request.targets[0], sendRoute: "control-socket" }] } });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(reply.text).toContain("后台将按授权预算持续推进");
    expect(reply.text).not.toMatch(/回复[“「]?确认|尚未派发|待确认/);
    expect(f.decide).not.toHaveBeenCalled();
    expect(f.dispatched).not.toHaveBeenCalled();
    expect((await f.store.getLeaderState(CHAT_ID))?.data.pendingGoal).toBeUndefined();
    expect(await f.create().handle(CHAT_ID, "goal", text)).toEqual(reply);
    expect(await f.store.listRecentGoals([CHAT_ID], 10)).toHaveLength(1);
    expect(f.model.calls).toHaveLength(1);
    expect(confirm).toHaveBeenCalledTimes(1);
    f.decide.mockResolvedValueOnce({ type: "next", target: 1, prompt: "核查最终结果", sourceActions: [], reason: "先收集核查证据" });
    await f.goals.advance(goal.id);
    expect(f.decide).toHaveBeenCalledTimes(1);
    expect(f.dispatched).not.toHaveBeenCalled();
    await f.goals.advance(goal.id);
    expect(f.dispatched).toHaveBeenCalledTimes(1);
    expect(await f.store.listRecentGoals([CHAT_ID], 10)).toHaveLength(1);
  });

  it("retains the real goal confirmation guard when authorization expires inside persistence", async () => {
    const f = fixture([tool("execute_goal", goalRequest())]);
    const confirm = f.store.confirmGoal.bind(f.store);
    const delayed = vi.spyOn(f.store, "confirmGoal").mockImplementationOnce(async (...args) => {
      f.tick(CLAIM_TTL_MS + 1);
      return confirm(...args);
    });
    await f.create().handle(CHAT_ID, "goal-expired", "在上述范围和预算内持续核查，直接开始");
    expect(delayed).toHaveBeenCalledTimes(1);
    expect(await f.store.getLatestGoal(CHAT_ID)).toBeNull();
    expect(f.decide).not.toHaveBeenCalled();
    expect(f.dispatched).not.toHaveBeenCalled();
  });

  it("reports direct terminal input as written without inventing an execution or completion, including replay", async () => {
    const f = fixture([tool("execute_plan", { actions: [{ nodeId: "air", sessionId: TERMINAL_SESSION_ID, prompt: "synthetic input" }] })]);
    const timestamp = new Date(f.now()).toISOString();
    f.sessions.push({ nodeId: "air", id: TERMINAL_SESSION_ID, provider: "terminal/codex", title: "既有终端", cwd: "/fixture",
      status: "idle", loaded: false, capabilities: ["read"], observedAt: timestamp,
      sendAvailability: { route: "terminal-pane", mode: "non-atomic", state: "ready", observedAt: timestamp, validUntil: new Date(f.now() + 45000).toISOString() } });
    const text = "直接向既有终端输入 synthetic input";
    const reply = await f.create().handle(CHAT_ID, "terminal", text);
    expect(reply.text).toContain("输入已写入，执行未确认");
    expect(reply.text).not.toContain("任务完成");
    expect(f.dispatched).toHaveBeenCalledTimes(1);
    expect(f.commands.submit.mock.calls[0][3]).toBe("terminal-pane");
    expect(await f.store.getLatestExecution(CHAT_ID)).toBeNull();
    expect((await f.store.listRecentCommands())[0].status).toBe("input-written");
    expect(await f.create().handle(CHAT_ID, "terminal", text)).toEqual(reply);
    expect(f.dispatched).toHaveBeenCalledTimes(1);
  });
});
