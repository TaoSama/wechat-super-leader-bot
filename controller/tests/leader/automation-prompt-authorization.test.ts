import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { CreateScheduleSchema } from "../../src/automations/contracts.js";
import { MemoryAutomationRepository } from "../../src/automations/memory.js";
import { AutomationService } from "../../src/automations/service.js";
import { MAX_AUTOMATION_TOOL_RESULT_CHARS } from "../../src/automations/tool-results.js";
import { ACKNOWLEDGEMENT_PROMPT } from "../../src/leader/acknowledgement.js";
import { CLAIM_TTL_MS } from "../../src/leader/contracts.js";
import { DirectCallSchema, type DirectAuthorization } from "../../src/leader/direct-contracts.js";
import { AUTOMATION_AUTHORIZATION_TOOL_NAME, type AutomationOperation } from "../../src/leader/model/automation-authorization.js";
import type { ModelMessage, ModelReply } from "../../src/leader/model/contracts.js";
import { LeaderOrchestrator } from "../../src/leader/orchestrator.js";
import { MemoryStore } from "../../src/store/memory.js";

const NOW = Date.parse("2026-11-03T10:00:00+08:00");
const CHAT = "prompt-edit-chat";
const ORIGINAL_PROMPT = "读取既有日报并汇总";
const EDIT_TEXT = "把现有后台日报的未来汇报正文改为结构化格式";
const PROMPT = "按结论、依据、风险和后续动作汇报，保留没有变化时静默的规则";
const tool = (name: string, args: unknown): ModelReply => ({ content: null, toolCalls: [{
  id: randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) },
}] });

function fixture(operations: AutomationOperation[] = ["edit"]) {
  let clock = NOW;
  const replies: ModelReply[] = [], authorizationMessages: ModelMessage[][] = [];
  const store = new MemoryStore(), repository = new MemoryAutomationRepository();
  const runner = { start: vi.fn(), inspect: vi.fn() };
  const automations = new AutomationService({ repository, runner, now: () => clock, validateBackground: async () => {} });
  const update = vi.spyOn(automations, "updatePrompt");
  const hub = { getAllSessions: async () => [], getNodeStatusList: () => [], getAllSkills: () => [], getNodeSkills: () => [],
    isNodeConnected: () => true, getNodeSession: () => undefined, readHistory: vi.fn() };
  const submit = vi.fn();
  const complete = vi.fn(async (messages: ModelMessage[], tools: { function: { name: string } }[]): Promise<ModelReply> => {
    if (tools[0]?.function.name === AUTOMATION_AUTHORIZATION_TOOL_NAME && tools.length === 1) {
      authorizationMessages.push(structuredClone(messages));
      return tool(AUTOMATION_AUTHORIZATION_TOOL_NAME, { operations });
    }
    if (messages[0].content === ACKNOWLEDGEMENT_PROMPT) return { content: "已根据持久记录核查定时配置。", toolCalls: [] };
    const reply = replies.shift();
    if (!reply) throw new Error("Missing planner fixture response");
    return reply;
  });
  const leader = () => new LeaderOrchestrator(store, hub, { submit }, { complete }, () => clock,
    undefined, undefined, undefined, automations, undefined, { isAllowed: chatId => chatId === CHAT });
  const seed = (chatId = CHAT) => automations.create(CreateScheduleSchema.parse({ kind: "background", title: "后台日报",
    timing: { type: "cron", expression: "0 10 * * *" }, timezone: "Asia/Shanghai", background: { prompt: ORIGINAL_PROMPT } }),
  { chatId, currentMessageId: "original-creation", explicitCurrentTurnAuthorization: true });
  const direct = (id: string, authorization: Partial<DirectAuthorization> = { automationOperations: ["edit"] },
    args: Record<string, unknown> = { prompt: PROMPT, expectedPromptRevision: 0 }) => DirectCallSchema.parse({
    chatId: CHAT, messageId: "current-edit-message", text: EDIT_TEXT, callId: randomUUID(), name: "update_automation",
    arguments: { id, ...args }, authorization,
  });
  return { store, repository, automations, update, runner, submit, complete, leader, seed, direct, replies,
    authorizationMessages, advance: () => { clock += CLAIM_TTL_MS + 1; } };
}

