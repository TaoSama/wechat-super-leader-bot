import { afterEach, expect, it, vi } from "vitest";
import { CommandService } from "../../src/commands/service.js";
import { MemoryStore } from "../../src/store/memory.js";
import { sameAuthority } from "../../src/commands/queue.js";
import type { ControllerCommandMessage, PostCommandRequest, Session } from "../../src/types.js";

const NODE_ID = "queue-node";
const SESSION_ID = "queue-session";
const TTL_SECONDS = 300;
const START_TIME = Date.parse("2026-10-18T00:00:00.000Z");
const input: PostCommandRequest = {
  nodeId: NODE_ID, sessionId: SESSION_ID, action: "send", prompt: "first", requestId: "queue-first",
};

afterEach(() => vi.useRealTimers());

async function setup(options: { connected?: boolean; busy?: boolean; ttlSeconds?: number } = {}) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START_TIME);
  const store = new MemoryStore();
  const session: Session = {
    id: SESSION_ID, title: "Queue fixture", cwd: "/queue", provider: "codex-app",
    observedAt: new Date().toISOString(), loaded: true, status: options.busy ? "active" : "idle",
    capabilities: ["read", "send"],
  };
  await store.upsertNodeSessions(NODE_ID, [session]);
  const hub = {
    isNodeConnected: vi.fn(() => options.connected !== false),
    supportsDeliveryMode: vi.fn(() => true),
    getNodeSession: vi.fn((nodeId: string, sessionId: string) =>
      nodeId === NODE_ID && sessionId === SESSION_ID ? session : undefined),
    getNodeSkills: vi.fn(() => []),
    registerCommandResultWaiter: vi.fn(() => ({ wait: async () => null, cancel: vi.fn() })),
    sendCommand: vi.fn(async (command: ControllerCommandMessage) => {
      await store.updateCommandStatus(command.commandId, "accepted", undefined, undefined,
        command.expectedTurnId ?? `turn-${command.commandId}`);
      return { delivered: true };
    }),
  };
  const commands = new CommandService(store, hub, options.ttlSeconds ?? TTL_SECONDS);
  return { store, session, hub, commands };
}

function nextRequest(index: number): PostCommandRequest {
  vi.setSystemTime(START_TIME + index);
  return { ...input, requestId: `queue-${index}`, prompt: `message ${index}` };
}

it("persists a known offline target and dispatches it after reconnect", async () => {
  const f = await setup({ connected: false });
  f.hub.getNodeSession.mockReturnValue(undefined);
  const queued = await f.commands.submit(input, 0);
  expect(queued).toMatchObject({ status: "queued", deliveryMode: "next-turn" });
  expect(await f.store.getCommand(queued.commandId)).toMatchObject({ status: "queued" });
  expect(f.hub.sendCommand).not.toHaveBeenCalled();

  f.hub.isNodeConnected.mockReturnValue(true);
  f.hub.getNodeSession.mockReturnValue(f.session);
  await f.commands.dispatchQueued();
  expect(await f.store.getCommand(queued.commandId)).toMatchObject({ status: "accepted" });
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
  expect(f.hub.sendCommand.mock.calls[0][0]).toMatchObject({ commandId: queued.commandId, deliveryMode: "next-turn" });
});

