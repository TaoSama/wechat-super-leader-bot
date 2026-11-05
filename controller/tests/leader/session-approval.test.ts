import { expect, it, vi } from "vitest";
import { classifyApprovalDecision } from "../../src/leader/model/approval-authorization.js";
import { answerSessionApproval } from "../../src/leader/session-approval.js";
import type { LeaderModel, ModelReply } from "../../src/leader/model/contracts.js";
import type { LeaderData } from "../../src/leader/contracts.js";
import type { ScopedSession } from "../../src/types.js";

const NOW = Date.parse("2026-11-05T00:00:00Z");
const CHAT_ID = "allowed-chat";
const PENDING = { requestId: "7", kind: "commandExecution", turnId: "turn-1", command: "make", answerable: true } as const;

const model = (reply: ModelReply) => ({ complete: vi.fn(async () => reply) }) as unknown as LeaderModel;
const call = (args: string): ModelReply => ({ content: "", toolCalls: [{ id: "c", type: "function",
  function: { name: "classify_approval_decision", arguments: args } }] } as ModelReply);

it("classifies only an explicit decision and fails closed to none", async () => {
  const signal = new AbortController().signal;
  expect(await classifyApprovalDecision(model(call('{"approvalDecision":"accept"}')), "批准", signal)).toBe("accept");
  expect(await classifyApprovalDecision(model(call('{"approvalDecision":"decline"}')), "拒绝", signal)).toBe("decline");
  expect(await classifyApprovalDecision(model(call('{"approvalDecision":"acceptForSession"}')), "全部批准", signal)).toBe("none");
  expect(await classifyApprovalDecision(model(call("nope")), "批准", signal)).toBe("none");
  expect(await classifyApprovalDecision(model({ content: "ok", toolCalls: [] } as unknown as ModelReply), "批准", signal)).toBe("none");
});

function context(session: Partial<ScopedSession> = {}) {
  const target: ScopedSession = { nodeId: "macair", id: "thread", provider: "codex-app", title: "A", cwd: "/w", status: "waitingApproval",
    loaded: true, capabilities: ["read", "send"], observedAt: new Date(NOW).toISOString(), pendingApprovals: [PENDING], ...session };
  const data = { inflight: { messageId: "msg-1", inputHash: "hash", expiresAt: NOW + 60_000 }, commandIds: [] } as unknown as LeaderData;
  const submit = vi.fn(async () => ({ commandId: "cmd_1", status: "completed", approvalDecision: "accept", turnId: "turn-1" }));
  const ctx = { store: { getLeaderState: vi.fn(async () => ({ data })) },
    hub: { isNodeConnected: () => true, getNodeSession: () => target }, commands: { submit }, now: () => NOW };
  return { ctx: ctx as never, data, submit };
}

it("binds the decision to the current message and the observed turn", async () => {
  const { ctx, data, submit } = context();
  const result = await answerSessionApproval(ctx, CHAT_ID, data, { nodeId: "macair", sessionId: "thread", requestId: "7", decision: "accept" },
    new AbortController().signal);
  expect(result).toMatchObject({ commandId: "cmd_1", receipt: expect.stringContaining("批准") });
  expect(submit).toHaveBeenCalledWith(expect.objectContaining({ action: "approve", expectedTurnId: "turn-1", approvalRequestId: "7",
    approvalDecision: "accept", requestId: expect.stringMatching(/^leader_approval_[a-f0-9]{64}$/) }), expect.any(Number),
  expect.any(Function), undefined, { type: "chat", chatId: CHAT_ID });
  expect(data.commandIds).toEqual(["cmd_1"]);
});

it("refuses unknown, non-answerable and expired targets without submitting", async () => {
  const signal = new AbortController().signal;
  const unknown = context();
  expect(await answerSessionApproval(unknown.ctx, CHAT_ID, unknown.data, { nodeId: "macair", sessionId: "thread", requestId: "8", decision: "accept" }, signal)).toHaveProperty("error");
  const local = context({ pendingApprovals: [{ ...PENDING, answerable: false }] });
  expect(await answerSessionApproval(local.ctx, CHAT_ID, local.data, { nodeId: "macair", sessionId: "thread", requestId: "7", decision: "accept" }, signal)).toHaveProperty("error");
  const expired = context();
  (expired.data.inflight as { expiresAt: number }).expiresAt = NOW - 1;
  expect(await answerSessionApproval(expired.ctx, CHAT_ID, expired.data, { nodeId: "macair", sessionId: "thread", requestId: "7", decision: "accept" }, signal)).toHaveProperty("error");
  for (const f of [unknown, local, expired]) expect(f.submit).not.toHaveBeenCalled();
});
