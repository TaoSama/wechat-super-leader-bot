import { afterEach, expect, it, vi } from "vitest";
import { CommandService, TERMINAL_INTERRUPT_UNSUPPORTED } from "../../src/commands/service.js";
import { validateCommandTurnBinding } from "../../src/store/command-state.js";
import { MemoryStore } from "../../src/store/memory.js";
import { findRunningTurn, interruptReceiptText, interruptRunningTurn } from "../../src/sessions/turn-interrupt.js";
import type { ControllerCommandMessage, PostCommandRequest, ScopedSession, SessionHistory } from "../../src/types.js";

const NODE_ID = "macair";
const SESSION_ID = "running-thread";
const TURN_ID = "turn-running";
const CHAT_ID = "allowed-chat";
const TTL_SECONDS = 60;

type Reply = { status: "completed" | "failed" | "uncertain"; output?: string; error?: string; turnId?: string } | null;

function fixture(reply: Reply = { status: "completed", output: "interrupted", turnId: TURN_ID }, overrides: Partial<ScopedSession> = {}) {
  const store = new MemoryStore();
  const session: ScopedSession = { nodeId: NODE_ID, id: SESSION_ID, provider: "codex-app", title: "Running", cwd: "/w",
    status: "active", loaded: true, capabilities: ["read", "send"], observedAt: new Date().toISOString(), ...overrides };
  const history: SessionHistory = { session, source: "control-socket", fetchedAt: new Date().toISOString(), truncated: false,
    items: [{ id: "item-1", turnId: TURN_ID, kind: "assistant", type: "agentMessage", text: "working", turnStatus: "inProgress" },
      { id: "item-0", turnId: "turn-done", kind: "assistant", type: "agentMessage", text: "done", turnStatus: "completed" }] };
  const hub = {
    isNodeConnected: vi.fn(() => true), supportsDeliveryMode: vi.fn(() => true),
    getNodeSession: vi.fn((): ScopedSession | undefined => session), getNodeSkills: () => [], getAllSessions: async () => [session],
    getNodeStatusList: () => [], getAllSkills: () => [], readHistory: vi.fn(async () => history),
    registerCommandResultWaiter: () => ({ wait: async () => null, cancel: vi.fn() }),
    sendCommand: vi.fn(async (wire: ControllerCommandMessage) => {
      if (reply) await store.updateCommandStatus(wire.commandId, reply.status, reply.output, reply.error, reply.turnId);
      return { delivered: true };
    }),
  };
  const service = new CommandService(store, hub, TTL_SECONDS, undefined, chatId => chatId === CHAT_ID);
  const request: PostCommandRequest = { nodeId: NODE_ID, sessionId: SESSION_ID, action: "interrupt", expectedTurnId: TURN_ID,
    requestId: "interrupt-request" };
  return { store, session, history, hub, service, request };
}

afterEach(() => vi.restoreAllMocks());

it("sends one exact interrupt and reports completion only with the confirmed exact turn", async () => {
  const f = fixture();
  const command = await f.service.submit(f.request, 0, undefined, undefined, { type: "chat", chatId: CHAT_ID });
  expect(command).toMatchObject({ action: "interrupt", status: "completed", turnId: TURN_ID, output: "interrupted", sendRoute: "control-socket" });
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
  expect(f.hub.sendCommand.mock.calls[0][0]).toEqual({ type: "command", commandId: command.commandId, nodeId: NODE_ID,
    sessionId: SESSION_ID, action: "interrupt", expiresAt: command.expiresAt, sendRoute: "control-socket", expectedTurnId: TURN_ID });
  expect(interruptReceiptText(command)).toContain("已停止");
});

it("is idempotent by requestId and rejects a reused requestId for another turn", async () => {
  const f = fixture();
  const authority = { type: "chat", chatId: CHAT_ID } as const;
  const first = await f.service.submit(f.request, 0, undefined, undefined, authority);
  expect(await f.service.submit(f.request, 0, undefined, undefined, authority)).toEqual(first);
  await expect(f.service.submit({ ...f.request, expectedTurnId: "turn-other" }, 0, undefined, undefined, authority))
    .rejects.toThrow(/different command payload/);
  await expect(f.service.submit(f.request, 0, undefined, undefined, { type: "chat", chatId: "another-chat" }))
    .rejects.toThrow(/different command payload/);
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});

