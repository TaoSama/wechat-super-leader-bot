import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { CommandService } from "../../../src/commands/service.js";
import { MemoryStore } from "../../../src/store/memory.js";
import { createExecution, executionRequestId } from "../../../src/leader/plans/execution.js";
import { ExecutionScheduler } from "../../../src/leader/plans/scheduler.js";
import type { Plan } from "../../../src/leader/contracts.js";
import type { ControllerCommandMessage, Session } from "../../../src/types.js";

it("continues a same-session resume plan after loading while preserving route and durable deduplication", async () => {
  const now = Date.now(), store = new MemoryStore();
  const session: Session = { id: "session", provider: "codex-app", title: "fixture", cwd: "/fixture",
    loaded: false, status: "notLoaded", capabilities: ["read", "resume-send"], observedAt: new Date(now).toISOString() };
  const hub = {
    getNodeSession: () => session, getNodeSkills: () => [], isNodeConnected: () => true,
    registerCommandResultWaiter: () => ({ wait: async () => null, cancel: vi.fn() }),
    sendCommand: vi.fn(async (command: ControllerCommandMessage) => {
      await store.updateCommandStatus(command.commandId, "accepted", undefined, undefined, `turn-${command.commandId}`);
      return { delivered: true };
    }),
  };
  const commands = new CommandService(store, hub, 300);
  const plan: Plan = { id: randomUUID(), expiresAt: now + 60_000, actions: [
    { nodeId: "node", sessionId: session.id, prompt: "first", dependsOn: [], sendRoute: "app-server-resume" },
    { nodeId: "node", sessionId: session.id, prompt: "second", dependsOn: [1], sendRoute: "app-server-resume" },
  ] };
  const execution = createExecution("chat", plan, now);
  await store.createExecutionIfAbsent(execution);
  const onError = vi.fn();
  const scheduler = new ExecutionScheduler(store, commands, { now: () => now, onError,
    canDispatch: (current, index) => {
      const action = current.plan.actions[index];
      return commands.canDispatchSend(action, action.sendRoute!);
    } });
  try {
    await scheduler.advance(execution.id);
    expect(hub.sendCommand).toHaveBeenCalledTimes(1);
    const first = (await store.findCommandByRequestId(executionRequestId(execution, 0)))!;
    await store.updateCommandStatus(first.commandId, "completed", "first result", undefined, first.turnId);
    Object.assign(session, { loaded: true, status: "idle", capabilities: ["read", "send", "resume-send"] });
    // Losing resume capability does not claim or silently switch the successor to native send.
    session.capabilities = ["read", "send"];
    await scheduler.advance(execution.id);
    expect((await store.getExecution(execution.id))?.attempts[1]).toBeNull();
    expect(hub.sendCommand).toHaveBeenCalledTimes(1);
    session.capabilities = ["read", "send", "resume-send"];
    await scheduler.advance(execution.id);
    const second = (await store.findCommandByRequestId(executionRequestId(execution, 1)))!;
    expect(second).toMatchObject({ status: "accepted", sendRoute: "app-server-resume", prompt: "second" });
    expect(hub.sendCommand.mock.calls.map(([command]) => command.sendRoute))
      .toEqual(["app-server-resume", "app-server-resume"]);
    await scheduler.advance(execution.id);
    await store.updateCommandStatus(second.commandId, "completed", "second result", undefined, second.turnId);
    await scheduler.advance(execution.id);
    await scheduler.advance(execution.id);
    expect((await store.getExecution(execution.id))?.status).toBe("completed");
    expect(hub.sendCommand).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  } finally { await scheduler.stop(); }
});
