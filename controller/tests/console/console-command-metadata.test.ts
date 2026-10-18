import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { consoleCommandReader } from "../../src/console/command-reader.js";
import { readConsoleExecutions } from "../../src/console/executions.js";
import { readConsoleGoals } from "../../src/console/goals.js";
import { createExecution, executionRequestId, EXECUTION_CLAIM_MS } from "../../src/leader/plans/execution.js";
import { recordedOutput, renderExecutionInput, type ExecutionResultSource } from "../../src/leader/plans/input.js";
import { readExecutionView } from "../../src/leader/plans/view.js";
import { createGoal, goalRequestId, normalizeGoal, renderGoalAction, GOAL_SEND_CLAIM_MS, type GoalRecord } from "../../src/leader/goals/goal.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { CommandRecord } from "../../src/types.js";

const NOW = 1_700_000_000_000;
const LARGE_OUTPUT_BYTES = 8 * 1024 * 1024;
const CHAT = "private-metadata-chat";
const uuid = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const stamp = new Date(NOW).toISOString();

function blockFullReads(store: MemoryStore) {
  return [vi.spyOn(store, "findCommandByRequestId").mockRejectedValue(new Error("Full command lookup is forbidden")),
    vi.spyOn(store, "getCommand").mockRejectedValue(new Error("Full command detail is forbidden")),
    vi.spyOn(store, "listRecentCommands").mockRejectedValue(new Error("Full command windows are forbidden"))];
}

async function executionFixture(output = "parent result") {
  const store = new MemoryStore();
  const execution = createExecution(CHAT, { id: uuid(1), expiresAt: NOW + 60_000, actions: [
    { nodeId: "node", sessionId: "parent", prompt: "parent task", dependsOn: [], sendRoute: "control-socket" },
    { nodeId: "node", sessionId: "child", prompt: "child task", dependsOn: [1], resultFrom: [1], sendRoute: "control-socket" },
  ] }, NOW);
  const source: ExecutionResultSource = {
    step: 1, commandId: "parent-command", turnId: "parent-turn",
    outputSHA256: createHash("sha256").update(output).digest("hex"), outputLength: output.length,
    excerpt: output.slice(0, 1000), truncated: output.length > 1000,
  };
  const input = { prompt: renderExecutionInput("child task", [source]), sources: [source] };
  execution.attempts[0] = { token: uuid(2), startedAt: NOW, expiresAt: NOW + EXECUTION_CLAIM_MS };
  execution.attempts[1] = { token: uuid(3), startedAt: NOW, expiresAt: NOW + EXECUTION_CLAIM_MS, input };
  vi.spyOn(store, "listRecentExecutions").mockResolvedValue([execution]);
  const parent: CommandRecord = {
    commandId: source.commandId, requestId: executionRequestId(execution, 0), nodeId: "node", sessionId: "parent",
    action: "send", prompt: "parent task", sendRoute: "control-socket", status: "completed", turnId: source.turnId,
    output, createdAt: stamp, updatedAt: stamp, expiresAt: stamp,
  };
  const child: CommandRecord = { ...parent, commandId: "child-command", requestId: executionRequestId(execution, 1),
    sessionId: "child", prompt: input.prompt, output: "child result", turnId: "child-turn" };
  await store.createCommandIfAbsent(parent);
  await store.createCommandIfAbsent(child);
  return { store, execution, parent, child, source };
}

afterEach(() => vi.restoreAllMocks());

it("preserves completed parent and frozen child receipts with an 8 MiB parent using metadata reads only", async () => {
  const { store, source } = await executionFixture("x".repeat(LARGE_OUTPUT_BYTES));
  const fullReads = blockFullReads(store);
  const metadata = vi.spyOn(store, "findCommandMetadataByRequestId");
  const result = await readConsoleExecutions(store, [CHAT], NOW, true);
  expect(result.items[0].steps).toMatchObject([
    { status: "completed", commandId: "parent-command", turnId: "parent-turn" },
    { status: "completed", commandId: "child-command", turnId: "child-turn", resultSources: [{
      step: source.step, commandId: source.commandId, turnId: source.turnId, outputSHA256: source.outputSHA256,
      outputLength: LARGE_OUTPUT_BYTES, excerptLength: 1000, truncated: true,
    }] },
  ]);
  expect(metadata).toHaveBeenCalled();
  fullReads.forEach(read => expect(read).not.toHaveBeenCalled());
  const serialized = JSON.stringify(result);
  expect(Buffer.byteLength(serialized)).toBeLessThan(10_000);
  for (const secret of [CHAT, "x".repeat(1000), '"excerpt"', '"input"', '"output"', '"authority"']) expect(serialized).not.toContain(secret);
});