it("enforces send authorization: allowlisted chat, no automation or plan authority", async () => {
  const f = fixture();
  await expect(f.service.submit(f.request, 0, undefined, undefined, { type: "chat", chatId: "blocked-chat" }))
    .rejects.toMatchObject({ httpStatus: 403 });
  await expect(f.service.submit(f.request, 0, undefined, undefined, { type: "plan", id: crypto.randomUUID(), chatId: CHAT_ID }))
    .rejects.toMatchObject({ httpStatus: 403 });
  expect(await f.store.listRecentCommands()).toEqual([]);
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("fails without sending when dispatch authority expires after persistence", async () => {
  const f = fixture();
  await expect(f.service.submit(f.request, 0, async () => { throw new Error("claim expired"); }, undefined,
    { type: "chat", chatId: CHAT_ID })).rejects.toThrow("claim expired");
  expect((await f.store.listRecentCommands())[0]).toMatchObject({ status: "failed" });
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it.each([
  ["prompt", { prompt: "stop" }],
  ["missing turn", { expectedTurnId: undefined }],
  ["delivery mode", { deliveryMode: "steer" }],
  ["terminal target", { sessionId: "terminal:pane-1" }],
] as const)("rejects an interrupt carrying %s before persistence", async (_name, change) => {
  const f = fixture();
  await expect(f.service.submit({ ...f.request, ...change } as PostCommandRequest, 0)).rejects.toMatchObject({ httpStatus: 400 });
  expect(await f.store.listRecentCommands()).toEqual([]);
});

it("reports terminal sessions as unsupported and offline nodes as unavailable", async () => {
  const terminal = fixture(undefined, { provider: "terminal/codex" });
  await expect(terminal.service.submit(terminal.request, 0)).rejects.toThrow(TERMINAL_INTERRUPT_UNSUPPORTED);
  const offline = fixture();
  offline.hub.isNodeConnected.mockReturnValue(false);
  await expect(offline.service.submit(offline.request, 0)).rejects.toMatchObject({ httpStatus: 503 });
  expect(await offline.store.listRecentCommands()).toEqual([]);
});

it.each([
  [{ status: "failed", error: "target turn is not running (status: completed); no interrupt sent" }, "failed", "未停止"],
  [{ status: "uncertain", error: "acknowledgement uncertain" }, "uncertain", "不会自动重试"],
  [null, "pending", "不会自动重发"],
] as const)("keeps %o receipts without claiming a stop", async (reply, status, text) => {
  const f = fixture(reply);
  const command = await f.service.submit(f.request, 0);
  expect(command.status).toBe(status);
  expect(interruptReceiptText(command)).toContain(text);
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});

it("rejects daemon results that bind another turn or accept input", () => {
  const record = { action: "interrupt", nodeId: NODE_ID, sessionId: SESSION_ID, expectedTurnId: TURN_ID, status: "pending" } as never;
  expect(() => validateCommandTurnBinding(record, "completed", "turn-other")).toThrow();
  expect(() => validateCommandTurnBinding(record, "completed", undefined)).toThrow();
  expect(() => validateCommandTurnBinding(record, "accepted", TURN_ID)).toThrow();
  expect(() => validateCommandTurnBinding(record, "failed", TURN_ID)).toThrow();
  expect(() => validateCommandTurnBinding(record, "completed", TURN_ID)).not.toThrow();
});

it("does not touch queued sends on the same session", async () => {
  const f = fixture();
  f.session.status = "active";
  f.session.sendAvailability = undefined;
  const queued = await f.service.submit({ nodeId: NODE_ID, sessionId: SESSION_ID, action: "send", prompt: "next", requestId: "queued-send" },
    0, undefined, undefined, { type: "chat", chatId: CHAT_ID });
  const before = await f.store.getCommand(queued.commandId);
  await f.service.submit(f.request, 0, undefined, undefined, { type: "chat", chatId: CHAT_ID });
  expect(await f.store.getCommand(queued.commandId)).toEqual(before);
});

it("resolves exactly one running turn from history and refuses ambiguity", async () => {
  const f = fixture();
  expect(await findRunningTurn(f.hub, NODE_ID, SESSION_ID)).toEqual({ found: true, turnId: TURN_ID });
  f.history.items.push({ id: "item-2", turnId: "turn-second", kind: "assistant", type: "agentMessage", text: "x", turnStatus: "inProgress" });
  expect(await findRunningTurn(f.hub, NODE_ID, SESSION_ID)).toEqual({ found: false, reason: "ambiguous" });
  f.history.items = [];
  expect(await findRunningTurn(f.hub, NODE_ID, SESSION_ID)).toEqual({ found: false, reason: "none" });
});

it("rules-mode interrupt binds the message requestId and the resolved turn", async () => {
  const f = fixture();
  const result = await interruptRunningTurn(f.hub, f.service, { chatId: CHAT_ID, nodeId: NODE_ID, sessionId: SESSION_ID,
    requestId: "msg_interrupt" });
  expect(result.text).toContain("已停止");
  expect(await f.store.getCommand(result.commandId!)).toMatchObject({ requestId: "msg_interrupt", expectedTurnId: TURN_ID,
    authority: { type: "chat", chatId: CHAT_ID } });
  f.history.items = [];
  const none = await interruptRunningTurn(f.hub, f.service, { chatId: CHAT_ID, nodeId: NODE_ID, sessionId: SESSION_ID, requestId: "msg_2" });
  expect(none.commandId).toBeUndefined();
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});
