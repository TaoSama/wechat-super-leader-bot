import { afterEach, expect, it, vi } from "vitest";
import { CommandService } from "../../src/commands/service.js";
import { LeaderOrchestrator } from "../../src/leader/orchestrator.js";
import { ExecutionScheduler } from "../../src/leader/plans/scheduler.js";
import type { LeaderModel, ModelMessage, ModelReply, ModelTool } from "../../src/leader/model/contracts.js";
import { AUTHORIZATION_TOOL_NAME } from "../../src/leader/model/user-authorization.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { ControllerCommandMessage, ScopedSession } from "../../src/types.js";

const CHAT_ID = "queued-leader-chat";
const NODE_ID = "queued-leader-node";
const SESSION_ID = "original-session";
const TTL_SECONDS = 300;
const START_TIME = Date.parse("2026-10-18T00:00:00.000Z");
const actions = [{ nodeId: NODE_ID, sessionId: SESSION_ID, prompt: "只读检查测试结果" }];
const execute = (nextActions: unknown = actions): ModelReply => ({ content: null, toolCalls: [{
  id: "execute-plan-call", type: "function", function: { name: "execute_plan", arguments: JSON.stringify({ actions: nextActions }) },
}] });

class ScriptedModel implements LeaderModel {
  calls: ModelMessage[][] = [];
  async complete(messages: ModelMessage[], tools: ModelTool[]): Promise<ModelReply> {
    if (tools.length === 1 && tools[0].function.name === AUTHORIZATION_TOOL_NAME) return {
      content: null, toolCalls: [{ id: "task-intent", type: "function", function: {
        name: AUTHORIZATION_TOOL_NAME, arguments: JSON.stringify({ intent: "task" }),
      } }],
    };
    this.calls.push(structuredClone(messages));
    const reply = this.replies.shift();
    if (!reply) throw new Error("Missing queued Leader fixture response");
    return reply;
  }
  constructor(private replies: ModelReply[]) {}
}

afterEach(() => vi.useRealTimers());

async function fixture(options: { busy?: boolean; offline?: boolean; replies?: ModelReply[] } = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START_TIME);
  const store = new MemoryStore();
  const session: ScopedSession = {
    nodeId: NODE_ID, id: SESSION_ID, provider: "codex-app", title: "原始会话", cwd: "/fixture",
    status: options.busy ? "active" : "idle", loaded: true, capabilities: ["read", "send"],
    observedAt: new Date().toISOString(),
  };
  await store.upsertNodeSessions(NODE_ID, [session]);
  if (options.offline) await store.removeNodeSessions(NODE_ID);
  const hub = {
    isNodeConnected: vi.fn(() => !options.offline),
    getNodeSession: vi.fn((nodeId: string, sessionId: string) =>
      !options.offline && nodeId === NODE_ID && sessionId === SESSION_ID ? session : undefined),
    getAllSessions: vi.fn(async () => options.offline ? [] : [session]),
    getNodeStatusList: () => [], getAllSkills: () => [], getNodeSkills: () => [], readHistory: vi.fn(),
    registerCommandResultWaiter: vi.fn(() => ({ wait: async () => null, cancel: vi.fn() })),
    sendCommand: vi.fn(async (command: ControllerCommandMessage) => {
      await store.updateCommandStatus(command.commandId, "accepted", undefined, undefined,
        command.expectedTurnId ?? `turn-${command.commandId}`);
      return { delivered: true };
    }),
  };
  const commands = new CommandService(store, hub, TTL_SECONDS);
  const errors = vi.fn();
  const createScheduler = () => new ExecutionScheduler(store, commands, {
    now: Date.now, onError: errors,
    canDispatch: (execution, index) => {
      const action = execution.plan.actions[index];
      return commands.canDispatchSend(action, action.sendRoute!);
    },
  });
  const scheduler = createScheduler();
  const model = new ScriptedModel(options.replies ?? [execute()]);
  const createLeader = (executions = scheduler, nextModel: LeaderModel = model) =>
    new LeaderOrchestrator(store, hub, commands, nextModel, Date.now, undefined, executions);
  const restore = async () => {
    session.status = "idle";
    session.observedAt = new Date().toISOString();
    hub.isNodeConnected.mockReturnValue(true);
    hub.getNodeSession.mockImplementation((nodeId, sessionId) =>
      nodeId === NODE_ID && sessionId === SESSION_ID ? session : undefined);
    hub.getAllSessions.mockResolvedValue([session]);
    await store.upsertNodeSessions(NODE_ID, [session]);
  };
  return { store, session, hub, commands, scheduler, model, errors, createScheduler, createLeader, restore };
}

