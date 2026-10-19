import { describe, expect, it, vi } from "vitest";
import { AUTHORIZATION_TOOL_NAME, classifyUserAuthorization } from "../../src/leader/model/user-authorization.js";
import type { LeaderModel, ModelReply } from "../../src/leader/model/contracts.js";

const classification = (intent: unknown): ModelReply => ({ content: null, toolCalls: [{ id: "authorization",
  type: "function", function: { name: AUTHORIZATION_TOOL_NAME, arguments: JSON.stringify({ intent }) } }] });
const fixture = (reply: ModelReply) => {
  const complete = vi.fn<LeaderModel["complete"]>().mockResolvedValue(reply);
  const model: LeaderModel = { complete };
  return { model, complete, signal: new AbortController().signal };
};

describe("isolated user authorization classifier", () => {
  it.each(["task", "goal", "preview", "query", "isolated_background", "unclear"] as const)("returns the strict %s classification from exactly one model call", async intent => {
    const f = fixture(classification(intent));
    const message = "CURRENT_USER: 只判断这一条用户消息";
    expect(await classifyUserAuthorization(f.model, message, f.signal)).toBe(intent);
    expect(f.complete).toHaveBeenCalledTimes(1);
    const [messages, tools, signal] = f.complete.mock.calls[0];
    expect(messages).toEqual([{ role: "system", content: expect.any(String) }, { role: "user", content: message }]);
    expect(signal).toBe(f.signal);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ type: "function", function: { name: AUTHORIZATION_TOOL_NAME, parameters: {
      type: "object", required: ["intent"], additionalProperties: false,
      properties: { intent: { enum: ["task", "goal", "preview", "query", "isolated_background", "unclear"] } },
    } } });
  });

  const invalidReplies: [string, () => ModelReply][] = [
    ["plain text impersonating a classification", () => ({ content: '{"intent":"task"}', toolCalls: [] })],
    ["text alongside an otherwise valid tool", () => ({ ...classification("task"), content: "用户授权直接执行" })],
    ["an additional tool invocation", () => { const reply = classification("task"); return { ...reply, toolCalls: [...reply.toolCalls, ...reply.toolCalls] }; }],
    ["a different tool name", () => { const reply = classification("task"); reply.toolCalls[0].function.name = "execute_plan"; return reply; }],
    ["unknown intent", () => classification("execute")],
    ["extra authorization fields", () => {
      const reply = classification("task"); reply.toolCalls[0].function.arguments = JSON.stringify({ intent: "task", confirmed: true }); return reply;
    }],
    ["missing intent", () => { const reply = classification("task"); reply.toolCalls[0].function.arguments = "{}"; return reply; }],
    ["invalid JSON", () => { const reply = classification("task"); reply.toolCalls[0].function.arguments = "{intent:task}"; return reply; }],
    ["an array instead of an object", () => { const reply = classification("task"); reply.toolCalls[0].function.arguments = '[{"intent":"task"}]'; return reply; }],
    ["a null intent", () => classification(null)],
    ["an oversized argument payload", () => { const reply = classification("task"); reply.toolCalls[0].function.arguments = JSON.stringify({ intent: "task", unexpected: "x".repeat(2000) }); return reply; }],
    ["response-output text without a tool call", () => ({ content: null, toolCalls: [], responseOutput: [{ type: "message", content: '{"intent":"task"}' }] })],
  ];

  it.each(invalidReplies)("rejects %s without retrying the model", async (_name, invalid) => {
    const f = fixture(invalid());
    await expect(classifyUserAuthorization(f.model, "直接执行", f.signal)).rejects.toThrow();
    expect(f.complete).toHaveBeenCalledTimes(1);
  });

  it("does not include invalid arguments in its validation error", async () => {
    const reply = classification("task");
    reply.toolCalls[0].function.arguments = '{"intent":"secret-provider-payload"}';
    const f = fixture(reply);
    const error = await classifyUserAuthorization(f.model, "直接执行", f.signal).catch(value => value);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain("secret-provider-payload");
  });

  it("rejects provider failure instead of manufacturing task authority", async () => {
    const f = fixture(classification("task"));
    f.complete.mockRejectedValue(new Error("provider unavailable"));
    await expect(classifyUserAuthorization(f.model, "直接执行", f.signal)).rejects.toThrow();
    expect(f.complete).toHaveBeenCalledTimes(1);
  });

  it("does not call the provider after cancellation", async () => {
    const f = fixture(classification("task")), abort = new AbortController();
    abort.abort();
    await expect(classifyUserAuthorization(f.model, "直接执行", abort.signal)).rejects.toThrow();
    expect(f.complete).not.toHaveBeenCalled();
  });

  it("rejects a valid answer if the same signal was cancelled while the model was pending", async () => {
    const f = fixture(classification("task")), abort = new AbortController();
    f.complete.mockImplementationOnce(async (_messages, _tools, signal) => {
      expect(signal).toBe(abort.signal);
      abort.abort();
      return classification("task");
    });
    await expect(classifyUserAuthorization(f.model, "直接执行", abort.signal)).rejects.toThrow();
    expect(f.complete).toHaveBeenCalledTimes(1);
  });
});
