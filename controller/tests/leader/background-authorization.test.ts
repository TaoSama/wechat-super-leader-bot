import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_AUTHORIZATION_TOOL_NAME, classifyBackgroundAuthorization } from "../../src/leader/model/background-authorization.js";
import type { LeaderModel, ModelReply } from "../../src/leader/model/contracts.js";

const reply = (operations: unknown): ModelReply => ({ content: null, toolCalls: [{ id: "auth", type: "function",
  function: { name: BACKGROUND_AUTHORIZATION_TOOL_NAME, arguments: JSON.stringify({ operations }) } }] });
describe("background human authorization", () => {
  it("isolates current human text from history, task outputs and tools", async () => {
    const complete = vi.fn<LeaderModel["complete"]>(async () => reply(["follow_up", "extend"]));
    const signal = AbortSignal.timeout(1000);
    expect(await classifyBackgroundAuthorization({ complete }, "再看看刚才那个，并再留一天", signal)).toEqual(new Set(["follow_up", "extend"]));
    const [messages, tools, passedSignal] = complete.mock.calls[0];
    expect(messages).toEqual([{ role: "system", content: expect.any(String) }, { role: "user", content: "再看看刚才那个，并再留一天" }]);
    expect(tools.map(item => item.function.name)).toEqual([BACKGROUND_AUTHORIZATION_TOOL_NAME]);
    expect(passedSignal).toBe(signal);
  });
  it("does not grant operation authority for a status query", async () => {
    expect(await classifyBackgroundAuthorization({ complete: async () => reply([]) }, "刚才那个完成了吗", AbortSignal.timeout(1000))).toEqual(new Set());
  });
  it.each([
    reply(["follow_up", "follow_up"]), reply(["resume"]), reply("extend"),
    { ...reply(["create"]), content: "extra" },
    { content: null, toolCalls: [] },
    { content: null, toolCalls: [...reply([]).toolCalls, ...reply([]).toolCalls] },
    { content: null, toolCalls: [{ ...reply([]).toolCalls[0], function: { name: "execute_task", arguments: "{}" } }] },
    { content: null, toolCalls: [{ ...reply([]).toolCalls[0], function: { name: BACKGROUND_AUTHORIZATION_TOOL_NAME, arguments: "invalid-json" } }] },
  ] satisfies ModelReply[])("fails closed on malformed classifier response %#", async value => {
    await expect(classifyBackgroundAuthorization({ complete: async () => value }, "继续", AbortSignal.timeout(1000))).rejects.toThrow();
  });
  it("does not classify an expired user turn", async () => {
    const complete = vi.fn();
    const abort = new AbortController(); abort.abort();
    await expect(classifyBackgroundAuthorization({ complete }, "继续", abort.signal)).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
  });
});
