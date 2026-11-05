import { afterEach, expect, it, vi } from "vitest";
import { CommandService } from "../../src/commands/service.js";
import { MemoryStore } from "../../src/store/memory.js";
import { approvalReceiptText } from "../../src/sessions/approval.js";
import { approvalAuthorizationFailure } from "../../src/leader/session-approval.js";
import { SessionSchema, type ControllerCommandMessage, type PostCommandRequest, type ScopedSession } from "../../src/types.js";

const NODE_ID = "macair";
const SESSION_ID = "waiting-thread";
const TURN_ID = "turn-waiting";
const CHAT_ID = "allowed-chat";
const PENDING = { requestId: "7", kind: "commandExecution", turnId: TURN_ID, command: "rm -rf build", cwd: "/w", answerable: true } as const;

function fixture(reply: { status: "completed" | "failed" | "uncertain"; output?: string; error?: string; turnId?: string } =
  { status: "completed", output: "resolved", turnId: TURN_ID }, overrides: Partial<ScopedSession> = {}) {
  const store = new MemoryStore();
  const session: ScopedSession = { nodeId: NODE_ID, id: SESSION_ID, provider: "codex-app", title: "Waiting", cwd: "/w",
    status: "waitingApproval", loaded: true, capabilities: ["read", "send"], observedAt: new Date().toISOString(),
    pendingApprovals: [PENDING], ...overrides };
  const hub = {
    isNodeConnected: vi.fn(() => true), supportsDeliveryMode: vi.fn(() => true),
    getNodeSession: vi.fn((): ScopedSession | undefined => session), getNodeSkills: () => [],
    registerCommandResultWaiter: () => ({ wait: async () => null, cancel: vi.fn() }),
    sendCommand: vi.fn(async (wire: ControllerCommandMessage) => {
      await store.updateCommandStatus(wire.commandId, reply.status, reply.output, reply.error, reply.turnId);
      return { delivered: true };
    }),
  };
  const service = new CommandService(store, hub, 60, undefined, chatId => chatId === CHAT_ID);
  const request: PostCommandRequest = { nodeId: NODE_ID, sessionId: SESSION_ID, action: "approve", expectedTurnId: TURN_ID,
    approvalRequestId: "7", approvalDecision: "accept", requestId: "approve-request" };
  return { store, hub, service, request };
}
const chat = { type: "chat", chatId: CHAT_ID } as const;

afterEach(() => vi.restoreAllMocks());

it("sends one exact approval decision and reports completion only for the exact turn", async () => {
  const f = fixture();
  const command = await f.service.submit(f.request, 0, undefined, undefined, chat);
  expect(command).toMatchObject({ action: "approve", status: "completed", turnId: TURN_ID, approvalRequestId: "7", approvalDecision: "accept" });
  expect(f.hub.sendCommand.mock.calls[0][0]).toEqual({ type: "command", commandId: command.commandId, nodeId: NODE_ID,
    sessionId: SESSION_ID, action: "approve", expiresAt: command.expiresAt, sendRoute: "control-socket", expectedTurnId: TURN_ID,
    approvalRequestId: "7", approvalDecision: "accept" });
  expect(approvalReceiptText(command)).toContain("已提交“批准”");
});

it("is idempotent by requestId and rejects the same requestId with another decision", async () => {
  const f = fixture();
  const first = await f.service.submit(f.request, 0, undefined, undefined, chat);
  expect(await f.service.submit(f.request, 0, undefined, undefined, chat)).toEqual(first);
  await expect(f.service.submit({ ...f.request, approvalDecision: "decline" }, 0, undefined, undefined, chat)).rejects.toThrow(/different command payload/);
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});

it("uses send authorization and requires the request to be observed on that exact turn", async () => {
  const f = fixture();
  await expect(f.service.submit(f.request, 0, undefined, undefined, { type: "chat", chatId: "blocked" })).rejects.toMatchObject({ httpStatus: 403 });
  await expect(f.service.submit(f.request, 0, undefined, undefined, { type: "plan", id: crypto.randomUUID(), chatId: CHAT_ID })).rejects.toMatchObject({ httpStatus: 403 });
  await expect(f.service.submit({ ...f.request, approvalRequestId: "8", requestId: "other" }, 0, undefined, undefined, chat)).rejects.toMatchObject({ httpStatus: 409 });
  await expect(f.service.submit({ ...f.request, expectedTurnId: "turn-x", requestId: "other-2" }, 0, undefined, undefined, chat)).rejects.toMatchObject({ httpStatus: 409 });
  const stale = fixture(undefined, { pendingApprovals: [{ ...PENDING, answerable: false }] });
  await expect(stale.service.submit(stale.request, 0, undefined, undefined, chat)).rejects.toMatchObject({ httpStatus: 409 });
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it.each([
  ["session-wide decision", { approvalDecision: "acceptForSession" }],
  ["missing request id", { approvalRequestId: undefined }],
  ["prompt", { prompt: "yes" }],
  ["missing turn", { expectedTurnId: undefined }],
  ["terminal target", { sessionId: "terminal:pane-1" }],
  ["approval fields on send", { action: "send", prompt: "p", expectedTurnId: undefined }],
] as const)("rejects an approve carrying %s before persistence", async (_name, change) => {
  const f = fixture();
  await expect(f.service.submit({ ...f.request, ...change } as unknown as PostCommandRequest, 0)).rejects.toMatchObject({ httpStatus: 400 });
  expect(await f.store.listRecentCommands()).toEqual([]);
});

it("keeps uncertain results uncertain and never claims the request closed", async () => {
  const f = fixture({ status: "uncertain", error: "resolution not confirmed" });
  const command = await f.service.submit(f.request, 0, undefined, undefined, chat);
  expect(command.status).toBe("uncertain");
  expect(approvalReceiptText(command)).toContain("不确定");
});

it("drops malformed pending approval telemetry without rejecting the session", () => {
  const session = SessionSchema.parse({ id: "s", observedAt: new Date().toISOString(), pendingApprovals: [{ requestId: "bad id", kind: "x" }] });
  expect(session.pendingApprovals).toBeUndefined();
  expect(SessionSchema.parse({ id: "s", observedAt: new Date().toISOString(), pendingApprovals: [PENDING] }).pendingApprovals).toEqual([PENDING]);
});

it("binds the leader decision to the user's explicit instruction and exact request", () => {
  const session = { pendingApprovals: [PENDING] };
  const target = { requestId: "7", decision: "accept" } as const;
  expect(approvalAuthorizationFailure("批准那个 rm 命令", "accept", session, target)).toBeUndefined();
  expect(approvalAuthorizationFailure("这个命令安全吗", "none", session, target)).toMatch(/未明确要求/);
  expect(approvalAuthorizationFailure("拒绝它", "decline", session, target)).toMatch(/不一致/);
  expect(approvalAuthorizationFailure("批准", "accept", { pendingApprovals: [] }, target)).toMatch(/未在会话中等待/);
  const two = { pendingApprovals: [PENDING, { ...PENDING, requestId: "9" }] };
  expect(approvalAuthorizationFailure("批准", "accept", two, target)).toMatch(/写明要处理的 requestId/);
  expect(approvalAuthorizationFailure("批准 requestId 7", "accept", two, target)).toBeUndefined();
});
