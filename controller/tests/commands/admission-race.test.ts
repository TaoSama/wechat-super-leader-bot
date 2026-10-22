import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { CommandService } from "../../src/commands/service.js";
import { NodeHub, type ConnectedNode } from "../../src/nodes/hub.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { CommandAuthority, DaemonMessage, Session } from "../../src/types.js";

const TTL_SECONDS = 300;
const input = { nodeId: "admission-node", sessionId: "admission-session", action: "send" as const,
  prompt: "Do authorized work", requestId: "admission-request" };
const authority: CommandAuthority = { type: "chat", chatId: "admission-chat" };

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function fixture() {
  const store = new MemoryStore();
  const session: Session = { id: input.sessionId, title: "Admission race", cwd: "/admission", provider: "codex-app",
    observedAt: new Date().toISOString(), loaded: true, status: "idle", capabilities: ["read", "send"] };
  const hub = {
    isNodeConnected: vi.fn(() => true),
    getNodeSession: vi.fn(() => session),
    getNodeSkills: vi.fn(() => []),
    registerCommandResultWaiter: vi.fn(() => ({ wait: async () => null, cancel: vi.fn() })),
    sendCommand: vi.fn(async () => ({ delivered: true })),
  };
  const commands = new CommandService(store, hub, TTL_SECONDS);
  const scanner = new CommandService(store, hub, TTL_SECONDS);
  return { store, session, hub, commands, scanner };
}

it("keeps a suspended, later rejected admission out of both queue dispatchers", async () => {
  const f = fixture();
  const entered = barrier(), resume = barrier();
  const submission = f.commands.submit(input, 0, async () => {
    entered.release();
    await resume.promise;
    throw new Error("lease expired");
  }, "control-socket", authority);
  const rejected = expect(submission).rejects.toThrow("lease expired");
  await entered.promise;
  await f.commands.dispatchQueued();
  await f.scanner.dispatchQueued();
  resume.release();
  await rejected;
  await f.scanner.dispatchQueued();

  expect(f.hub.sendCommand).not.toHaveBeenCalled();
  const saved = await f.store.findCommandByRequestId(input.requestId);
  expect(saved).toMatchObject({ status: "failed", sendRoute: "control-socket", authority,
    error: "Dispatch authority expired before transmission" });
  const repeatedGuard = vi.fn(async () => { throw new Error("must not re-admit a durable request"); });
  expect(await f.commands.submit(input, 0, repeatedGuard, "control-socket", authority)).toEqual(saved);
  expect(repeatedGuard).not.toHaveBeenCalled();
});

it("finishes the ready-at-submission recheck before publishing to another queue scanner", async () => {
  const f = fixture();
  const create = f.store.createCommandIfAbsent.bind(f.store);
  vi.spyOn(f.store, "createCommandIfAbsent").mockImplementation(async record => {
    const saved = await create(record);
    // A fresh idle observation arrives while the durable insert response is outstanding.
    f.session.status = "idle";
    await f.scanner.dispatchQueued();
    return saved;
  });

  await expect(f.commands.submit(input, 0, async () => {
    f.session.status = "active";
  }, "control-socket", authority)).rejects.toThrow("changed before transmission");

  expect(f.hub.sendCommand).not.toHaveBeenCalled();
  expect(await f.store.findCommandByRequestId(input.requestId)).toMatchObject({ status: "failed",
    sendRoute: "control-socket", authority, error: "Target send route or authority changed before transmission" });
});

