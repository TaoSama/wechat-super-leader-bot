import { describe, expect, it } from "vitest";
import { createExecution, normalizeExecution, validateExecutionUpdate, validatePlanDependencies,
  executionRequestId, matchesExecutionCommand, executionPageLimit, EXECUTION_TTL_MS, EXECUTION_CLAIM_MS,
  type ExecutionRecord } from "../src/leader/execution.js";
import { PlanSchema, type Plan } from "../src/leader/contracts.js";
import type { CommandRecord } from "../src/types.js";

const NOW = 1_700_000_000_000;
const ID = "00000000-0000-4000-8000-000000000001";
const TOKEN = "00000000-0000-4000-8000-000000000002";
const skill = { id: "a".repeat(64), digest: "b".repeat(64) };
function plan(): Plan {
  return { id: ID, expiresAt: NOW + 600_000, actions: [
    { nodeId: "node", sessionId: "first", prompt: "first task", skills: [skill], sendRoute: "desktop-owner", dependsOn: [] },
    { nodeId: "node", sessionId: "second", prompt: "second task", sendRoute: "control-socket", dependsOn: [1] },
  ] };
}
function execution(): ExecutionRecord { return createExecution("chat", plan(), NOW); }
function next(current: ExecutionRecord): ExecutionRecord { return { ...structuredClone(current), revision: current.revision + 1 }; }
function command(): CommandRecord {
  const original = execution();
  const action = original.plan.actions[0];
  const stamp = new Date(NOW).toISOString();
  return { commandId: "fixture-command", requestId: executionRequestId(original, 0), action: "send",
    nodeId: action.nodeId, sessionId: action.sessionId, prompt: action.prompt, skills: structuredClone(action.skills),
    sendRoute: action.sendRoute, status: "pending", createdAt: stamp, updatedAt: stamp, expiresAt: stamp };
}

describe("confirmed plan dependency graph", () => {
  it("supports independent steps and earlier-step dependencies; missing dependencies normalize to empty", () => {
    const valid = plan();
    expect(() => validatePlanDependencies(valid)).not.toThrow();
    valid.actions[1].dependsOn = [];
    expect(() => validatePlanDependencies(valid)).not.toThrow();
    const raw = structuredClone(valid) as unknown as { actions: Array<Record<string, unknown>> };
    delete raw.actions[0].dependsOn;
    expect(PlanSchema.parse(raw).actions[0].dependsOn).toEqual([]);
  });

  it.each([[1], [2], [0], [-1], [5]].map(dependsOn => ({ dependsOn })))("rejects first-step self/future/out-of-range dependency %j", ({ dependsOn }) => {
    const invalid = plan();
    invalid.actions[0].dependsOn = dependsOn;
    expect(() => normalizeExecution({ ...execution(), plan: invalid })).toThrow();
  });

  it.each([[2], [3], [1, 1], [0], [1.5], [NaN]].map(dependsOn => ({ dependsOn })))("rejects second-step self/future/duplicate/noninteger dependency %j", ({ dependsOn }) => {
    const invalid = execution();
    invalid.plan.actions[1].dependsOn = dependsOn;
    expect(() => normalizeExecution(invalid)).toThrow();
  });

  it("rejects a cycle and accepts repeated targets only through a transitive chain", () => {
    const valid = plan();
    valid.actions.push({ ...structuredClone(valid.actions[0]), dependsOn: [2] });
    valid.actions.push({ ...structuredClone(valid.actions[0]), dependsOn: [3] });
    expect(() => validatePlanDependencies(valid)).not.toThrow();
    valid.actions[3].dependsOn = [1];
    expect(() => validatePlanDependencies(valid)).toThrow("chain");
    valid.actions[3].dependsOn = [3];
    valid.actions[0].dependsOn = [4];
    expect(() => validatePlanDependencies(valid)).toThrow("earlier");
  });

  it("scopes repeated targets by both node and session, and rejects unordered repeated session", () => {
    const valid = plan();
    valid.actions[1] = { ...structuredClone(valid.actions[0]), nodeId: "other", dependsOn: [] };
    expect(() => validatePlanDependencies(valid)).not.toThrow();
    valid.actions[1].nodeId = "node";
    expect(() => validatePlanDependencies(valid)).toThrow("chain");
    valid.actions[1].dependsOn = [1];
    expect(() => validatePlanDependencies(valid)).not.toThrow();
  });
});

