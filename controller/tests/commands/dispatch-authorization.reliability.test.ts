import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { CommandService } from "../../src/commands/service.js";
import { publicCommand, commandSummary } from "../../src/commands/public.js";
import { MemoryStore } from "../../src/store/memory.js";
import { createExecution, executionRequestId, EXECUTION_CLAIM_MS } from "../../src/leader/plans/execution.js";
import { ExecutionScheduler } from "../../src/leader/plans/scheduler.js";
import type { ControllerCommandMessage, Session } from "../../src/types.js";

const TTL_SECONDS = 300;
const START_TIME = Date.parse("2026-10-23T00:00:00Z");
const NODE_ID = "synthetic-node";
const input = { nodeId: NODE_ID, sessionId: "session-0", action: "send" as const,
  prompt: "Synthetic regression task", requestId: "synthetic-request" };
const schedulers: ExecutionScheduler[] = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(ttlSeconds = TTL_SECONDS) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START_TIME);
  const store = new MemoryStore();
  const sessions: Session[] = [0, 1].map(index => ({ id: `session-${index}`, title: "Synthetic session",
    provider: "codex-app", cwd: "/synthetic", status: "idle", loaded: true,
    observedAt: new Date().toISOString(), capabilities: ["read", "send"] }));
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
  const createCommands = () => new CommandService(store, hub, ttlSeconds);
  return { store, sessions, hub, commands: createCommands(), createCommands };
}

async function queuedPlan() {
  const f = await fixture();
  const execution = createExecution("synthetic-chat", { id: randomUUID(), expiresAt: START_TIME + 60_000,
    actions: f.sessions.map(session => ({ nodeId: NODE_ID, sessionId: session.id,
      prompt: `Synthetic task for ${session.id}`, sendRoute: "control-socket" as const, dependsOn: [] })) }, START_TIME);
  await f.store.createExecutionIfAbsent(execution);
  const scheduler = new ExecutionScheduler(f.store, f.commands, { now: Date.now,
    canDispatch: (_execution, index) => {
      const action = execution.plan.actions[index];
      const ready = f.commands.canDispatchSend(action, action.sendRoute!);
      // The target becomes busy after production preflight but before the durable submit.
      if (index === 1) f.sessions[1].status = "active";
      return ready;
    } });
  schedulers.push(scheduler);
  await scheduler.advance(execution.id);
  const first = (await f.store.findCommandByRequestId(executionRequestId(execution, 0)))!;
  const queued = (await f.store.findCommandByRequestId(executionRequestId(execution, 1)))!;
  expect(first.status).toBe("accepted");
  expect(queued.status).toBe("queued");
  f.sessions[1].status = "idle";
  return { ...f, scheduler, execution, first, queued };
}

