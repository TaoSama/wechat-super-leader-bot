import { describe, it, expect } from "vitest";
import { NaturalLanguageResolver } from "../../../src/leader/queries/resolver.js";
import { ScopedSession } from "../../../src/types.js";

describe("NaturalLanguageResolver Security & Edge Cases", () => {
  const resolver = new NaturalLanguageResolver();

  const sessions: ScopedSession[] = [
    {
      id: "session-1",
      nodeId: "demoair",
      provider: "codex-app",
      title: "Codex App Main",
      cwd: "/Users/test/project",
      status: "idle",
      loaded: true,
      capabilities: ["read", "send"],
      observedAt: new Date().toISOString(),
    },
    {
      id: "session-2",
      nodeId: "demoair",
      provider: "codex-app",
      title: "Codex Worker",
      cwd: "/Users/test/worker",
      status: "running",
      capabilities: ["read"], // read-only!
      observedAt: new Date().toISOString(),
    },
    {
      id: "session-3",
      nodeId: "vps-hk",
      provider: "codex-app",
      title: "Remote Node Task",
      cwd: "/root/task",
      status: "idle",
      capabilities: ["read", "send"],
      observedAt: new Date().toISOString(),
    },
  ];

  it("Fix 1: correctly routes '查看 demoair 的会话 session-1 的输出' to read_session, not list_sessions", () => {
    const res = resolver.resolve("查看 demoair 的会话 session-1 的输出", { sessions });
    expect(res.action).toBe("read_session");
    expect(res.nodeId).toBe("demoair");
    expect(res.sessionId).toBe("session-1");
  });

  it("Fix 2: ordinary colon chat message does NOT trigger execution", () => {
    const singleSession: ScopedSession[] = [sessions[0]];
    const res = resolver.resolve("提示：请大家注意明天下午开会", { sessions: singleSession });
    expect(res.action).toBe("unknown");
    expect(res.action).not.toBe("send_session");
  });

  it("Fix 3: prompt containing another session ID does not confuse target resolution", () => {
    const res = resolver.resolve("让 session-1 执行：检查 session-2 的状态", { sessions });
    expect(res.action).toBe("send_session");
    expect(res.nodeId).toBe("demoair");
    expect(res.sessionId).toBe("session-1");
    expect(res.prompt).toBe("检查 session-2 的状态");
  });

  it("Fix 4a: explicit non-existent node/session does not fallback to single session", () => {
    const singleSession: ScopedSession[] = [sessions[0]];
    const res = resolver.resolve("让不存在的节点 bad-node 的 bad-sess 执行：echo dangerous", {
      sessions: singleSession,
    });
    expect(res.action).toBe("unknown");
    expect(res.replyText).toContain("未找到指定的目标");
  });

  it("Fix 4b: explicit non-existent session does not fallback to lastContext", () => {
    const res = resolver.resolve("让不存在的会话 ghost-sess 执行：rm -rf /", {
      sessions,
      lastContext: { nodeId: "demoair", sessionId: "session-1" },
    });
    expect(res.action).toBe("unknown");
    expect(res.replyText).toContain("未找到指定的目标");
  });
});
