import { describe, expect, it, vi } from "vitest";
import { LeaderOrchestrator } from "../../src/leader/orchestrator.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { LeaderModel, ModelMessage, ModelReply } from "../../src/leader/model/contracts.js";
import type { CommandRecord, PostCommandRequest, ScopedSession } from "../../src/types.js";

const tool = (name: string, args: unknown): ModelReply => ({
  content: null,
  toolCalls: [{ id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const final = (content: string): ModelReply => ({ content, toolCalls: [] });

class ScriptedModel implements LeaderModel {
  calls: ModelMessage[][] = [];
  constructor(private replies: (ModelReply | (() => never))[]) {}
  async complete(messages: ModelMessage[]) {
    this.calls.push(structuredClone(messages));
    const next = this.replies.shift();
    if (!next) throw new Error("No scripted response");
    if (typeof next === "function") return next();
    return next;
  }
}

function fixture(replies: (ModelReply | (() => never))[] = [], issuer?: (requestId: string) => Promise<{ url: string; expiresAt: string }>) {
  const store = new MemoryStore();
  let clock = 1700000000000;
  const sessions: ScopedSession[] = [
    { id: "s1", nodeId: "macair", provider: "codex-app", title: "测试", cwd: "/test", status: "idle", loaded: true, capabilities: ["read", "send"], observedAt: new Date(clock).toISOString() },
  ];
  const hub = {
    getAllSkills: () => [],
    getNodeSkills: () => [],
    getAllSessions: async () => sessions,
    getNodeStatusList: () => [],
    getNodeSession: (node: string, id: string) => sessions.find(s => s.nodeId === node && s.id === id) ?? null,
    isNodeConnected: (node: string) => sessions.some(s => s.nodeId === node),
  };
  const model = new ScriptedModel(replies);
  const commands = {
    submit: vi.fn(async (req: PostCommandRequest) => {
      const now = new Date().toISOString();
      const result: CommandRecord = {
        ...req,
        commandId: `cmd-${commands.submit.mock.calls.length}`,
        status: req.action === "send" ? "accepted" : "completed",
        turnId: req.action === "send" ? `turn-${commands.submit.mock.calls.length}` : undefined,
        createdAt: now,
        updatedAt: now,
        expiresAt: new Date(Date.now() + 100000).toISOString(),
      };
      const stored = await store.createCommandIfAbsent(result);
      return stored.command;
    }),
  };
  const create = (nextModel: LeaderModel = model, nextIssuer = issuer) =>
    new LeaderOrchestrator(store, hub, commands, nextModel, () => clock, nextIssuer);
  return { store, model, hub, commands, create, tick: (ms: number) => { clock += ms; } };
}

describe("Leader console link integration", () => {
  it("issues one-time link, appends URL with updated notice, and keeps model trace and history completely sanitized", async () => {
    const issuer = vi.fn(async (requestId: string) => ({
      url: `https://leader.taoai.site/#login=secret-otp-token-for-${requestId}`,
      expiresAt: "2026-10-11T12:00:00.000Z",
    }));
    const f = fixture([tool("get_console_link", {}), final("已为你生成控制台链接。")], issuer);
    const leader = f.create();

    const reply = await leader.handle("chat-1", "msg-1", "帮我打开控制台");

    // 1. 用户收到的回复包含真实链接，且文案为“打开后地址栏会自动隐藏登录凭证”
    expect(reply.text).toContain("已为你生成控制台链接");
    expect(reply.text).toContain("https://leader.taoai.site/#login=secret-otp-token-for-console_link_");
    expect(reply.text).toContain("1小时内有效，仅可使用一次，打开后地址栏会自动隐藏登录凭证");
    expect(issuer).toHaveBeenCalledTimes(1);
    const invokedRequestId = issuer.mock.calls[0][0];
    expect(invokedRequestId).toMatch(/^console_link_[0-9a-f]{64}$/);

    // 2. 模型自身接收到的所有消息（trace）中绝不含任何真实 URL 或 token
    expect(f.model.calls.length).toBe(2);
    const secondStep = f.model.calls[1];
    const toolOutputMsg = secondStep.find(m => m.role === "tool");
    expect(toolOutputMsg).toBeDefined();
    expect(toolOutputMsg?.content).toBe(JSON.stringify({ ready: true, expiresAt: "2026-10-11T12:00:00.000Z" }));
    for (const callMessages of f.model.calls) {
      for (const msg of callMessages) {
        expect(msg.content ?? "").not.toContain("secret-otp-token");
        expect(msg.content ?? "").not.toContain("https://leader.taoai.site");
      }
    }

    // 3. 存储在 state 中的 history 被安全脱敏，不含 token 或 url
    const state = await f.store.getLeaderState("chat-1");
    expect(state).not.toBeNull();
    const history = state!.data.history as Array<{ role: string; content: string }>;
    expect(history.length).toBe(2);
    expect(history[1].content).toContain("[一次性控制台登录链接已生成，有效期1小时]");
    expect(history[1].content).not.toContain("secret-otp-token");
    expect(history[1].content).not.toContain("https://leader.taoai.site");

    // 4. 重复消息（相同 messageId 与相同文本）幂等返回已有的 receipt，绝不重新调用 issuer
    const repeatReply = await leader.handle("chat-1", "msg-1", "帮我打开控制台");
    expect(repeatReply).toEqual(reply);
    expect(issuer).toHaveBeenCalledTimes(1);
  });

  it("reuses the same issuance if get_console_link is called multiple times within the same message turn", async () => {
    const issuer = vi.fn(async (requestId: string) => ({
      url: `https://leader.taoai.site/#login=token-${requestId}`,
      expiresAt: "2026-10-11T12:00:00.000Z",
    }));
    const f = fixture([tool("get_console_link", {}), tool("get_console_link", {}), final("链接已备妥")], issuer);
    const reply = await f.create().handle("chat-1", "msg-dup-tool", "我需要控制台链接");
    expect(reply.text).toContain("https://leader.taoai.site/#login=token-");
    expect(issuer).toHaveBeenCalledTimes(1);
  });

  it("returns error when console link issuer is not configured", async () => {
    const f = fixture([tool("get_console_link", {}), final("当前控制台链接暂未启用")]);
    const reply = await f.create().handle("chat-1", "msg-no-issuer", "给我控制台链接");
    expect(f.model.calls.length).toBe(2);
    const toolMsg = f.model.calls[1].find(m => m.role === "tool");
    expect(toolMsg?.content).toContain("控制台链接发行功能未配置或未启用");
    expect(reply.text).not.toContain("https://");
    expect(reply.text).toContain("当前控制台链接暂未启用");
  });

  it("catches issuer error with fixed sanitized message, preventing synthetic secret leaks to model", async () => {
    // 注入包含假 secret 的 Error，断言绝不泄露给模型
    const failingIssuer = vi.fn(async () => {
      throw new Error("Connection failed: secret_database_password_987654321");
    });
    const f = fixture([tool("get_console_link", {}), final("未能获取到控制台链接")], failingIssuer);
    const reply = await f.create().handle("chat-1", "msg-err", "获取链接");
    const toolMsg = f.model.calls[1].find(m => m.role === "tool");
    expect(toolMsg?.content).toBe(JSON.stringify({ error: "获取控制台链接失败，请稍后再试" }));
    expect(toolMsg?.content).not.toContain("secret_database_password_987654321");
    expect(reply.text).toContain("未能获取到控制台链接");
    expect(reply.text).not.toContain("控制台登录链接");
    expect(reply.text).not.toContain("secret_database_password_987654321");
  });

  it("does not attach console link when model step limit is reached", async () => {
    const issuer = vi.fn(async () => ({
      url: "https://leader.taoai.site/#login=test-token-step-limit",
      expiresAt: "2026-10-11T12:00:00.000Z",
    }));
    const replies = Array.from({ length: 6 }, () => tool("get_console_link", {}));
    const f = fixture(replies, issuer);
    const reply = await f.create().handle("chat-1", "msg-limit", "疯狂请求链接");
    expect(reply.text).toContain("本轮查询已达到上限");
    expect(reply.text).not.toContain("https://leader.taoai.site/#login=");
    expect(reply.text).not.toContain("test-token-step-limit");
    expect(reply.text).not.toContain("控制台登录链接");
  });

  it("does not attach console link when reason loop fails with an exception", async () => {
    const issuer = vi.fn(async () => ({
      url: "https://leader.taoai.site/#login=test-token-failed-reason",
      expiresAt: "2026-10-11T12:00:00.000Z",
    }));
    // 步骤 1 获取链接成功，步骤 2 模型抛出异常模拟 provider 崩溃
    const replies = [
      tool("get_console_link", {}),
      () => { throw new Error("Simulated provider crash"); },
    ];
    const f = fixture(replies, issuer);
    const reply = await f.create().handle("chat-1", "msg-crash", "获取链接然后崩溃");
    expect(reply.text).toContain("本次模型处理未成功");
    expect(reply.text).not.toContain("https://leader.taoai.site/#login=");
    expect(reply.text).not.toContain("test-token-failed-reason");
    expect(reply.text).not.toContain("控制台登录链接");
  });

  it("sanitizes user-pasted #login= credentials before feeding into model and storing in history", async () => {
    const f = fixture([final("收到你反馈的问题")]);
    const leader = f.create();
    await leader.handle(
      "chat-1",
      "msg-user-paste",
      "请帮我看看这个控制台链接为什么进不去：https://leader.taoai.site/#login=super-secret-pasted-token-999"
    );

    expect(f.model.calls.length).toBe(1);
    const userPrompt = f.model.calls[0].find(m => m.role === "user");
    expect(userPrompt?.content).toContain("#login=[REDACTED]");
    expect(userPrompt?.content).not.toContain("super-secret-pasted-token-999");

    const state = await f.store.getLeaderState("chat-1");
    const userHistory = (state!.data.history as Array<{ role: string; content: string }>)[0];
    expect(userHistory.content).toContain("#login=[REDACTED]");
    expect(userHistory.content).not.toContain("super-secret-pasted-token-999");
  });
});