describe("execution record validation", () => {
  it("freezes a confirmed plan for exactly 24 hours with unclaimed steps", () => {
    const original = execution();
    expect(original.id).toBe(original.plan.id);
    expect(original.expiresAt).toBe(NOW + EXECUTION_TTL_MS);
    expect(original.attempts).toEqual([null, null]);
    expect(original.revision).toBe(1);
    expect(original.status).toBe("active");
    const input = plan();
    const cloned = createExecution("chat", input, NOW);
    input.actions[0].prompt = "changed";
    expect(cloned.plan.actions[0].prompt).toBe("first task");
    expect(() => createExecution("chat", plan(), plan().expiresAt)).toThrow("expired");
  });

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid creation timestamp %s", createdAt => {
    expect(() => normalizeExecution({ ...execution(), createdAt })).toThrow();
  });

  it.each([NOW, NOW - 1, NOW + EXECUTION_TTL_MS + 1, NaN, Infinity])("rejects invalid expiration %s", expiresAt => {
    expect(() => normalizeExecution({ ...execution(), expiresAt })).toThrow();
  });

  it("rejects unknown fields, UUID/plan mismatch, invalid chat, route, step count and revision", () => {
    const valid = execution();
    for (const invalid of [
      { ...valid, extra: true }, { ...valid, id: TOKEN }, { ...valid, id: "not-a-uuid" },
      { ...valid, chatId: " chat " }, { ...valid, attempts: [null] }, { ...valid, revision: 0 },
      { ...valid, revision: Number.MAX_SAFE_INTEGER + 1 },
    ]) expect(() => normalizeExecution(invalid)).toThrow();
    const unbound = execution();
    delete unbound.plan.actions[0].sendRoute;
    expect(() => normalizeExecution(unbound)).toThrow();
    const tooMany = execution();
    tooMany.plan.actions.push(...Array.from({ length: 3 }, (_, index) => ({ ...tooMany.plan.actions[0], sessionId: `extra-${index}` })));
    tooMany.attempts.push(null, null, null);
    expect(() => normalizeExecution(tooMany)).toThrow();
  });

  it("accepts the 15-second claim boundary but rejects malformed attempts and longer windows", () => {
    const valid = execution();
    const attempt = { token: TOKEN, startedAt: NOW, expiresAt: NOW + EXECUTION_CLAIM_MS };
    valid.attempts[0] = attempt;
    expect(normalizeExecution(valid)).toEqual(valid);
    for (const invalid of [
      { ...attempt, token: "invalid" }, { ...attempt, startedAt: NOW - 1 },
      { ...attempt, expiresAt: NOW }, { ...attempt, expiresAt: NOW + EXECUTION_CLAIM_MS + 1 },
      { ...attempt, startedAt: NaN }, { ...attempt, expiresAt: Infinity }, { ...attempt, extra: true },
    ]) expect(() => normalizeExecution({ ...valid, attempts: [invalid, null] })).toThrow();
  });

  it("clones schema-normalized nested records and validates page size boundaries", () => {
    const input = execution();
    const cloned = normalizeExecution(input);
    cloned.plan.actions[0].skills![0].digest = "c".repeat(64);
    expect(input.plan.actions[0].skills![0].digest).toBe(skill.digest);
    expect(executionPageLimit(1)).toBe(1);
    expect(executionPageLimit(64)).toBe(64);
    for (const limit of [0, 65, -1, 1.5, NaN, Infinity]) expect(() => executionPageLimit(limit)).toThrow();
  });
});

