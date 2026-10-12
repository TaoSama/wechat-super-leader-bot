import { describe, expect, it } from "vitest";
import { parseConsoleExecutions } from "../src/execution-contract";
import { normalizeControlPlaneStatus } from "../src/api";
import type { ConsoleExecutionStep, ExecutionResultSource } from "../src/types";
import { completedRelayFixture, emptyExecutions, executionFixture } from "./status-fixtures";

const source = (step: number, outputLength = 2000, excerptLength = 1000): ExecutionResultSource => ({ step,
  commandId: `command-${step}`, turnId: `turn-${step}`, outputSHA256: "a".repeat(64),
  outputLength, excerptLength, truncated: excerptLength < outputLength });
function snapshot() {
  const plan = executionFixture();
  plan.steps = [1, 2, 3, 4].map(step => ({ ...plan.steps[0], step,
    status: step === 4 ? "claimed" : "completed", commandId: step === 4 ? undefined : `command-${step}`,
    turnId: step === 4 ? undefined : `turn-${step}`, dependsOn: step === 4 ? [1, 2, 3] : [],
    resultFrom: step === 4 ? [3, 1, 2] : [], ...(step === 4 ? { resultSources: [source(3, 0, 0), source(1), source(2, 4, 4)] } : {}) }));
  return { ...emptyExecutions(), items: [plan] };
}
describe("frozen result source projection", () => {
  it.each(["active", "completed"] as const)("accepts the serialized two-step relay while the plan is %s", status => {
    const value = { ...emptyExecutions(), items: [completedRelayFixture(status)] };
    const wire: unknown = JSON.parse(JSON.stringify(value));
    const parsed = parseConsoleExecutions(wire);
    expect(parsed).toEqual(value);
    expect(parsed.items[0].steps[0]).not.toHaveProperty("resultSources");
    expect(parsed.items[0].steps[1].resultSources![0]).toMatchObject({ outputLength: 28, excerptLength: 28, truncated: false });
    expect(parseConsoleExecutions(parsed)).toEqual(value);
    expect(normalizeControlPlaneStatus({ nodes: [], sessions: [], commands: [], executions: wire }).executions).toEqual(value);
  });
  it("requires explicit selections and retains source order, empty records and clipping through HTTP/SSE normalization", () => {
    const value = snapshot(), before = structuredClone(value);
    expect(parseConsoleExecutions(value)).toEqual(value);
    expect(normalizeControlPlaneStatus({ nodes: [], sessions: [], commands: [], executions: value }).executions).toEqual(value);
    const parsed = parseConsoleExecutions(value);
    parsed.items[0].steps[3].resultFrom.reverse();
    parsed.items[0].steps[3].resultSources![0].outputLength = 100;
    expect(value).toEqual(before);
  });
  it("permits waiting selections and frozen snapshots when the current parent receipt is unavailable without asserting completion", () => {
    const value = snapshot();
    value.items[0].steps[0].status = "uncertain";
    delete value.items[0].steps[0].commandId; delete value.items[0].steps[0].turnId;
    expect(parseConsoleExecutions(value).items[0].steps[0].status).toBe("uncertain");
    const waiting = value.items[0].steps[3]; waiting.status = "waiting"; delete waiting.resultSources;
    expect(parseConsoleExecutions(value).items[0].steps[3].resultFrom).toEqual([3, 1, 2]);
  });
  it.each(["claimed", "pending", "accepted", "completed"] as const)("requires source metadata after the %s step was claimed", status => {
    const value = snapshot(); const step = value.items[0].steps[3];
    Object.assign(step, { status, commandId: "target-command", turnId: "target-turn" }); delete step.resultSources;
    expect(() => parseConsoleExecutions(value)).toThrow("持久计划状态格式无效");
  });
  it.each(["uncertain", "failed", "cancelled", "expired"] as const)("does not invent frozen input for an unclaimed %s step", status => {
    const value = snapshot(); const step = value.items[0].steps[3]; step.status = status; delete step.resultSources;
    expect(parseConsoleExecutions(value).items[0].steps[3].resultSources).toBeUndefined();
  });
  const invalid: Array<[string, (step: ConsoleExecutionStep) => void]> = [
    ["missing resultFrom", step => { Object.assign(step, { resultFrom: undefined }); }],
    ["nonarray resultFrom", step => { Object.assign(step, { resultFrom: "1" }); }],
    ["too many selections", step => { step.resultFrom = [1, 2, 3, 4]; }],
    ["duplicate selection", step => { step.resultFrom = [1, 1]; }],
    ["self selection", step => { step.resultFrom = [4]; }],
    ["non-direct dependency", step => { step.dependsOn = [1, 2]; }],
    ["fractional selection", step => { step.resultFrom = [1.5]; }],
    ["string selection", step => { Object.assign(step, { resultFrom: ["1"] }); }],
    ["null sources", step => { Object.assign(step, { resultSources: null }); }],
    ["empty sources", step => { step.resultSources = []; }],
    ["different source count", step => { step.resultSources!.pop(); }],
    ["different source order", step => { step.resultSources!.reverse(); }],
    ["frozen waiting", step => { step.status = "waiting"; }],
    ["raw excerpt", step => { Object.assign(step.resultSources![0], { excerpt: "private output" }); }],
    ["raw actual prompt", step => { Object.assign(step.resultSources![0], { prompt: "private input" }); }],
    ["authority token", step => { Object.assign(step.resultSources![0], { token: "secret" }); }],
    ["chat identity", step => { Object.assign(step.resultSources![0], { chatId: "secret" }); }],
    ["mismatched parent command", step => { step.resultSources![0].commandId = "other-plan"; }],
    ["mismatched parent turn", step => { step.resultSources![0].turnId = "other-turn"; }],
    ["empty source command", step => { step.resultSources![0].commandId = ""; }],
    ["oversized source command", step => { step.resultSources![0].commandId = "x".repeat(65); }],
    ["invalid source turn", step => { step.resultSources![0].turnId = "turn\n"; }],
    ["oversized UTF8 turn", step => { step.resultSources![0].turnId = "界".repeat(43); }],
    ["surrogate turn", step => { step.resultSources![0].turnId = "\uD800"; }],
    ["uppercase hash", step => { step.resultSources![0].outputSHA256 = "A".repeat(64); }],
    ["newline hash", step => { step.resultSources![0].outputSHA256 += "\n"; }],
    ["unsafe output length", step => { step.resultSources![0].outputLength = Number.MAX_SAFE_INTEGER + 1; }],
    ["negative output length", step => { step.resultSources![0].outputLength = -1; }],
    ["fractional excerpt length", step => { step.resultSources![0].excerptLength = 0.5; }],
    ["oversized excerpt", step => { step.resultSources![1].excerptLength = 1001; }],
    ["longer excerpt than output", step => { step.resultSources![2].excerptLength = 5; }],
    ["truncation mismatch", step => { step.resultSources![1].truncated = false; }],
    ["empty marked truncated", step => { step.resultSources![0].truncated = true; }],
    ["nonboolean truncation", step => { Object.assign(step.resultSources![0], { truncated: "false" }); }],
  ];
  it.each(invalid)("rejects %s instead of fabricating valid provenance", (_name, mutate) => {
    const value = snapshot(); mutate(value.items[0].steps[3]);
    expect(() => parseConsoleExecutions(value)).toThrow("持久计划状态格式无效");
  });
});
