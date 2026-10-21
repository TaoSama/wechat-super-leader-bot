import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { DISPLAY_TIME_GUIDANCE, formatDisplayTime } from "../src/display-time.js";
import { AutomationService } from "../src/automations/service.js";
import { MemoryAutomationRepository } from "../src/automations/memory.js";
import { ResultDeliveryService } from "../src/deliveries/service.js";
import { MemoryDeliveryRepository } from "../src/deliveries/memory.js";
import { generateAutomationAcknowledgement } from "../src/leader/acknowledgement.js";
import { LeaderOrchestrator } from "../src/leader/orchestrator.js";
import { goalPreview, goalSummary } from "../src/leader/goals/presentation.js";
import type { GoalProposal } from "../src/leader/goals/goal.js";
import type { LeaderModel } from "../src/leader/model/contracts.js";
import { MemoryStore } from "../src/store/memory.js";

const NOW = Date.parse("2026-10-18T15:14:05Z");
const hub = { getAllSessions: async () => [], getNodeStatusList: () => [], getAllSkills: () => [], getNodeSkills: () => [],
  isNodeConnected: () => true, getNodeSession: () => undefined, readHistory: vi.fn() };
function automations() {
  const repository = new MemoryAutomationRepository();
  const service = new AutomationService({ repository, runner: { start: vi.fn(), inspect: vi.fn() }, now: () => NOW });
  return { repository, service };
}

it.each([
  ["2026-10-18T15:14:05Z", "2026-10-18 23:14:05（北京时间）"],
  ["2026-10-18T16:00:00Z", "2026-10-19 00:00:00（北京时间）"],
  ["2026-12-31T20:30:00Z", "2027-01-01 04:30:00（北京时间）"],
])("converts the instant %s including date rollover", (iso, expected) => {
  const timestamp = Date.parse(iso);
  expect(formatDisplayTime(timestamp)).toBe(expected);
  expect(new Date(timestamp).toISOString()).toBe(iso.replace("Z", ".000Z"));
});

it("renders both goal deadlines in Beijing time without altering frozen authorization", () => {
  const expiresAt = Date.parse("2026-10-18T16:05:00Z");
  const proposal: GoalProposal = { id: randomUUID(), expiresAt, objective: "检查任务", criteria: ["取得检查结果"],
    constraints: "只读", targets: [{ nodeId: "node", sessionId: "session", sendRoute: "control-socket" }],
    durationMinutes: 30, maxActions: 2, maxDecisions: 3, shareResults: true };
  const frozen = structuredClone(proposal);
  const preview = goalPreview(proposal, () => []);
  const summary = goalSummary({ id: proposal.id, status: "active", proposal, createdAt: NOW,
    expiresAt, actions: [], decisions: [], decisionAttempts: 0 });
  for (const text of [preview, summary]) {
    expect(text).toContain("2026-10-19 00:05:00（北京时间）");
    expect(text).not.toContain("2026-10-18T16:05:00");
  }
  expect(proposal).toEqual(frozen);
});

it("gives the actual planner a Beijing current time and concise display guidance", async () => {
  const complete = vi.fn<LeaderModel["complete"]>(async () => ({ content: "当前没有已观测到的运行任务。", toolCalls: [] }));
  const { service } = automations();
  const leader = new LeaderOrchestrator(new MemoryStore(), hub, { submit: vi.fn() }, { complete }, () => NOW,
    undefined, undefined, undefined, service);
  await leader.handle("chat", "query", "现在有哪些任务，并核对观测来源");
  const prompt = complete.mock.calls[0][0][0].content;
  expect(prompt).toContain("当前时间：2026-10-18 23:14:05（北京时间）");
  expect(prompt).toContain(DISPLAY_TIME_GUIDANCE);
  expect(prompt).toContain("不固定附加桌面/控制接口");
  expect(prompt).not.toContain("并说明来源与观测时间");
});

it.each(["Asia/Shanghai", "America/New_York"])("keeps %s schedule semantics and converts confirmation fallback only", async timezone => {
  const { repository, service } = automations();
  const schedule = await service.create({ kind: "reminder", title: "晨间提醒", timing: { type: "cron", expression: "0 9 * * *" },
    timezone, text: "检查任务", businessTtlMs: 60_000, retention: "latest" },
  { chatId: "chat", currentMessageId: "create", explicitCurrentTurnAuthorization: true });
  expect(schedule.nextAt).toBe(Date.parse(timezone === "Asia/Shanghai" ? "2026-10-19T01:00:00Z" : "2026-10-19T13:00:00Z"));
  const before = await repository.get(schedule.id, "chat");
  const complete = vi.fn<LeaderModel["complete"]>(async () => { throw new Error("model unavailable"); });
  const reply = await generateAutomationAcknowledgement({ complete }, { getCommand: vi.fn() }, hub, service, "chat", "create",
    { attempted: true, ids: new Set([schedule.id]), errors: [] });
  expect(reply.text).toContain(formatDisplayTime(schedule.nextAt!));
  if (timezone !== "Asia/Shanghai") expect(reply.text).toContain(`调度时区 ${timezone}`);
  const evidence = JSON.parse(complete.mock.calls[0][0][1].content!);
  expect(evidence.durableState.schedules[0]).toMatchObject({ nextAt: schedule.nextAt, timezone,
    nextAtDisplay: formatDisplayTime(schedule.nextAt!) });
  expect(complete.mock.calls[0][0][0].content).toContain(DISPLAY_TIME_GUIDANCE);
  expect(await repository.get(schedule.id, "chat")).toEqual(before);
});

it("instructs result summaries to display Beijing time while retaining original UTC evidence in attachments", async () => {
  const complete = vi.fn<LeaderModel["complete"]>(async () => ({ content: "23:14:05（北京时间）已完成检查。", toolCalls: [] }));
  const repository = new MemoryDeliveryRepository();
  const service = new ResultDeliveryService(repository, { model: { complete }, now: () => NOW,
    publicUrl: "https://results.example", signingSecret: "test-display-time-secret-at-least-32-chars" });
  const original = "检查日志：2026-10-18T15:14:05Z\n" + "资料".repeat(6000);
  const plan = await service.prepareResult({ key: "time-result", chatId: "chat", source: { type: "plan", id: "task" },
    kind: "completed", text: original, createdAt: NOW, expiresAt: NOW + 60_000 });
  expect(complete.mock.calls[0][0][0].content).toContain(DISPLAY_TIME_GUIDANCE);
  expect(complete.mock.calls[0][0][1].content).toContain("2026-10-18T15:14:05Z");
  expect(plan.messages).toEqual(["23:14:05（北京时间）已完成检查。"]);
  expect((await repository.getArtifact(plan.artifact.id))?.bytes.toString("utf8")).toBe(original);
});
