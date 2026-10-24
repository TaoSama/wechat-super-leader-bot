import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CommandService, type AutomationCommandAuthorizer } from "../../src/commands/service.js";
import type { IStore } from "../../src/store/interface.js";
import { MemoryStore } from "../../src/store/memory.js";
import { PostgresStore } from "../../src/store/postgres.js";
import type { CommandAuthority, CommandRecord, ControllerCommandMessage, Session } from "../../src/types.js";

const TTL_SECONDS = 300;
const EXPIRED_AT = "2020-01-01T00:00:00.000Z";
const databaseUrl = process.env.COMMAND_TEST_DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/command_admission_test") {
    throw new Error("COMMAND_TEST_DATABASE_URL requires a disposable loopback command_admission_test database");
  }
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe.each(["memory", "postgres"] as const)("%s admission publication", kind => {
  const stores: IStore[] = [];
  const createStore = () => {
    const store = kind === "memory" ? new MemoryStore() : new PostgresStore(databaseUrl!);
    stores.push(store);
    return store;
  };
  beforeAll(async () => {
    if (kind === "postgres" && databaseUrl) {
      const store = new PostgresStore(databaseUrl);
      try { await store.init(); } finally { await store.close(); }
    }
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(stores.splice(0).map(store => store.close()));
  });
  const test = kind === "postgres" && !databaseUrl ? it.skip : it;

  function fixture() {
    const store = createStore();
    const input = { nodeId: randomUUID(), sessionId: randomUUID(), action: "send" as const,
      prompt: "Authorized work", requestId: randomUUID() };
    const authority: CommandAuthority = { type: "chat", chatId: "admission-chat" };
    const session: Session = { id: input.sessionId, title: "Admission", cwd: "/fixture", provider: "codex-app",
      status: "idle", loaded: true, capabilities: ["read", "send"], observedAt: new Date().toISOString() };
    const state: { connected: boolean; authorization: boolean | "paused" } = { connected: true, authorization: true };
    const hub = {
      isNodeConnected: (nodeId: string) => state.connected && nodeId === input.nodeId,
      getNodeSession: (nodeId: string, sessionId: string) => nodeId === input.nodeId && sessionId === input.sessionId ? session : undefined,
      getNodeSkills: () => [],
      registerCommandResultWaiter: () => ({ wait: async () => null, cancel: vi.fn() }),
      sendCommand: vi.fn(async (command: ControllerCommandMessage) => {
        await store.updateCommandStatus(command.commandId, "accepted", undefined, undefined, `turn-${command.commandId}`);
        return { delivered: true };
      }),
    };
    const authorize: AutomationCommandAuthorizer = async () => state.authorization;
    const commands = new CommandService(store, hub, TTL_SECONDS, undefined, () => true, authorize);
    const scanner = new CommandService(kind === "postgres" ? createStore() : store, hub, TTL_SECONDS, undefined, () => true, authorize);
    const record = (overrides: Partial<CommandRecord> = {}): CommandRecord => {
      const now = new Date();
      return { ...input, commandId: randomUUID(), status: "admitting", sendRoute: "control-socket", authority,
        createdAt: now.toISOString(), updatedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + TTL_SECONDS * 1000).toISOString(), ...overrides };
    };
    const raw = store as unknown as { commands: Map<string, CommandRecord>;
      pool: { query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }> } };
    const alter = async (commandId: string, changes: Partial<CommandRecord>) => {
      if (kind === "memory") { Object.assign(raw.commands.get(commandId)!, changes); return; }
      const columns: Record<string, string> = { status: "status", turnId: "turn_id", sessionId: "session_id",
        sendRoute: "send_route", inputReceipt: "input_receipt", action: "action", authority: "authority", expiresAt: "expires_at" };
      const entries = Object.entries(changes);
      await raw.pool.query(`UPDATE commands SET ${entries.map(([field], index) => `${columns[field]}=$${index + 2}`).join(",")} WHERE command_id=$1`,
        [commandId, ...entries.map(([, value]) => value)]);
    };
    const snapshot = async (commandId: string) => kind === "memory" ? structuredClone(raw.commands.get(commandId)) :
      (await raw.pool.query("SELECT * FROM commands WHERE command_id=$1", [commandId])).rows[0];
    return { store, input, authority, session, state, hub, commands, scanner, record, alter, snapshot };
  }

  test.each(["control-socket", "app-server-resume", "desktop-owner"] as const)("publishes frozen %s once and preserves FIFO identity before atomic dispatch", async sendRoute => {
    const f = fixture();
    const saved = (await f.store.createCommandIfAbsent(f.record({ sendRoute }))).command;
    const published = (await Promise.all(Array.from({ length: 8 }, () => f.store.admitCommand(saved.commandId)))).filter(Boolean);
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ ...saved, status: "queued", updatedAt: expect.any(String) });
    const claims = (await Promise.all(Array.from({ length: 8 }, () => f.store.claimQueuedCommand(saved.commandId, sendRoute)))).filter(Boolean);
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ commandId: saved.commandId, status: "pending", sendRoute, queueOrder: saved.queueOrder });
  });

  test.each(["pending", "uncertain", "accepted", "completed", "failed", "cancelled", "expired", "queued", "turn-bound",
    "terminal", "receipt", "read", "unbound-route", "missing-authority", "deadline"] as const)("does not publish or alter %s work", async blocked => {
    const f = fixture();
    const changes: Partial<CommandRecord> = {};
    if (["pending", "uncertain", "accepted", "completed", "failed", "cancelled", "expired", "queued"].includes(blocked)) {
      changes.status = blocked as CommandRecord["status"];
    }
    if (["accepted", "completed", "turn-bound"].includes(blocked)) changes.turnId = "exact-turn";
    if (blocked === "terminal" || blocked === "receipt") {
      changes.sessionId = `terminal:${"a".repeat(43)}`; changes.sendRoute = "terminal-pane";
      if (blocked === "receipt") {
        changes.status = "input-written";
        changes.inputReceipt = { kind: "terminal-input-written", sessionId: changes.sessionId, requestId: randomUUID(),
          promptSHA256: "a".repeat(64), responseRevision: 0, observedRevision: 1 };
      }
    }
    if (blocked === "read") { changes.action = "read"; changes.sendRoute = undefined; }
    if (blocked === "unbound-route") changes.sendRoute = undefined;
    if (blocked === "missing-authority") changes.authority = undefined;
    if (blocked === "deadline") changes.expiresAt = EXPIRED_AT;
    const saved = (await f.store.createCommandIfAbsent(f.record())).command;
    await f.alter(saved.commandId, changes);
    const before = await f.snapshot(saved.commandId);
    expect(await f.store.admitCommand(saved.commandId)).toBeNull();
    expect(await f.snapshot(saved.commandId)).toEqual(before);
  });

  test.each(["admitting", "queued", "pending", "accepted", "uncertain", "completed", "cancelled", "input-written"] as const)(
    "rejects a fabricated %s receipt before admission without altering the reservation", async status => {
    const f = fixture();
    const saved = (await f.store.createCommandIfAbsent(f.record())).command;
    await expect(f.store.updateCommandStatus(saved.commandId, status, undefined, undefined,
      ["accepted", "completed"].includes(status) ? "fabricated-turn" : undefined)).rejects.toThrow();
    expect(await f.store.getCommand(saved.commandId)).toEqual(saved);
  });

  test.each(["failed", "expired"] as const)("allows unsent admission to end as %s without replay", async status => {
    const f = fixture();
    const saved = (await f.store.createCommandIfAbsent(f.record())).command;
    await f.store.updateCommandStatus(saved.commandId, status);
    expect(await f.store.getCommand(saved.commandId)).toMatchObject({ status, turnId: undefined });
    expect(await f.store.failAdmittingCommand(saved.commandId, "late admission failure")).toBeNull();
    expect(await f.store.getCommand(saved.commandId)).toMatchObject({ status });
    expect(await f.store.admitCommand(saved.commandId)).toBeNull();
    expect(await f.store.requeueClaimedCommand(saved.commandId)).toBeNull();
  });

  test.each(["chat-pending", "automation-admitting", "automation-uncertain", "automation-accepted"] as const)(
    "does not use automation pause recovery to publish %s work", async blocked => {
    const f = fixture();
    const automation: CommandAuthority = { type: "automation", chatId: "automation-chat", scheduleId: randomUUID(), runId: randomUUID() };
    const status = blocked === "chat-pending" ? "pending" : blocked === "automation-admitting" ? "admitting" :
      blocked === "automation-uncertain" ? "uncertain" : "accepted";
    const saved = (await f.store.createCommandIfAbsent(f.record({ status,
      authority: blocked === "chat-pending" ? f.authority : automation,
      ...(status === "accepted" ? { turnId: "accepted-turn" } : {}) }))).command;
    expect(await f.store.requeueClaimedCommand(saved.commandId)).toBeNull();
    expect(await f.store.getCommand(saved.commandId)).toEqual(saved);
  });

  test("never dispatches a suspended rejected guard, including through a separate store connection", async () => {
    const f = fixture(), entered = barrier(), resume = barrier();
    const submission = f.commands.submit(f.input, 0, async () => {
      entered.release(); await resume.promise; throw new Error("admission revoked");
    }, "control-socket", f.authority);
    const rejected = expect(submission).rejects.toThrow("admission revoked");
    await entered.promise;
    const reserved = (await f.store.findCommandByRequestId(f.input.requestId))!;
    expect(reserved.status).toBe("admitting");
    await f.scanner.dispatchQueued();
    resume.release(); await rejected;
    await f.scanner.dispatchQueued();
    expect(await f.store.getCommand(reserved.commandId)).toMatchObject({ status: "failed" });
    expect(f.hub.sendCommand).not.toHaveBeenCalled();
  });

  test("does not overwrite a command claimed during the post-insert readiness recheck", async () => {
    const f = fixture(), create = f.store.createCommandIfAbsent.bind(f.store);
    vi.spyOn(f.store, "createCommandIfAbsent").mockImplementation(async command => {
      const result = await create(command);
      expect(await f.store.admitCommand(result.command.commandId)).toMatchObject({ status: "queued" });
      await f.scanner.dispatchQueued();
      return result;
    });
    await expect(f.commands.submit(f.input, 0, async () => { f.session.status = "active"; },
      "control-socket", f.authority)).rejects.toThrow("changed before transmission");
    expect(await f.store.findCommandByRequestId(f.input.requestId)).toMatchObject({ status: "accepted" });
    expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
  });

  test("reserves concurrent duplicates without re-running admission or sending twice", async () => {
    const f = fixture(), entered = barrier(), resume = barrier();
    const submission = f.commands.submit(f.input, 0, async () => { entered.release(); await resume.promise; },
      "control-socket", f.authority);
    await entered.promise;
    const guard = vi.fn(async () => { throw new Error("duplicate must not run guard"); });
    const duplicates = await Promise.all(Array.from({ length: 8 }, () =>
      f.scanner.submit(f.input, 0, guard, "control-socket", f.authority)));
    expect(new Set(duplicates.map(command => command.commandId)).size).toBe(1);
    expect(guard).not.toHaveBeenCalled();
    await f.scanner.dispatchQueued();
    expect(f.hub.sendCommand).not.toHaveBeenCalled();
    resume.release();
    expect(await submission).toMatchObject({ commandId: duplicates[0].commandId, status: "accepted" });
    await f.scanner.dispatchQueued();
    expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
  });

  test("keeps a later submission behind a pending admission and its accepted turn", async () => {
    const f = fixture(), entered = barrier(), resume = barrier();
    const first = f.commands.submit(f.input, 0, async () => { entered.release(); await resume.promise; },
      "control-socket", f.authority);
    await entered.promise;
    const follower = await f.scanner.submit({ ...f.input, requestId: randomUUID(), prompt: "Follow admitted work" },
      0, undefined, "control-socket", f.authority);
    expect(follower.status).toBe("queued");
    await f.scanner.dispatchQueued();
    expect(f.hub.sendCommand).not.toHaveBeenCalled();
    resume.release();
    const admitted = await first;
    expect(admitted.status).toBe("accepted");
    await f.scanner.dispatchQueued();
    expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
    await f.store.updateCommandStatus(admitted.commandId, "completed", "first result", undefined, admitted.turnId);
    await f.scanner.dispatchQueued();
    expect(f.hub.sendCommand.mock.calls.map(([command]) => command.commandId)).toEqual([admitted.commandId, follower.commandId]);
  });

  test("does not let a later admission block an earlier queued request", async () => {
    const f = fixture();
    const earlier = (await f.store.createCommandIfAbsent(f.record({ status: "queued" }))).command;
    const later = (await f.store.createCommandIfAbsent(f.record({ requestId: randomUUID() }))).command;
    expect((await f.store.listQueuedCommands()).some(command => command.commandId === earlier.commandId)).toBe(true);
    expect(await f.store.claimQueuedCommand(earlier.commandId, "control-socket"))
      .toMatchObject({ commandId: earlier.commandId, status: "pending" });
    expect(await f.store.getCommand(later.commandId)).toMatchObject({ status: "admitting" });
  });

  test("releases a queued successor only after an abandoned admission expires", async () => {
    const f = fixture();
    const orphan = (await f.store.createCommandIfAbsent(f.record({ expiresAt: EXPIRED_AT }))).command;
    const follower = (await f.store.createCommandIfAbsent(f.record({ status: "queued", requestId: randomUUID() }))).command;
    expect(await f.store.claimQueuedCommand(follower.commandId, "control-socket")).toBeNull();
    await f.scanner.dispatchQueued();
    expect(await f.store.getCommand(orphan.commandId)).toMatchObject({ status: "expired" });
    expect(await f.store.getCommand(follower.commandId)).toMatchObject({ status: "accepted" });
    expect(f.hub.sendCommand.mock.calls.map(([command]) => command.commandId)).toEqual([follower.commandId]);
  });

  test("keeps unsent admission distinct from delivery uncertainty when a node disconnects", async () => {
    const f = fixture();
    await expect(f.commands.submit(f.input, 0, async () => {
      await f.store.markNodeActiveCommandsUncertain(f.input.nodeId, "disconnected during admission");
      expect(await f.store.findCommandByRequestId(f.input.requestId)).toMatchObject({ status: "admitting" });
      f.state.connected = false;
    }, "control-socket", f.authority)).rejects.toThrow("changed before transmission");
    expect(await f.store.findCommandByRequestId(f.input.requestId)).toMatchObject({ status: "failed" });
    await f.scanner.dispatchQueued();
    expect(f.hub.sendCommand).not.toHaveBeenCalled();
  });

  test("does not inspect or resurrect abandoned admission, but retains inspection of a dispatched pending request", async () => {
    const f = fixture();
    const orphan = (await f.store.createCommandIfAbsent(f.record())).command;
    await f.scanner.dispatchQueued();
    expect(await f.scanner.submit(f.input, 0, undefined, "control-socket", f.authority)).toMatchObject({ commandId: orphan.commandId, status: "admitting" });
    const pending = (await f.store.createCommandIfAbsent(f.record({ requestId: randomUUID(), status: "pending" }))).command;
    expect((await f.store.listInspectableCommands(f.input.nodeId)).map(command => command.commandId)).toEqual([pending.commandId]);
    const expired = (await f.store.createCommandIfAbsent(f.record({ requestId: randomUUID(), expiresAt: EXPIRED_AT }))).command;
    await f.scanner.dispatchQueued();
    expect(await f.store.getCommand(expired.commandId)).toMatchObject({ status: "expired" });
    expect(await f.store.admitCommand(expired.commandId)).toBeNull();
    expect(f.hub.sendCommand).not.toHaveBeenCalled();
  });

  if (kind === "postgres") test("preserves abandoned admission across database reinitialization while pending retains restart uncertainty", async () => {
    const f = fixture();
    const orphan = (await f.store.createCommandIfAbsent(f.record())).command;
    const pending = (await f.store.createCommandIfAbsent(f.record({ requestId: randomUUID(), status: "pending" }))).command;
    const reopened = createStore();
    await reopened.init();
    expect(await reopened.getCommand(orphan.commandId)).toEqual(orphan);
    expect(await reopened.getCommand(pending.commandId)).toMatchObject({ status: "uncertain",
      error: "Controller restarted while command was pending or accepted" });
    expect((await reopened.listInspectableCommands(f.input.nodeId)).map(command => command.commandId)).toEqual([pending.commandId]);
    const restartedCommands = new CommandService(reopened, f.hub, TTL_SECONDS, undefined, () => true);
    expect(await restartedCommands.submit(f.input, 0, undefined, "control-socket", f.authority))
      .toMatchObject({ commandId: orphan.commandId, status: "admitting" });
    await restartedCommands.dispatchQueued();
    expect(f.hub.sendCommand).not.toHaveBeenCalled();
    await f.alter(orphan.commandId, { expiresAt: EXPIRED_AT });
    await restartedCommands.dispatchQueued();
    expect(await reopened.getCommand(orphan.commandId)).toMatchObject({ status: "expired" });
    expect(await reopened.admitCommand(orphan.commandId)).toBeNull();
  });

  test("retains an automation's claimed FIFO position when pause wins, then sends once after resume", async () => {
    const f = fixture();
    const automation: CommandAuthority = { type: "automation", chatId: "automation-chat", scheduleId: randomUUID(), runId: randomUUID() };
    f.state.connected = false;
    const queued = await f.commands.submit(f.input, 0, undefined, "control-socket", automation);
    expect(queued.status).toBe("queued");
    f.state.connected = true;
    const claim = f.store.claimQueuedCommand.bind(f.store);
    vi.spyOn(f.store, "claimQueuedCommand").mockImplementation(async (...args) => {
      const result = await claim(...args); f.state.authorization = "paused"; return result;
    });
    await f.commands.dispatchQueued();
    expect(await f.store.getCommand(queued.commandId)).toMatchObject({ status: "queued", queueOrder: queued.queueOrder, authority: automation });
    expect(f.hub.sendCommand).not.toHaveBeenCalled();
    vi.restoreAllMocks(); f.state.authorization = true;
    await f.scanner.dispatchQueued(); await f.commands.dispatchQueued();
    expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
  });
});
