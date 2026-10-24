import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { CommandService } from "../../src/commands/service.js";
import { isPlanCommandAuthorized } from "../../src/commands/plan-authorization.js";
import { createExecution, executionRequestId, EXECUTION_CLAIM_MS } from "../../src/leader/plans/execution.js";
import { collectExecutionInput } from "../../src/leader/plans/input-source.js";
import * as executionInput from "../../src/leader/plans/input.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { CommandRecord, Session } from "../../src/types.js";

const STEP_COUNT = 4;
const OUTPUT_LENGTH = 2500;
const COMMAND_TTL_SECONDS = 300;

async function densePlan() {
  const store = new MemoryStore(), now = Date.now(), stamp = new Date(now).toISOString();
  const sessions: Session[] = Array.from({ length: STEP_COUNT }, (_, index) => ({ id: `session-${index}`,
    title: "Result dependency fixture", provider: "codex-app", cwd: "/fixture", status: "idle", loaded: true,
    capabilities: ["send"], observedAt: stamp }));
  const execution = createExecution("plan-auth-chat", { id: randomUUID(), expiresAt: now + 60_000,
    actions: sessions.map((session, index) => {
      const predecessors = Array.from({ length: index }, (_, parent) => parent + 1);
      return { nodeId: "node", sessionId: session.id, prompt: `Task ${index + 1}`, sendRoute: "control-socket" as const,
        dependsOn: predecessors, ...(index ? { resultFrom: predecessors } : {}) };
    }) }, now);
  const authority = { type: "plan" as const, id: execution.id, chatId: execution.chatId };
  const commands: CommandRecord[] = [];
  await store.createExecutionIfAbsent(execution);
  for (const [index, action] of execution.plan.actions.entries()) {
    const input = await collectExecutionInput(store, execution, index);
    execution.attempts[index] = { token: randomUUID(), startedAt: now, expiresAt: now + EXECUTION_CLAIM_MS,
      ...(input ? { input } : {}) };
    const revision = execution.revision++;
    expect(await store.compareAndSetExecution(execution, revision)).not.toBeNull();
    const final = index === STEP_COUNT - 1;
    const command: CommandRecord = { commandId: `command-${index}`, requestId: executionRequestId(execution, index),
      nodeId: action.nodeId, sessionId: action.sessionId, action: "send", prompt: input?.prompt ?? action.prompt,
      sendRoute: action.sendRoute, authority, status: final ? "queued" : "completed",
      ...(!final ? { output: `Result ${index}:` + "x".repeat(OUTPUT_LENGTH), turnId: `turn-${index}` } : {}),
      createdAt: stamp, updatedAt: stamp, expiresAt: new Date(now + COMMAND_TTL_SECONDS * 1000).toISOString() };
    await store.createCommandIfAbsent(command);
    commands.push(command);
  }
  await store.upsertNodeSessions("node", sessions);
  const queued = commands.at(-1)!;
  const authorize = () => isPlanCommandAuthorized(store, queued, authority);
  const cancel = () => store.compareAndSetExecution({ ...execution, revision: execution.revision + 1, status: "cancelled" }, execution.revision);
  return { store, execution, commands, queued, sessions, authorize, cancel };
}

afterEach(() => vi.restoreAllMocks());

it("reads each command and samples each source once per authorization of a dense four-step plan", async () => {
  const f = await densePlan();
  const reads = vi.spyOn(f.store, "findCommandByRequestId");
  const executions = vi.spyOn(f.store, "getExecution");
  const samples = vi.spyOn(executionInput, "recordedOutput");
  expect(await f.authorize()).toBe(true);
  expect.soft(reads).toHaveBeenCalledTimes(STEP_COUNT);
  expect.soft(new Set(reads.mock.calls.map(([id]) => id)).size).toBe(STEP_COUNT);
  expect.soft(samples).toHaveBeenCalledTimes(STEP_COUNT - 1);
  expect(executions).toHaveBeenCalledTimes(2);
});

it.each(["failed", "uncertain", "output", "turn"] as const)("resamples changed source %s on the next authorization", async change => {
  const f = await densePlan(), find = f.store.findCommandByRequestId.bind(f.store);
  let changed = false;
  const reads = vi.spyOn(f.store, "findCommandByRequestId").mockImplementation(async id => {
    const command = await find(id);
    if (!changed || id !== f.commands[0].requestId || !command) return command;
    return { ...command, ...(change === "output" ? { output: command.output + "changed" } :
      change === "turn" ? { turnId: "different-exact-turn" } : { status: change }) };
  });
  expect(await f.authorize()).toBe(true);
  changed = true;
  expect(await f.authorize()).toBe(change === "failed" ? false : "paused");
  changed = false;
  expect(await f.authorize()).toBe(true);
  expect(reads).toHaveBeenCalledTimes(STEP_COUNT * 3);
});

it("rechecks cancellation after asynchronous receipt reads", async () => {
  const f = await densePlan(), find = f.store.findCommandByRequestId.bind(f.store);
  vi.spyOn(f.store, "findCommandByRequestId").mockImplementationOnce(async id => {
    const command = await find(id);
    expect(await f.cancel()).not.toBeNull();
    return command;
  });
  expect(await f.authorize()).toBe(false);
  expect((await f.store.getExecution(f.execution.id))?.status).toBe("cancelled");
});

it.each(["output", "uncertain", "cancelled"] as const)("uses fresh source proofs after queue claim when %s changes", async change => {
  const f = await densePlan(), find = f.store.findCommandByRequestId.bind(f.store);
  let changed = false;
  const reads = vi.spyOn(f.store, "findCommandByRequestId").mockImplementation(async id => {
    const command = await find(id);
    if (!changed || id !== f.commands[0].requestId || !command) return command;
    return { ...command, ...(change === "output" ? { output: command.output + "changed" } :
      change === "uncertain" ? { status: "uncertain" as const } : {}) };
  });
  const claim = f.store.claimQueuedCommand.bind(f.store);
  vi.spyOn(f.store, "claimQueuedCommand").mockImplementationOnce(async (...args) => {
    const claimed = await claim(...args);
    expect(claimed?.commandId).toBe(f.queued.commandId);
    if (change === "cancelled") expect(await f.cancel()).not.toBeNull();
    else changed = true;
    return claimed;
  });
  const hub = { isNodeConnected: () => true, getNodeSkills: () => [],
    getNodeSession: (_node: string, id: string) => f.sessions.find(session => session.id === id),
    registerCommandResultWaiter: () => ({ wait: async () => null, cancel() {} }),
    sendCommand: vi.fn(async () => ({ delivered: true })) };
  await new CommandService(f.store, hub, COMMAND_TTL_SECONDS).dispatchQueued();
  expect(hub.sendCommand).not.toHaveBeenCalled();
  expect((await f.store.getCommand(f.queued.commandId))?.status).toBe(change === "cancelled" ? "failed" : "queued");
  expect(reads).toHaveBeenCalledTimes(STEP_COUNT * (change === "cancelled" ? 1 : 2));
});
