import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { LeaderOrchestrator } from "../../src/leader/orchestrator.js";
import { DirectCallSchema } from "../../src/leader/direct-contracts.js";
import { LeaderDataSchema } from "../../src/leader/contracts.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { CommandRecord, PostCommandRequest, ScopedSession, SendRoute } from "../../src/types.js";

const chatId = "direct-chat";
const actions = [{ nodeId: "air", sessionId: "original", prompt: "检查测试结果" }];
const call = (name: string, args: unknown = {}, extra: Record<string, unknown> = {}) => DirectCallSchema.parse({
  chatId, messageId: "request", text: "检查原会话测试结果", callId: randomUUID(), name, arguments: args, ...extra,
});
function fixture() {
  const store = new MemoryStore();
  const now = Date.now();
  const sessions: ScopedSession[] = [{ nodeId: "air", id: "original", provider: "codex-app", title: "完整原始标题",
    status: "idle", loaded: true, capabilities: ["send", "read"], observedAt: new Date(now).toISOString() }];
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
  const create = () => new LeaderOrchestrator(store, hub, commands, model, () => now, undefined, undefined, undefined,
    undefined, undefined, { isAllowed: id => id === chatId });
  return { store, sessions, hub, commands, model, create };
}

describe("single-agent direct business executor", () => {
  it("dispatches once without classifier or acknowledgement models, including a different-call-ID replay", async () => {
    const f = fixture(), direct = f.create().direct;
    const request = call("execute_plan", { actions }, { authorization: { intent: "task" } });
    const first = await direct.call(request);
    expect(first.reply?.text).toContain("已接收");
    expect(f.commands.submit).toHaveBeenCalledOnce();
    expect(await f.create().direct.call({ ...request, callId: randomUUID() })).toEqual(first);
    await expect(direct.call({ ...request, callId: randomUUID(), arguments: { actions: [{ ...actions[0], prompt: "第二个任务" }] } })).rejects.toThrow(/effect key/);
    expect(f.commands.submit).toHaveBeenCalledOnce();
    expect(f.model.complete).not.toHaveBeenCalled();
  });

  it("persists a continuous goal without invoking a synchronous goal decision or acknowledgement", async () => {
    const f = fixture();
    const request = call("execute_goal", { objective: "持续核查结果", criteria: ["取得最终结论"],
      targets: [{ nodeId: "air", sessionId: "original" }], constraints: "仅核查，不修改其他会话",
      maxActions: 3, maxDecisions: 5, durationMinutes: 30, shareResults: true }, { authorization: { intent: "goal" } });
    const result = await f.create().direct.call(request);
    expect(result.reply?.text).toContain("目标已确认");
    expect((await f.store.getLatestGoal(chatId))?.status).toBe("active");
    expect(f.model.complete).not.toHaveBeenCalled();
    expect(f.commands.submit).not.toHaveBeenCalled();
    expect(await f.create().direct.call({ ...request, callId: randomUUID() })).toEqual(result);
  });

  it("rejects implicit authorization before writing an uncertain effect and permits corrected authorization", async () => {
    const f = fixture(), direct = f.create().direct, request = call("execute_plan", { actions });
    await expect(direct.call(request)).rejects.toThrow(/authorization/);
    const result = await direct.call({ ...request, authorization: { ...request.authorization, intent: "task" } });
    expect(result.reply?.text).toContain("已接收");
    expect(f.model.complete).not.toHaveBeenCalled();
  });

  it("allows preview confirmation only from a subsequent real user message, preserving explicit confirmation after queries", async () => {
    const f = fixture(), direct = f.create().direct;
    const preview = call("propose_plan", { actions }, { text: "先预览任务", authorization: { intent: "preview" } });
    expect((await direct.call(preview)).reply?.text).toContain("尚未派发");
    await expect(direct.call({ ...preview, name: "confirm_pending", callId: randomUUID(), arguments: {} })).rejects.toThrow(/prior preview/);
    expect(f.commands.submit).not.toHaveBeenCalled();
    await f.create().direct.call(call("list_nodes", {}, { messageId: "unrelated-query", text: "节点在线吗" }));
    await expect(f.create().direct.call(call("confirm_pending", {}, { messageId: "ambiguous-yes", text: "好" }))).rejects.toThrow(/prior preview/);
    const result = await f.create().direct.call(call("confirm_pending", {}, { messageId: "explicit-confirm", text: "确认" }));
    expect(result.reply?.text).toContain("已接收");
    expect(f.commands.submit).toHaveBeenCalledOnce();
    expect(f.model.complete).not.toHaveBeenCalled();
  });

  it("accepts an immediate natural confirmation across executor restart", async () => {
    const f = fixture();
    await f.create().direct.call(call("propose_plan", { actions }, { messageId: "preview", text: "先预览", authorization: { intent: "preview" } }));
    expect((await f.create().direct.call(call("confirm_pending", {}, { messageId: "yes", text: "好" }))).reply?.text).toContain("已接收");
    expect(f.commands.submit).toHaveBeenCalledOnce();
  });

  it("permits only one displayed preview per real user turn", async () => {
    const f = fixture(), direct = f.create().direct;
    const request = call("propose_plan", { actions }, { authorization: { intent: "preview" } });
    const first = await direct.call(request);
    expect(await direct.call({ ...request, callId: randomUUID() })).toEqual(first);
    await expect(direct.call({ ...request, callId: randomUUID(), arguments: { actions: [{ ...actions[0], prompt: "另一个候选任务" }] } })).rejects.toThrow(/effect key/);
    const pending = LeaderDataSchema.parse((await f.store.getLeaderState(chatId))?.data).pending;
    expect(pending?.actions[0].prompt).toBe(actions[0].prompt);
  });

  it("rejects an oversized preview without leaving a confirmable pending plan", async () => {
    const f = fixture();
    f.sessions[0].title = "完整标题".repeat(2300);
    const result = await f.create().direct.call(call("propose_plan", { actions }, { authorization: { intent: "preview" } }));
    expect(result.reply?.text).toContain("无法完整展示");
    expect(LeaderDataSchema.parse((await f.store.getLeaderState(chatId))?.data).pending).toBeUndefined();
    await expect(f.create().direct.call(call("confirm_pending", {}, { messageId: "yes", text: "确认" }))).rejects.toThrow(/prior preview/);
    expect(f.commands.submit).not.toHaveBeenCalled();
  });

  it("persists title discovery for focus across executor restart and returns real labels", async () => {
    const f = fixture();
    const request = call("list_sessions");
    const listed = await f.create().direct.call(request);
    expect(JSON.stringify(listed)).toContain("完整原始标题");
    expect(JSON.stringify(listed)).not.toContain("⟦session:");
    const focused = await f.create().direct.call({ ...request, name: "focus_session_candidates", callId: randomUUID(),
      arguments: { targets: [{ nodeId: "air", sessionId: "original" }] } });
    expect(focused.result).toEqual({ candidates: [{ nodeId: "air", sessionId: "original", displayLabel: "[air] 完整原始标题" }] });
    await expect(f.create().direct.call(call("focus_session_candidates", { targets: [{ nodeId: "air", sessionId: "original" }] },
      { messageId: "another-turn" }))).resolves.toMatchObject({ result: { error: expect.stringContaining("discovered") } });
  });

  it("runs actual query RPCs concurrently and merges discovery without an inflight lease", async () => {
    const f = fixture(), direct = f.create().direct;
    let release!: () => void, entered!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    f.hub.getAllSessions.mockImplementation(async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); return f.sessions; });
    const first = direct.call(call("list_sessions"));
    await enteredPromise;
    const second = await direct.call(call("list_nodes"));
    expect(f.hub.getNodeStatusList).toHaveBeenCalled();
    expect(second.result).toEqual([]);
    expect(LeaderDataSchema.parse((await f.store.getLeaderState(chatId))?.data).inflight).toBeUndefined();
    release();
    expect((await first).result).toBeTruthy();
    expect(f.model.complete).not.toHaveBeenCalled();
  });

  it("returns sanitized complete persisted context and rejects another chat", async () => {
    const f = fixture();
    await f.store.compareAndSetLeaderState(chatId, 0, { history: [
      { role: "user", content: "约束#login=secret-token", complete: true },
      { role: "assistant", content: "完整答复", complete: true },
    ], memories: { language: "中文" } });
    const listed = await f.create().direct.list({ chatId, messageId: "context", text: "上个任务" });
    expect(listed.context.history[0].content).toBe("约束#login=[REDACTED]");
    expect(listed.context.memories).toEqual({ language: "中文" });
    expect(listed.context.pending).toBeNull();
    await expect(f.create().direct.call(call("list_nodes", {}, { chatId: "other" }))).rejects.toThrow(/CHAT_NOT_ALLOWED/);
  });
});
