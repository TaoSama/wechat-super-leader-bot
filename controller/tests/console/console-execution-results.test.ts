import { beforeEach, expect, it, vi } from "vitest";
import { ConsoleExecutionsSchema, readConsoleExecutions } from "../../src/console/executions.js";
import { executionSummary } from "../../src/leader/plans/presentation.js";
import { createExecution } from "../../src/leader/plans/execution.js";
import type { ExecutionView } from "../../src/leader/plans/view.js";
import { MemoryStore } from "../../src/store/memory.js";

const mocked = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../../src/leader/plans/view.js", () => ({ readExecutionView: mocked.read }));
const NOW = 1_700_000_000_000;
const ID = "00000000-0000-4000-8000-000000000001";
const source = (step = 1, outputLength = 2000, excerptLength = 1000) => ({ step, commandId: `command-${step}`,
  turnId: `turn-${step}`, outputSHA256: "a".repeat(64), outputLength, excerptLength, truncated: excerptLength < outputLength });
function view(): ExecutionView {
  return { id: ID, chatId: "private-chat", status: "active", createdAt: NOW, expiresAt: NOW + 60_000,
    steps: [1, 2, 3, 4].map(step => ({ step, nodeId: "node", sessionId: `session-${step}`, prompt: "original task",
      dependsOn: step === 4 ? [1, 2, 3] : [], resultFrom: step === 4 ? [3, 1, 2] : [],
      status: step === 4 ? "claimed" : "completed", ...(step === 4 ? { resultSources: [source(3, 0, 0), source(1), source(2, 4, 4)] } :
        { commandId: `command-${step}`, turnId: `turn-${step}` }), output: "secret output", error: "secret error" })) };
}
function dto() {
  const value = view();
  return { observedAt: NOW, limit: 12, hasMore: false, items: [{ id: value.id, status: value.status,
    createdAt: value.createdAt, expiresAt: value.expiresAt,
    steps: value.steps.map(({ output: _output, error: _error, ...step }) => ({ ...step, promptTruncated: false })) }] };
}
beforeEach(() => { mocked.read.mockReset(); });

it("projects ordered frozen metadata without outputs, excerpt, actual prompt or authority", async () => {
  const store = new MemoryStore();
  const record = createExecution("private-chat", { id: ID, expiresAt: NOW + 60_000,
    actions: [{ nodeId: "node", sessionId: "session-1", prompt: "original task", dependsOn: [], sendRoute: "control-socket" }] }, NOW);
  await store.createExecutionIfAbsent(record);
  const raw = view();
  Object.assign(raw.steps[3].resultSources![0], { excerpt: "private excerpt", prompt: "private actual prompt", token: "private-token" });
  mocked.read.mockResolvedValue(raw);
  const writes = vi.spyOn(store, "compareAndSetExecution");
  const result = await readConsoleExecutions(store, ["private-chat"], NOW);
  expect(result.items[0].steps[3]).toMatchObject({ resultFrom: [3, 1, 2], resultSources: [source(3, 0, 0), source(1), source(2, 4, 4)] });
  for (const text of ["private-chat", "secret output", "secret error", "private excerpt", "private actual prompt", "private-token", "attempt", "token", "excerpt\"", "input"])
    expect(JSON.stringify(result)).not.toContain(text);
  expect(writes).not.toHaveBeenCalled();
});

it("accepts empty/no sharing, ordered frozen summaries, and preserves frozen identity when a parent receipt is unavailable", () => {
  const value = dto();
  expect(ConsoleExecutionsSchema.parse(value)).toEqual(value);
  value.items[0].steps[0].commandId = undefined;
  value.items[0].steps[0].turnId = undefined;
  value.items[0].steps[0].status = "uncertain";
  expect(ConsoleExecutionsSchema.parse(value).items[0].steps[3].resultSources).toEqual(value.items[0].steps[3].resultSources);
});

it.each(["claimed", "pending", "accepted", "completed"])("requires frozen source metadata for a %s result-sharing step", status => {
  const value = dto(); const step = value.items[0].steps[3];
  Object.assign(step, { status, commandId: "target-command", turnId: "target-turn" }); delete step.resultSources;
  expect(() => ConsoleExecutionsSchema.parse(value)).toThrow();
});

it.each(["uncertain", "failed", "cancelled", "expired"])("allows a %s step with selections that was never claimed", status => {
  const value = dto(); const step = value.items[0].steps[3];
  Object.assign(step, { status }); delete step.resultSources;
  expect(ConsoleExecutionsSchema.parse(value).items[0].steps[3].resultFrom).toEqual([3, 1, 2]);
});

it.each([
  ["missing selections", (step: Record<string, unknown>) => { delete step.resultFrom; }],
  ["duplicate selection", (step: Record<string, unknown>) => { step.resultFrom = [1, 1]; }],
  ["self selection", (step: Record<string, unknown>) => { step.resultFrom = [4]; }],
  ["not a direct dependency", (step: Record<string, unknown>) => { step.dependsOn = [1]; }],
  ["mismatched order", (step: Record<string, unknown>) => { step.resultFrom = [1, 3, 2]; }],
  ["waiting frozen input", (step: Record<string, unknown>) => { step.status = "waiting"; }],
  ["raw source", (step: Record<string, unknown>) => { Object.assign((step.resultSources as object[])[0], { excerpt: "secret" }); }],
  ["parent command mismatch", (step: Record<string, unknown>) => { Object.assign((step.resultSources as object[])[0], { commandId: "other" }); }],
  ["parent turn mismatch", (step: Record<string, unknown>) => { Object.assign((step.resultSources as object[])[0], { turnId: "other" }); }],
  ["false truncation", (step: Record<string, unknown>) => { Object.assign((step.resultSources as object[])[1], { truncated: false }); }],
  ["oversized excerpt", (step: Record<string, unknown>) => { Object.assign((step.resultSources as object[])[1], { excerptLength: 1001 }); }],
  ["invalid hash", (step: Record<string, unknown>) => { Object.assign((step.resultSources as object[])[1], { outputSHA256: "A".repeat(64) }); }],
] as const)("rejects %s in the strict console DTO", (_label, mutate) => {
  const value = dto(); mutate(value.items[0].steps[3]);
  expect(() => ConsoleExecutionsSchema.parse(value)).toThrow();
});

it("keeps generated plan summaries source-only with empty and clipping notices and no output text", () => {
  const value = view();
  const summary = executionSummary(value);
  expect(summary).toContain("已冻结输入资料：步骤 3（已记录输出为空）、步骤 1（已裁剪）、步骤 2（未裁剪），冻结不代表已送达");
  expect(summary).not.toContain("secret output"); expect(summary).not.toContain("secret error");
  expect(summary).not.toContain("a".repeat(64));
  value.steps[3].status = "waiting"; delete value.steps[3].resultSources;
  expect(executionSummary(value)).toContain("将使用步骤 3、1、2 的已记录输出");
});
