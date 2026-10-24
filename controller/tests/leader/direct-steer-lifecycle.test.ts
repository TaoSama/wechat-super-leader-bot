import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { CommandService } from "../../src/commands/service.js";
import { LeaderOrchestrator } from "../../src/leader/orchestrator.js";
import { DirectCallSchema } from "../../src/leader/direct-contracts.js";
import { CLAIM_TTL_MS, LeaderDataSchema, MAX_COMMAND_IDS, MAX_RECEIPTS } from "../../src/leader/contracts.js";
import { MAX_LEADER_DATA_BYTES } from "../../src/leader/state.js";
import { steerPlanRequestId } from "../../src/leader/plans/steer.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { ControllerCommandMessage, ScopedSession } from "../../src/types.js";

const CHAT_ID = "direct-steer-chat";
const NODE_ID = "direct-steer-node";
const SESSION_ID = "original-session";
const ACTIVE_TURN = "original-active-turn";
const TTL_SECONDS = 300;
const HISTORY_PADDING_CHARS = 1024;
const START_TIME = Date.parse("2026-10-23T00:00:00.000Z");
const call = (name: string, args: unknown = {}, extra: Record<string, unknown> = {}) => DirectCallSchema.parse({
  chatId: CHAT_ID, messageId: randomUUID(), text: "查询当前任务", callId: randomUUID(), name, arguments: args, ...extra,
});
const steer = () => call("execute_plan", { actions: [{ nodeId: NODE_ID, sessionId: SESSION_ID,
  prompt: "补充记录失败用例名称", deliveryMode: "steer", expectedTurnId: ACTIVE_TURN }] },
{ text: `给原会话当前轮 ${ACTIVE_TURN} 补充记录失败用例名称`, authorization: { intent: "task" } });

afterEach(() => vi.useRealTimers());

async function fixture(offline = false) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START_TIME);
  const store = new MemoryStore();
  const session: ScopedSession = { nodeId: NODE_ID, id: SESSION_ID, provider: "codex-app", title: "原始会话",
    status: "active", loaded: true, capabilities: ["read", "send"], observedAt: new Date().toISOString() };
  await store.upsertNodeSessions(NODE_ID, [session]);
  let online = !offline;
  if (offline) await store.removeNodeSessions(NODE_ID);
  const hub = {
    isNodeConnected: () => online, supportsDeliveryMode: () => true,
    getNodeSession: (node: string, id: string) => online && node === NODE_ID && id === SESSION_ID ? session : undefined,
    getAllSessions: async () => online ? [session] : [], getNodeStatusList: () => [],
    getAllSkills: () => [], getNodeSkills: () => [], readHistory: vi.fn(),
    registerCommandResultWaiter: () => ({ wait: async () => null, cancel: vi.fn() }),
    sendCommand: vi.fn(async (command: ControllerCommandMessage) => {
      await store.updateCommandStatus(command.commandId, "accepted", undefined, undefined, command.expectedTurnId);
      return { delivered: true };
    }),
  };
  const commands = new CommandService(store, hub, TTL_SECONDS);
  const model = { complete: vi.fn(async () => { throw new Error("Synchronous model call forbidden"); }) };
  const create = () => new LeaderOrchestrator(store, hub, commands, model, Date.now, undefined, undefined,
    undefined, undefined, undefined, { isAllowed: id => id === CHAT_ID });
  const restore = async () => {
    online = true;
    session.observedAt = new Date().toISOString();
    await store.upsertNodeSessions(NODE_ID, [session]);
  };
  return { store, hub, commands, model, create, restore };
}

it.each([
  { name: "cancel_plan", cleanupFails: false }, { name: "cancel_goal", cleanupFails: false },
  { name: "cancel_plan", cleanupFails: true }, { name: "cancel_goal", cleanupFails: true },
])("revokes an offline queued steer on direct $name before cleanup (failure: $cleanupFails)", async ({ name, cleanupFails }) => {
  const f = await fixture(true);
  const submitted = await f.create().direct.call(steer());
  expect(await f.store.getCommand(submitted.reply!.commandId!)).toMatchObject({ status: "queued", deliveryMode: "steer" });
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
  if (cleanupFails) {
    vi.spyOn(f.store, name === "cancel_plan" ? "getLatestExecution" : "getLatestGoal").mockImplementationOnce(async () => {
      expect((await f.store.getLeaderState(CHAT_ID))?.data.steerGeneration).toBe(1);
      throw new Error("Injected cancellation cleanup failure");
    });
  }
  const cancelled = f.create().direct.call(call(name, {}, { text: "取消后续执行", authorization: { intent: "task" } }));
  if (cleanupFails) await expect(cancelled).rejects.toThrow("Injected cancellation cleanup failure");
  else expect((await cancelled).reply?.text).toContain("已取消");
  expect((await f.store.getLeaderState(CHAT_ID))?.data.steerGeneration).toBe(1);
  await f.restore();
  await new CommandService(f.store, f.hub, TTL_SECONDS).dispatchQueued();
  expect(await f.store.getCommand(submitted.reply!.commandId!)).toMatchObject({ status: "cancelled" });
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
  expect(f.model.complete).not.toHaveBeenCalled();
});

