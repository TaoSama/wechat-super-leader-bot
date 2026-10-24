import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { CommandService } from "../../../src/commands/service.js";
import { createExecution, executionRequestId } from "../../../src/leader/plans/execution.js";
import { executionSummary } from "../../../src/leader/plans/presentation.js";
import { ExecutionScheduler } from "../../../src/leader/plans/scheduler.js";
import { MemoryStore } from "../../../src/store/memory.js";
import type { ControllerCommandMessage, Session } from "../../../src/types.js";
import { deferred } from "../../fixtures/goals.js";

const COMMAND_TTL_SECONDS = 60;
const schedulers: ExecutionScheduler[] = [];

afterEach(async () => {
  await Promise.all(schedulers.splice(0).map(scheduler => scheduler.stop()));
  vi.restoreAllMocks();
});

async function fixture() {
  const store = new MemoryStore();
  const now = Date.now();
  const execution = createExecution("chat", { id: randomUUID(), expiresAt: now + COMMAND_TTL_SECONDS * 1000,
    actions: [{ nodeId: "node", sessionId: "session", prompt: "检查资料", dependsOn: [], sendRoute: "control-socket" }] }, now);
  await store.createExecutionIfAbsent(execution);
  const session: Session = { id: "session", title: "检查会话", cwd: "/fixture", provider: "codex-app",
    status: "idle", loaded: true, capabilities: ["send"], observedAt: new Date(now).toISOString() };
  const sendCommand = vi.fn(async (message: ControllerCommandMessage) => {
    await store.updateCommandStatus(message.commandId, "accepted", undefined, undefined, `turn-${message.commandId}`);
    return { delivered: true };
  });
  const hub = { isNodeConnected: () => true, getNodeSkills: () => [], getNodeSession: () => session,
    registerCommandResultWaiter: () => ({ wait: async () => null, cancel: vi.fn() }), sendCommand };
  const commands = new CommandService(store, hub, COMMAND_TTL_SECONDS);
  const errors = vi.fn();
  const create = (service: Pick<CommandService, "submit"> = commands) => {
    const scheduler = new ExecutionScheduler(store, service, { onError: errors, canDispatch: (record, index) => {
      const action = record.plan.actions[index];
      return commands.canDispatchSend(action, action.sendRoute!);
    } });
    schedulers.push(scheduler);
    return scheduler;
  };
  return { store, execution, commands, errors, sendCommand, create, scheduler: create() };
}

it("shows durable queuing in plan summaries and restored queries until the preceding command completes", async () => {
  const f = await fixture();
  const preceding = await f.commands.submit({ nodeId: "node", sessionId: "session", action: "send",
    prompt: "先完成原任务", requestId: "preceding" }, 0, undefined, "control-socket");
  expect(preceding.status).toBe("accepted");
  await f.scheduler.advance(f.execution.id);
  const queued = await f.store.findCommandByRequestId(executionRequestId(f.execution, 0));
  expect(queued).toMatchObject({ status: "queued" });
  const view = (await f.scheduler.view(f.execution.id, "chat"))!;
  expect(view.steps[0]).toMatchObject({ status: "queued", commandId: queued!.commandId });
  expect(executionSummary(view)).toContain("1. [node] 会话 session：已排队，等待会话可用或前序指令结束");
  expect(executionSummary(view)).not.toContain("待核查");
  expect(f.sendCommand).toHaveBeenCalledTimes(1);

  await f.scheduler.stop();
  const restored = f.create();
  await restored.advance(f.execution.id);
  expect(await restored.view(f.execution.id, "chat")).toEqual(view);
  expect(executionSummary((await restored.view(f.execution.id, "chat"))!)).toContain("已排队");
  expect(f.sendCommand).toHaveBeenCalledTimes(1);

  await f.store.updateCommandStatus(preceding.commandId, "completed", "原任务已完成", undefined, preceding.turnId);
  await f.commands.dispatchQueued();
  const dispatched = (await restored.view(f.execution.id, "chat"))!;
  expect(dispatched.steps[0]).toMatchObject({ status: "accepted", commandId: queued!.commandId });
  expect(executionSummary(dispatched)).toContain("已接收，等待完成");
  expect(f.sendCommand).toHaveBeenCalledTimes(2);
  expect(f.errors).not.toHaveBeenCalled();
});

it("describes an admitting command as dispatch validation before any transmission", async () => {
  const f = await fixture();
  const entered = deferred<void>();
  const release = deferred<void>();
  const scheduler = f.create({ submit: (request, wait, guard, route, authority) =>
    f.commands.submit(request, wait, async () => {
      entered.resolve();
      await release.promise;
      await guard?.();
    }, route, authority) });
  const advancing = scheduler.advance(f.execution.id);
  try {
    await entered.promise;
    expect(await f.store.findCommandByRequestId(executionRequestId(f.execution, 0))).toMatchObject({ status: "admitting" });
    const recovered = (await f.create().view(f.execution.id, "chat"))!;
    expect(recovered.steps[0].status).toBe("claimed");
    expect(executionSummary(recovered)).toContain("1. [node] 会话 session：派发校验中，尚未发送");
    expect(executionSummary(recovered)).not.toContain("发送中，等待回执");
    expect(f.sendCommand).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    await advancing;
  }
  expect((await scheduler.view(f.execution.id, "chat"))!.steps[0].status).toBe("accepted");
  expect(f.sendCommand).toHaveBeenCalledTimes(1);
  expect(f.errors).not.toHaveBeenCalled();
});
