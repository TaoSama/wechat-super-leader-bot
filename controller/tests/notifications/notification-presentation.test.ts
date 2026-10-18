import { describe, expect, it } from "vitest";
import { createExecution, executionRequestId, type ExecutionRecord } from "../../src/leader/plans/execution.js";
import type { CommandRecord } from "../../src/types.js";
import { createTerminalNotification, normalizeNotification, claimNotificationRecord, receiptNotificationRecord,
  readNotification, NOTIFICATION_TEXT_LIMIT, NOTIFICATION_TEXT_BYTES, LEGACY_NOTIFICATION_ATTEMPT_MS } from "../../src/notifications/contracts.js";
import { goalResultNotificationText, goalNotificationRequestIds } from "../../src/notifications/presentation.js";
import { createGoal, goalRequestId, type GoalRecord } from "../../src/leader/goals/goal.js";
import { proposal } from "../fixtures/goals.js";

const NOW = 1_700_000_000_000;
const ID = "00000000-0000-4000-8000-000000000001";
const ATTEMPT = "00000000-0000-4000-8000-000000000002";
function execution(prompts = ["检查订单统计"]): ExecutionRecord {
  const record = createExecution("chat", { id: ID, expiresAt: NOW + 60_000,
    actions: prompts.map((prompt, index) => ({ nodeId: "node", sessionId: `session-${index}`, prompt,
      sendRoute: "control-socket", dependsOn: [] })) }, NOW);
  return { ...record, status: "completed", attempts: prompts.map(() => ({ token: ATTEMPT, startedAt: NOW, expiresAt: NOW + 15_000 })) };
}
function command(record: ExecutionRecord, index = 0, output: string | undefined = "订单总数：42\n- 异常订单：0"): CommandRecord {
  const action = record.plan.actions[index], stamp = new Date(NOW).toISOString();
  return { commandId: `command-${index}`, requestId: executionRequestId(record, index), nodeId: action.nodeId,
    sessionId: action.sessionId, prompt: action.prompt, sendRoute: action.sendRoute, action: "send", status: "completed",
    turnId: `exact-${index}`, output, createdAt: stamp, updatedAt: stamp, expiresAt: stamp };
}