it.each(["final-save", "expired-claim"] as const)("recovers an accepted direct steer after %s without repeating dispatch", async recovery => {
  const f = await fixture();
  const request = steer();
  const save = f.store.compareAndSetLeaderState.bind(f.store);
  let failFinalSave = true;
  vi.spyOn(f.store, "compareAndSetLeaderState").mockImplementation(async (...args) => {
    if (failFinalSave && !args[2].inflight && f.hub.sendCommand.mock.calls.length) {
      if (recovery === "final-save") failFinalSave = false;
      throw new Error("Injected final receipt save failure");
    }
    return save(...args);
  });
  await expect(f.create().direct.call(request)).rejects.toThrow("Injected final receipt save failure");
  const command = (await f.store.listRecentCommands())[0];
  expect(command).toMatchObject({ status: "accepted", deliveryMode: "steer", expectedTurnId: ACTIVE_TURN,
    authority: { type: "chat", chatId: CHAT_ID, steerGeneration: 0 } });
  failFinalSave = false;
  if (recovery === "expired-claim") {
    const state = (await f.store.getLeaderState(CHAT_ID))!;
    expect(state.data.inflight).toMatchObject({ messageId: request.messageId, plan: { actions: [{ deliveryMode: "steer" }] } });
    // A revoked send authorization does not revoke this chat's historical receipt.
    await save(CHAT_ID, state.revision, { ...state.data, steerGeneration: 1, pending: state.data.inflight.plan,
      commandIds: Array.from({ length: MAX_COMMAND_IDS }, (_, index) => `old-command-${index}`),
      receipts: Array.from({ length: MAX_RECEIPTS }, (_, index) => ({ messageId: `old-message-${index}`, inputHash: "old", text: "old" })),
    });
    vi.setSystemTime(START_TIME + CLAIM_TTL_MS + 1);
  } else {
    expect((await f.store.getLeaderState(CHAT_ID))?.data.inflight).toBeUndefined();
    await f.create().direct.call(call("cancel_plan", {}, { text: "取消后续执行", authorization: { intent: "task" } }));
  }
  const queried = await f.create().direct.call(call("get_command", { commandId: command.commandId }));
  expect(queried.result).toMatchObject({ commandId: command.commandId, status: "accepted", expectedTurnId: ACTIVE_TURN });
  const data = LeaderDataSchema.parse((await f.store.getLeaderState(CHAT_ID))?.data);
  expect(data.pending).toBeUndefined();
  expect(data.commandIds).toContain(command.commandId);
  expect(data.receipts.find(receipt => receipt.messageId === request.messageId)).toMatchObject({
    commandId: command.commandId, text: expect.stringContaining("accepted"),
  });
  expect(await f.create().handle(CHAT_ID, request.messageId, request.text)).toMatchObject({ commandId: command.commandId });
  await expect(f.create().direct.call(request)).rejects.toThrow(/uncertain/);
  await f.commands.dispatchQueued();
  expect(await f.store.listRecentCommands()).toHaveLength(1);
  expect(await f.store.getLatestExecution(CHAT_ID)).toBeNull();
  expect(f.hub.sendCommand).toHaveBeenCalledOnce();
  expect(f.model.complete).not.toHaveBeenCalled();
});

it("trims whole history turns at the state byte boundary while preserving the recovered receipt", async () => {
  const f = await fixture();
  const messageId = "r", inputHash = "0".repeat(64), commandId = "c".repeat(64);
  const plan = { id: "p", expiresAt: START_TIME + CLAIM_TTL_MS, actions: [{ nodeId: NODE_ID, sessionId: SESSION_ID,
    prompt: "x", deliveryMode: "steer" as const, expectedTurnId: "t", sendRoute: "control-socket" as const }] };
  const stamp = new Date().toISOString();
  await f.store.createCommandIfAbsent({ commandId, requestId: steerPlanRequestId(CHAT_ID, plan.id), nodeId: NODE_ID,
    sessionId: SESSION_ID, action: "send", prompt: "x", deliveryMode: "steer", expectedTurnId: "t", sendRoute: "control-socket",
    authority: { type: "chat", chatId: CHAT_ID, steerGeneration: 0 }, status: "accepted", turnId: "t",
    createdAt: stamp, updatedAt: stamp, expiresAt: new Date(START_TIME + TTL_SECONDS * 1000).toISOString() });
  const data = LeaderDataSchema.parse({ steerGeneration: 1, memories: { padding: "" },
    history: [{ role: "user", content: "h".repeat(HISTORY_PADDING_CHARS) }, { role: "assistant", content: "old response" }],
    inflight: { messageId, inputHash, expiresAt: START_TIME - 1, plan },
    directContext: { messageId, inputHash, expiresAt: START_TIME + CLAIM_TTL_MS },
  });
  data.memories.padding = "p".repeat(MAX_LEADER_DATA_BYTES - Buffer.byteLength(JSON.stringify(data), "utf8"));
  await f.store.compareAndSetLeaderState(CHAT_ID, 0, data);
  expect(Buffer.byteLength(JSON.stringify(data), "utf8")).toBe(MAX_LEADER_DATA_BYTES);
  const queried = await f.create().direct.call(call("get_command", { commandId }, { messageId: "q".repeat(128) }));
  expect(queried.result).toMatchObject({ commandId, status: "accepted" });
  const recovered = LeaderDataSchema.parse((await f.store.getLeaderState(CHAT_ID))?.data);
  expect(Buffer.byteLength(JSON.stringify(recovered), "utf8")).toBeLessThanOrEqual(MAX_LEADER_DATA_BYTES);
  expect(recovered.history).toEqual([]);
  expect(recovered.commandIds).toContain(commandId);
  expect(recovered.receipts).toContainEqual(expect.objectContaining({ messageId, inputHash, commandId }));
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
  expect(f.model.complete).not.toHaveBeenCalled();
});
