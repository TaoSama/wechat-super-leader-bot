import { expect, it, vi } from "vitest";
import { MemoryStore } from "../src/store/memory.js";
import { createExecution, executionRequestId, EXECUTION_CLAIM_MS, type ExecutionRecord } from "../src/leader/execution.js";
import { readConsoleExecutions, CONSOLE_EXECUTION_LIMIT } from "../src/console/executions.js";
import type { CommandRecord } from "../src/types.js";

const NOW = 1_700_000_000_000;
const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
function execution(index = 1, chatId = "allowed", prompts = ["first", "second"]): ExecutionRecord {
  return createExecution(chatId, { id: uuid(index), expiresAt: NOW + 600_000,
    actions: prompts.map((prompt, action) => ({ nodeId: action % 2 ? "mini" : "air", sessionId: `session-${action}`,
      prompt, dependsOn: action ? [action] : [], sendRoute: "control-socket" })) }, NOW);
}
async function seed(store: MemoryStore, record: ExecutionRecord, status: ExecutionRecord["status"] = "active", claimSteps: number[] = []) {
  await store.createExecutionIfAbsent(record);
  if (status === "active" && !claimSteps.length) return record;
  const updated = { ...structuredClone(record), revision: 2, status };
  for (const index of claimSteps) updated.attempts[index] = { token: uuid(100 + index), startedAt: NOW, expiresAt: NOW + EXECUTION_CLAIM_MS };
  await store.compareAndSetExecution(updated, 1);
  return updated;
}
async function command(store: MemoryStore, record: ExecutionRecord, index: number, status: CommandRecord["status"], turnId?: string) {
  const action = record.plan.actions[index];
  const value: CommandRecord = { commandId: `command-${record.id}-${index}`, requestId: executionRequestId(record, index),
    nodeId: action.nodeId, sessionId: action.sessionId, action: "send", prompt: action.prompt, sendRoute: action.sendRoute,
    skills: action.skills, status, turnId, output: "secret raw output", error: "secret raw error",
    expiresAt: new Date(NOW + 600_000).toISOString(), createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() };
  await store.createCommandIfAbsent(value);
  return value;
}

it("is bounded to twelve plans/four steps, computes hasMore and expands only displayed records", async () => {
  const store = new MemoryStore();
  for (let index = 1; index <= 15; index++) await seed(store, execution(index, `allowed-${index}`, ["one", "two", "three", "four"]));
  await seed(store, execution(99, "forbidden"));
  const allowed = Array.from({ length: 15 }, (_, index) => `allowed-${index + 1}`);
  const reads = vi.spyOn(store, "findCommandByRequestId");
  const result = await readConsoleExecutions(store, allowed, NOW);
  expect(result).toMatchObject({ observedAt: NOW, limit: 12, hasMore: true });
  expect(result.items).toHaveLength(CONSOLE_EXECUTION_LIMIT);
  expect(result.items[0].id).toBe(uuid(15));
  expect(result.items.every(item => item.steps.length === 4)).toBe(true);
  expect(reads).toHaveBeenCalledTimes(CONSOLE_EXECUTION_LIMIT * 4);
  expect((await readConsoleExecutions(store, allowed.slice(0, 12), NOW)).hasMore).toBe(false);
  expect(await readConsoleExecutions(store, [], NOW)).toEqual({ observedAt: NOW, limit: 12, hasMore: false, items: [] });
});

it("uses an explicit whitelist and truncates prompts by Unicode code points without losing dependencies", async () => {
  const store = new MemoryStore();
  const record = execution(1, "private-chat", ["a".repeat(512), "a".repeat(510) + "🙂" + "suffix"]);
  const claimed = await seed(store, record, "active", [0]);
  await command(store, claimed, 0, "accepted", "exact-turn");
  const result = await readConsoleExecutions(store, ["private-chat"], NOW);
  const item = result.items[0];
  expect(Object.keys(item).sort()).toEqual(["createdAt", "expiresAt", "id", "status", "steps"]);
  expect(Object.keys(item.steps[0]).sort()).toEqual(["commandId", "dependsOn", "nodeId", "prompt", "promptTruncated", "resultFrom", "sessionId", "status", "step", "turnId"]);
  expect(item.steps[0]).toMatchObject({ status: "accepted", promptTruncated: false, turnId: "exact-turn" });
  expect(item.steps[1]).toMatchObject({ prompt: "a".repeat(510) + "🙂s", promptTruncated: true, dependsOn: [1] });
  expect(Array.from(item.steps[1].prompt)).toHaveLength(512);
  const json = JSON.stringify(result);
  for (const secret of ["private-chat", "secret raw output", "secret raw error", "attempts", "token", "requestId", "skills", "plan"])
    expect(json).not.toContain(secret);
});