it.each(["commandId", "turnId"] as const)("marks a frozen source with changed %s uncertain and rejects contradictory public provenance", async field => {
  const { store, execution, parent } = await executionFixture();
  const fullReads = blockFullReads(store);
  const original = store.findCommandMetadataByRequestId.bind(store);
  vi.spyOn(store, "findCommandMetadataByRequestId").mockImplementation(async id => {
    const metadata = await original(id);
    return metadata && id === parent.requestId ? { ...metadata, [field]: "changed-source-identity" } : metadata;
  });
  const view = await readExecutionView(consoleCommandReader(store), execution, NOW, true);
  expect(view.steps[1]).toMatchObject({ status: "uncertain", error: "Execution input snapshot is inconsistent" });
  await expect(readConsoleExecutions(store, [CHAT], NOW, true)).rejects.toThrow("Inconsistent execution result sources");
  fullReads.forEach(read => expect(read).not.toHaveBeenCalled());
});

it.each(["nodeId", "sessionId", "prompt", "requestId", "sendRoute"] as const)("keeps command %s validation in metadata mode", async field => {
  const { store, parent } = await executionFixture();
  const fullReads = blockFullReads(store);
  const original = store.findCommandMetadataByRequestId.bind(store);
  vi.spyOn(store, "findCommandMetadataByRequestId").mockImplementation(async id => {
    const metadata = await original(id);
    if (!metadata || id !== parent.requestId) return metadata;
    return { ...metadata, [field]: field === "sendRoute" ? "desktop-owner" : "foreign-identity" };
  });
  const result = await readConsoleExecutions(store, [CHAT], NOW, true);
  expect(result.items[0].steps.map(step => step.status)).toEqual(["uncertain", "uncertain"]);
  fullReads.forEach(read => expect(read).not.toHaveBeenCalled());
});

it("does not accept a completed source whose output was never recorded", async () => {
  const { store, execution, parent } = await executionFixture();
  const fullReads = blockFullReads(store);
  const original = store.findCommandMetadataByRequestId.bind(store);
  vi.spyOn(store, "findCommandMetadataByRequestId").mockImplementation(async id => {
    const metadata = await original(id);
    return metadata && id === parent.requestId ? { ...metadata, hasOutput: false, outputPreview: "", outputTruncated: false } : metadata;
  });
  const view = await readExecutionView(consoleCommandReader(store), execution, NOW, true);
  expect(view.steps[1].status).toBe("uncertain");
  fullReads.forEach(read => expect(read).not.toHaveBeenCalled());
});

it.each(["valid", "commandId", "turnId", "hasOutput"] as const)("preserves completed goal actions and verifies frozen criterion evidence with %s metadata", async variant => {
  const store = new MemoryStore();
  const goal = createGoal(CHAT, { id: uuid(10), expiresAt: NOW + 60_000, objective: "verify goal",
    criteria: ["test passes"], targets: [{ nodeId: "node", sessionId: "goal-thread", sendRoute: "control-socket" }],
    constraints: "private constraints", maxActions: 3, maxDecisions: 5, durationMinutes: 30, shareResults: true }, NOW);
  const prompt = "verify exact target";
  goal.actions.push({ index: 1, target: 1, prompt, sourceActions: [], input: { prompt: renderGoalAction(goal.proposal, prompt, []), sources: [] },
    attempt: { token: uuid(11), startedAt: NOW, expiresAt: NOW + GOAL_SEND_CLAIM_MS } });
  const output = "exact evidence";
  const command: CommandRecord = { commandId: "goal-command", requestId: goalRequestId(goal, 0), nodeId: "node", sessionId: "goal-thread",
    action: "send", prompt: goal.actions[0].input.prompt, sendRoute: "control-socket", status: "completed", turnId: "goal-turn", output,
    createdAt: stamp, updatedAt: stamp, expiresAt: stamp };
  goal.status = "completed";
  goal.decisionAttempts = 1;
  goal.decisions = [{ index: 1, inputSHA256: "a".repeat(64), evidence: [{ action: 1, commandId: command.commandId,
    turnId: command.turnId!, ...recordedOutput(output) }],
    decision: { type: "complete", criteria: [{ criterion: 1, actions: [1] }], reason: "evidence supports completion" } }];
  vi.spyOn(store, "listRecentGoals").mockResolvedValue([goal]);
  await store.createCommandIfAbsent(command);
  expect((await readConsoleGoals(store, [CHAT], NOW)).items[0].criteria[0]).toMatchObject({ supported: true, actions: [1] });
  const fullReads = blockFullReads(store);
  const original = store.findCommandMetadataByRequestId.bind(store);
  const metadata = vi.spyOn(store, "findCommandMetadataByRequestId").mockImplementation(async id => {
    const result = await original(id);
    if (!result || variant === "valid") return result;
    return { ...result, [variant]: variant === "hasOutput" ? false : "changed-evidence-identity" };
  });
  const result = await readConsoleGoals(store, [CHAT], NOW, true);
  expect(result.items[0]).toMatchObject({ status: "completed", actions: [{ status: "completed" }],
    criteria: [{ supported: variant === "valid", actions: variant === "valid" ? [1] : [] }] });
  expect(metadata).toHaveBeenCalledWith(command.requestId);
  fullReads.forEach(read => expect(read).not.toHaveBeenCalled());
  for (const secret of [CHAT, output, "private constraints", '"input"', '"authority"']) expect(JSON.stringify(result)).not.toContain(secret);
});

