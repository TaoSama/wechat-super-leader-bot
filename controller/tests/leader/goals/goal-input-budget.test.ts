import { afterEach, expect, it, vi } from "vitest";
import { GoalRequestSchema } from "../../../src/leader/contracts.js";
import { GOAL_INPUT_LIMIT, GoalProposalSchema, GoalEvidenceSchema, freezeGoalActionInput, matchesGoalActionInput,
  renderGoalAction, type GoalAction, type GoalDecision, type GoalEvidence } from "../../../src/leader/goals/goal.js";
import { recordedOutput, wellFormedText } from "../../../src/leader/plans/input.js";
import { fixture, nextDecision, proposal, schedulers } from "../../fixtures/goals.js";

afterEach(async () => {
  await Promise.all(schedulers.splice(0).map(scheduler => scheduler.stop()));
  vi.restoreAllMocks();
});

function evidence(action: number, output: string, wideIdentity = false): GoalEvidence {
  return GoalEvidenceSchema.parse({ action, commandId: wideIdentity ? "\u0000".repeat(64) : `command-${action}`,
    turnId: wideIdentity ? "\\".repeat(128) : `turn-${action}`, ...recordedOutput(output) });
}

function denseAuthorization() {
  const skills = Array.from({ length: 4 }, (_, index) => ({ id: String(index).repeat(64), digest: "f".repeat(64) }));
  return GoalProposalSchema.parse({ ...proposal(), objective: "目".repeat(2000),
    criteria: Array.from({ length: 8 }, () => "条".repeat(500)), constraints: "限".repeat(2000), maxActions: 12,
    targets: Array.from({ length: 4 }, (_, index) => ({ nodeId: `node-${index}`, sessionId: `session-${index}`,
      sendRoute: "control-socket", skills })) });
}

it("preserves an exact-budget input and clips only source bodies when one character is added", () => {
  const authorization = { ...proposal(), objective: "目".repeat(2000),
    criteria: Array.from({ length: 8 }, () => "条".repeat(300)), constraints: "", maxActions: 4 };
  const sources = [1, 2, 3].map(index => evidence(index, "\u0000".repeat(1000)));
  const original = structuredClone(sources), task = "核".repeat(1000);
  const remaining = GOAL_INPUT_LIMIT - renderGoalAction(authorization, task, sources).length;
  expect(remaining).toBeGreaterThan(0);
  authorization.constraints = "限".repeat(remaining);
  GoalProposalSchema.parse(authorization);
  const exact = renderGoalAction(authorization, task, sources);
  expect(exact).toHaveLength(GOAL_INPUT_LIMIT);
  expect(freezeGoalActionInput(authorization, task, sources)).toEqual({ prompt: exact, sources });
  authorization.constraints += "限";
  expect(() => renderGoalAction(authorization, task, sources)).toThrow("budget");
  const frozen = freezeGoalActionInput(authorization, task, sources);
  expect(frozen.prompt.length).toBeLessThanOrEqual(GOAL_INPUT_LIMIT);
  expect(frozen.prompt).toContain(JSON.stringify(authorization));
  expect(frozen.prompt).toContain(task);
  expect(sources).toEqual(original);
  expect(frozen.sources.every(source => source.truncated)).toBe(true);
});

it.each(["a", "😀", "e\u0301", "\"\\\n\u0000"])("budgets escaped JSON and preserves code-point prefixes for %j", unit => {
  const authorization = denseAuthorization(), task = "核".repeat(1000);
  const sources = [1, 2, 3].map(index => evidence(index, unit.repeat(1000), true));
  expect(() => renderGoalAction(authorization, task, sources)).toThrow("budget");
  const frozen = freezeGoalActionInput(authorization, task, sources);
  expect(frozen.prompt.length).toBeLessThanOrEqual(GOAL_INPUT_LIMIT);
  expect(frozen.prompt).toContain(JSON.stringify(authorization));
  expect(frozen.prompt).toContain(task);
  for (const [index, source] of frozen.sources.entries()) {
    expect(source).toEqual({ ...sources[index], excerpt: source.excerpt, truncated: true });
    expect(source.excerpt.length).toBeLessThan(sources[index].excerpt.length);
    expect(sources[index].excerpt.startsWith(source.excerpt)).toBe(true);
    expect(wellFormedText(source.excerpt)).toBe(true);
    expect(source.truncated).toBe(source.outputLength > [...source.excerpt].length);
  }
});