it("confirms an explicit task while its original session is busy and dispatches once after idle", async () => {
  const f = await fixture({ busy: true });
  const confirmed = vi.spyOn(f.store, "confirmExecution");
  const leader = f.createLeader();
  const text = "让原始会话只读检查测试结果，直接执行，会话忙时等空闲再做";
  const reply = await leader.handle(CHAT_ID, "busy-request", text);
  const execution = (await f.store.getLatestExecution(CHAT_ID))!;
  expect(execution).toMatchObject({ status: "active", attempts: [null], plan: { actions: [{
    ...actions[0], sendRoute: "control-socket", dependsOn: [],
  }] } });
  expect(await f.scheduler.view(execution.id, CHAT_ID)).toMatchObject({ steps: [{ status: "waiting" }] });
  expect(reply.text).toContain("等待前序完成或会话可用");
  expect(reply.text).not.toMatch(/回复[“「]?确认|待确认/);
  expect((await f.store.getLeaderState(CHAT_ID))?.data.pending).toBeUndefined();
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
  expect(confirmed).toHaveBeenCalledTimes(1);

  await f.restore();
  await f.scheduler.advance(execution.id);
  await f.scheduler.advance(execution.id);
  await f.commands.dispatchQueued();
  expect(await f.scheduler.view(execution.id, CHAT_ID)).toMatchObject({ steps: [{ status: "accepted" }] });
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
  expect(f.hub.sendCommand.mock.calls[0][0]).toMatchObject({ nodeId: NODE_ID, sessionId: SESSION_ID,
    action: "send", prompt: actions[0].prompt, deliveryMode: "next-turn", sendRoute: "control-socket" });
  expect(await leader.handle(CHAT_ID, "busy-request", text)).toEqual(reply);
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
  expect(f.errors).not.toHaveBeenCalled();
});

it("accepts an offline known session and resumes its persisted execution after Leader restart", async () => {
  const f = await fixture({ offline: true });
  expect(await f.store.getNodeSessions(NODE_ID)).toEqual([]);
  expect(await f.store.getKnownSession(NODE_ID, SESSION_ID)).toMatchObject({ id: SESSION_ID });
  expect(f.hub.getNodeSession(NODE_ID, SESSION_ID)).toBeUndefined();
  const text = "给已发现的原始会话执行只读检查，离线先排队，恢复后继续";
  const reply = await f.createLeader().handle(CHAT_ID, "offline-request", text);
  const execution = (await f.store.getLatestExecution(CHAT_ID))!;
  expect(execution).toMatchObject({ status: "active", attempts: [null] });
  expect(await f.scheduler.view(execution.id, CHAT_ID)).toMatchObject({ steps: [{ status: "waiting" }] });
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
  await f.scheduler.stop();

  const restartedScheduler = f.createScheduler();
  const restartedLeader = f.createLeader(restartedScheduler, new ScriptedModel([]));
  expect(await restartedLeader.handle(CHAT_ID, "offline-request", text)).toEqual(reply);
  await f.restore();
  await restartedScheduler.advance(execution.id);
  await restartedScheduler.advance(execution.id);
  expect(await restartedScheduler.view(execution.id, CHAT_ID)).toMatchObject({ steps: [{ status: "accepted" }] });
  expect(await f.store.listRecentExecutions([CHAT_ID], 10)).toHaveLength(1);
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
  expect(f.hub.sendCommand.mock.calls[0][0]).toMatchObject({ nodeId: NODE_ID, sessionId: SESSION_ID,
    prompt: actions[0].prompt, deliveryMode: "next-turn" });
  expect(f.errors).not.toHaveBeenCalled();
});