it("reads exact old commands outside recent fifty and never claims, advances or submits", async () => {
  const store = new MemoryStore();
  const record = await seed(store, execution(), "active", [0]);
  const original = await command(store, record, 0, "completed", "old-exact-turn");
  for (let index = 0; index < 60; index++) await store.createCommandIfAbsent({ ...original,
    commandId: `noise-${index}`, requestId: `noise-${index}`, createdAt: new Date(NOW + index + 1).toISOString() });
  expect((await store.listRecentCommands(50)).some(value => value.commandId === original.commandId)).toBe(false);
  const writes = [vi.spyOn(store, "compareAndSetExecution"), vi.spyOn(store, "createExecutionIfAbsent"), vi.spyOn(store, "createCommandIfAbsent")];
  const recent = vi.spyOn(store, "listRecentCommands");
  const result = await readConsoleExecutions(store, ["allowed"], NOW);
  expect(result.items[0]).toMatchObject({ status: "active", steps: [{ status: "completed", turnId: "old-exact-turn" }, { status: "waiting" }] });
  for (const spy of [...writes, recent]) expect(spy).not.toHaveBeenCalled();
  expect(await store.getExecution(record.id)).toEqual(record);
});

it("preserves cancelled/failed/expired plan receipts and treats accepted, claimed and uncertain as non-completion", async () => {
  for (const status of ["active", "cancelled", "failed", "expired"] as const) {
    const store = new MemoryStore();
    const record = await seed(store, execution(), status, [0]);
    await command(store, record, 0, "accepted", "running-turn");
    const result = await readConsoleExecutions(store, ["allowed"], NOW);
    expect(result.items[0]).toMatchObject({ status, steps: [{ status: "accepted", turnId: "running-turn" },
      { status: status === "active" ? "waiting" : status }] });
  }
  const store = new MemoryStore();
  const record = await seed(store, execution(), "active", [0]);
  expect((await readConsoleExecutions(store, ["allowed"], NOW)).items[0].steps[0].status).toBe("claimed");
  expect((await readConsoleExecutions(store, ["allowed"], NOW + EXECUTION_CLAIM_MS)).items[0].steps[0].status).toBe("uncertain");
  await command(store, record, 0, "completed");
  expect((await readConsoleExecutions(store, ["allowed"], NOW)).items[0].steps[0].status).toBe("uncertain");
});

it("keeps persisted active status even after authorization expiry instead of mutating or inventing a terminal result", async () => {
  const store = new MemoryStore();
  const record = await seed(store, execution());
  const result = await readConsoleExecutions(store, ["allowed"], record.expiresAt);
  expect(result).toMatchObject({ observedAt: record.expiresAt, items: [{ status: "active", expiresAt: record.expiresAt, steps: [{ status: "waiting" }, { status: "waiting" }] }] });
  expect(await store.getExecution(record.id)).toEqual(record);
});

it("fails explicitly for malformed records, unauthorized data, invalid clocks and unsupported command status", async () => {
  const store = new MemoryStore();
  const record = execution();
  for (const values of [[{ ...record, attempts: [] }], [execution(1, "forbidden")], Array(14).fill(record)]) {
    const spy = vi.spyOn(store, "listRecentExecutions").mockResolvedValueOnce(values);
    await expect(readConsoleExecutions(store, ["allowed"], NOW)).rejects.toThrow();
    spy.mockRestore();
  }
  for (const now of [-1, NaN, 1.5]) await expect(readConsoleExecutions(store, ["allowed"], now)).rejects.toThrow();
  const claimed = await seed(store, record, "active", [0]);
  const exact = await command(store, claimed, 0, "accepted", "turn");
  vi.spyOn(store, "findCommandByRequestId").mockResolvedValueOnce({ ...exact, status: "corrupted" as CommandRecord["status"] });
  await expect(readConsoleExecutions(store, ["allowed"], NOW)).rejects.toThrow();
});