it.each([false, true])("preserves a claimed plan's queued command with metadataOnly=%s", async metadataOnly => {
  const store = new MemoryStore();
  const execution = createExecution(CHAT, { id: uuid(20), expiresAt: NOW + 60_000, actions: [
    { nodeId: "node", sessionId: "queued-plan", prompt: "queued task", dependsOn: [], sendRoute: "control-socket" },
  ] }, NOW);
  await store.createExecutionIfAbsent(execution);
  execution.attempts[0] = { token: uuid(21), startedAt: NOW, expiresAt: NOW + EXECUTION_CLAIM_MS };
  execution.revision++;
  expect(await store.compareAndSetExecution(execution, 1, NOW)).not.toBeNull();
  await store.createCommandIfAbsent({ commandId: "queued-plan-command", requestId: executionRequestId(execution, 0),
    nodeId: "node", sessionId: "queued-plan", action: "send", prompt: "queued task", sendRoute: "control-socket", status: "queued",
    authority: { type: "plan", id: execution.id, chatId: CHAT }, createdAt: stamp, updatedAt: stamp, expiresAt: stamp });
  const fullReads = metadataOnly ? blockFullReads(store) : [];
  const result = await readConsoleExecutions(store, [CHAT], NOW, metadataOnly);
  expect(result.items[0]).toMatchObject({ status: "active", steps: [{ status: "queued", commandId: "queued-plan-command" }] });
  expect(result.items[0].steps[0]).not.toHaveProperty("turnId");
  fullReads.forEach(read => expect(read).not.toHaveBeenCalled());
});

it.each([false, true])("preserves a goal's queued command with metadataOnly=%s without claiming criterion completion", async metadataOnly => {
  const store = new MemoryStore();
  const goal = createGoal(CHAT, { id: uuid(30), expiresAt: NOW + 60_000, objective: "queued goal",
    criteria: ["test passes"], targets: [{ nodeId: "node", sessionId: "queued-goal", sendRoute: "control-socket" }],
    constraints: "scope", maxActions: 3, maxDecisions: 5, durationMinutes: 30, shareResults: true }, NOW);
  const prompt = "queued goal task";
  goal.actions.push({ index: 1, target: 1, prompt, sourceActions: [], input: { prompt: renderGoalAction(goal.proposal, prompt, []), sources: [] },
    attempt: { token: uuid(31), startedAt: NOW, expiresAt: NOW + GOAL_SEND_CLAIM_MS } });
  const records = (store as unknown as { goals: Map<string, GoalRecord> }).goals;
  records.set(goal.id, normalizeGoal(goal));
  await store.createCommandIfAbsent({ commandId: "queued-goal-command", requestId: goalRequestId(goal, 0),
    nodeId: "node", sessionId: "queued-goal", action: "send", prompt: goal.actions[0].input.prompt, sendRoute: "control-socket", status: "queued",
    authority: { type: "goal", id: goal.id, chatId: CHAT }, createdAt: stamp, updatedAt: stamp, expiresAt: stamp });
  const fullReads = metadataOnly ? blockFullReads(store) : [];
  const result = await readConsoleGoals(store, [CHAT], NOW, metadataOnly);
  expect(result.items[0]).toMatchObject({ status: "active", actions: [{ status: "queued", commandId: "queued-goal-command" }],
    criteria: [{ supported: false, actions: [] }] });
  expect(result.items[0].actions[0]).not.toHaveProperty("turnId");
  fullReads.forEach(read => expect(read).not.toHaveBeenCalled());
});

it.each(["strict", "metadata", "invalid-source"])("validates frozen sources for queued result-sharing steps in %s mode", async variant => {
  const { store, execution, parent, child } = await executionFixture();
  const records = (store as unknown as { commands: Map<string, CommandRecord> }).commands;
  records.set(child.commandId, { ...child, status: "queued", output: undefined, turnId: undefined,
    authority: { type: "plan", id: execution.id, chatId: CHAT } });
  const metadataOnly = variant !== "strict";
  const fullReads = metadataOnly ? blockFullReads(store) : [];
  if (variant === "invalid-source") {
    const original = store.findCommandMetadataByRequestId.bind(store);
    vi.spyOn(store, "findCommandMetadataByRequestId").mockImplementation(async id => {
      const metadata = await original(id);
      return metadata && id === parent.requestId ? { ...metadata, prompt: "foreign task" } : metadata;
    });
  }
  const result = await readConsoleExecutions(store, [CHAT], NOW, metadataOnly);
  expect(result.items[0].steps[1]).toMatchObject({ status: variant === "invalid-source" ? "uncertain" : "queued",
    resultSources: [{ commandId: parent.commandId, turnId: parent.turnId }] });
  if (variant !== "invalid-source") expect(result.items[0].steps[1].commandId).toBe(child.commandId);
  fullReads.forEach(read => expect(read).not.toHaveBeenCalled());
});
