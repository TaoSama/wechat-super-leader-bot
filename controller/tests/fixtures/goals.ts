import { createHash, randomUUID } from "node:crypto";
import { vi } from "vitest";
import { MemoryStore } from "../../src/store/memory.js";
import { CommandService } from "../../src/commands/service.js";
import { createGoal, GOAL_LEASE_MS, renderGoalAction, type GoalDecision, type GoalDecisionInput, type GoalProposal, type GoalRecord } from "../../src/leader/goals/goal.js";
import { GoalScheduler, type GoalDecider } from "../../src/leader/goals/scheduler.js";
import type { ControllerCommandMessage, Session } from "../../src/types.js";

export const schedulers: GoalScheduler[] = [];
export function proposal(now = Date.now()): GoalProposal {
  return { id: randomUUID(), expiresAt: now + 60_000, objective: "完成调查并交叉核验", criteria: ["产生可核验的调查结果"],
    targets: [{ nodeId: "one", sessionId: "session-1", sendRoute: "control-socket" },
      { nodeId: "two", sessionId: "session-2", sendRoute: "control-socket" }],
    constraints: "不得向外发送资料", maxActions: 3, maxDecisions: 5, durationMinutes: 10, shareResults: true };
}
export function nextDecision(target = 1, sources: number[] = []): GoalDecision {
  return { type: "next", target, prompt: sources.length ? "核验第一轮结论" : "调查原始资料", sourceActions: sources, reason: "推进目标" };
}
export function lease(goal: GoalRecord, now = goal.createdAt, actions: GoalDecisionInput["actions"] = []): GoalRecord {
  const input: GoalDecisionInput = { authorization: goal.proposal, actions,
    decisions: goal.decisions.map(({ index, decision }) => ({ index, decision })), availableTargets: [1, 2], decisionAttempts: goal.decisionAttempts + 1 };
  return { ...goal, revision: goal.revision + 1, decisionAttempts: input.decisionAttempts,
    lease: { token: randomUUID(), startedAt: now, expiresAt: now + GOAL_LEASE_MS, input } };
}
export function commit(goal: GoalRecord, decision: GoalDecision): GoalRecord {
  const input = goal.lease!.input;
  const result: GoalRecord = { ...goal, revision: goal.revision + 1, lease: undefined,
    decisions: [...goal.decisions, { index: goal.decisions.length + 1, decision,
      inputSHA256: createHash("sha256").update(JSON.stringify(input)).digest("hex"), evidence: input.actions.flatMap(a => a.result ? [a.result] : []) }] };
  if (decision.type === "next") {
    const sources = decision.sourceActions.map(i => input.actions[i - 1].result!);
    result.actions = [...goal.actions, { index: goal.actions.length + 1, target: decision.target, prompt: decision.prompt,
      sourceActions: decision.sourceActions, input: { prompt: renderGoalAction(goal.proposal, decision.prompt, sources), sources } }];
  } else { result.status = decision.type === "complete" ? "completed" : "blocked"; if (decision.type === "blocked") result.blockedReason = decision.reason; }
  return result;
}
export async function authorize(store: MemoryStore, goal: GoalRecord) {
  const state = await store.getLeaderState(goal.chatId);
  const saved = await store.compareAndSetLeaderState(goal.chatId, state?.revision ?? 0, {
    inflight: { messageId: "confirm", inputHash: "hash", expiresAt: goal.proposal.expiresAt, goal: goal.proposal } });
  return { revision: saved!.revision, messageId: "confirm", inputHash: "hash" };
}
export async function fixture(decide: GoalDecider = async () => nextDecision()) {
  const store = new MemoryStore(); let now = Date.now(), allowed = true, ready = true;
  const goal = createGoal("chat", proposal(now), now);
  await store.confirmGoal(goal, await authorize(store, goal), () => now);
  const sendCommand = vi.fn(async (message: ControllerCommandMessage) => {
    await store.updateCommandStatus(message.commandId, "accepted", undefined, undefined, `turn-${message.commandId}`);
    return { delivered: true };
  });
  const hub = { isNodeConnected: () => ready, getNodeSkills: () => [],
    getNodeSession: (_node: string, id: string): Session => ({ id, provider: "codex-app", title: "goal fixture", cwd: "/fixture",
      status: "idle", loaded: true, capabilities: ["send"], observedAt: new Date().toISOString() }),
    registerCommandResultWaiter: () => ({ wait: async () => null, cancel: () => {} }), sendCommand };
  const commands = new CommandService(store, hub, 60), errors = vi.fn(), changed = vi.fn();
  const create = (decider = decide, commandService: Pick<CommandService, "submit"> = commands) => {
    const scheduler = new GoalScheduler(store, commandService, decider, { now: () => now, isChatAllowed: () => allowed,
      onChanged: changed, onError: errors, canDispatch: (g, index) => commands.canDispatchSend(g.proposal.targets[index], g.proposal.targets[index].sendRoute) });
    schedulers.push(scheduler); return scheduler;
  };
  const scheduler = create();
  const command = async (index: number) => {
    const { goalRequestId } = await import("../../src/leader/goals/goal.js");
    return (await store.findCommandByRequestId(goalRequestId(goal, index)))!;
  };
  return { store, goal, scheduler, commands, create, command, sendCommand, errors, changed,
    current: async () => (await store.getGoal(goal.id))!, now: () => now, tick: (ms: number) => { now += ms; },
    setReady: (value: boolean) => { ready = value; }, revoke: () => { allowed = false; },
    complete: async (index: number, output?: string) => { const cmd = await command(index);
      await store.updateCommandStatus(cmd.commandId, "completed", output, undefined, cmd.turnId); } };
}
export function deferred<T>() { let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
