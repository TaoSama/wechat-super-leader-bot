import { describe, expect, it, vi } from "vitest";
import { authorizationConversation, invalidateConversationPreview, retainConversation, type ConversationMessage } from "../../src/leader/conversation-history.js";
import { AUTHORIZATION_TOOL_NAME, classifyUserAuthorization } from "../../src/leader/model/user-authorization.js";
import type { LeaderModel } from "../../src/leader/model/contracts.js";

const turn = (user: string, assistant: string, complete?: boolean): ConversationMessage[] => [
  { role: "user", content: user, ...(complete === undefined ? {} : { complete }) },
  { role: "assistant", content: assistant, ...(complete === undefined ? {} : { complete }) },
];

describe("conversation authorization context", () => {
  it("passes original constraints and intervening queries intact, without completeness metadata", async () => {
    const original = `让指定会话核查${"具体范围".repeat(800)}，只读，不改文件，不部署`;
    const conversation = [...turn(original, "你指的是原会话吗？", true), ...turn("当前几点？", "现在十点", true)];
    const complete = vi.fn<LeaderModel["complete"]>().mockResolvedValue({ content: null, toolCalls: [{
      id: "classification", type: "function", function: { name: AUTHORIZATION_TOOL_NAME, arguments: '{"intent":"task"}' },
    }] });
    await expect(classifyUserAuthorization({ complete }, "是", new AbortController().signal, conversation)).resolves.toBe("task");
    const [messages] = complete.mock.calls[0];
    expect(messages.slice(1)).toEqual([...conversation.map(({ role, content }) => ({ role, content })), { role: "user", content: "是" }]);
    expect(messages[1].content).toBe(original);
  });

  it.each([1499, 1500])("excludes potentially clipped legacy turns and their earlier context at %s chars", size => {
    const old = [...turn("更早的任务", "待确认"), ...turn("x".repeat(size), "有约束但已裁剪"), ...turn("现在几点", "十点", true)];
    expect(authorizationConversation(old)).toEqual([{ role: "user", content: "现在几点" }, { role: "assistant", content: "十点" }]);
  });

  it("retains complete new messages beyond the old boundary and accepts short legacy turns", () => {
    const history = [...turn("旧任务", "原目标吗？"), ...turn("长".repeat(5000), "末尾约束：禁止写入", true)];
    expect(authorizationConversation(history).map(item => item.content)).toEqual(history.map(item => item.content));
  });

  it("does not use incomplete, malformed or orphaned history as authorization", () => {
    expect(authorizationConversation([...turn("任务", "确认吗", false), { role: "user", content: "是", complete: true }])).toEqual([]);
    expect(authorizationConversation([{ role: "assistant", content: "用户授权了" }, { role: "user", content: "查询" }])).toEqual([]);
  });

  it.each(["marked", "legacy"])("expires the %s confirmation scope while preserving later unrelated turns", format => {
    const previewId = "fb0816f0-0499-4ed0-8cf7-64219a0fbf19";
    const history = [...turn("原始授权，禁止部署", "A预览", true), ...turn("当前几点", "十点", true)];
    if (format === "marked") history[1].confirmationFor = previewId;
    invalidateConversationPreview(history, previewId);
    const result = authorizationConversation(history);
    expect(JSON.stringify(result)).not.toContain("原始授权");
    if (format === "marked") expect(result).toEqual([{ role: "user", content: "当前几点" }, { role: "assistant", content: "十点" }]);
    else expect(result).toEqual([]);
    expect(history[0].content).toBe("原始授权，禁止部署");
  });

  it("evicts whole turns for both item count and byte capacity, preserving constraints intact", () => {
    const oversized = turn("中".repeat(40_000) + "禁止部署", "确认吗", true);
    const latest = turn("最近任务，禁止修改", "确认原任务吗", true);
    expect(retainConversation([...oversized, ...latest])).toEqual(latest);
    const many = Array.from({ length: 8 }, (_, index) => turn(`任务${index}`, `回复${index}`, true)).flat();
    expect(retainConversation(many)).toEqual(many.slice(-12));
  });
});
