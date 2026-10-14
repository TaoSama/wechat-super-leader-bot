import { describe, it, expect } from "vitest";
import { NaturalLanguageResolver } from "../../../src/leader/queries/resolver.js";
import { ScopedSession } from "../../../src/types.js";

describe("NaturalLanguageResolver", () => {
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
      loaded: true,
      capabilities: ["read", "send"],
      observedAt: new Date().toISOString(),
    },
  ];

  it("resolves list_nodes query", () => {
    const res = resolver.resolve("查看所有机器节点", { sessions });
    expect(res.action).toBe("list_nodes");
  });

  it("resolves list_sessions query", () => {
    const res = resolver.resolve("当前有哪些会话在跑？", { sessions });
    expect(res.action).toBe("list_sessions");
  });

  it("resolves read_session with explicit target", () => {
    const res = resolver.resolve("查看 session-1 的输出", { sessions });
    expect(res.action).toBe("read_session");
    expect(res.nodeId).toBe("demoair");
    expect(res.sessionId).toBe("session-1");
  });

  it("requires clarification when ambiguous target in read query", () => {
    const res = resolver.resolve("在 demoair 上查看输出", { sessions });
    expect(res.action).toBe("clarification");
    expect(res.clarificationMessage).toContain("拥有多个会话");
  });

  it("resolves send_session with prompt", () => {
    const res = resolver.resolve("在 session-1 执行: pnpm test", { sessions });
    expect(res.action).toBe("send_session");
    expect(res.nodeId).toBe("demoair");
    expect(res.sessionId).toBe("session-1");
    expect(res.prompt).toBe("pnpm test");
  });

  it("rejects send to read-only session", () => {
    const res = resolver.resolve("让 session-2 执行: echo 123", { sessions });
    expect(res.action).toBe("unknown");
    expect(res.replyText).toContain("不支持 send 指令");
  });

  it("requires clarification when multiple candidates exist for send", () => {
    const res = resolver.resolve("让它继续跑", { sessions });
    expect(res.action).toBe("clarification");
    expect(res.clarificationMessage).toContain("检测到多个会话");
  });

  it("resolves target from lastContext when user says 继续", () => {
    const res = resolver.resolve("继续", {
      sessions,
      lastContext: { nodeId: "demoair", sessionId: "session-1" },
    });
    expect(res.action).toBe("send_session");
    expect(res.nodeId).toBe("demoair");
    expect(res.sessionId).toBe("session-1");
    expect(res.prompt).toBe("继续");
  });

  it("does not turn acknowledgement or status questions into execution", () => {
    for (const text of ["ok", "运行状态怎么样", "备注：session-1"]) {
      expect(resolver.resolve(text, { sessions: [sessions[0]] }).action).not.toBe("send_session");
    }
  });

  it("does not resolve targets from prompt content", () => {
    const res = resolver.resolve("执行：检查 session-3 的配置", { sessions });
    expect(res.action).toBe("clarification");
  });

  it("fails closed for unknown or conflicting explicit targets", () => {
    for (const text of [
      "让 missing 执行：测试",
      "让 vps-hk session-1 执行：测试",
      "让 missing session-1 执行：测试",
      "让 session-100 执行：测试",
      "查看 missing 的输出",
    ]) {
      expect(resolver.resolve(text, { sessions: [sessions[0]] }).action).toBe("unknown");
    }
  });

  it("supports whitespace, exact node and duplicate session IDs", () => {
    const duplicates = [sessions[0], { ...sessions[0], nodeId: "vps-hk" }];
    expect(resolver.resolve("让 session-1 执行：测试", { sessions: duplicates }).action).toBe("clarification");
    const res = resolver.resolve("在 demoair session-1 上执行: pnpm test", { sessions: duplicates });
    expect(res).toMatchObject({ action: "send_session", nodeId: "demoair", prompt: "pnpm test" });
  });

  it("uses desktop eligibility for explicit, single and contextual targets without native fallback", () => {
    const now = Date.now();
    const desktop: ScopedSession = { ...sessions[0], loaded: false, status: "notLoaded", capabilities: ["read"],
      sendAvailability: { route: "desktop-owner", state: "ready", observedAt: new Date(now).toISOString(), validUntil: new Date(now + 45000).toISOString() } };
    const cases = [
      { text: "让 session-1 执行：fixture", context: { sessions: [desktop] } },
      { text: "执行：fixture", context: { sessions: [desktop] } },
      { text: "继续", context: { sessions: [desktop, sessions[2]], lastContext: { nodeId: "demoair", sessionId: "session-1" } } },
    ];
    for (const entry of cases) expect(resolver.resolve(entry.text, entry.context).action).toBe("send_session");
    desktop.loaded = true;
    desktop.status = "idle";
    desktop.capabilities = ["read", "send"];
    desktop.sendAvailability!.state = "blocked";
    for (const entry of cases) expect(resolver.resolve(entry.text, entry.context).action).toBe("unknown");
  });
});
