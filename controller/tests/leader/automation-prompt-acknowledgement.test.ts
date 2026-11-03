import { describe, expect, it, vi } from "vitest";
import { AutomationService, CreateScheduleSchema, MemoryAutomationRepository } from "../../src/automations/index.js";
import { generateAutomationAcknowledgement } from "../../src/leader/acknowledgement.js";
import type { LeaderModel } from "../../src/leader/model/contracts.js";
import { MemoryStore } from "../../src/store/memory.js";

describe("automation prompt edit acknowledgements", () => {
  it("distinguishes this turn's saved edit from a historical edit without echoing the prompt", async () => {
    const repository = new MemoryAutomationRepository();
    const service = new AutomationService({ repository, validateBackground: async () => {}, runner: {
      start: async () => ({ status: "running" }), inspect: async () => ({ status: "running" }),
    } });
    const schedule = await service.create(CreateScheduleSchema.parse({ kind: "background", title: "Daily report",
      timezone: "Asia/Shanghai", timing: { type: "cron", expression: "0 10 * * *" }, background: { prompt: "old" } }),
    { chatId: "chat", currentMessageId: "creation", explicitCurrentTurnAuthorization: true });
    await service.updatePrompt(schedule.id, { prompt: "do not echo this full prompt", expectedPromptRevision: 0 },
      { chatId: "chat", currentMessageId: "edit", explicitCurrentTurnAuthorization: true });
    const hub = { isNodeConnected: () => false, getNodeSession: () => undefined, readHistory: vi.fn() };
    for (const messageId of ["edit", "another-message"]) {
      const complete = vi.fn<LeaderModel["complete"]>(async () => { throw new Error("synthetic acknowledgement unavailable"); });
      const reply = await generateAutomationAcknowledgement({ complete }, new MemoryStore(), hub, service, "chat", messageId,
        { attempted: true, ids: new Set([schedule.id]), errors: [] });
      const payload = JSON.parse(complete.mock.calls[0][0][1].content);
      expect(payload.durableState.schedules[0]).toMatchObject({
        latestPromptUpdate: { revision: 1, requestId: "edit" }, promptUpdatedThisTurn: messageId === "edit",
      });
      expect(JSON.stringify(payload)).not.toContain("do not echo this full prompt");
      if (messageId === "edit") expect(reply.text).toContain("汇报正文已保存，仅影响未来轮次");
      else expect(reply.text).not.toContain("汇报正文已保存");
    }
  });
});
