import { acknowledgementFixture } from "../acknowledgement-fixture.js";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { LeaderOrchestrator } from "../../../src/leader/orchestrator.js";
import { MemoryStore } from "../../../src/store/memory.js";
import { CLAIM_TTL_MS } from "../../../src/leader/contracts.js";
import { createExecution, normalizeExecution, type ExecutionRecord } from "../../../src/leader/plans/execution.js";
import { readExecutionView } from "../../../src/leader/plans/view.js";
import { ExecutionScheduler } from "../../../src/leader/plans/scheduler.js";
import { terminalPlanRequestId } from "../../../src/leader/plans/terminal.js";
import { NaturalLanguageResolver } from "../../../src/leader/queries/resolver.js";
import type { LeaderModel, ModelReply } from "../../../src/leader/model/contracts.js";
import type { PostCommandRequest, ScopedSession, SendRoute } from "../../../src/types.js";

const sessionId = `terminal:${"a".repeat(43)}`;
const tool = (actions: unknown[]): ModelReply => ({ content: null,
  toolCalls: [{ id: "plan", type: "function", function: { name: "propose_plan", arguments: JSON.stringify({ actions }) } }] });
function fixture(actions: unknown[] = [{ nodeId: "node", sessionId, prompt: "synthetic input" }]) {
  const store = new MemoryStore();
  let clock = Date.now();
  const session: ScopedSession = { nodeId: "node", id: sessionId, provider: "terminal/codex", cwd: "", title: "synthetic terminal",
    status: "idle", capabilities: ["read"], observedAt: new Date(clock).toISOString(), loaded: false,
    sendAvailability: { route: "terminal-pane", mode: "non-atomic", state: "ready", observedAt: new Date(clock).toISOString(), validUntil: new Date(clock + 45000).toISOString() } };
  const hub = { getAllSkills: () => [], getNodeSkills: () => [], getAllSessions: async () => [session], getNodeStatusList: () => [],
    getNodeSession: (node: string, id: string) => node === "node" && id === sessionId ? session : null, isNodeConnected: () => true };
  const replies = [tool(actions), { content: "没有待确认计划；终端多步不能派发", toolCalls: [] } satisfies ModelReply,
    { content: "没有待确认计划", toolCalls: [] } satisfies ModelReply];
  const model: LeaderModel = { complete: vi.fn(async messages => { const acknowledgement = acknowledgementFixture(messages); if (acknowledgement) return acknowledgement; const next = replies.shift(); if (!next) throw new Error("No synthetic reply"); return next; }) };
  const dispatched = vi.fn();
  const commands = { submit: vi.fn(async (request: PostCommandRequest, _wait?: number, guard?: () => Promise<void>, sendRoute?: SendRoute) => {
    await guard?.();
    dispatched();
    const timestamp = new Date(clock).toISOString();
    const created = await store.createCommandIfAbsent({ ...request, commandId: "cmd", status: "input-written", sendRoute, output: "",
      inputReceipt: { kind: "terminal-input-written", sessionId, requestId: randomUUID(), promptSHA256: "a".repeat(64), responseRevision: 0, observedRevision: 1 },
      createdAt: timestamp, updatedAt: timestamp, expiresAt: new Date(clock + 60000).toISOString() });
    return created.command;
  }) };
  const create = () => new LeaderOrchestrator(store, hub, commands, model, () => clock);
  return { store, session, model, commands, dispatched, create, tick: (ms: number) => { clock += ms; }, now: () => clock };
}

