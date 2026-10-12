import type { ConsoleExecution, ConsoleExecutions } from "../src/types";
import type { ConsoleGoal, ConsoleGoals } from "../src/goal-contract";

export const FIXTURE_NOW = Date.parse("2026-10-12T12:00:00Z");
export function emptyGoals(): ConsoleGoals {
  return { observedAt: FIXTURE_NOW, limit: 12, hasMore: false, items: [] };
}
export function goalFixture(): ConsoleGoal {
  return { id: "00000000-0000-4000-8000-000000000001", status: "active", objective: "持续核查跨机会话", objectiveTruncated: false,
    createdAt: FIXTURE_NOW - 60_000, expiresAt: FIXTURE_NOW + 60_000, maxActions: 3, maxDecisions: 5, decisionAttempts: 2,
    reason: "根据首轮记录补充核查", targets: [{ nodeId: "air", sessionId: "same-session" }, { nodeId: "mini", sessionId: "same-session" }],
    criteria: [{ index: 1, text: "所有测试通过", supported: false, actions: [] }], actions: [
      { index: 1, target: 1, prompt: "检查初始状态", promptTruncated: false, sourceActions: [], status: "completed", commandId: "command-1", turnId: "turn-1" },
      { index: 2, target: 2, prompt: "基于首轮结果核查", promptTruncated: false, sourceActions: [1], status: "accepted", commandId: "command-2", turnId: "turn-2" },
    ] };
}
export function emptyExecutions(): ConsoleExecutions {
  return { observedAt: FIXTURE_NOW, limit: 12, hasMore: false, items: [] };
}
export function executionFixture(): ConsoleExecution {
  return { id: "00000000-0000-4000-8000-000000000001", status: "active", createdAt: FIXTURE_NOW - 60_000,
    expiresAt: FIXTURE_NOW + 60_000, steps: [
      { step: 1, nodeId: "air", sessionId: "same-session", prompt: "先检查测试", promptTruncated: false,
        dependsOn: [], resultFrom: [], status: "accepted", commandId: "first-command", turnId: "first-turn" },
      { step: 2, nodeId: "mini", sessionId: "same-session", prompt: "完成后检查文档", promptTruncated: false,
        dependsOn: [1], resultFrom: [], status: "waiting" },
    ] };
}

export function completedRelayFixture(status: ConsoleExecution["status"] = "completed"): ConsoleExecution {
  const plan = executionFixture();
  plan.status = status;
  Object.assign(plan.steps[0], { status: "completed", commandId: "cmd_00000000-0000-4000-8000-000000000011",
    turnId: "00000000-0000-4000-8000-000000000021" });
  Object.assign(plan.steps[1], { status: "completed", commandId: "cmd_00000000-0000-4000-8000-000000000012",
    turnId: "00000000-0000-4000-8000-000000000022", resultFrom: [1], resultSources: [{ step: 1,
      commandId: plan.steps[0].commandId!, turnId: plan.steps[0].turnId!, outputSHA256: "a".repeat(64),
      outputLength: 28, excerptLength: 28, truncated: false }] });
  return plan;
}