it("rejects an offline target that has never been observed", async () => {
  const f = await setup({ connected: false });
  f.hub.getNodeSession.mockReturnValue(undefined);
  await expect(f.commands.submit({ ...input, sessionId: "unknown-session" }, 0)).rejects.toThrow();
  expect(await f.store.listRecentCommands()).toEqual([]);
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("waits for a busy target to become idle", async () => {
  const f = await setup({ busy: true });
  const queued = await f.commands.submit(input, 0);
  await f.commands.dispatchQueued();
  expect(await f.store.getCommand(queued.commandId)).toMatchObject({ status: "queued" });
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
  f.session.status = "idle";
  await f.commands.dispatchQueued();
  expect(await f.store.getCommand(queued.commandId)).toMatchObject({ status: "accepted" });
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});

it("preserves unsent queued work when node disconnection marks active commands uncertain", async () => {
  const f = await setup({ busy: true });
  const queued = await f.commands.submit(input, 0);
  await f.store.markNodeActiveCommandsUncertain(NODE_ID, "node disconnected");
  expect(await f.store.getCommand(queued.commandId)).toMatchObject({ status: "queued" });
  f.session.status = "idle";
  await f.commands.dispatchQueued();
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});

it("immediately dispatches an idle next-turn command", async () => {
  const f = await setup();
  const result = await f.commands.submit(input, 0);
  expect(result).toMatchObject({ status: "accepted", deliveryMode: "next-turn", sendRoute: "control-socket" });
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});

it("dispatches queued commands in session FIFO order and waits for each accepted turn", async () => {
  const f = await setup({ busy: true });
  const records = [];
  for (let index = 0; index < 3; index++) records.push(await f.commands.submit(nextRequest(index), 0));
  f.session.status = "idle";
  for (const record of records) {
    await f.commands.dispatchQueued();
    const sent = f.hub.sendCommand.mock.calls.map(([command]) => command.commandId);
    expect(sent.at(-1)).toBe(record.commandId);
    const count = sent.length;
    await f.commands.dispatchQueued();
    expect(f.hub.sendCommand).toHaveBeenCalledTimes(count);
    await f.store.updateCommandStatus(record.commandId, "completed", "done", undefined, `turn-${record.commandId}`);
  }
  expect(f.hub.sendCommand.mock.calls.map(([command]) => command.commandId)).toEqual(records.map(record => record.commandId));
});

it("paginates queued work by durable queue order instead of random command IDs", async () => {
  const store = new MemoryStore();
  const createdAt = new Date(START_TIME).toISOString();
  for (let index = 0; index < 65; index++) {
    await store.createCommandIfAbsent({
      commandId: `cmd-${String(64 - index).padStart(3, "0")}`,
      requestId: `queue-page-${index}`,
      nodeId: `page-node-${index}`,
      sessionId: `page-session-${index}`,
      action: "send",
      prompt: `page ${index}`,
      sendRoute: "control-socket",
      deliveryMode: "next-turn",
      authority: { type: "admin" },
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      expiresAt: new Date(START_TIME + TTL_SECONDS * 1000).toISOString(),
    });
  }
  const first = await store.listQueuedCommands(64, 0);
  const second = await store.listQueuedCommands(64, first.at(-1)!.queueOrder);
  expect(first).toHaveLength(64);
  expect(second).toHaveLength(1);
  expect(new Set([...first, ...second].map(command => command.commandId)).size).toBe(65);
  expect(second[0].queueOrder).toBeGreaterThan(first.at(-1)!.queueOrder!);
});

it("rescans blocked queue entries after a later eligible entry was dispatched", async () => {
  const f = await setup({ busy: true });
  const blocked = await f.commands.submit(input, 0);
  const otherSession = { ...f.session, id: "other-session", status: "idle" as const };
  f.hub.getNodeSession.mockImplementation((nodeId, sessionId) =>
    nodeId === "other-node" && sessionId === "other-session" ? otherSession : f.session);
  const later = await f.commands.submit({ ...nextRequest(1), nodeId: "other-node", sessionId: "other-session" }, 0);

  await f.commands.dispatchQueued();
  expect(await f.store.getCommand(blocked.commandId)).toMatchObject({ status: "queued" });
  expect(await f.store.getCommand(later.commandId)).toMatchObject({ status: "accepted" });

  f.session.status = "idle";
  await f.commands.dispatchQueued();
  expect(await f.store.getCommand(blocked.commandId)).toMatchObject({ status: "accepted" });
  expect(f.hub.sendCommand.mock.calls.map(([command]) => command.commandId)).toEqual([later.commandId, blocked.commandId]);
});

it.each(["pending", "accepted", "uncertain"] as const)("never skips a %s command for the same target", async status => {
  const f = await setup({ busy: true });
  const first = await f.commands.submit(input, 0);
  const second = await f.commands.submit(nextRequest(1), 0);
  expect(await f.store.claimQueuedCommand(first.commandId, "control-socket")).toMatchObject({ status: "pending" });
  if (status !== "pending") {
    await f.store.updateCommandStatus(first.commandId, status, undefined, undefined, status === "accepted" ? "active-turn" : undefined);
  }
  f.session.status = "idle";
  await f.commands.dispatchQueued();
  expect(await f.store.getCommand(second.commandId)).toMatchObject({ status: "queued" });
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("does not let a new submission bypass an accepted command", async () => {
  const f = await setup();
  await f.commands.submit(input, 0);
  const second = await f.commands.submit(nextRequest(1), 0);
  expect(second.status).toBe("queued");
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});

it.each(["node", "session"] as const)("allows another %s target to proceed independently", async scope => {
  const f = await setup();
  const first = await f.commands.submit(input, 0);
  const otherNodeId = scope === "node" ? "other-node" : NODE_ID;
  const otherSessionId = scope === "session" ? "other-session" : SESSION_ID;
  const otherSession = { ...f.session, id: otherSessionId };
  f.hub.getNodeSession.mockImplementation((nodeId, sessionId) =>
    nodeId === otherNodeId && sessionId === otherSessionId ? otherSession : f.session);
  const other = await f.commands.submit({ ...nextRequest(1), nodeId: otherNodeId, sessionId: otherSessionId }, 0);
  expect(other.status).toBe("accepted");
  expect(f.hub.sendCommand.mock.calls.map(([command]) => command.commandId)).toEqual([first.commandId, other.commandId]);
});

it("cancels a queued command durably and releases the following command", async () => {
  const f = await setup({ busy: true });
  const first = await f.commands.submit(input, 0);
  const second = await f.commands.submit(nextRequest(1), 0);
  await f.commands.cancel(first.commandId);
  expect(await f.store.getCommand(first.commandId)).toMatchObject({ status: "cancelled" });
  expect(await f.commands.cancel(first.commandId)).toMatchObject({ status: "cancelled" });
  expect(await f.commands.submit(input, 0)).toMatchObject({ commandId: first.commandId, status: "cancelled" });
  f.session.status = "idle";
  await f.commands.dispatchQueued();
  expect(f.hub.sendCommand.mock.calls.map(([command]) => command.commandId)).toEqual([second.commandId]);
});

it.each(["pending", "accepted", "uncertain"] as const)("refuses cancellation after a command becomes %s", async status => {
  const f = await setup({ busy: true });
  const first = await f.commands.submit(input, 0);
  expect(await f.store.claimQueuedCommand(first.commandId, "control-socket")).toMatchObject({ status: "pending" });
  if (status !== "pending") {
    await f.store.updateCommandStatus(first.commandId, status, undefined, undefined, status === "accepted" ? "active-turn" : undefined);
  }
  await expect(f.commands.cancel(first.commandId)).rejects.toThrow();
  expect(await f.store.getCommand(first.commandId)).toMatchObject({ status });
});

it("expires unsent commands without sending them or marking them uncertain", async () => {
  const f = await setup({ busy: true, ttlSeconds: 1 });
  const first = await f.commands.submit(input, 0);
  vi.setSystemTime(START_TIME + 1_000);
  f.session.status = "idle";
  f.session.observedAt = new Date().toISOString();
  await f.commands.dispatchQueued();
  expect(await f.store.getCommand(first.commandId)).toMatchObject({ status: "expired" });
  expect(await f.commands.submit(input, 0)).toMatchObject({ commandId: first.commandId, status: "expired" });
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("includes queued commands in the store expiration sweep", async () => {
  const f = await setup({ connected: false, ttlSeconds: 1 });
  const first = await f.commands.submit(input, 0);
  vi.setSystemTime(START_TIME + 1_000);
  await f.store.markExpiredActiveCommandsUncertain();
  expect(await f.store.getCommand(first.commandId)).toMatchObject({ status: "expired" });
});

it("lets a later unexpired command proceed after its predecessor expires", async () => {
  const f = await setup({ busy: true, ttlSeconds: 1 });
  const first = await f.commands.submit(input, 0);
  const second = await f.commands.submit(nextRequest(1), 0);
  vi.setSystemTime(START_TIME + 1_000);
  f.session.status = "idle";
  await f.commands.dispatchQueued();
  expect(await f.store.getCommand(first.commandId)).toMatchObject({ status: "expired" });
  expect(f.hub.sendCommand.mock.calls.map(([command]) => command.commandId)).toEqual([second.commandId]);
});

it("recovers queued work through a new service instance without changing its command ID", async () => {
  const f = await setup({ busy: true });
  const first = await f.commands.submit(input, 0);
  const restarted = new CommandService(f.store, f.hub, TTL_SECONDS);
  expect(await restarted.submit(input, 0)).toMatchObject({ commandId: first.commandId, status: "queued" });
  f.session.status = "idle";
  await restarted.dispatchQueued();
  await f.commands.dispatchQueued();
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
  expect(f.hub.sendCommand.mock.calls[0][0].commandId).toBe(first.commandId);
});

it("deduplicates concurrent submission and concurrent queue scans across service instances", async () => {
  const f = await setup({ busy: true });
  const secondService = new CommandService(f.store, f.hub, TTL_SECONDS);
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    (index % 2 ? secondService : f.commands).submit(input, 0)));
  expect(new Set(results.map(result => result.commandId)).size).toBe(1);
  f.session.status = "idle";
  await Promise.all(Array.from({ length: 8 }, (_, index) =>
    (index % 2 ? secondService : f.commands).dispatchQueued()));
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});

it("leaves ambiguous transmission uncertain and never resends it or its follower", async () => {
  const f = await setup({ busy: true });
  const first = await f.commands.submit(input, 0);
  const second = await f.commands.submit(nextRequest(1), 0);
  f.hub.sendCommand.mockImplementation(async () => ({ delivered: false }));
  f.session.status = "idle";
  await f.commands.dispatchQueued();
  await f.commands.dispatchQueued();
  expect(await f.commands.submit(input, 0)).toMatchObject({ commandId: first.commandId, status: "uncertain" });
  expect(await f.store.getCommand(second.commandId)).toMatchObject({ status: "queued" });
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});

it("treats an explicit next-turn replay as the same payload and rejects a changed delivery mode", async () => {
  const f = await setup({ busy: true });
  const first = await f.commands.submit(input, 0);
  expect(await f.commands.submit({ ...input, deliveryMode: "next-turn" }, 0)).toMatchObject({ commandId: first.commandId });
  await expect(f.commands.submit({ ...input, deliveryMode: "steer", expectedTurnId: "target-turn" }, 0)).rejects.toThrow();
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("requires a precise expected turn for steer and rejects an expected turn on next-turn", async () => {
  const f = await setup();
  await expect(f.commands.submit({ ...input, deliveryMode: "steer" }, 0)).rejects.toThrow();
  await expect(f.commands.submit({ ...input, deliveryMode: "next-turn", expectedTurnId: "target-turn" }, 0)).rejects.toThrow();
  expect(await f.store.listRecentCommands()).toEqual([]);
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("dispatches steer only with the exact requested active turn", async () => {
  const f = await setup({ busy: true });
  const expectedTurnId = "precise-active-turn";
  const first = await f.commands.submit({ ...input, deliveryMode: "steer", expectedTurnId }, 0);
  expect(first).toMatchObject({ status: "accepted", deliveryMode: "steer", expectedTurnId });
  expect(f.hub.sendCommand.mock.calls[0][0]).toMatchObject({ deliveryMode: "steer", expectedTurnId });
  expect(await f.commands.submit({ ...input, deliveryMode: "steer", expectedTurnId }, 0)).toMatchObject({ commandId: first.commandId });
  await expect(f.commands.submit({ ...input, deliveryMode: "steer", expectedTurnId: "different-turn" }, 0)).rejects.toThrow();
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});

it("lets an exact steer reach an accepted turn while a next-turn follower waits", async () => {
  const f = await setup();
  const first = await f.commands.submit(input, 0);
  const follower = await f.commands.submit(nextRequest(1), 0);
  f.session.status = "active";
  const steer = await f.commands.submit({
    ...nextRequest(2), deliveryMode: "steer", expectedTurnId: first.turnId,
  }, 0);
  expect(steer).toMatchObject({ status: "accepted", expectedTurnId: first.turnId });
  expect(await f.store.getCommand(follower.commandId)).toMatchObject({ status: "queued" });
  expect(f.hub.sendCommand.mock.calls.map(([command]) => command.commandId)).toEqual([first.commandId, steer.commandId]);
});

it.each(["revoked", "expired"] as const)("rechecks a %s console session after the queue service restarts", async change => {
  const f = await setup({ busy: true });
  const linkHash = "a".repeat(64);
  const tokenHash = "b".repeat(64);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(START_TIME + 1_000).toISOString();
  await f.store.createConsoleLinkIfAbsent({ tokenHash: linkHash, createdAt, expiresAt });
  expect(await f.store.consumeConsoleLink(linkHash, { tokenHash, createdAt, expiresAt }, createdAt)).toBe(true);
  const authority = { type: "console" as const, tokenHash, expiresAt };
  const queued = await f.commands.submit(input, 0, undefined, undefined, authority);
  expect(queued).toMatchObject({ status: "queued", authority });

  if (change === "revoked") await f.store.deleteConsoleSession(tokenHash);
  else vi.setSystemTime(START_TIME + 1_000);
  f.session.status = "idle";
  const restarted = new CommandService(f.store, f.hub, TTL_SECONDS);
  await restarted.dispatchQueued();
  expect(await f.store.getCommand(queued.commandId)).toMatchObject({ status: "cancelled", authority });
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("cancels queued chat work when its allowlist authorization is revoked", async () => {
  const f = await setup({ busy: true });
  const chatId = "authorized-chat";
  const isChatAllowed = vi.fn((candidate: string) => candidate === chatId);
  const commands = new CommandService(f.store, f.hub, TTL_SECONDS, undefined, isChatAllowed);
  const authority = { type: "chat" as const, chatId };
  const queued = await commands.submit(input, 0, undefined, undefined, authority);
  expect(queued).toMatchObject({ status: "queued", authority });
  expect(isChatAllowed).toHaveBeenCalledWith(chatId);
  isChatAllowed.mockReturnValue(false);
  f.session.status = "idle";
  const restarted = new CommandService(f.store, f.hub, TTL_SECONDS, undefined, isChatAllowed);
  await restarted.dispatchQueued();
  expect(await f.store.getCommand(queued.commandId)).toMatchObject({ status: "cancelled", authority });
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("compares persisted authorization fields independently of JSONB property order", () => {
  const tokenHash = "a".repeat(64);
  const expiresAt = new Date(START_TIME + 60_000).toISOString();
  expect(sameAuthority({ type: "console", tokenHash, expiresAt }, { expiresAt, tokenHash, type: "console" })).toBe(true);
  expect(sameAuthority({ type: "plan", id: "plan-id", chatId: "chat" }, { chatId: "chat", id: "plan-id", type: "plan" })).toBe(true);
  expect(sameAuthority({ type: "goal", id: "goal-id", chatId: "chat" }, { chatId: "chat", id: "goal-id", type: "goal" })).toBe(true);
  expect(sameAuthority({ type: "chat", chatId: "chat" }, { chatId: "chat", type: "chat" })).toBe(true);
  expect(sameAuthority({ type: "chat", chatId: "chat" }, { chatId: "chat", type: "chat", steerGeneration: 0 })).toBe(false);
  expect(sameAuthority({ type: "chat", chatId: "chat", steerGeneration: 1 }, { chatId: "chat", type: "chat", steerGeneration: 0 })).toBe(false);
  expect(sameAuthority(undefined, { type: "admin" })).toBe(true);
  expect(sameAuthority({ type: "console", tokenHash, expiresAt }, { type: "console", tokenHash, expiresAt: new Date(START_TIME).toISOString() })).toBe(false);
  expect(sameAuthority({ type: "chat", chatId: "chat" }, { type: "chat", chatId: "other-chat" })).toBe(false);
  expect(sameAuthority({ type: "plan", id: "same-id", chatId: "chat" }, { type: "goal", id: "same-id", chatId: "chat" })).toBe(false);
});

it("revokes chat steer commands while retaining another chat's queued authorization", async () => {
  const f = await setup({ connected: false });
  const cancelledChat = "cancelled-chat", otherChat = "other-chat";
  await f.store.compareAndSetLeaderState(cancelledChat, 0, { steerGeneration: 0 });
  await f.store.compareAndSetLeaderState(otherChat, 0, { steerGeneration: 0 });
  const cancelled = await f.commands.submit({ ...input, deliveryMode: "steer", expectedTurnId: "cancelled-turn" },
    0, undefined, undefined, { type: "chat", chatId: cancelledChat, steerGeneration: 0 });
  const other = await f.commands.submit({ ...nextRequest(1), deliveryMode: "steer", expectedTurnId: "other-turn" },
    0, undefined, undefined, { type: "chat", chatId: otherChat, steerGeneration: 0 });
  expect(cancelled.status).toBe("queued");
  expect(other.status).toBe("queued");
  await f.store.compareAndSetLeaderState(cancelledChat, 1, { steerGeneration: 1 });
  f.hub.isNodeConnected.mockReturnValue(true);
  await new CommandService(f.store, f.hub, TTL_SECONDS).dispatchQueued();
  expect(await f.store.getCommand(cancelled.commandId)).toMatchObject({ status: "cancelled" });
  expect(await f.store.getCommand(other.commandId)).toMatchObject({ status: "accepted" });
  expect(f.hub.sendCommand.mock.calls.map(([command]) => command.commandId)).toEqual([other.commandId]);
});

it("rejects a persisted steer without its durable chat state", async () => {
  const f = await setup({ connected: false });
  const queued = await f.commands.submit({ ...input, deliveryMode: "steer", expectedTurnId: "missing-state-turn" },
    0, undefined, undefined, { type: "chat", chatId: "missing-chat", steerGeneration: 0 });
  expect(queued.status).toBe("cancelled");
  f.hub.isNodeConnected.mockReturnValue(true);
  await new CommandService(f.store, f.hub, TTL_SECONDS).dispatchQueued();
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("rejects a legacy unscoped chat steer rather than restoring its permanent authorization", async () => {
  const f = await setup({ connected: false });
  const chatId = "legacy-steer-chat";
  await f.store.compareAndSetLeaderState(chatId, 0, { steerGeneration: 0 });
  const stamp = new Date().toISOString();
  const { command } = await f.store.createCommandIfAbsent({ ...input, commandId: "legacy-queued-steer",
    status: "queued", sendRoute: "control-socket", deliveryMode: "steer", expectedTurnId: "legacy-turn",
    authority: { type: "chat", chatId }, createdAt: stamp, updatedAt: stamp,
    expiresAt: new Date(START_TIME + TTL_SECONDS * 1000).toISOString() });
  expect(command.status).toBe("queued");
  f.hub.isNodeConnected.mockReturnValue(true);
  await new CommandService(f.store, f.hub, TTL_SECONDS).dispatchQueued();
  expect(await f.store.getCommand(command.commandId)).toMatchObject({ status: "cancelled" });
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it.each([undefined, null, -1, 0.5, "0"])("rejects a persisted steer with invalid cancellation generation %s", async steerGeneration => {
  const f = await setup();
  const chatId = "invalid-generation-chat";
  await f.store.compareAndSetLeaderState(chatId, 0, { steerGeneration });
  const command = await f.commands.submit({ ...input, deliveryMode: "steer", expectedTurnId: "invalid-state-turn" },
    0, undefined, undefined, { type: "chat", chatId, steerGeneration: 0 });
  expect(command.status).toBe("cancelled");
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});
