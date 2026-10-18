import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { CommandService } from "../../src/commands/service.js";
import { createExecution, executionRequestId } from "../../src/leader/plans/execution.js";
import { ExecutionScheduler } from "../../src/leader/plans/scheduler.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { CommandRecord, ControllerCommandMessage, Session } from "../../src/types.js";
import { fixture as goalFixture, nextDecision, schedulers as goalSchedulers } from "../fixtures/goals.js";

const START_TIME = Date.parse("2026-10-18T00:00:00.000Z");
const COMMAND_TTL_SECONDS = 60;
const FAILURE_REASON = `无法执行已确认的检查：${"完整失败原因与证据；".repeat(160)}最后一条诊断必须保留。`;
const executionSchedulers: ExecutionScheduler[] = [];
const terminalStatuses = ["cancelled", "expired", "failed"] as const;
type TerminalStatus = typeof terminalStatuses[number];

afterEach(async () => {
  await Promise.all([...executionSchedulers.splice(0), ...goalSchedulers.splice(0)].map(scheduler => scheduler.stop()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function useClock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START_TIME);
}

async function terminate(commands: CommandService, store: MemoryStore, command: CommandRecord, status: TerminalStatus) {
  if (status === "cancelled") await commands.cancel(command.commandId);
  else if (status === "expired") {
    vi.setSystemTime(Date.parse(command.expiresAt));
    await store.markExpiredActiveCommandsUncertain();
  } else await store.updateCommandStatus(command.commandId, "failed", undefined, FAILURE_REASON);
  expect(await store.getCommand(command.commandId)).toMatchObject({ status });
}

function assertReason(text: string, status: TerminalStatus) {
  if (status === "failed") expect(text).toContain(FAILURE_REASON);
  else expect(text).toMatch(status === "cancelled" ? /取消|cancelled/u : /过期|到期|expired/u);
}

async function planFixture() {
  useClock();
  const store = new MemoryStore();
  const execution = createExecution("chat", { id: randomUUID(), expiresAt: START_TIME + 60_000, actions: [
    { nodeId: "node", sessionId: "original", prompt: "检查原始资料", dependsOn: [], sendRoute: "control-socket" },
    { nodeId: "node", sessionId: "downstream", prompt: "仅在检查完成后汇总", dependsOn: [1], sendRoute: "control-socket" },
  ] }, START_TIME);
  await store.createExecutionIfAbsent(execution);
  const session: Session = { id: "original", title: "原始会话", cwd: "/fixture", provider: "codex-app",
    observedAt: new Date().toISOString(), status: "idle", loaded: true, capabilities: ["read", "send"] };
  const sendCommand = vi.fn(async (_message: ControllerCommandMessage) => ({ delivered: true }));
  const hub = { isNodeConnected: () => true, getNodeSkills: () => [], getNodeSession: () => session,
    registerCommandResultWaiter: () => ({ wait: async () => null, cancel: vi.fn() }), sendCommand };
  const commands = new CommandService(store, hub, COMMAND_TTL_SECONDS);
  const errors = vi.fn();
  const create = () => {
    const scheduler = new ExecutionScheduler(store, {
      submit: (request, wait, guard, route, authority) => {
        session.status = "active";
        return commands.submit(request, wait, guard, route, authority);
      },
    }, { now: Date.now, onError: errors, canDispatch: (record, index) => {
      const action = record.plan.actions[index];
      return commands.canDispatchSend(action, action.sendRoute!);
    } });
    executionSchedulers.push(scheduler);
    return scheduler;
  };
  const scheduler = create();
  await scheduler.advance(execution.id);
  const command = (await store.findCommandByRequestId(executionRequestId(execution, 0)))!;
  expect(command).toMatchObject({ status: "queued" });
  return { store, commands, execution, scheduler, command, create, errors, sendCommand, session };
}

it.each(terminalStatuses)("stops a plan immediately when its durable queued command becomes %s", async status => {
  const f = await planFixture();
  await terminate(f.commands, f.store, f.command, status);
  expect(f.execution.expiresAt).toBeGreaterThan(Date.now());
  const restored = f.create();
  await restored.advance(f.execution.id);
  expect(await f.store.getExecution(f.execution.id)).toMatchObject({ status: "failed", attempts: [expect.any(Object), null] });
  expect(await f.store.findCommandByRequestId(executionRequestId(f.execution, 1))).toBeNull();
  expect(await restored.view(f.execution.id, "chat")).toMatchObject({ steps: [{ status }, { status: "failed" }] });
  f.session.status = "idle";
  await f.commands.dispatchQueued();
  await restored.advance(f.execution.id);
  expect(f.sendCommand).not.toHaveBeenCalled();
  const notification = await f.store.getNotification(f.execution.id, Date.now());
  expect(notification).toMatchObject({ source: { type: "plan", id: f.execution.id }, kind: "failed", status: "pending" });
  assertReason(notification!.text, status);
  expect(f.errors).not.toHaveBeenCalled();
});

it.each(terminalStatuses)("blocks a goal without another model decision when its durable queued command becomes %s", async status => {
  useClock();
  const decide = vi.fn(async () => nextDecision());
  const f = await goalFixture(decide);
  await f.scheduler.advance(f.goal.id);
  const restored = f.create(undefined, { submit: (request, wait, guard, route, authority) => {
    f.setReady(false);
    return f.commands.submit(request, wait, guard, route, authority);
  } });
  await restored.advance(f.goal.id);
  const command = await f.command(0);
  expect(command).toMatchObject({ status: "queued" });
  await terminate(f.commands, f.store, command, status);
  f.tick(Date.now() - f.now());
  expect(f.goal.expiresAt).toBeGreaterThan(f.now());
  await f.create().advance(f.goal.id);
  expect(await f.current()).toMatchObject({ status: "blocked", blockedReason: "result_unavailable_or_failed", decisionAttempts: 1 });
  f.setReady(true);
  await f.commands.dispatchQueued();
  await f.create().advance(f.goal.id);
  expect((await f.current()).actions).toHaveLength(1);
  expect(decide).toHaveBeenCalledTimes(1);
  expect(f.sendCommand).not.toHaveBeenCalled();
  const notification = await f.store.getNotification(f.goal.id, f.now());
  expect(notification).toMatchObject({ source: { type: "goal", id: f.goal.id }, kind: "blocked", status: "pending" });
  assertReason(notification!.text, status);
  expect(f.errors).not.toHaveBeenCalled();
});
