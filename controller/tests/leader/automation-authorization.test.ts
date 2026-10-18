import { describe, expect, it, vi } from "vitest";
import { AUTOMATION_AUTHORIZATION_TOOL_NAME, classifyAutomationAuthorization } from "../../src/leader/model/automation-authorization.js";
import type { LeaderModel, ModelReply } from "../../src/leader/model/contracts.js";

const tool = (operations: unknown, name = AUTOMATION_AUTHORIZATION_TOOL_NAME): ModelReply => ({ content: null,
  toolCalls: [{ id: "authorization", type: "function", function: { name, arguments: JSON.stringify({ operations }) } }] });

describe("isolated automation authorization", () => {
  it("classifies only the current user message and exposes no execution tools", async () => {
    const complete = vi.fn<LeaderModel["complete"]>(async () => tool(["create", "pause"]));
    const signal = AbortSignal.timeout(1000);
    expect(await classifyAutomationAuthorization({ complete }, "每天9点提醒我，并暂停旧日报", signal)).toEqual(new Set(["create", "pause"]));
    const [messages, tools, passedSignal] = complete.mock.calls[0];
    expect(messages).toEqual([{ role: "system", content: expect.any(String) }, { role: "user", content: "每天9点提醒我，并暂停旧日报" }]);
    expect(tools.map(item => item.function.name)).toEqual([AUTOMATION_AUTHORIZATION_TOOL_NAME]);
    expect(passedSignal).toBe(signal);
  });

  it("permits no mutations for a read-only request", async () => {
    const complete = vi.fn<LeaderModel["complete"]>(async () => tool([]));
    expect(await classifyAutomationAuthorization({ complete }, "有哪些定时任务？", AbortSignal.timeout(1000))).toEqual(new Set());
  });

  it.each([
    { content: "可以创建", toolCalls: [] },
    { ...tool(["create"]), content: "额外授权" },
    tool(["create"], "execute_plan"),
    tool(["create", "create"]),
    tool(["update"]),
    tool("create"),
    { ...tool([]), toolCalls: [...tool([]).toolCalls, ...tool(["cancel"]).toolCalls] },
    { content: null, toolCalls: [{ id: "bad", type: "function", function: { name: AUTOMATION_AUTHORIZATION_TOOL_NAME, arguments: "not-json" } }] },
  ] satisfies ModelReply[])("rejects malformed or ambiguous classifier output %#", async reply => {
    const model: LeaderModel = { complete: async () => reply };
    await expect(classifyAutomationAuthorization(model, "看看任务", AbortSignal.timeout(1000))).rejects.toThrow();
  });

  it("does not call the model after the turn has expired", async () => {
    const complete = vi.fn();
    const abort = new AbortController(); abort.abort();
    await expect(classifyAutomationAuthorization({ complete }, "每天9点提醒我", abort.signal)).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
  });
});
