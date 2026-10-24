import { acknowledgementFixture } from "./acknowledgement-fixture.js";
import { afterEach, expect, it, vi } from "vitest";
import { CommandService } from "../../src/commands/service.js";
import { LeaderOrchestrator } from "../../src/leader/orchestrator.js";
import { CLAIM_TTL_MS, type Plan } from "../../src/leader/contracts.js";
import { ExecutionScheduler } from "../../src/leader/plans/scheduler.js";
import { recoverSteerPlanCommand } from "../../src/leader/plans/steer.js";
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
    const acknowledgement = acknowledgementFixture(messages);
    if (acknowledgement) return acknowledgement;
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
    supportsDeliveryMode: vi.fn(() => true),
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

async function queuedSteer() {
  const f = await fixture();
  await f.createLeader().handle(CHAT_ID, "start-original-task", "让原始会话只读检查测试结果，直接执行");
  const execution = (await f.store.getLatestExecution(CHAT_ID))!;
  const original = (await f.store.listRecentCommands())[0];
  f.session.status = "active";
  await f.store.upsertNodeSessions(NODE_ID, [f.session]);
  await f.store.removeNodeSessions(NODE_ID);
  f.hub.isNodeConnected.mockReturnValue(false);
  f.hub.getNodeSession.mockReturnValue(undefined);
  f.hub.getAllSessions.mockResolvedValue([]);
  const model = new ScriptedModel([execute([{ nodeId: NODE_ID, sessionId: SESSION_ID,
    prompt: "补充记录失败用例名称", deliveryMode: "steer", expectedTurnId: original.turnId }])]);
  const text = "给原始会话当前轮补充记录失败用例名称，直接补充";
  const reply = await f.createLeader(f.scheduler, model).handle(CHAT_ID, "queue-supplement", text);
  const supplement = (await f.store.getCommand(reply.commandId!))!;
  expect(supplement).toMatchObject({ status: "queued", deliveryMode: "steer", expectedTurnId: original.turnId });
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
  const restore = async () => {
    await f.restore();
    f.session.status = "active";
    await f.store.upsertNodeSessions(NODE_ID, [f.session]);
  };
  return { ...f, execution, original, supplement, text, reply, restore };
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
  expect(await f.hub.getAllSessions()).toEqual([]);
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

it.each([
  { recovery: "same-request", priorCancellation: false, cancelDuringRecovery: false },
  { recovery: "new-request", priorCancellation: false, cancelDuringRecovery: false },
  { recovery: "same-request", priorCancellation: true, cancelDuringRecovery: false },
  { recovery: "new-request", priorCancellation: false, cancelDuringRecovery: true },
])("recovers a sent steer during $recovery recovery (prior cancellation: $priorCancellation, concurrent cancellation: $cancelDuringRecovery)", async ({ recovery, priorCancellation, cancelDuringRecovery }) => {
  const f = await fixture();
  if (priorCancellation) {
    await f.createLeader().handle(CHAT_ID, "cancel-before-new-supplement", "停止后续执行");
  }
  await f.createLeader().handle(CHAT_ID, "original-before-save-failure", "让原始会话只读检查测试结果，直接执行");
  const execution = await f.store.getLatestExecution(CHAT_ID);
  const original = (await f.store.listRecentCommands())[0];
  f.session.status = "active";
  const prompt = "补充记录失败用例名称";
  const model = new ScriptedModel([execute([{ nodeId: NODE_ID, sessionId: SESSION_ID,
    prompt, deliveryMode: "steer", expectedTurnId: original.turnId }])]);
  const save = f.store.compareAndSetLeaderState.bind(f.store);
  let failFinalSave = true;
  vi.spyOn(f.store, "compareAndSetLeaderState").mockImplementation(async (...args) => {
    if (failFinalSave && !args[2].inflight) {
      failFinalSave = false;
      throw new Error("Injected final receipt save failure");
    }
    return save(...args);
  });
  const messageId = "steer-before-save-failure";
  const text = "给原始会话当前轮补充记录失败用例名称，直接补充";
  await expect(f.createLeader(f.scheduler, model).handle(CHAT_ID, messageId, text)).rejects.toThrow("Injected final receipt save failure");
  const supplement = (await f.store.listRecentCommands()).find(command => command.deliveryMode === "steer")!;
  expect(supplement).toMatchObject({ status: "accepted", expectedTurnId: original.turnId,
    authority: { type: "chat", chatId: CHAT_ID, steerGeneration: priorCancellation ? 1 : 0 } });
  expect((await f.store.getLeaderState(CHAT_ID))?.data).toMatchObject({ inflight: {
    messageId, plan: { actions: [{ deliveryMode: "steer" }] },
  } });
  const frozenPlan = (await f.store.getLeaderState(CHAT_ID))!.data.inflight.plan as Plan;
  expect((await f.store.getLeaderState(CHAT_ID))?.data.commandIds).not.toContain(supplement.commandId);

  vi.setSystemTime(START_TIME + CLAIM_TTL_MS + 1);
  const queryModel = new ScriptedModel([{ content: null, toolCalls: [{ id: "recovered-command", type: "function", function: {
    name: "get_command", arguments: JSON.stringify({ commandId: supplement.commandId }),
  } }] }, { content: "补充已受理，执行仍待核查", toolCalls: [] }]);
  const restarted = f.createLeader(f.createScheduler(), queryModel);
  if (cancelDuringRecovery) {
    await restarted.handle(CHAT_ID, "cancel-during-receipt-recovery", "停止后续执行");
    expect((await f.store.getLeaderState(CHAT_ID))?.data.steerGeneration).toBe(1);
    // A revoked send authorization does not revoke access to its historical receipt.
    expect(await recoverSteerPlanCommand(f.store, CHAT_ID, frozenPlan)).toMatchObject({ commandId: supplement.commandId, status: "accepted" });
  }
  if (recovery === "same-request") {
    const reply = await restarted.handle(CHAT_ID, messageId, text);
    expect(reply).toMatchObject({ commandId: supplement.commandId, text: expect.stringContaining(supplement.commandId) });
    expect(reply.text).toContain("accepted");
    expect(reply.text).not.toContain("尚无可确认的持久执行记录");
  }
  await restarted.handle(CHAT_ID, "query-after-save-failure", "查询这条补充指令");
  const queried = JSON.parse(queryModel.calls[1].find(message => message.role === "tool")!.content!);
  expect(queried).toMatchObject({ commandId: supplement.commandId, status: "accepted", expectedTurnId: original.turnId });
  const recoveredReceipt = (await f.store.getLeaderState(CHAT_ID))?.data.receipts.find((receipt: { messageId: string }) => receipt.messageId === messageId);
  expect(recoveredReceipt).toMatchObject({ commandId: supplement.commandId, text: expect.stringContaining("accepted") });
  expect((await f.store.getLeaderState(CHAT_ID))?.data.commandIds).toContain(supplement.commandId);
  expect(await restarted.handle(CHAT_ID, messageId, text)).toMatchObject({ commandId: supplement.commandId });
  if (cancelDuringRecovery) expect(await f.store.getLatestExecution(CHAT_ID)).toMatchObject({ id: execution!.id, status: "cancelled" });
  else expect(await f.store.getLatestExecution(CHAT_ID)).toEqual(execution);
  expect(await f.store.listRecentCommands()).toHaveLength(2);
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(2);
  expect(f.errors).not.toHaveBeenCalled();
});

it("keeps a revoked steer out of both queue scanners until its admission rejects", async () => {
  const f = await fixture();
  await f.createLeader().handle(CHAT_ID, "original-before-revoke", "让原始会话只读检查测试结果，直接执行");
  const execution = await f.store.getLatestExecution(CHAT_ID);
  const original = (await f.store.listRecentCommands())[0];
  f.session.status = "active";
  const scanner = new CommandService(f.store, f.hub, TTL_SECONDS);
  const submit = f.commands.submit.bind(f.commands);
  vi.spyOn(f.commands, "submit").mockImplementation((request, wait, guard, route, authority) =>
    submit(request, wait, async () => {
      const state = (await f.store.getLeaderState(CHAT_ID))!;
      expect(await f.store.compareAndSetLeaderState(CHAT_ID, state.revision,
        { ...state.data, inflight: undefined })).not.toBeNull();
      await Promise.all([f.commands.dispatchQueued(), scanner.dispatchQueued()]);
      expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
      expect(await f.store.findCommandByRequestId(request.requestId)).toMatchObject({ status: "admitting" });
      await guard?.();
    }, route, authority));
  const model = new ScriptedModel([execute([{ nodeId: NODE_ID, sessionId: SESSION_ID,
    prompt: "补充记录失败用例名称", deliveryMode: "steer", expectedTurnId: original.turnId }])]);
  await expect(f.createLeader(f.scheduler, model).handle(CHAT_ID, "steer-with-revoked-claim",
    "给原始会话当前轮补充记录失败用例名称，直接补充")).rejects.toThrow("supplement authority changed");
  await scanner.dispatchQueued();
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
  const supplement = (await f.store.listRecentCommands()).find(command => command.deliveryMode === "steer");
  expect(supplement).toMatchObject({ status: "failed", nodeId: NODE_ID, sessionId: SESSION_ID,
    expectedTurnId: original.turnId, authority: { type: "chat", chatId: CHAT_ID } });
  expect(await f.store.getLatestExecution(CHAT_ID)).toEqual(execution);
});

it("revokes a queued current-turn supplement when its plan is cancelled before reconnect", async () => {
  const f = await queuedSteer();
  const cancellation = await f.createLeader(f.scheduler, new ScriptedModel([]))
    .handle(CHAT_ID, "cancel-original-plan", "停止后续执行");
  expect(cancellation.text).toContain("停止后续派发");
  expect(await f.store.getExecution(f.execution.id)).toMatchObject({ status: "cancelled" });
  await f.restore();
  const restartedCommands = new CommandService(f.store, f.hub, TTL_SECONDS);
  await restartedCommands.dispatchQueued();
  await restartedCommands.dispatchQueued();
  expect(await f.store.getCommand(f.supplement.commandId)).toMatchObject({ status: "cancelled" });
  expect(await f.store.getCommand(f.original.commandId)).toMatchObject({ status: "accepted" });
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});

it("retains an uncancelled supplement through a query and controller restart", async () => {
  const f = await queuedSteer();
  const queryModel = new ScriptedModel([{ content: "原任务等待完成。", toolCalls: [] }]);
  await f.createLeader(f.scheduler, queryModel).handle(CHAT_ID, "query-original-plan", "查询原任务的状态");
  await f.scheduler.stop();
  const restarted = f.createLeader(f.createScheduler(), new ScriptedModel([]));
  expect(await restarted.handle(CHAT_ID, "queue-supplement", f.text)).toEqual(f.reply);
  await f.restore();
  const restartedCommands = new CommandService(f.store, f.hub, TTL_SECONDS);
  await restartedCommands.dispatchQueued();
  await restartedCommands.dispatchQueued();
  expect(await f.store.getCommand(f.supplement.commandId)).toMatchObject({ status: "accepted", turnId: f.original.turnId });
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(2);
  expect(await f.store.listRecentExecutions([CHAT_ID], 10)).toHaveLength(1);
});

it("retains cancellation authority if the handler fails after its durable claim", async () => {
  const f = await queuedSteer();
  vi.spyOn(f.scheduler, "cancel").mockRejectedValueOnce(new Error("cancellation interrupted"));
  await expect(f.createLeader(f.scheduler, new ScriptedModel([]))
    .handle(CHAT_ID, "interrupted-cancellation", "停止后续执行")).rejects.toThrow("cancellation interrupted");
  await f.restore();
  await new CommandService(f.store, f.hub, TTL_SECONDS).dispatchQueued();
  expect(await f.store.getCommand(f.supplement.commandId)).toMatchObject({ status: "cancelled" });
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});

it("rechecks cancellation after a queued supplement is claimed", async () => {
  const f = await queuedSteer();
  await f.restore();
  const claim = f.store.claimQueuedCommand.bind(f.store);
  vi.spyOn(f.store, "claimQueuedCommand").mockImplementation(async (commandId, route) => {
    const claimed = await claim(commandId, route);
    if (commandId === f.supplement.commandId) {
      await f.createLeader(f.scheduler, new ScriptedModel([]))
        .handle(CHAT_ID, "cancel-before-transmission", "停止后续执行");
    }
    return claimed;
  });
  await new CommandService(f.store, f.hub, TTL_SECONDS).dispatchQueued();
  expect(await f.store.getCommand(f.supplement.commandId)).toMatchObject({ status: "failed",
    error: "Dispatch authority revoked before transmission" });
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});

it("allows a newly authorized supplement after cancellation without reviving the old one", async () => {
  const f = await queuedSteer();
  await f.createLeader(f.scheduler, new ScriptedModel([]))
    .handle(CHAT_ID, "cancel-then-authorize", "停止后续执行");
  const model = new ScriptedModel([execute([{ nodeId: NODE_ID, sessionId: SESSION_ID,
    prompt: "新授权：只补充记录错误位置", deliveryMode: "steer", expectedTurnId: f.original.turnId }])]);
  const reply = await f.createLeader(f.scheduler, model)
    .handle(CHAT_ID, "new-supplement", "重新给原始会话当前轮补充记录错误位置，直接补充");
  expect(await f.store.getCommand(reply.commandId!)).toMatchObject({ status: "queued" });
  await f.restore();
  await new CommandService(f.store, f.hub, TTL_SECONDS).dispatchQueued();
  expect(await f.store.getCommand(f.supplement.commandId)).toMatchObject({ status: "cancelled" });
  expect(await f.store.getCommand(reply.commandId!)).toMatchObject({ status: "accepted", turnId: f.original.turnId });
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(2);
  expect(f.hub.sendCommand.mock.calls[1][0]).toMatchObject({ commandId: reply.commandId });
  expect(await f.store.listRecentExecutions([CHAT_ID], 10)).toHaveLength(1);
});
