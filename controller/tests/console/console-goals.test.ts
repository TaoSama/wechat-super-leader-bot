import { expect, it, vi } from "vitest";
import { MemoryStore } from "../../src/store/memory.js";
import { readConsoleGoals } from "../../src/console/goals.js";
import { createGoal, renderGoalAction, goalRequestId, GOAL_SEND_CLAIM_MS, type GoalRecord } from "../../src/leader/goals/goal.js";
import { recordedOutput } from "../../src/leader/plans/input.js";
import type { CommandRecord } from "../../src/types.js";

const NOW = 1_700_000_000_000;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function goal(n = 1, chatId = "allowed"): GoalRecord {
  const value = createGoal(chatId, { id: uuid(n), expiresAt: NOW + 60_000, objective: "核查目标",
    criteria: ["最终测试通过"], targets: [{ nodeId: "air", sessionId: "same", sendRoute: "desktop-owner" }],
    constraints: "private constraints", maxActions: 3, maxDecisions: 5, durationMinutes: 30, shareResults: true }, NOW);
  const prompt = "检查原会话";
  value.actions.push({ index: 1, target: 1, prompt, sourceActions: [], input: { prompt: renderGoalAction(value.proposal, prompt, []), sources: [] } });
  return value;
}
function command(value: GoalRecord): CommandRecord {
  return { commandId: "precise-command", requestId: goalRequestId(value, 0), nodeId: "air", sessionId: "same",
    action: "send", prompt: value.actions[0].input.prompt, sendRoute: "desktop-owner", status: "completed", turnId: "precise-turn",
    output: "private exact output", createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 60_000).toISOString() };
}
function fixture(value = goal(), completed = false) {
  const store = new MemoryStore();
  const commands: CommandRecord[] = [];
  if (completed) {
    value.actions[0].attempt = { token: uuid(100), startedAt: NOW, expiresAt: NOW + GOAL_SEND_CLAIM_MS };
    const precise = command(value); commands.push(precise);
    value.status = "completed"; value.decisionAttempts = 1;
    value.decisions = [{ index: 1, inputSHA256: "a".repeat(64), evidence: [{ action: 1, commandId: precise.commandId,
      turnId: precise.turnId!, ...recordedOutput(precise.output!) }],
      decision: { type: "complete", criteria: [{ criterion: 1, actions: [1] }], reason: "证据支持条件" } }];
  }
  vi.spyOn(store, "listRecentGoals").mockImplementation(async (chatIds, limit) => chatIds.includes(value.chatId) ? [structuredClone(value)].slice(0, limit) : []);
  vi.spyOn(store, "findCommandByRequestId").mockImplementation(async id => commands.find(c => c.requestId === id) ?? null);
  return { store, value, commands };
}

it("publishes only bounded public fields, clips by code point, and never writes or reads recent-command windows", async () => {
  const value = goal(); value.proposal.objective = "🙂".repeat(600);
  value.actions[0].prompt = "a".repeat(510) + "🙂suffix";
  value.actions[0].input.prompt = renderGoalAction(value.proposal, value.actions[0].prompt, []);
  const { store } = fixture(value);
  const writes = [vi.spyOn(store, "compareAndSetGoal"), vi.spyOn(store, "confirmGoal"), vi.spyOn(store, "listRecentCommands")];
  const result = await readConsoleGoals(store, ["allowed"], NOW);
  expect(result.items[0]).toMatchObject({ objective: "🙂".repeat(512), objectiveTruncated: true,
    actions: [{ prompt: "a".repeat(510) + "🙂s", promptTruncated: true, status: "waiting" }], criteria: [{ supported: false }] });
  for (const secret of ["private constraints", "private exact output", '"chatId"', '"input"', '"lease"', '"attempt"', '"sendRoute"', '"skills"']) expect(JSON.stringify(result)).not.toContain(secret);
  writes.forEach(write => expect(write).not.toHaveBeenCalled());
  expect(await readConsoleGoals(store, [], NOW)).toEqual({ observedAt: NOW, limit: 12, hasMore: false, items: [] });
});
it("verifies completed criterion evidence against exact commands and the evidence frozen when decided", async () => {
  const { store, commands } = fixture(goal(), true);
  expect((await readConsoleGoals(store, ["allowed"], NOW)).items[0].criteria).toEqual([{ index: 1, text: "最终测试通过", supported: true, actions: [1] }]);
  commands[0].output = "different nonempty output";
  expect((await readConsoleGoals(store, ["allowed"], NOW)).items[0].criteria[0]).toMatchObject({ supported: false, actions: [] });
});
it.each(["accepted", "uncertain", "empty", "truncated", "wrong-route", "missing-turn"])("does not present %s evidence as a completed goal", async variant => {
  const { store, commands } = fixture(goal(), true);
  if (variant === "accepted" || variant === "uncertain") commands[0].status = variant;
  else if (variant === "empty") commands[0].output = " ";
  else if (variant === "truncated") commands[0].output = "a".repeat(1001);
  else if (variant === "wrong-route") commands[0].sendRoute = "control-socket";
  else delete commands[0].turnId;
  expect((await readConsoleGoals(store, ["allowed"], NOW)).items[0]).toMatchObject({ status: "completed", criteria: [{ supported: false, actions: [] }] });
});
it.each(["blocked", "cancelled", "expired"] as const)("preserves %s waiting actions without claiming successful receipt", async status => {
  const { store, value } = fixture(); value.status = status;
  if (status === "blocked") value.blockedReason = "等待信息";
  expect((await readConsoleGoals(store, ["allowed"], NOW)).items[0]).toMatchObject({ status, actions: [{ status }], criteria: [{ supported: false }] });
});
it("checks the allowlist and validates records before limiting projection reads", async () => {
  const { store } = fixture();
  const values = Array.from({ length: 13 }, (_, i) => goal(i + 1));
  vi.mocked(store.listRecentGoals).mockResolvedValue(values);
  const result = await readConsoleGoals(store, ["allowed"], NOW);
  expect(result.items).toHaveLength(12); expect(result.hasMore).toBe(true);
  expect(store.findCommandByRequestId).toHaveBeenCalledTimes(12);
  for (const records of [values.concat(goal(14)), [goal(1, "forbidden")], [goal(), goal()]]) {
    vi.mocked(store.listRecentGoals).mockResolvedValueOnce(records);
    await expect(readConsoleGoals(store, ["allowed"], NOW)).rejects.toThrow();
  }
  for (const clock of [NaN, -1, 1.5, 8_640_000_000_000_001]) await expect(readConsoleGoals(store, ["allowed"], clock)).rejects.toThrow();
});
