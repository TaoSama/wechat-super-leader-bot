import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { consoleCommandReader } from "../../src/console/command-reader.js";
import { readConsoleExecutions } from "../../src/console/executions.js";
import { readConsoleGoals } from "../../src/console/goals.js";
import { createExecution, executionRequestId, EXECUTION_CLAIM_MS } from "../../src/leader/plans/execution.js";
import { recordedOutput, renderExecutionInput, type ExecutionResultSource } from "../../src/leader/plans/input.js";
import { readExecutionView } from "../../src/leader/plans/view.js";
import { createGoal, goalRequestId, renderGoalAction, GOAL_SEND_CLAIM_MS } from "../../src/leader/goals/goal.js";
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

it("keeps completed goal actions visible but leaves criterion support unverified without output hashes", async () => {
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
  const metadata = vi.spyOn(store, "findCommandMetadataByRequestId");
  const result = await readConsoleGoals(store, [CHAT], NOW, true);
  expect(result.items[0]).toMatchObject({ status: "completed", actions: [{ status: "completed", commandId: "goal-command", turnId: "goal-turn" }],
    criteria: [{ supported: false, actions: [] }] });
  expect(metadata).toHaveBeenCalledWith(command.requestId);
  fullReads.forEach(read => expect(read).not.toHaveBeenCalled());
  for (const secret of [CHAT, output, "private constraints", '"input"', '"authority"']) expect(JSON.stringify(result)).not.toContain(secret);
});