describe("confirmed terminal input is a single durable command, not an execution", () => {
  it("previews non-atomic hazards, confirms one fixed-route command, returns input-written wording, deduplicates across restart", async () => {
    const f = fixture();
    const preview = await f.create().handle("chat", "plan", "安排输入");
    for (const text of ["非原子", "CLI 退出", "同类进程替换", "人工输入", "执行", "不创建后台执行计划"]) expect(preview.text).toContain(text);
    expect(f.commands.submit).not.toHaveBeenCalled();
    const planId = (await f.store.getLeaderState("chat"))!.data.pending.id;
    const reply = await f.create().handle("chat", "confirm", "确认执行");
    expect(reply.text).toContain("输入已写入，执行未确认");
    expect(reply.text).not.toContain("任务完成");
    expect(reply.text).not.toContain("指令：cmd");
    expect(f.commands.submit).toHaveBeenCalledTimes(1);
    expect(f.commands.submit.mock.calls[0][0].requestId).toBe(terminalPlanRequestId("chat", planId));
    expect(f.commands.submit.mock.calls[0][3]).toBe("terminal-pane");
    expect(await f.store.getLatestExecution("chat")).toBeNull();
    expect(await f.create().handle("chat", "confirm", "确认执行")).toEqual(reply);
    expect((await f.create().handle("chat", "again", "确认执行")).text).toContain("没有待确认计划");
    expect(f.dispatched).toHaveBeenCalledTimes(1);
  });

  it.each([[], [1]])("rejects every terminal multi-step proposal, even with dependsOn %j, without pending or dispatch", async dependencies => {
    const f = fixture([{ nodeId: "node", sessionId, prompt: "first" },
      { nodeId: "node", sessionId, prompt: "second", dependsOn: dependencies }]);
    await f.create().handle("chat", "plan", "两步输入");
    expect((await f.store.getLeaderState("chat"))!.data.pending).toBeUndefined();
    expect((await f.create().handle("chat", "confirm", "确认执行")).text).toContain("没有待确认计划");
    expect(f.dispatched).not.toHaveBeenCalled();
  });

  it("revalidates leader ownership immediately before a terminal side effect and cannot dispatch a delayed cancelled confirmation", async () => {
    const f = fixture();
    await f.create().handle("chat", "plan", "安排输入");
    const submit = f.commands.submit.getMockImplementation()!;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    f.commands.submit.mockImplementationOnce(async (...args) => { await barrier; return submit(...args); });
    const pending = f.create().handle("chat", "confirm", "确认执行").then(reply => ({ reply }), error => ({ error }));
    await vi.waitFor(() => expect(f.commands.submit).toHaveBeenCalledTimes(1));
    f.tick(CLAIM_TTL_MS + 1);
    await f.create().handle("chat", "cancel", "取消计划");
    release();
    expect(await pending).toHaveProperty("error.httpStatus", 409);
    expect(f.dispatched).not.toHaveBeenCalled();
    expect(await f.store.listRecentCommands()).toEqual([]);
  });

  it("recovers an interrupted terminal confirmation conservatively without recreating or sending it", async () => {
    const f = fixture();
    const text = "确认执行";
    await f.store.compareAndSetLeaderState("chat", 0, { inflight: { messageId: "old", inputHash: createHash("sha256").update(JSON.stringify(text)).digest("hex"), expiresAt: 1,
      plan: { id: randomUUID(), expiresAt: 2, actions: [{ nodeId: "node", sessionId, prompt: "synthetic", dependsOn: [], sendRoute: "terminal-pane" }] } } });
    expect((await f.create().handle("chat", "old", text)).text).toContain("未自动重试");
    expect(f.dispatched).not.toHaveBeenCalled();
    expect(await f.store.getLatestExecution("chat")).toBeNull();
  });

  it("clears old pending before rejecting a multi-step proposal with a disabled terminal target", async () => {
    const f = fixture([{ nodeId: "node", sessionId, prompt: "first" },
      { nodeId: "node", sessionId, prompt: "second", dependsOn: [1] }]);
    await f.store.compareAndSetLeaderState("chat", 0, { pending: { id: randomUUID(), expiresAt: f.now() + 60000,
      actions: [{ nodeId: "node", sessionId, prompt: "old", dependsOn: [], sendRoute: "terminal-pane" }] } });
    f.session.sendAvailability = { ...f.session.sendAvailability!, route: "terminal-pane", mode: "non-atomic", state: "unavailable" };
    await f.create().handle("chat", "replace", "改成两步");
    expect((await f.store.getLeaderState("chat"))!.data.pending).toBeUndefined();
    expect((await f.create().handle("chat", "confirm", "确认执行")).text).toContain("没有待确认计划");
    expect(f.dispatched).not.toHaveBeenCalled();
    expect(await f.store.listRecentCommands()).toEqual([]);
  });

  it("keeps terminal sends out of unconfirmed rules mode while reads remain available", () => {
    const f = fixture();
    const resolver = new NaturalLanguageResolver();
    expect(resolver.resolve("执行：synthetic", { sessions: [f.session] })).toMatchObject({ action: "unknown", replyText: expect.stringContaining("独立单步并确认") });
    expect(resolver.resolve(`让 ${f.session.title} 执行：synthetic`, { sessions: [f.session] })).toMatchObject({ action: "unknown", replyText: expect.stringContaining("独立单步并确认") });
    expect(resolver.resolve("执行：synthetic", { sessions: [f.session, { ...f.session, id: "native", provider: "codex-app" }],
      lastContext: { nodeId: "node", sessionId } })).toMatchObject({ action: "unknown", replyText: expect.stringContaining("独立单步并确认") });
    expect(resolver.resolve(`查看 ${sessionId} 最新输出`, { sessions: [f.session] }).action).toBe("read_session");
    expect(resolver.resolve("查看最新输出", { sessions: [f.session] }).action).toBe("read_session");
  });
});

it.each(["terminal-route", "terminal-session"])("rejects malicious persisted %s at normalize, store read, view and scheduler boundaries", async attack => {
  const store = new MemoryStore();
  const now = Date.now();
  const execution = createExecution("chat", { id: randomUUID(), expiresAt: now + 60000,
    actions: [{ nodeId: "node", sessionId: "native", prompt: "synthetic", dependsOn: [], sendRoute: "control-socket" }] }, now);
  if (attack === "terminal-route") execution.plan.actions[0].sendRoute = "terminal-pane";
  else execution.plan.actions[0].sessionId = sessionId;
  expect(() => normalizeExecution(execution)).toThrow("Terminal input");
  (store as unknown as { executions: Map<string, ExecutionRecord> }).executions.set(execution.id, execution);
  await expect(store.getExecution(execution.id)).rejects.toThrow("Terminal input");
  await expect(store.listActiveExecutions()).rejects.toThrow("Terminal input");
  await expect(store.getLatestExecution("chat")).rejects.toThrow("Terminal input");
  await expect(readExecutionView(store, execution, now)).rejects.toThrow("Terminal input");
  const submit = vi.fn();
  const unsafeStore = Object.assign(Object.create(store), { getExecution: async () => execution });
  const scheduler = new ExecutionScheduler(unsafeStore, { submit });
  await expect(scheduler.advance(execution.id)).rejects.toThrow("Terminal input");
  expect(submit).not.toHaveBeenCalled();
});