describe("execution update immutability", () => {
  it("accepts one revision increment and any terminal status from active", () => {
    const current = execution();
    expect(() => validateExecutionUpdate(current, next(current))).not.toThrow();
    for (const status of ["completed", "failed", "cancelled", "expired"] as const) {
      expect(() => validateExecutionUpdate(current, { ...next(current), status })).not.toThrow();
      expect(() => validateExecutionUpdate({ ...current, status }, next(current))).toThrow("terminal");
    }
  });

  it("rejects revision drift and all immutable identity/authorization/plan mutations", () => {
    const current = execution();
    for (const patch of [{ id: TOKEN }, { chatId: "other" }, { createdAt: NOW + 1 },
      { expiresAt: current.expiresAt - 1 }, { revision: 1 }, { revision: 3 }]) {
      expect(() => validateExecutionUpdate(current, { ...next(current), ...patch })).toThrow();
    }
    const mutations = [
      (value: Plan) => { value.actions.reverse(); },
      (value: Plan) => { value.actions[0].nodeId = "other"; },
      (value: Plan) => { value.actions[0].sessionId = "other"; },
      (value: Plan) => { value.actions[0].prompt = "changed"; },
      (value: Plan) => { value.actions[0].sendRoute = "control-socket"; },
      (value: Plan) => { value.actions[0].skills![0].digest = "c".repeat(64); },
      (value: Plan) => { value.actions[1].dependsOn = []; },
      (value: Plan) => { value.expiresAt++; },
    ];
    for (const mutate of mutations) {
      const changed = next(current);
      mutate(changed.plan);
      expect(() => validateExecutionUpdate(current, changed)).toThrow("immutable");
    }
  });

  it("permits a fresh attempt but never clears or edits an existing token/window", () => {
    const initial = execution();
    const claimed = next(initial);
    claimed.attempts[0] = { token: TOKEN, startedAt: NOW, expiresAt: NOW + EXECUTION_CLAIM_MS };
    expect(() => validateExecutionUpdate(initial, claimed)).not.toThrow();
    for (const attempt of [null, { ...claimed.attempts[0], token: ID },
      { ...claimed.attempts[0], startedAt: NOW + 1 }, { ...claimed.attempts[0], expiresAt: NOW + 1 }]) {
      const changed = next(claimed);
      changed.attempts[0] = attempt;
      expect(() => validateExecutionUpdate(claimed, changed)).toThrow("attempt");
    }
    const second = next(claimed);
    second.attempts[1] = { token: ID, startedAt: NOW + 1, expiresAt: NOW + EXECUTION_CLAIM_MS };
    expect(() => validateExecutionUpdate(claimed, second)).not.toThrow();
  });
});

describe("frozen command identity", () => {
  it("derives stable bounded request IDs isolated by chat, plan and one-based step", () => {
    const original = execution();
    const key = executionRequestId(original, 0);
    expect(key).toMatch(/^leader_exec_[a-f0-9]{64}$/);
    expect(executionRequestId(structuredClone(original), 0)).toBe(key);
    expect(new Set([key, executionRequestId(original, 1), executionRequestId({ ...original, chatId: "other" }, 0),
      executionRequestId({ ...original, id: TOKEN }, 0)]).size).toBe(4);
  });

  it("matches only exact request, target, action, prompt, skills and route", () => {
    const original = execution();
    const valid = command();
    expect(matchesExecutionCommand(original, 0, valid)).toBe(true);
    for (const patch of [
      { requestId: "other" }, { nodeId: "other" }, { sessionId: "other" }, { action: "read" as const },
      { prompt: "different" }, { prompt: undefined }, { sendRoute: "control-socket" as const },
      { sendRoute: undefined }, { skills: [] }, { skills: [{ ...skill, digest: "c".repeat(64) }] },
      { skills: [{ ...skill, id: "c".repeat(64) }] },
    ]) expect(matchesExecutionCommand(original, 0, { ...valid, ...patch })).toBe(false);
    expect(matchesExecutionCommand(original, 1, valid)).toBe(false);
    expect(matchesExecutionCommand({ ...original, chatId: "other" }, 0, valid)).toBe(false);
  });

  it("treats absent and empty skill lists equally and does not infer completion from payload match", () => {
    const original = execution();
    delete original.plan.actions[0].skills;
    const valid = command();
    delete valid.skills;
    expect(matchesExecutionCommand(original, 0, valid)).toBe(true);
    expect(matchesExecutionCommand(original, 0, { ...valid, skills: [] })).toBe(true);
    for (const status of ["pending", "accepted", "uncertain", "completed", "failed"] as const) {
      expect(matchesExecutionCommand(original, 0, { ...valid, status })).toBe(true);
    }
  });
});
