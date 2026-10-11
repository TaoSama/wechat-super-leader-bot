import { expect, it, vi } from "vitest";
import { CommandService } from "../src/commands.js";
import { MemoryStore } from "../src/store/memory.js";
import type { ControllerCommandMessage, Session } from "../src/types.js";
import type { Skill } from "../src/skills.js";

function setup() {
  const store = new MemoryStore();
  const session: Session = { id: "s", title: "test", cwd: "/test", provider: "codex-app", observedAt: new Date().toISOString(), loaded: true, status: "idle", capabilities: ["read", "send"] };
  const hub = {
    getNodeSkills: vi.fn<() => Skill[]>(() => []),
    isNodeConnected: vi.fn(() => true), getNodeSession: vi.fn(() => session),
    registerCommandResultWaiter: vi.fn(() => ({ wait: async () => null, cancel: vi.fn() })),
    sendCommand: vi.fn(async (cmd: ControllerCommandMessage) => {
      await store.updateCommandStatus(cmd.commandId, cmd.action === "read" ? "completed" : "accepted", "test-output",
        undefined, cmd.action === "send" ? `turn-${cmd.commandId}` : undefined);
      return { delivered: true };
    }),
  };
  return { store, hub, session, commands: new CommandService(store, hub, 300) };
}
const input = { nodeId: "demoair", sessionId: "s", action: "send" as const, prompt: "test", requestId: "request" };

it("uses one persisted command for concurrent requests and rejects changed payload", async () => {
  const f = setup();
  const results = await Promise.all(Array.from({ length: 8 }, () => f.commands.submit(input, 0)));
  expect(new Set(results.map(r => r.commandId)).size).toBe(1);
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
  await expect(f.commands.submit({ ...input, prompt: "changed" })).rejects.toThrow("different command payload");
  f.hub.isNodeConnected.mockReturnValue(false);
  expect((await f.commands.submit(input)).commandId).toBe(results[0].commandId);
});

it("checks authority after persisting and before transmission", async () => {
  const f = setup();
  await expect(f.commands.submit(input, 0, async () => { throw new Error("lease expired"); })).rejects.toThrow("lease expired");
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
  expect((await f.store.findCommandByRequestId(input.requestId))?.status).toBe("failed");
});

it("returns uncertain with a traceable command ID when transport delivery is ambiguous", async () => {
  const f = setup();
  f.hub.sendCommand.mockImplementation(async () => ({ delivered: false }));
  const result = await f.commands.submit(input, 0);
  expect(result.status).toBe("uncertain");
  expect(result.commandId).toBeTruthy();
  expect((await f.commands.submit(input)).commandId).toBe(result.commandId);
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});

