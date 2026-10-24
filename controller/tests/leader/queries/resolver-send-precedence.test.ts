import { describe, expect, it } from "vitest";
import { NaturalLanguageResolver } from "../../../src/leader/queries/resolver.js";
import type { ScopedSession } from "../../../src/types.js";

describe("rule resolver send precedence", () => {
  const resolver = new NaturalLanguageResolver();
  const session: ScopedSession = {
    id: "s1",
    nodeId: "node-1",
    provider: "codex-app",
    title: "Main session",
    cwd: "/test/project",
    status: "idle",
    loaded: true,
    capabilities: ["read", "send"],
    observedAt: new Date().toISOString(),
  };

  it.each([
    ["让 s1 执行：查看主机配置", "查看主机配置"],
    ["让 s1 执行：列出任务", "列出任务"],
    ["在 s1 上执行：看看 host 列表", "看看 host 列表"],
    ["发给 s1：列出所有会话", "列出所有会话"],
    ["让 s1 执行 查看主机配置", "查看主机配置"],
    ["让 s1 执行 列出任务", "列出任务"],
    ["执行：查看主机配置", "查看主机配置"],
    ["运行：列出任务", "列出任务"],
    ["让 s1 执行：查看主机配置\n列出任务", "查看主机配置\n列出任务"],
  ])("dispatches the complete task body in %s", (text, prompt) => {
    expect(resolver.resolve(text, { sessions: [session] })).toEqual({
      action: "send_session",
      nodeId: session.nodeId,
      sessionId: session.id,
      prompt,
    });
  });

  it.each(["查看所有机器节点", "列出主机", "节点列表"])(
    "keeps the outer node query %s",
    (text) => {
      expect(resolver.resolve(text, { sessions: [session] }).action).toBe("list_nodes");
    },
  );

  it.each(["当前有哪些会话在跑？", "列出任务", "会话列表"])(
    "keeps the outer session query %s",
    (text) => {
      expect(resolver.resolve(text, { sessions: [session] }).action).toBe("list_sessions");
    },
  );

  it.each(["查看 s1 的日志", "在 s1 上查看输出"])(
    "keeps the outer read query %s",
    (text) => {
      expect(resolver.resolve(text, { sessions: [session] })).toEqual({
        action: "read_session",
        nodeId: session.nodeId,
        sessionId: session.id,
      });
    },
  );

  it("rejects an unknown explicit target even when the body contains listing words", () => {
    const intent = resolver.resolve("让 missing 执行：列出任务", {
      sessions: [session],
      lastContext: { nodeId: session.nodeId, sessionId: session.id },
    });
    expect(intent.action).toBe("unknown");
    expect(intent.replyText).toContain("未找到指定的目标 'missing'");
  });

  it("checks send eligibility before handling listing words in the body", () => {
    const intent = resolver.resolve("让 s1 执行：查看主机配置", {
      sessions: [{ ...session, capabilities: ["read"] }],
    });
    expect(intent.action).toBe("unknown");
    expect(intent.replyText).toContain("不支持 send 指令");
  });

  it("clarifies ambiguous explicit targets before handling listing words in the body", () => {
    const intent = resolver.resolve("让 s1 执行：列出任务", {
      sessions: [session, { ...session, nodeId: "node-2" }],
    });
    expect(intent.action).toBe("clarification");
    expect(intent.clarificationMessage).toContain("匹配到多个可能的目标会话");
  });

  it("keeps terminal confirmation required for a task body containing listing words", () => {
    const intent = resolver.resolve("让 Main session 执行：查看主机配置", {
      sessions: [{ ...session, id: `terminal:${"A".repeat(43)}`, provider: "terminal/codex" }],
    });
    expect(intent.action).toBe("unknown");
    expect(intent.replyText).toContain("终端非原子输入");
  });

  it("does not invent a target when the body contains a session listing request", () => {
    const intent = resolver.resolve("执行：列出任务", { sessions: [] });
    expect(intent.action).toBe("unknown");
    expect(intent.replyText).toContain("当前未发现任何可用会话");
  });

  it.each(["提示：请大家注意明天下午开会", "运行状态怎么样", "让 s1 执行：", ""])(
    "does not dispatch incomplete or non-command input %s",
    (text) => {
      expect(resolver.resolve(text, { sessions: [session] }).action).toBe("unknown");
    },
  );
});