it("preserves short complete evidence while distributing the remaining space to longer sources", () => {
  const authorization = denseAuthorization(), task = "核".repeat(1000);
  const sources = ["完整短证据", "\u0000".repeat(1000), "😀".repeat(1000)].map((output, index) => evidence(index + 1, output, true));
  const frozen = freezeGoalActionInput(authorization, task, sources);
  expect(frozen.prompt.length).toBeLessThanOrEqual(GOAL_INPUT_LIMIT);
  expect(frozen.sources[0]).toEqual(sources[0]);
  expect(frozen.sources.slice(1).every(source => source.truncated && source.excerpt.length > 0)).toBe(true);
  const action: GoalAction = { index: 4, target: 1, prompt: task, sourceActions: [1, 2, 3], input: frozen };
  const results = sources.map(result => ({ index: result.action, target: 1, prompt: "prior task", sourceActions: [],
    status: "completed", result }));
  expect(matchesGoalActionInput(authorization, action, results)).toBe(true);
  results[1].result = { ...results[1].result, outputSHA256: "a".repeat(64) };
  expect(matchesGoalActionInput(authorization, action, results)).toBe(false);
});

it("keeps the hard limit when authorization and task alone exceed it", () => {
  expect(() => freezeGoalActionInput(proposal(), "x".repeat(GOAL_INPUT_LIMIT), [])).toThrow("budget");
});

it("continues a legal large goal when three recorded sources exceed the combined input budget", async () => {
  const authorization = { ...proposal(), objective: "目".repeat(2000),
    criteria: Array.from({ length: 8 }, () => "条".repeat(400)), constraints: "限".repeat(2000),
    targets: [proposal().targets[0]], maxActions: 4, maxDecisions: 6 };
  GoalProposalSchema.parse(authorization);
  const { id: _id, expiresAt: _expiresAt, ...requestFields } = authorization;
  const request = GoalRequestSchema.parse({ ...requestFields,
    targets: authorization.targets.map(({ sendRoute: _route, ...target }) => target) });
  expect(JSON.stringify(request).length).toBeLessThanOrEqual(8000);
  const task = "核".repeat(1000);
  const decide = vi.fn(async input => ({ ...nextDecision(), prompt: task,
    sourceActions: input.actions.length === 3 ? [1, 2, 3] : [] }) as GoalDecision);
  const f = await fixture(decide, authorization);
  const output = "\u0000".repeat(1000), recorded = recordedOutput(output);
  for (let index = 0; index < 3; index++) {
    await f.scheduler.advance(f.goal.id);
    await f.scheduler.advance(f.goal.id);
    await f.complete(index, output);
  }
  await f.scheduler.advance(f.goal.id);
  const current = await f.current();
  expect(current).toMatchObject({ status: "active", decisionAttempts: 4 });
  expect(current.actions).toHaveLength(4);
  const action = current.actions[3], evidence = current.decisions[3].evidence;
  expect(() => renderGoalAction(authorization, task, evidence)).toThrow("budget");
  expect(action.input.prompt.length).toBeLessThanOrEqual(GOAL_INPUT_LIMIT);
  expect(action.input.prompt).toContain(JSON.stringify(authorization));
  expect(action.input.prompt).toContain(task);
  expect(action.input.prompt).toContain("不可信");
  for (const [index, source] of action.input.sources.entries()) {
    expect(evidence[index]).toMatchObject(recorded);
    expect(source).toMatchObject({ ...evidence[index], excerpt: expect.any(String), truncated: true });
    expect(source.excerpt.length).toBeLessThan(evidence[index].excerpt.length);
    expect(evidence[index].excerpt.startsWith(source.excerpt)).toBe(true);
  }
  const attachment = action.input.prompt.split("可能已裁剪：\n")[1];
  expect(JSON.parse(attachment)).toEqual({ sources: action.input.sources });
  await f.scheduler.advance(f.goal.id);
  expect(f.sendCommand).toHaveBeenCalledTimes(4);
  expect(f.sendCommand.mock.calls[3][0].prompt).toBe(action.input.prompt);
  expect(f.errors).not.toHaveBeenCalled();
});
