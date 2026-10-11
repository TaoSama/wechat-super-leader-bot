import type { ConsoleExecution, ConsoleExecutions } from "../src/types";

export const FIXTURE_NOW = Date.parse("2026-10-12T12:00:00Z");
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
