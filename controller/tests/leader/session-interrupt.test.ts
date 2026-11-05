import { expect, it, vi } from "vitest";
import { authorizeSessionInterrupt } from "../../src/leader/model/interrupt-authorization.js";
import { interruptSessionTurn } from "../../src/leader/session-interrupt.js";
import type { LeaderModel, ModelReply } from "../../src/leader/model/contracts.js";
import type { LeaderData } from "../../src/leader/contracts.js";
import type { ScopedSession } from "../../src/types.js";

const NOW = Date.parse("2026-11-04T00:00:00Z");
const CHAT_ID = "allowed-chat";

function model(reply: ModelReply): LeaderModel {
  return { complete: vi.fn(async () => reply) } as unknown as LeaderModel;
}
const call = (args: string): ModelReply => ({ content: "", toolCalls: [{ id: "c", type: "function",
  function: { name: "classify_session_interrupt", arguments: args } }] } as ModelReply);

it("authorizes only an explicit classification and fails closed on malformed replies", async () => {
  const signal = new AbortController().signal;
  expect(await authorizeSessionInterrupt(model(call('{"interruptSession":true}')), "停掉A", signal)).toBe(true);
  expect(await authorizeSessionInterrupt(model(call('{"interruptSession":false}')), "能停吗", signal)).toBe(false);
  expect(await authorizeSessionInterrupt(model(call("not json")), "停掉A", signal)).toBe(false);
  expect(await authorizeSessionInterrupt(model(call('{"interruptSession":true,"x":1}')), "停掉A", signal)).toBe(false);
  expect(await authorizeSessionInterrupt(model({ content: "yes", toolCalls: [] } as unknown as ModelReply), "停掉A", signal)).toBe(false);
});

function context(session?: Partial<ScopedSession>) {
  const target: ScopedSession = { nodeId: "macair", id: "thread", provider: "codex-app", title: "A", cwd: "/w", status: "active",
    loaded: true, capabilities: ["read", "send"], ...session };
  const data = { inflight: { messageId: "msg-1", inputHash: "hash", expiresAt: NOW + 60_000 }, commandIds: [] } as unknown as LeaderData;
  const submit = vi.fn(async () => ({ commandId: "cmd_1", status: "completed", output: "interrupted", turnId: "turn-1" }));
  const ctx = {
    store: { getLeaderState: vi.fn(async () => ({ data })) },
    hub: { isNodeConnected: () => true, getNodeSession: () => target, readHistory: vi.fn(async () => ({ items: [
      { id: "i", turnId: "turn-1", kind: "assistant", type: "agentMessage", text: "x", turnStatus: "inProgress" }] })) },
    commands: { submit }, now: () => NOW,
  };
  return { ctx: ctx as never, data, submit };
}

it("binds the leader interrupt to the current message and the exact resolved turn", async () => {
  const { ctx, data, submit } = context();
  const result = await interruptSessionTurn(ctx, CHAT_ID, data, { nodeId: "macair", sessionId: "thread" }, new AbortController().signal);
  expect(result).toMatchObject({ commandId: "cmd_1", turnId: "turn-1" });
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ action: "interrupt", expectedTurnId: "turn-1",
    requestId: expect.stringMatching(/^leader_interrupt_[a-f0-9]{64}$/) }), expect.any(Number), expect.any(Function),
  undefined, { type: "chat", chatId: CHAT_ID });
  expect(data.commandIds).toEqual(["cmd_1"]);
});

it("refuses terminal sessions and expired message claims without submitting", async () => {
  const terminal = context({ provider: "terminal/codex" });
  expect(await interruptSessionTurn(terminal.ctx, CHAT_ID, terminal.data, { nodeId: "macair", sessionId: "thread" },
    new AbortController().signal)).toEqual({ error: "终端会话暂不支持中断" });
  const expired = context();
  (expired.data.inflight as { expiresAt: number }).expiresAt = NOW - 1;
  expect(await interruptSessionTurn(expired.ctx, CHAT_ID, expired.data, { nodeId: "macair", sessionId: "thread" },
    new AbortController().signal)).toHaveProperty("error");
  expect(terminal.submit).not.toHaveBeenCalled();
  expect(expired.submit).not.toHaveBeenCalled();
});