afterEach(async () => {
  await Promise.all(schedulers.splice(0).map(scheduler => scheduler.stop()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("keeps a real scheduler guard's command unclaimable until that guard rejects its expired attempt", async () => {
  const f = await fixture();
  let now = START_TIME;
  const execution = createExecution("synthetic-chat", { id: randomUUID(), expiresAt: now + 60_000,
    actions: [{ nodeId: NODE_ID, sessionId: input.sessionId, prompt: input.prompt, sendRoute: "control-socket", dependsOn: [] }] }, now);
  await f.store.createExecutionIfAbsent(execution);
  const entered = deferred(), release = deferred();
  let blockGuard = false;
  const create = f.store.createCommandIfAbsent.bind(f.store);
  vi.spyOn(f.store, "createCommandIfAbsent").mockImplementation(async command => {
    const result = await create(command);
    blockGuard = true;
    return result;
  });
  const getExecution = f.store.getExecution.bind(f.store);
  vi.spyOn(f.store, "getExecution").mockImplementation(async id => {
    if (blockGuard) { blockGuard = false; entered.resolve(); await release.promise; }
    return getExecution(id);
  });
  const errors = vi.fn();
  const scheduler = new ExecutionScheduler(f.store, f.commands, { now: () => now, onError: errors });
  schedulers.push(scheduler);
  const advancing = scheduler.advance(execution.id);
  try {
    await entered.promise;
    const saved = (await f.store.findCommandByRequestId(executionRequestId(execution, 0)))!;
    expect(saved.status).toBe("preparing");
    expect(publicCommand(saved).status).toBe("pending");
    expect(commandSummary(saved).status).toBe("pending");
    expect(await f.store.claimQueuedCommand(saved.commandId, "control-socket")).toBeNull();
    now += EXECUTION_CLAIM_MS + 1;
    await f.createCommands().dispatchQueued();
    expect(f.hub.sendCommand).not.toHaveBeenCalled();
  } finally { release.resolve(); await advancing; }
  expect(errors.mock.calls[0][0]).toMatchObject({ message: "Execution dispatch authority is unavailable" });
  expect((await f.store.findCommandByRequestId(executionRequestId(execution, 0)))?.status).toBe("failed");
  expect((await f.store.getExecution(execution.id))?.status).toBe("failed");
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("does not let concurrent retries or another service publish an in-flight guard", async () => {
  const f = await fixture();
  const entered = deferred(), release = deferred();
  const submitting = f.commands.submit(input, 0, async () => { entered.resolve(); await release.promise; });
  let originalId = "";
  try {
    await entered.promise;
    const retryGuard = vi.fn();
    const repeated = await f.createCommands().submit(input, 0, retryGuard);
    originalId = repeated.commandId;
    expect(repeated.status).toBe("preparing");
    expect(retryGuard).not.toHaveBeenCalled();
    await f.createCommands().dispatchQueued();
    expect(f.hub.sendCommand).not.toHaveBeenCalled();
  } finally { release.resolve(); await submitting; }
  await f.createCommands().dispatchQueued();
  expect(await f.commands.submit(input, 0)).toMatchObject({ commandId: originalId, status: "accepted" });
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});

it.each(["restart", "expiry"] as const)("cannot publish or resend a preparation interrupted by %s", async interruption => {
  const f = await fixture(1);
  const entered = deferred(), release = deferred();
  const submitting = f.commands.submit(input, 0, async () => { entered.resolve(); await release.promise; });
  try {
    await entered.promise;
    if (interruption === "restart") await f.store.init();
    else vi.setSystemTime(START_TIME + 1_000);
  } finally { release.resolve(); await submitting; }
  const result = await f.createCommands().submit(input, 0);
  expect(result.status).toBe(interruption === "restart" ? "failed" : "expired");
  await f.createCommands().dispatchQueued();
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("retains session FIFO while an earlier guard is still preparing", async () => {
  const f = await fixture();
  const entered = deferred(), release = deferred();
  const submitting = f.commands.submit(input, 0, async () => { entered.resolve(); await release.promise; });
  let laterId = "";
  try {
    await entered.promise;
    const later = await f.commands.submit({ ...input, requestId: "later", prompt: "Later task" }, 0);
    laterId = later.commandId;
    expect(later.status).toBe("queued");
    await f.createCommands().dispatchQueued();
    expect(f.hub.sendCommand).not.toHaveBeenCalled();
  } finally { release.resolve(); await submitting; }
  const first = (await f.store.findCommandByRequestId(input.requestId))!;
  await f.store.updateCommandStatus(first.commandId, "completed", "Done", undefined, first.turnId);
  await f.createCommands().dispatchQueued();
  expect(f.hub.sendCommand.mock.calls.map(([command]) => command.commandId)).toEqual([first.commandId, laterId]);
});

it("cancels a queued independent plan step before the next scheduler tick when a sibling failed", async () => {
  const f = await queuedPlan();
  await f.store.updateCommandStatus(f.first.commandId, "failed", undefined, "Synthetic failure", f.first.turnId);
  expect((await f.store.getExecution(f.execution.id))?.status).toBe("active");
  await f.createCommands().dispatchQueued();
  expect((await f.store.getCommand(f.queued.commandId))?.status).toBe("cancelled");
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
  await f.scheduler.advance(f.execution.id);
  expect((await f.store.getExecution(f.execution.id))?.status).toBe("failed");
});

it.each(["before-claim", "after-claim"] as const)("pauses queued plan work when uncertainty appears %s and sends once after exact recovery", async timing => {
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
  await f.createCommands().dispatchQueued();
  expect(await f.store.getCommand(f.queued.commandId)).toMatchObject({ status: "queued", queueOrder: f.queued.queueOrder });
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
  await f.store.updateCommandStatus(f.first.commandId, "completed", "Exact recovered result", undefined, f.first.turnId);
  // Admission of already approved queued work outlives the scheduler's short claim lease.
  vi.setSystemTime(START_TIME + EXECUTION_CLAIM_MS + 1);
  await f.createCommands().dispatchQueued();
  await f.createCommands().dispatchQueued();
  expect((await f.store.getCommand(f.queued.commandId))?.status).toBe("accepted");
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(2);
});
