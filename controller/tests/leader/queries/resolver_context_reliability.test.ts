import { describe, expect, it } from "vitest";
import { NaturalLanguageResolver } from "../../../src/leader/queries/resolver.js";
import type { ScopedSession } from "../../../src/types.js";

const original: ScopedSession = {
  id: "original",
  nodeId: "air",
  provider: "codex-app",
  title: "Original task",
  cwd: "/fixture/original",
  status: "idle",
  loaded: true,
  capabilities: ["read", "send"],
  observedAt: "2026-10-23T00:00:00.000Z",
};
const unrelated: ScopedSession = { ...original, id: "unrelated", nodeId: "mini" };
const lastContext = { nodeId: original.nodeId, sessionId: original.id };
const resolver = new NaturalLanguageResolver();

describe("implicit send context reliability", () => {
  it.each(["继续", "继续执行", "让它继续跑", "执行：检查测试结果"])(
    "rejects %s when only an unrelated session remains online",
    text => {
      const result = resolver.resolve(text, { sessions: [unrelated], lastContext });
      expect(result).toMatchObject({ action: "unknown" });
      expect(result.replyText).toContain("[air] original 当前不可用");
      expect(result).not.toHaveProperty("nodeId");
      expect(result).not.toHaveProperty("sessionId");
    },
  );

  it.each([
    { name: "same session ID on a different node", sessions: [{ ...original, nodeId: "mini" }] },
    { name: "different session on the original node", sessions: [{ ...unrelated, nodeId: "air" }] },
    { name: "multiple unrelated sessions", sessions: [unrelated, { ...unrelated, id: "another" }] },
    { name: "no online sessions", sessions: [] },
  ])("rejects a missing exact target with $name", ({ sessions }) => {
    const result = resolver.resolve("继续", { sessions, lastContext });
    expect(result.action).toBe("unknown");
    expect(result.replyText).toContain("请等待原会话恢复，或明确指定新的目标会话");
  });

  it("resumes the exact context after it returns online", () => {
    expect(resolver.resolve("继续", { sessions: [unrelated, original], lastContext })).toEqual({
      action: "send_session", nodeId: "air", sessionId: "original", prompt: "继续",
    });
  });

  it("preserves the context target's send and terminal guards", () => {
    const readOnly: ScopedSession = { ...original, capabilities: ["read"] };
    expect(resolver.resolve("继续", { sessions: [readOnly, unrelated], lastContext })).toMatchObject({
      action: "unknown", replyText: expect.stringContaining("当前不具备 send 资格"),
    });
    const terminal = { ...original, provider: "terminal/codex" };
    expect(resolver.resolve("继续", { sessions: [terminal, unrelated], lastContext })).toMatchObject({
      action: "unknown", replyText: expect.stringContaining("规则模式仅支持读取终端观测"),
    });
  });

  it("allows an explicit new target despite an unavailable previous target", () => {
    expect(resolver.resolve("让 unrelated 执行：测试", { sessions: [unrelated], lastContext })).toEqual({
      action: "send_session", nodeId: "mini", sessionId: "unrelated", prompt: "测试",
    });
  });

  it("keeps single-session inference when no previous target exists", () => {
    expect(resolver.resolve("继续", { sessions: [unrelated] })).toEqual({
      action: "send_session", nodeId: "mini", sessionId: "unrelated", prompt: "继续",
    });
  });
});
