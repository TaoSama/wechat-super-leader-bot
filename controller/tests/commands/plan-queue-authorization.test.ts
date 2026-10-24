import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { CommandService } from "../../src/commands/service.js";
import { MemoryStore } from "../../src/store/memory.js";
import { createExecution, executionRequestId, EXECUTION_CLAIM_MS } from "../../src/leader/plans/execution.js";
import { ExecutionScheduler } from "../../src/leader/plans/scheduler.js";
import type { ControllerCommandMessage, Session } from "../../src/types.js";

const START_TIME = Date.parse("2026-10-23T00:00:00Z");
const NODE_ID = "plan-queue-node";
const CHAT_ID = "plan-queue-chat";
const COMMAND_TTL_SECONDS = 300;
const schedulers: ExecutionScheduler[] = [];

async function queuedPlan() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START_TIME);
  const store = new MemoryStore();
  const sessions: Session[] = [0, 1].map(index => ({ id: `session-${index}`, title: "Plan queue fixture",
    provider: "codex-app", cwd: "/fixture", status: "idle", loaded: true, capabilities: ["send"],
    observedAt: new Date().toISOString() }));
  await store.upsertNodeSessions(NODE_ID, sessions);
  const hub = {
    isNodeConnected: () => true,
    getNodeSession: (_nodeId: string, sessionId: string) => sessions.find(session => session.id === sessionId),
    getNodeSkills: () => [],
    registerCommandResultWaiter: () => ({ wait: async () => null, cancel() {} }),
    sendCommand: vi.fn(async (command: ControllerCommandMessage) => {
      await store.updateCommandStatus(command.commandId, "accepted", undefined, undefined, `turn-${command.commandId}`);
      return { delivered: true };
    }),
  };
  const createCommands = () => new CommandService(store, hub, COMMAND_TTL_SECONDS);
  const commands = createCommands();
  const blocker = await commands.submit({ nodeId: NODE_ID, sessionId: sessions[1].id,
    action: "send", prompt: "Earlier independent task", requestId: "plan-queue-blocker" }, 0);
  expect(blocker.status).toBe("accepted");
  const execution = createExecution(CHAT_ID, { id: randomUUID(), expiresAt: START_TIME + 60_000,
    actions: sessions.map(session => ({ nodeId: NODE_ID, sessionId: session.id, prompt: `Task for ${session.id}`,
      sendRoute: "control-socket" as const, dependsOn: [] })) }, START_TIME);
  await store.createExecutionIfAbsent(execution);
  const scheduler = new ExecutionScheduler(store, commands, {
    canDispatch: (current, index) => commands.canDispatchSend(current.plan.actions[index], current.plan.actions[index].sendRoute!),
  });
  schedulers.push(scheduler);
  await scheduler.advance(execution.id);
  const first = (await store.findCommandByRequestId(executionRequestId(execution, 0)))!;
  const queued = (await store.findCommandByRequestId(executionRequestId(execution, 1)))!;
  expect(first.status).toBe("accepted");
  expect(queued.status).toBe("queued");
  expect(sessions[1].status).toBe("idle");
  expect((await store.getExecution(execution.id))?.status).toBe("active");
  const unblock = () => store.updateCommandStatus(blocker.commandId, "completed", "Earlier task done", undefined, blocker.turnId);
  const sent = () => hub.sendCommand.mock.calls.map(([command]) => command.commandId);
  return { store, hub, scheduler, execution, first, queued, blocker, unblock, sent, createCommands };
}

afterEach(async () => {
  await Promise.all(schedulers.splice(0).map(scheduler => scheduler.stop()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["before-claim", "after-claim"] as const)("stops queued plan work after a sibling fails %s without waiting for the plan tick", async timing => {
  const f = await queuedPlan();
  const fail = () => f.store.updateCommandStatus(f.first.commandId, "failed", undefined, "Synthetic sibling failure", f.first.turnId);
  if (timing === "before-claim") await fail();
  else {
    const claim = f.store.claimQueuedCommand.bind(f.store);
    vi.spyOn(f.store, "claimQueuedCommand").mockImplementationOnce(async (...args) => {
      const claimed = await claim(...args);
      expect(claimed?.commandId).toBe(f.queued.commandId);
      await fail();
      return claimed;
    });
  }
  await f.unblock();
  await f.createCommands().dispatchQueued();
  expect((await f.store.getExecution(f.execution.id))?.status).toBe("active");
  expect((await f.store.getCommand(f.queued.commandId))?.status).toBe(timing === "before-claim" ? "cancelled" : "failed");
  expect(f.sent()).toEqual([f.blocker.commandId, f.first.commandId]);
  await f.scheduler.advance(f.execution.id);
  expect((await f.store.getExecution(f.execution.id))?.status).toBe("failed");
});

it.each(["before-claim", "after-claim"] as const)("pauses a queued plan for uncertainty %s and resumes once exact recovery arrives", async timing => {
  const f = await queuedPlan();
  const uncertain = () => f.store.updateCommandStatus(f.first.commandId, "uncertain", undefined, "Synthetic disconnect", f.first.turnId);
  if (timing === "before-claim") await uncertain();
  else {
    const claim = f.store.claimQueuedCommand.bind(f.store);
    vi.spyOn(f.store, "claimQueuedCommand").mockImplementationOnce(async (...args) => {
      const claimed = await claim(...args);
      await uncertain();
      return claimed;
    });
  }
  await f.unblock();
  await f.createCommands().dispatchQueued();
  expect(await f.store.getCommand(f.queued.commandId)).toMatchObject({ status: "queued", queueOrder: f.queued.queueOrder });
  expect(f.sent()).toEqual([f.blocker.commandId, f.first.commandId]);
  await f.store.updateCommandStatus(f.first.commandId, "completed", "Exact recovered result", undefined, f.first.turnId);
  vi.setSystemTime(START_TIME + EXECUTION_CLAIM_MS + 1);
  await f.createCommands().dispatchQueued();
  await f.createCommands().dispatchQueued();
  expect((await f.store.getCommand(f.queued.commandId))?.status).toBe("accepted");
  expect(f.sent()).toEqual([f.blocker.commandId, f.first.commandId, f.queued.commandId]);
});

it("keeps independent queued work authorized after its admission claim expires while a sibling is still running", async () => {
  const f = await queuedPlan();
  await f.unblock();
  vi.setSystemTime(START_TIME + EXECUTION_CLAIM_MS + 1);
  await f.createCommands().dispatchQueued();
  expect((await f.store.getCommand(f.first.commandId))?.status).toBe("accepted");
  expect((await f.store.getCommand(f.queued.commandId))?.status).toBe("accepted");
  expect(f.sent()).toEqual([f.blocker.commandId, f.first.commandId, f.queued.commandId]);
});
