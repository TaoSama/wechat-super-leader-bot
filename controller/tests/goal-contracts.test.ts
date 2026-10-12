import { randomUUID, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGoal, normalizeGoal, GoalProposalSchema, GoalDecisionSchema, validateGoalDecision, validateGoalUpdate,
  GOAL_LEASE_MS, GOAL_SEND_CLAIM_MS, renderGoalAction, type GoalDecisionInput } from "../src/leader/goal.js";
import { proposal, lease, commit, nextDecision } from "./goal-contracts-fixtures.js";

describe("continuous goal authorization contracts", () => {
  it.each(["maxActions", "maxDecisions", "durationMinutes"] as const)("rejects excessive %s", field => {
    expect(GoalProposalSchema.safeParse({ ...proposal(), [field]: 99999 }).success).toBe(false);
  });
  it("rejects duplicate scope and terminal sessions", () => {
    const p = proposal();
    expect(() => createGoal("chat", { ...p, targets: [p.targets[0], p.targets[0]] }, Date.now())).toThrow();
    expect(() => createGoal("chat", { ...p, targets: [{ ...p.targets[0], sessionId: "terminal:session" }] }, Date.now())).toThrow();
    expect(GoalProposalSchema.safeParse({ ...p, targets: [{ ...p.targets[0], sendRoute: "terminal-pane" }] }).success).toBe(false);
  });
  it("freezes a goal deadline independently of the confirmation deadline", () => {
    const now = Date.now(), p = proposal(now), goal = createGoal("chat", p, now);
    expect(goal.expiresAt).toBe(now + p.durationMinutes * 60000);
    expect(() => createGoal("chat", p, p.expiresAt)).toThrow("expired");
  });
  it.each(["objective", "constraints", "maxActions", "targets"])("rejects authorization mutation %s", field => {
    const current = createGoal("chat", proposal(), Date.now()), next = structuredClone(current);
    next.revision++; (next.proposal as unknown as Record<string, unknown>)[field] = "changed";
    expect(() => validateGoalUpdate(current, next, current.createdAt)).toThrow("immutable");
  });
  it("requires a live isolated lease for decision commit and exact action binding", () => {
    const current = createGoal("chat", proposal(), Date.now()), claimed = lease(current), next = commit(claimed, nextDecision());
    expect(() => validateGoalUpdate(current, claimed, current.createdAt)).not.toThrow();
    expect(() => validateGoalUpdate(claimed, normalizeGoal(next), current.createdAt)).not.toThrow();
    expect(() => validateGoalUpdate(claimed, next, claimed.lease!.expiresAt)).toThrow("unavailable");
    next.actions[0].target = 2;
    expect(() => validateGoalUpdate(claimed, next, current.createdAt)).toThrow("differs");
  });
  it("does not permit stealing or silently clearing a lease", () => {
    const current = lease(createGoal("chat", proposal(), Date.now()));
    expect(() => validateGoalUpdate(current, lease(current), current.createdAt)).toThrow("stolen");
    expect(() => validateGoalUpdate(current, { ...current, revision: current.revision + 1, lease: undefined }, current.createdAt)).toThrow("cleared");
    expect(() => validateGoalUpdate(current, lease(current, current.lease!.expiresAt), current.lease!.expiresAt)).not.toThrow();
  });
  it("rejects an unleased appended action and invalid completion", () => {
    const current = createGoal("chat", proposal(), Date.now()), next = commit(lease(current), nextDecision());
    next.revision = current.revision + 1; next.decisions = []; next.decisionAttempts = 0;
    expect(() => validateGoalUpdate(current, next, current.createdAt)).toThrow("committed decision");
    expect(() => normalizeGoal({ ...current, status: "completed" })).toThrow("history");
  });
  it("binds audit digest and evidence to the exact leased input", () => {
    const current = lease(createGoal("chat", proposal(), Date.now())), next = commit(current, nextDecision());
    next.decisions[0].inputSHA256 = "a".repeat(64);
    expect(() => validateGoalUpdate(current, next, current.createdAt)).toThrow("differs from lease");
  });
  it("freezes full authorization into input and refuses truncating it", () => {
    const p = proposal(), prompt = renderGoalAction(p, "task", []);
    expect(prompt).toContain(JSON.stringify(p)); expect(prompt).toContain("不可信");
    expect(() => renderGoalAction(p, "x".repeat(17000), [])).toThrow("budget");
  });
  it("requires each completion criterion once with nonempty nontruncated completed evidence", () => {
    const p = proposal(), output = "proof", evidence = { action: 1, commandId: "cmd", turnId: "turn",
      outputSHA256: createHash("sha256").update(output).digest("hex"), outputLength: 5, excerpt: output, truncated: false };
    const input: GoalDecisionInput = { authorization: p, actions: [{ index: 1, target: 1, prompt: "task", sourceActions: [],
      status: "completed", commandId: "cmd", turnId: "turn", result: evidence }], decisions: [], availableTargets: [], decisionAttempts: 1 };
    const decision = GoalDecisionSchema.parse({ type: "complete", criteria: [{ criterion: 1, actions: [1] }], reason: "proof" });
    expect(() => validateGoalDecision(decision, input)).not.toThrow();
    for (const result of [{ ...evidence, truncated: true }, { ...evidence, excerpt: "", outputLength: 0 }]) {
      expect(() => validateGoalDecision(decision, { ...input, actions: [{ ...input.actions[0], result }] })).toThrow("exact evidence");
    }
    expect(() => validateGoalDecision({ ...decision, criteria: [{ criterion: 1, actions: [1] }, { criterion: 1, actions: [1] }] }, input)).toThrow();
    expect(() => validateGoalDecision(nextDecision(1, [2]), input)).toThrow("unauthorized");
  });
  it("permanently fences a send claim and disallows lease/claim combination", () => {
    const current = commit(lease(createGoal("chat", proposal(), Date.now())), nextDecision());
    const next = structuredClone(current); next.revision++;
    next.actions[0].attempt = { token: randomUUID(), startedAt: current.createdAt, expiresAt: current.createdAt + GOAL_SEND_CLAIM_MS };
    expect(() => validateGoalUpdate(current, next, current.createdAt)).not.toThrow();
    const replay = structuredClone(next); replay.revision++; replay.actions[0].attempt!.token = randomUUID();
    expect(() => validateGoalUpdate(next, replay, current.createdAt + GOAL_SEND_CLAIM_MS)).toThrow("replay");
    const mixed = lease(next); mixed.actions[0].attempt = undefined;
    expect(() => validateGoalUpdate(next, mixed, current.createdAt + GOAL_LEASE_MS)).toThrow();
  });
  it("blocked holds its state except cancellation or genuine expiry", () => {
    const current = { ...createGoal("chat", proposal(), Date.now()), status: "blocked" as const, blockedReason: "needs evidence" };
    expect(() => validateGoalUpdate(current, { ...current, revision: 2, status: "active" }, current.createdAt)).toThrow();
    expect(() => validateGoalUpdate(current, { ...current, revision: 2, status: "expired" }, current.createdAt)).toThrow();
    expect(() => validateGoalUpdate(current, { ...current, revision: 2, status: "expired" }, current.expiresAt)).not.toThrow();
    expect(() => validateGoalUpdate(current, { ...current, revision: 2, status: "cancelled" }, current.createdAt)).not.toThrow();
  });
});
