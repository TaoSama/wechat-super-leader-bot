import { afterEach, expect, it, vi } from "vitest";
import { CommandService } from "../../src/commands/service.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { ControllerCommandMessage, SendRoute, Session } from "../../src/types.js";

const NOW = Date.parse("2026-10-23T00:00:00Z");
const at = (offset = 0) => new Date(NOW + offset).toISOString();
afterEach(() => vi.useRealTimers());

it.each(["control-socket", "app-server-resume"] as const)("queues loaded busy work on frozen %s until fresh idle", async route => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const store = new MemoryStore();
  const session: Session = { id: "busy", provider: "codex-app", title: "Busy", cwd: "/fixture",
    status: "active", loaded: true, capabilities: ["read", "send", "resume-send"], observedAt: at() };
  const hub = {
    isNodeConnected: () => true, getNodeSession: () => session, getNodeSkills: () => [],
    registerCommandResultWaiter: () => ({ wait: async () => null, cancel: vi.fn() }),
    sendCommand: vi.fn(async (command: ControllerCommandMessage) => {
      await store.updateCommandStatus(command.commandId, "accepted", undefined, undefined, "exact-turn");
      return { delivered: true };
    }),
  };
  const commands = new CommandService(store, hub, 300);
  const request = { nodeId: "node", sessionId: session.id, action: "send" as const, prompt: "next turn", requestId: "busy-next" };
  const queued = await commands.submit(request, 0, undefined, route);
  expect(queued).toMatchObject({ status: "queued", sendRoute: route, deliveryMode: "next-turn" });
  for (const status of ["active", "waitingApproval", "waitingUserInput", "unknown", "notLoaded"]) {
    session.status = status;
    await commands.dispatchQueued();
  }
  expect(hub.sendCommand).not.toHaveBeenCalled();

  session.status = "idle";
  session.observedAt = at(-45_001);
  await commands.dispatchQueued();
  session.observedAt = at(1);
  await commands.dispatchQueued();
  session.observedAt = at();
  session.capabilities = route === "control-socket" ? ["read", "resume-send"] : ["read", "send"];
  await commands.dispatchQueued();
  expect(hub.sendCommand).not.toHaveBeenCalled();

  session.capabilities = ["read", "send", "resume-send"];
  await Promise.all([commands.dispatchQueued(), commands.dispatchQueued()]);
  await commands.dispatchQueued();
  expect(hub.sendCommand).toHaveBeenCalledTimes(1);
  expect(hub.sendCommand.mock.calls[0][0]).toMatchObject({ commandId: queued.commandId, sendRoute: route });
  expect(await commands.submit(request, 0, undefined, route)).toMatchObject({ commandId: queued.commandId, status: "accepted" });
});

it.each(["active", "waitingApproval", "unknown", "notLoaded"])("does not invent queue authority for read-only %s", async status => {
  const store = new MemoryStore();
  const session: Session = { id: "read-only", provider: "codex-app", title: "Read only", cwd: "/fixture",
    status, loaded: true, capabilities: ["read"], observedAt: new Date().toISOString() };
  const hub = { isNodeConnected: () => true, getNodeSession: () => session, getNodeSkills: () => [],
    registerCommandResultWaiter: () => ({ wait: async () => null, cancel: vi.fn() }),
    sendCommand: vi.fn(async () => ({ delivered: true })) };
  const commands = new CommandService(store, hub, 300);
  for (const route of [undefined, "app-server-resume", "control-socket"] as (SendRoute | undefined)[]) {
    await expect(commands.submit({ nodeId: "node", sessionId: session.id, action: "send", prompt: "next", requestId: `deny-${route}` },
      0, undefined, route)).rejects.toThrow();
  }
  expect(await store.listRecentCommands()).toEqual([]);
  expect(hub.sendCommand).not.toHaveBeenCalled();
});