it("appends an exact current-turn steer without replacing the active execution", async () => {
  const f = await fixture();
  const confirmed = vi.spyOn(f.store, "confirmExecution");
  const leader = f.createLeader();
  await leader.handle(CHAT_ID, "start-original-task", "让原始会话只读检查测试结果，直接执行");
  const execution = (await f.store.getLatestExecution(CHAT_ID))!;
  const original = (await f.store.listRecentCommands())[0];
  expect(original.status).toBe("accepted");
  f.session.status = "active";
  const prompt = "补充：检查时也记录失败用例名称";
  const steeringModel = new ScriptedModel([execute([{ nodeId: NODE_ID, sessionId: SESSION_ID,
    prompt, deliveryMode: "steer", expectedTurnId: original.turnId }])]);
  const steeringLeader = f.createLeader(f.scheduler, steeringModel);
  const text = `仅给原始会话当前轮 ${original.turnId} 补充检查失败用例名称，直接补充，不创建新任务`;
  const reply = await steeringLeader.handle(CHAT_ID, "append-to-original-turn", text);
  expect(reply.text).toContain("补充已由原会话当前轮受理");
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(2);
  expect(f.hub.sendCommand.mock.calls[1][0]).toMatchObject({ type: "command", nodeId: NODE_ID,
    sessionId: SESSION_ID, prompt, deliveryMode: "steer", expectedTurnId: original.turnId });
  expect(await f.store.getLatestExecution(CHAT_ID)).toEqual(execution);
  expect(await f.store.listRecentExecutions([CHAT_ID], 10)).toHaveLength(1);
  expect(confirmed).toHaveBeenCalledTimes(1);
  expect((await f.store.getLeaderState(CHAT_ID))?.data.commandIds).toContain(reply.commandId);
  expect(await steeringLeader.handle(CHAT_ID, "append-to-original-turn", text)).toEqual(reply);
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(2);
  expect(f.errors).not.toHaveBeenCalled();
});

it("rejects a steer when its original chat claim changes before transmission", async () => {
  const f = await fixture();
  await f.createLeader().handle(CHAT_ID, "original-before-revoke", "让原始会话只读检查测试结果，直接执行");
  const execution = await f.store.getLatestExecution(CHAT_ID);
  const original = (await f.store.listRecentCommands())[0];
  f.session.status = "active";
  const submit = f.commands.submit.bind(f.commands);
  vi.spyOn(f.commands, "submit").mockImplementation((request, wait, guard, route, authority) =>
    submit(request, wait, async () => {
      const state = (await f.store.getLeaderState(CHAT_ID))!;
      expect(await f.store.compareAndSetLeaderState(CHAT_ID, state.revision,
        { ...state.data, inflight: undefined })).not.toBeNull();
      await guard?.();
    }, route, authority));
  const model = new ScriptedModel([execute([{ nodeId: NODE_ID, sessionId: SESSION_ID,
    prompt: "补充记录失败用例名称", deliveryMode: "steer", expectedTurnId: original.turnId }])]);
  await expect(f.createLeader(f.scheduler, model).handle(CHAT_ID, "steer-with-revoked-claim",
    "给原始会话当前轮补充记录失败用例名称，直接补充")).rejects.toThrow("supplement authority changed");
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
  const supplement = (await f.store.listRecentCommands()).find(command => command.deliveryMode === "steer");
  expect(supplement).toMatchObject({ status: "failed", nodeId: NODE_ID, sessionId: SESSION_ID,
    expectedTurnId: original.turnId, authority: { type: "chat", chatId: CHAT_ID } });
  expect(await f.store.getLatestExecution(CHAT_ID)).toEqual(execution);
});