describe("direct automation prompt edit authority", () => {
  it("applies an explicit edit once and replays its durable result without another model or edit", async () => {
    const f = fixture(), schedule = await f.seed(), request = f.direct(schedule.id);
    const result = await f.leader().direct.call(request);
    expect(result.result).toMatchObject({ id: schedule.id, authorizedMessageId: "original-creation",
      background: { prompt: PROMPT }, latestPromptUpdate: { source: "current_turn", requestId: request.messageId, revision: 1 } });
    expect(await f.leader().direct.call({ ...request, callId: randomUUID() })).toEqual(result);
    expect(f.update).toHaveBeenCalledOnce();
    expect(f.update.mock.calls[0][2]).toMatchObject({ chatId: CHAT, currentMessageId: request.messageId,
      explicitCurrentTurnAuthorization: true, assertCurrentAuthority: expect.any(Function) });
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.runner.start).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  it.each(([[], ["create"], ["pause"], ["resume"], ["cancel"]] satisfies AutomationOperation[][]).map(operations => ({ operations })))(
    "rejects prompt editing without edit permission: $operations", async ({ operations }) => {
      const f = fixture(), schedule = await f.seed();
      await expect(f.leader().direct.call(f.direct(schedule.id, { automationOperations: operations }))).rejects.toThrow(/authorization/);
      expect(f.update).not.toHaveBeenCalled();
      expect(await f.repository.get(schedule.id, CHAT)).toMatchObject({ background: { prompt: ORIGINAL_PROMPT } });
    });

  it.each(["active", "paused", "cancelled"])("does not use edit permission to set status %s", async status => {
    const f = fixture(), schedule = await f.seed();
    await expect(f.leader().direct.call(f.direct(schedule.id, { automationOperations: ["edit"] }, { status }))).rejects.toThrow(/authorization/);
    expect((await f.repository.get(schedule.id, CHAT))?.status).toBe("active");
  });

  it.each([
    { status: "paused", operation: "pause" }, { status: "active", operation: "resume" }, { status: "cancelled", operation: "cancel" },
  ] as const)("preserves the existing $operation operation", async ({ status, operation }) => {
    const f = fixture(), schedule = await f.seed();
    if (operation === "resume") await f.repository.setStatus(schedule.id, CHAT, "paused", NOW);
    const result = await f.leader().direct.call(f.direct(schedule.id, { automationOperations: [operation] }, { status }));
    expect(result.result).toMatchObject({ status, background: { prompt: ORIGINAL_PROMPT } });
    expect(f.update).not.toHaveBeenCalled();
  });

  it("rejects mixed status and prompt arguments before either mutation", async () => {
    const f = fixture(), schedule = await f.seed();
    const request = f.direct(schedule.id, { automationOperations: ["edit", "pause"] }, {
      status: "paused", prompt: PROMPT, expectedPromptRevision: 0,
    });
    await expect(f.leader().direct.call(request)).rejects.toThrow(/arguments/);
    expect(f.update).not.toHaveBeenCalled();
    expect(await f.repository.get(schedule.id, CHAT)).toMatchObject({ status: "active", background: { prompt: ORIGINAL_PROMPT } });
  });

  it("cannot use current-chat edit authority to modify another chat's schedule", async () => {
    const f = fixture(), other = await f.seed("other-chat");
    expect((await f.leader().direct.call(f.direct(other.id))).result).toBeNull();
    expect(await f.repository.get(other.id, "other-chat")).toMatchObject({ background: { prompt: ORIGINAL_PROMPT } });
  });

  it("rejects a caller from a chat outside the allowlist", async () => {
    const f = fixture(), schedule = await f.seed();
    await expect(f.leader().direct.call({ ...f.direct(schedule.id), chatId: "other-chat" })).rejects.toThrow(/CHAT_NOT_ALLOWED/);
    expect(f.update).not.toHaveBeenCalled();
  });

  it("does not rebind an existing user message ID to new edit text", async () => {
    const f = fixture(), schedule = await f.seed(), request = f.direct(schedule.id);
    await f.store.recordMessage({ chatId: CHAT, messageId: request.messageId, text: "只查询日报，不修改", replyText: "已查询",
      createdAt: new Date(NOW).toISOString() });
    await expect(f.leader().direct.call(request)).rejects.toThrow(/different user text/);
    expect(f.update).not.toHaveBeenCalled();
  });

  it("checks the acquired current-message lease immediately before executing an edit", async () => {
    const f = fixture(), schedule = await f.seed(), read = f.store.getLeaderState.bind(f.store);
    vi.spyOn(f.store, "getLeaderState").mockImplementation(async chatId => {
      const state = await read(chatId);
      if (state?.data.inflight) f.advance();
      return state;
    });
    await expect(f.leader().direct.call(f.direct(schedule.id))).rejects.toThrow(/authority.*expired/);
    expect(f.update).not.toHaveBeenCalled();
    expect(await f.repository.get(schedule.id, CHAT)).toMatchObject({ background: { prompt: ORIGINAL_PROMPT } });
  });
});

describe("orchestrated automation prompt edit authority", () => {
  it("reads the revision of an already edited long prompt from a large list before editing again", async () => {
    const f = fixture(), target = await f.seed(), longPrompt = "既有长正文".repeat(5_000);
    await f.automations.updatePrompt(target.id, { prompt: longPrompt, expectedPromptRevision: 0 }, {
      chatId: CHAT, currentMessageId: "previous-edit", explicitCurrentTurnAuthorization: true,
    });
    f.advance();
    const preceding = await f.automations.create(CreateScheduleSchema.parse({ kind: "background", title: "较新大正文任务",
      timing: { type: "cron", expression: "0 10 * * *" }, timezone: "Asia/Shanghai", background: { prompt: longPrompt } }),
    { chatId: CHAT, currentMessageId: "preceding-creation", explicitCurrentTurnAuthorization: true });
    expect((await f.repository.list(CHAT)).map(item => item.id)).toEqual([preceding.id, target.id]);
    f.update.mockClear();
    const complete = f.complete.getMockImplementation()!;
    let observedRevision: number | undefined;
    f.complete.mockImplementation(async (...args) => {
      const last = args[0].at(-1);
      if (args[0][0].content !== ACKNOWLEDGEMENT_PROMPT && last?.role === "tool") {
        expect(last.content.length).toBeLessThanOrEqual(MAX_AUTOMATION_TOOL_RESULT_CHARS);
        const listing = JSON.parse(last.content);
        expect(listing).toMatchObject({ truncated: true, omittedCount: 0 });
        expect(listing.items.map((item: { id: string }) => item.id)).toEqual([preceding.id, target.id]);
        observedRevision = listing.items.find((item: { id: string }) => item.id === target.id).latestPromptUpdate.revision;
        return tool("update_automation", { id: target.id, prompt: PROMPT, expectedPromptRevision: observedRevision });
      }
      return complete(...args);
    });
    f.replies.push(tool("list_automations", {}));
    await f.leader().handle(CHAT, "edit-after-large-list", EDIT_TEXT);
    expect(observedRevision).toBe(1);
    expect(f.update).toHaveBeenCalledOnce();
    expect(await f.repository.get(target.id, CHAT)).toMatchObject({ background: { prompt: PROMPT }, latestPromptUpdate: { revision: 2 } });
    expect(await f.repository.get(preceding.id, CHAT)).toMatchObject({ background: { prompt: longPrompt } });
    expect(f.runner.start).not.toHaveBeenCalled();
    expect(f.submit).not.toHaveBeenCalled();
  });

  it("accepts an explicitly classified edit beyond the standard tool argument limit", async () => {
    const f = fixture(), schedule = await f.seed(), prompt = "结构化汇报内容".repeat(2_000);
    f.replies.push(tool("update_automation", { id: schedule.id, prompt, expectedPromptRevision: 0 }));
    await f.leader().handle(CHAT, "large-prompt-edit", EDIT_TEXT);
    expect(await f.repository.get(schedule.id, CHAT)).toMatchObject({ background: { prompt }, latestPromptUpdate: { revision: 1 } });
    expect(f.authorizationMessages).toEqual([[{ role: "system", content: expect.any(String) }, { role: "user", content: EDIT_TEXT }]]);
    expect(f.update).toHaveBeenCalledOnce();
    expect(f.submit).not.toHaveBeenCalled();
  });

  it.each(([[], ["create"], ["pause"]] satisfies AutomationOperation[][]).map(operations => ({ operations })))(
    "requires an independent edit classification, got $operations", async ({ operations }) => {
      const f = fixture(operations), schedule = await f.seed();
      f.replies.push(tool("update_automation", { id: schedule.id, prompt: PROMPT, expectedPromptRevision: 0 }));
      const reply = await f.leader().handle(CHAT, "wrong-edit-operation", EDIT_TEXT);
      expect(reply.text).toContain("没有明确授权");
      expect(f.update).not.toHaveBeenCalled();
      expect(await f.repository.get(schedule.id, CHAT)).toMatchObject({ background: { prompt: ORIGINAL_PROMPT } });
    });

  it("cannot classify historical edit text as current permission", async () => {
    const f = fixture([]), schedule = await f.seed(), current = "仅查看日报格式，不修改";
    await f.store.compareAndSetLeaderState(CHAT, 0, { history: [{ role: "user", content: EDIT_TEXT }] });
    f.replies.push(tool("update_automation", { id: schedule.id, prompt: PROMPT, expectedPromptRevision: 0 }));
    await f.leader().handle(CHAT, "read-only-current-turn", current);
    expect(f.authorizationMessages[0][1]).toEqual({ role: "user", content: current });
    expect(f.update).not.toHaveBeenCalled();
  });

  it("does not broaden the argument limit for malformed prompt updates or status changes", async () => {
    for (const args of [
      { prompt: "x".repeat(9_000), expectedPromptRevision: "0" },
      { status: "paused", padding: "x".repeat(9_000) },
      { prompt: "x".repeat(160_001), expectedPromptRevision: 0 },
    ]) {
      const f = fixture(["edit", "pause"]), schedule = await f.seed();
      f.replies.push(tool("update_automation", { id: schedule.id, ...args }));
      await f.leader().handle(CHAT, "invalid-large-edit", EDIT_TEXT);
      expect(f.update).not.toHaveBeenCalled();
      expect(await f.repository.get(schedule.id, CHAT)).toMatchObject({ status: "active", background: { prompt: ORIGINAL_PROMPT } });
    }
  });

  it("rechecks the current-turn lease after the edit classifier returns", async () => {
    const f = fixture(), schedule = await f.seed(), complete = f.complete.getMockImplementation()!;
    f.complete.mockImplementation(async (...args) => {
      const reply = await complete(...args);
      if (args[1][0]?.function.name === AUTOMATION_AUTHORIZATION_TOOL_NAME) f.advance();
      return reply;
    });
    f.replies.push(tool("update_automation", { id: schedule.id, prompt: PROMPT, expectedPromptRevision: 0 }));
    await f.leader().handle(CHAT, "expired-edit-claim", EDIT_TEXT);
    expect(f.update).not.toHaveBeenCalled();
    expect(await f.repository.get(schedule.id, CHAT)).toMatchObject({ background: { prompt: ORIGINAL_PROMPT } });
  });
});