describe("notification result presentation", () => {
  it("names the task and preserves the original bound Markdown without quoting or summarizing", () => {
    const record = execution(), text = createTerminalNotification(record, NOW, [command(record)])!.text;
    expect(text).toContain("### 已完成"); expect(text).toContain("**任务**：检查订单统计");
    expect(text).toContain("订单总数：42\n- 异常订单：0");
    expect(text).not.toContain("> 订单总数");
    expect(text.match(/检查订单统计/gu)).toHaveLength(1);
    expect(text).not.toContain(record.id);
  });
  it.each(["requestId", "nodeId", "sessionId", "prompt", "turnId", "status", "sendRoute", "skills"] as const)(
    "never borrows results with a mismatched %s", field => {
      const record = execution(), source = command(record);
      const wrong = { ...source, [field]: field === "turnId" ? undefined : field === "status" ? "accepted" :
        field === "sendRoute" ? "desktop-owner" : field === "skills" ? [{ id: "other", digest: "a".repeat(64) }] : "other" } as CommandRecord;
      const text = createTerminalNotification(record, NOW, [wrong])!.text;
      expect(text).not.toContain("订单总数：42"); expect(text).toContain("尚无可核对的精确完成结果");
    });
  it("does not expose a command for an unclaimed step", () => {
    const record = execution(), source = command(record); record.attempts[0] = null;
    expect(createTerminalNotification(record, NOW, [source])!.text).not.toContain("订单总数：42");
  });
  it.each(["failed", "cancelled", "expired"] as const)("preserves bound %s command status and complete error without claiming completion", status => {
    const record = { ...execution(), status: "failed" as const }, error = `# 失败原因\n${"完整诊断😀\n".repeat(300)}末尾错误证据  `;
    const source = { ...command(record), status, turnId: undefined, error };
    const text = createTerminalNotification(record, NOW, [source])!.text;
    expect(text).toContain(error); expect(text).not.toContain("订单总数：42");
    expect(text).not.toContain("尚无可核对的精确完成结果");
    expect(createTerminalNotification(record, NOW, [{ ...source, prompt: "unrelated" }])!.text).not.toContain(error);
  });
  it.each([undefined, "", "   "])("honestly reports missing or empty result %s", output => {
    const record = execution(), source = command(record); source.output = output;
    expect(createTerminalNotification(record, NOW, [source])!.text).toContain("未记录结果正文");
  });
  it("preserves an old truncated receipt verbatim with an explicit upstream notice", () => {
    const record = execution(), text = createTerminalNotification(record, NOW, [command(record, 0, "报告结论：统计无误...(truncated)")])!.text;
    expect(text).toContain("报告结论：统计无误...(truncated)"); expect(text).toContain("原记录已截断");
  });
  it("preserves all four large Unicode and multiline results including their endings", () => {
    const record = execution(Array.from({ length: 4 }, () => "订单检查😀".repeat(100)));
    const commands = record.plan.actions.map((_action, index) => command(record, index, `结论${index}：无异常\n${"😀\n".repeat(1000)}`));
    const text = createTerminalNotification(record, NOW, commands)!.text;
    expect(text.length).toBeLessThanOrEqual(NOTIFICATION_TEXT_LIMIT);
    for (const source of commands) expect(text).toContain(source.output!);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  });
  it.each(["accepted", "uncertain"] as const)("reads old static %s records without reopening their permanent attempt", status => {
    const record = execution(), notification = createTerminalNotification(record, NOW)!;
    notification.text = `计划 ${ID}（共 1 步）：所有步骤已收到精确完成回执。`;
    const claimed = claimNotificationRecord(notification, ATTEMPT, ["chat"], NOW);
    const old = receiptNotificationRecord(claimed, ATTEMPT, status, NOW);
    expect(normalizeNotification(old)).toEqual(old);
    expect(readNotification(old, NOW + 90_000).status).toBe(status);
    expect(() => claimNotificationRecord(old, ATTEMPT, ["chat"], NOW + 90_000)).toThrow();
  });
  it("preserves Markdown larger than 128KiB and fails explicitly above the UTF-8 body budget", () => {
    const record = execution(), output = `  # 报告\n\n| 名称 | 值 |\n|---|---|\n${"| 中文😀 | 完整 |\n".repeat(12_000)}\n\`\`\`ts\nconst ok = true;\n\`\`\`\n末尾证据  `;
    expect(Buffer.byteLength(output, "utf8")).toBeGreaterThan(128 * 1024);
    expect(createTerminalNotification(record, NOW, [command(record, 0, output)])!.text).toContain(output);
    expect(() => createTerminalNotification(record, NOW, [command(record, 0, "中".repeat(Math.ceil(NOTIFICATION_TEXT_BYTES / 3)))])).toThrow();
  });
  it("includes every goal action's original result, beyond the last three", () => {
    const goal = createGoal("chat", { ...proposal(NOW), maxActions: 4 }, NOW);
    goal.status = "completed";
    goal.actions = Array.from({ length: 4 }, (_, index) => ({ index: index + 1, target: 1, prompt: `任务 ${index + 1}`,
      sourceActions: [], input: { prompt: `original-${index}`, sources: [] }, attempt: { token: ATTEMPT, startedAt: NOW, expiresAt: NOW + 15_000 } }));
    const commands = goal.actions.map((action, index) => ({ ...command(execution()), requestId: goalRequestId(goal, index),
      nodeId: goal.proposal.targets[0].nodeId, sessionId: goal.proposal.targets[0].sessionId, prompt: action.input.prompt,
      output: `### 完整结果 ${index + 1}\n${"正文😀".repeat(200)}\n末尾-${index}` }));
    expect(goalNotificationRequestIds(goal)).toHaveLength(4);
    const text = goalResultNotificationText(goal as GoalRecord, commands);
    for (const source of commands) expect(text).toContain(source.output!);
    expect(text).not.toContain("仅展示最近");
  });
  it("reads legacy sixty-second attempts without changing timestamps or replay authority", () => {
    const claimed = claimNotificationRecord(createTerminalNotification(execution(), NOW)!, ATTEMPT, ["chat"], NOW);
    claimed.attemptExpiresAt = NOW + LEGACY_NOTIFICATION_ATTEMPT_MS;
    expect(normalizeNotification(claimed)).toEqual(claimed);
    expect(readNotification(claimed, NOW + LEGACY_NOTIFICATION_ATTEMPT_MS).status).toBe("uncertain");
    expect(() => claimNotificationRecord(claimed, ATTEMPT, ["chat"], NOW + LEGACY_NOTIFICATION_ATTEMPT_MS)).toThrow();
  });
});