it("does not send to non-idle or read-only sessions", async () => {
  const f = setup();
  f.session.status = "active";
  await expect(f.commands.submit(input)).rejects.toThrow("not idle");
  f.session.status = "idle";
  f.session.loaded = false;
  await expect(f.commands.submit(input)).rejects.toThrow("not loaded");
  f.session.loaded = true;
  f.session.capabilities = ["read"];
  await expect(f.commands.submit(input)).rejects.toThrow("does not support");
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

function desktopReady(): NonNullable<Session["sendAvailability"]> {
  const observed = Date.now();
  return { route: "desktop-owner", state: "ready", observedAt: new Date(observed).toISOString(), validUntil: new Date(observed + 45000).toISOString() };
}

it("persists desktop authority and dispatches it without native send capability", async () => {
  const f = setup();
  Object.assign(f.session, { status: "notLoaded", loaded: false, capabilities: ["read"], sendAvailability: desktopReady() });
  const result = await f.commands.submit(input, 0);
  expect(result.sendRoute).toBe("desktop-owner");
  expect((await f.store.getCommand(result.commandId))?.sendRoute).toBe("desktop-owner");
  expect(f.hub.sendCommand.mock.calls[0][0].sendRoute).toBe("desktop-owner");
  delete f.session.sendAvailability;
  expect((await f.commands.submit(input, 0)).sendRoute).toBe("desktop-owner");
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});

it.each(["native-to-desktop", "desktop-to-native", "blocked", "expired", "active-observation", "offline"])(
  "fails the persisted command with zero dispatch when authority changes: %s", async change => {
    const f = setup();
    if (change !== "native-to-desktop") f.session.sendAvailability = desktopReady();
    await expect(f.commands.submit(input, 0, async () => {
      if (change === "native-to-desktop") f.session.sendAvailability = desktopReady();
      if (change === "desktop-to-native") delete f.session.sendAvailability;
      if (change === "blocked") f.session.sendAvailability!.state = "blocked";
      if (change === "expired") f.session.sendAvailability!.validUntil = new Date().toISOString();
      if (change === "active-observation") f.session.desktopObservation = {
        source: "codex-desktop", status: "active", availability: "available", observedAt: new Date().toISOString(),
      };
      if (change === "offline") f.hub.isNodeConnected.mockReturnValue(false);
    })).rejects.toThrow("changed before transmission");
    const result = await f.store.findCommandByRequestId(input.requestId);
    expect(result).toMatchObject({ status: "failed", sendRoute: change === "native-to-desktop" ? "control-socket" : "desktop-owner" });
    expect(f.hub.sendCommand).not.toHaveBeenCalled();
    expect((await f.commands.submit(input, 0)).commandId).toBe(result!.commandId);
    expect(f.hub.sendCommand).not.toHaveBeenCalled();
  });

it("requires a plan's expected route before creating a command", async () => {
  const f = setup();
  await expect(f.commands.submit(input, 0, undefined, "desktop-owner")).rejects.toThrow("route changed");
  expect(await f.store.listRecentCommands()).toEqual([]);
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("returns old unbound commands without ever replaying them and leaves reads unbound", async () => {
  const f = setup();
  const now = new Date().toISOString();
  await f.store.createCommandIfAbsent({ ...input, commandId: "legacy", status: "uncertain", createdAt: now, updatedAt: now, expiresAt: now });
  expect((await f.commands.submit(input, 0)).commandId).toBe("legacy");
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
  const read = await f.commands.submit({ ...input, action: "read", prompt: undefined, requestId: "read" }, 0);
  expect(read).not.toHaveProperty("sendRoute");
  expect(f.hub.sendCommand.mock.calls[0][0]).not.toHaveProperty("sendRoute");
  await expect(f.commands.submit({ ...input, action: "read", requestId: "bad-read" }, 0, undefined, "control-socket")).rejects.toThrow("Read commands");
});

it("preflights the frozen target without persisting, waiting for or dispatching a command", async () => {
  const f = setup();
  expect(f.commands.canDispatchSend(input, "control-socket")).toBe(true);
  f.session.status = "active";
  expect(f.commands.canDispatchSend(input, "control-socket")).toBe(false);
  f.session.status = "idle";
  f.session.observedAt = new Date(Date.now() - 60_000).toISOString();
  expect(f.commands.canDispatchSend(input, "control-socket")).toBe(false);
  f.session.observedAt = new Date().toISOString();
  expect(f.commands.canDispatchSend(input, "control-socket")).toBe(true);
  f.hub.isNodeConnected.mockReturnValue(false);
  expect(f.commands.canDispatchSend(input, "control-socket")).toBe(false);
  expect(await f.store.listRecentCommands()).toEqual([]);
  expect(f.hub.registerCommandResultWaiter).not.toHaveBeenCalled();
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("preflight never substitutes a different route or skill digest", async () => {
  const f = setup();
  const skill: Skill = { id: "a".repeat(64), digest: "b".repeat(64), name: "fixture", description: "fixture", path: "/test/SKILL.md" };
  const request = { ...input, skills: [{ id: skill.id, digest: skill.digest }] };
  expect(f.commands.canDispatchSend(request, "control-socket")).toBe(false);
  f.hub.getNodeSkills.mockReturnValue([skill]);
  expect(f.commands.canDispatchSend(request, "control-socket")).toBe(true);
  f.hub.getNodeSkills.mockReturnValue([{ ...skill, digest: "c".repeat(64) }]);
  expect(f.commands.canDispatchSend(request, "control-socket")).toBe(false);
  f.hub.getNodeSkills.mockReturnValue([skill]);
  f.session.sendAvailability = desktopReady();
  expect(f.commands.canDispatchSend(request, "control-socket")).toBe(false);
  expect(f.commands.canDispatchSend(request, "desktop-owner")).toBe(true);
  f.session.sendAvailability.state = "blocked";
  expect(f.commands.canDispatchSend(request, "desktop-owner")).toBe(false);
  expect(f.commands.canDispatchSend(request, "control-socket")).toBe(false);
  expect(await f.store.listRecentCommands()).toEqual([]);
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("does not hide unexpected preflight failures as normal busy state", () => {
  const f = setup();
  f.hub.getNodeSession.mockImplementation(() => { throw new Error("broken observation"); });
  expect(() => f.commands.canDispatchSend(input, "control-socket")).toThrow("broken observation");
});