it("does not let a duplicate bypass the original admission", async () => {
  const f = fixture();
  const entered = barrier(), resume = barrier();
  const delayed = f.commands.submit(input, 0, async () => {
    entered.release();
    await resume.promise;
    throw new Error("late admission rejection");
  }, "control-socket", authority);
  const rejected = expect(delayed).rejects.toThrow("late admission rejection");
  await entered.promise;
  const duplicateGuard = vi.fn(async () => {});
  const reserved = await f.scanner.submit(input, 0, duplicateGuard, "control-socket", authority);
  expect(reserved.status).toBe("admitting");
  expect(duplicateGuard).not.toHaveBeenCalled();
  await f.scanner.dispatchQueued();
  resume.release();
  await rejected;
  expect(await f.store.findCommandByRequestId(input.requestId)).toMatchObject({ commandId: reserved.commandId, status: "failed" });
  await f.commands.dispatchQueued();
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("keeps admission out of real hub inspection while preserving recovery of a dispatched pending command", async () => {
  const f = fixture(), entered = barrier(), resume = barrier();
  const frames: Array<{ type: string; commandId?: string }> = [];
  const socket = { readyState: WebSocket.OPEN,
    send(data: string, callback?: () => void) { frames.push(JSON.parse(data)); callback?.(); },
    close() {},
  };
  const hub = new NodeHub(f.store, new Map());
  const node: ConnectedNode = { nodeId: input.nodeId, ws: socket as unknown as WebSocket,
    connectedAt: new Date(), lastHeartbeat: new Date(), sessions: [f.session], skills: [], isHelloCompleted: true };
  const inspection = hub as unknown as { nodes: Map<string, ConnectedNode>;
    reconcileTurn(node: ConnectedNode): Promise<void>;
    handleDaemonMessage(node: ConnectedNode, message: DaemonMessage): Promise<void> };
  inspection.nodes.set(input.nodeId, node);
  const commands = new CommandService(f.store, hub, TTL_SECONDS);
  const submission = commands.submit(input, 0, async () => { entered.release(); await resume.promise; },
    "control-socket", authority);
  try {
    await entered.promise;
    await inspection.reconcileTurn(node);
    const premature = frames.find(frame => frame.type === "inspect_command");
    if (premature) await inspection.handleDaemonMessage(node, { type: "result", commandId: premature.commandId!,
      status: "uncertain", error: "Original command receipt unavailable; execution is unconfirmed, do not replay" });
    resume.release();
    const command = await submission;
    expect(premature).toBeUndefined();
    expect(command.status).toBe("pending");
    expect(frames.filter(frame => frame.type === "command")).toHaveLength(1);

    await inspection.reconcileTurn(node);
    expect(frames.filter(frame => frame.type === "inspect_command")).toEqual([
      expect.objectContaining({ commandId: command.commandId }),
    ]);
    await inspection.handleDaemonMessage(node, { type: "result", commandId: command.commandId,
      status: "uncertain", error: "Original command receipt unavailable; execution is unconfirmed, do not replay" });
    expect(await commands.get(command.commandId)).toMatchObject({ status: "uncertain" });
    await commands.dispatchQueued();
    expect(frames.filter(frame => frame.type === "command")).toHaveLength(1);
  } finally { resume.release(); await submission; await hub.closeAll(); }
});

it("returns the reserved request to concurrent duplicates and transmits it once after admission", async () => {
  const f = fixture();
  const entered = barrier(), resume = barrier();
  const delayed = f.commands.submit(input, 0, async () => {
    entered.release();
    await resume.promise;
  }, "control-socket", authority);
  await entered.promise;
  const duplicateGuard = vi.fn(async () => { throw new Error("a duplicate must not re-admit the original"); });
  const duplicates = await Promise.all(Array.from({ length: 8 }, () =>
    f.scanner.submit(input, 0, duplicateGuard, "control-socket", authority)));
  expect(new Set(duplicates.map(command => command.commandId)).size).toBe(1);
  expect(duplicateGuard).not.toHaveBeenCalled();
  resume.release();
  const result = await delayed;
  expect(result).toMatchObject({ commandId: duplicates[0].commandId, status: "pending" });
  await f.scanner.dispatchQueued();
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});

it.each(["payload", "authority"] as const)("rejects a conflicting %s while the original admission is suspended", async conflict => {
  const f = fixture();
  const entered = barrier(), resume = barrier();
  const delayed = f.commands.submit(input, 0, async () => {
    entered.release();
    await resume.promise;
  }, "control-socket", authority);
  await entered.promise;
  const otherInput = conflict === "payload" ? { ...input, prompt: "Different authorized work" } : input;
  const otherAuthority: CommandAuthority = conflict === "authority" ? { ...authority, chatId: "other-chat" } : authority;
  await expect(f.scanner.submit(otherInput, 0, undefined, "control-socket", otherAuthority)).rejects.toThrow(/different.*payload/);
  resume.release();
  const winner = await delayed;
  expect(await f.store.findCommandByRequestId(input.requestId)).toEqual(winner);
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});

it("fails an admission whose live target disconnects without inventing delivery uncertainty", async () => {
  const f = fixture();
  const entered = barrier(), resume = barrier();
  const submission = f.commands.submit(input, 0, async () => {
    entered.release();
    await resume.promise;
  }, "control-socket", authority);
  const rejected = expect(submission).rejects.toThrow("changed before transmission");
  await entered.promise;
  const reserved = (await f.store.findCommandByRequestId(input.requestId))!;
  await f.store.markNodeActiveCommandsUncertain(input.nodeId, "node disconnected during admission");
  expect(await f.store.getCommand(reserved.commandId)).toMatchObject({ status: "admitting" });
  f.hub.isNodeConnected.mockReturnValue(false);
  resume.release();
  await rejected;
  expect(await f.store.getCommand(reserved.commandId)).toMatchObject({ status: "failed" });
  await f.scanner.dispatchQueued();
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("expires an unsent admission without uncertainty or revival", async () => {
  const f = fixture(), entered = barrier(), resume = barrier();
  const submission = f.commands.submit(input, 0, async () => { entered.release(); await resume.promise; },
    "control-socket", authority);
  await entered.promise;
  const reserved = (await f.store.findCommandByRequestId(input.requestId))!;
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(reserved.expiresAt));
  try { await f.scanner.dispatchQueued(); }
  finally { vi.restoreAllMocks(); }
  resume.release();
  expect(await submission).toMatchObject({ commandId: reserved.commandId, status: "expired" });
  await f.scanner.dispatchQueued();
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});
