import { expect, it } from "vitest";
import { NaturalLanguageResolver } from "../../../src/leader/queries/resolver.js";
import type { ScopedSession } from "../../../src/types.js";

const sessions: ScopedSession[] = [{ id: "session-1", nodeId: "macair", provider: "codex-app", title: "Codex App Main",
  cwd: "/w", status: "active", loaded: true, capabilities: ["read", "send"], observedAt: new Date().toISOString() }];
const resolver = new NaturalLanguageResolver();

it.each(["停止 Codex App Main 当前运行", "帮我停掉 Codex App Main 会话正在运行的任务", "中断 Codex App Main"])(
  "resolves an explicit stop of a named session: %s", text => {
    expect(resolver.resolve(text, { sessions })).toEqual({ action: "interrupt_session", nodeId: "macair", sessionId: "session-1" });
  });

it("never resolves a stop from previous context or plan cancellation", () => {
  const ctx = { sessions, lastContext: { nodeId: "macair", sessionId: "session-1" } };
  expect(resolver.resolve("停止", ctx).action).toBe("clarification");
  expect(resolver.resolve("停止后续派发", ctx).action).not.toBe("interrupt_session");
  expect(resolver.resolve("停止 不存在的会话", ctx).action).not.toBe("interrupt_session");
});
