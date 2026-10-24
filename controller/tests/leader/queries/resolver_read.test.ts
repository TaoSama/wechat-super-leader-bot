import { describe, expect, it } from "vitest";
import { NaturalLanguageResolver } from "../../../src/leader/queries/resolver.js";
import { ScopedSession } from "../../../src/types.js";

describe("NaturalLanguageResolver read queries", () => {
  const resolver = new NaturalLanguageResolver();
  const session: ScopedSession = {
    id: "s1",
    nodeId: "macair",
    provider: "codex-app",
    title: "执行器",
    cwd: "/test/project",
    status: "idle",
    loaded: true,
    capabilities: ["read", "send"],
    observedAt: new Date().toISOString(),
  };
  const sessions = [session, { ...session, id: "s2", nodeId: "lab", title: "Worker" }];

  it.each([
    "查看 s1 执行到哪",
    "看看 s1 跑成什么样",
    "同步 s1 的进度",
    "说一下 s1 的状态",
    "讲讲 s1 的进展",
    "读取 s1 的最新日志？",
    "查一下 s1 的结果",
    "汇报 s1 的情况",
    "报告 s1 的内容",
    "检查 s1 的输出",
    "读取 s1 的 tail",
    "读取 s1 的 LOG",
    "在 s1 上同步进度",
    "查看 s1 上的输出",
    "查看 s1 上读取日志",
    "查看 macair 的会话 s1 的输出",
    "查看 执行器 的状态",
  ])("extracts the exact read target from %s", (text) => {
    expect(resolver.resolve(text, { sessions })).toMatchObject({
      action: "read_session", nodeId: "macair", sessionId: "s1",
    });
  });

  it.each([
    "查看 missing 执行到哪",
    "看看 missing 跑成什么样",
    "同步 missing 的进度",
    "说一下 missing 的状态",
  ])("does not fall back when %s names an unknown target", (text) => {
    const result = resolver.resolve(text, {
      sessions: [session], lastContext: { nodeId: "macair", sessionId: "s1" },
    });
    expect(result.action).toBe("unknown");
    expect(result.replyText).toContain("'missing'");
  });

  it("retains implicit-target clarification and single-session resolution", () => {
    expect(resolver.resolve("看看跑成什么样", { sessions: [session] })).toMatchObject({
      action: "read_session", nodeId: "macair", sessionId: "s1",
    });
    expect(resolver.resolve("同步进度", { sessions }).action).toBe("clarification");
    expect(resolver.resolve("说一下状态", { sessions: [] }).action).toBe("unknown");
  });

  it("retains ambiguity and exact node constraints for read targets", () => {
    const duplicates = [session, { ...session, nodeId: "lab" }];
    expect(resolver.resolve("同步 s1 的进度", { sessions: duplicates }).action).toBe("clarification");
    expect(resolver.resolve("同步 macair s1 的进度", { sessions: duplicates })).toMatchObject({
      action: "read_session", nodeId: "macair", sessionId: "s1",
    });
    expect(resolver.resolve("说一下 lab s1 的状态", { sessions: [session] }).action).toBe("unknown");
  });

  it.each([
    "查看 s1 的状态并执行测试",
    "查看进度：让 s1 执行测试",
  ])("does not accept a partial read sentence in %s", (text) => {
    expect(resolver.resolve(text, { sessions: [session] }).action).toBe("unknown");
  });

  it.each([
    ["输入：说一下 s1 的状态", "说一下 s1 的状态"],
    ["告诉 s1：同步进度", "同步进度"],
    ["发给 s1：看看 s2 跑成什么样", "看看 s2 跑成什么样"],
  ])("keeps explicit sends containing read phrases as sends: %s", (text, prompt) => {
    expect(resolver.resolve(text, { sessions: [session] })).toMatchObject({
      action: "send_session", nodeId: "macair", sessionId: "s1", prompt,
    });
  });
});
