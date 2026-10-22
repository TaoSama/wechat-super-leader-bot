import { expect, it, vi } from "vitest";
import { CommandService } from "../../src/commands/service.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { ControllerCommandMessage, Session } from "../../src/types.js";
import type { Skill } from "../../src/skills/catalog.js";

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
const input = { nodeId: "macair", sessionId: "s", action: "send" as const, prompt: "test", requestId: "request" };

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

it("queues known busy or unloaded sessions without sending and rejects read-only targets", async () => {
  const f = setup();
  f.session.status = "active";
  expect((await f.commands.submit(input)).status).toBe("queued");
  f.session.status = "idle";
  f.session.loaded = false;
  expect((await f.commands.submit({...input,requestId:"unloaded"})).status).toBe("queued");
  f.session.loaded = true;
  f.session.capabilities = ["read"];
  await expect(f.commands.submit({...input,requestId:"read-only"})).rejects.toThrow("does not support");
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

function desktopReady(): NonNullable<Session["sendAvailability"]> {
  const observed = Date.now();
  return { route: "desktop-owner", state: "ready", observedAt: new Date(observed).toISOString(), validUntil: new Date(observed + 45000).toISOString() };
}

it.each(["observation-only", "blocked", "expired"] as const)("rejects %s terminal input with its live qualification error and no queued record", async state => {
  const f = setup();
  Object.assign(f.session, {id:`terminal:${"a".repeat(43)}`,provider:"terminal/claude",capabilities:["read"],loaded:false});
  if (state !== "observation-only") f.session.sendAvailability = {route:"terminal-pane",mode:"non-atomic",
    state:state === "blocked" ? "blocked" : "ready",observedAt:new Date(Date.now()-1000).toISOString(),
    validUntil:new Date(Date.now()+(state === "expired" ? -1 : 44000)).toISOString()};
  await expect(f.commands.submit({...input,sessionId:f.session.id},0)).rejects.toMatchObject({httpStatus:409});
  expect(await f.store.listRecentCommands()).toEqual([]);
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

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

it("persists explicit resume route, preserves native unloaded facts and deduplicates replay", async () => {
  const f = setup();
  Object.assign(f.session, { status: "notLoaded", loaded: false, capabilities: ["read", "resume-send"] });
  const result = await f.commands.submit(input, 0, undefined, "app-server-resume");
  expect(result.sendRoute).toBe("app-server-resume");
  expect(f.hub.sendCommand.mock.calls[0][0].sendRoute).toBe("app-server-resume");
  expect(f.session).toMatchObject({ status: "notLoaded", loaded: false, capabilities: ["read", "resume-send"] });
  f.session.capabilities = ["read"];
  expect((await f.commands.submit(input, 0)).commandId).toBe(result.commandId);
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});

it("dispatches a frozen resume route after loading and never rewrites its persisted route", async () => {
  const f = setup();
  f.session.capabilities = ["read", "send", "resume-send"];
  expect(f.commands.canDispatchSend(input, "app-server-resume")).toBe(true);
  const result = await f.commands.submit(input, 0, undefined, "app-server-resume");
  expect(result.sendRoute).toBe("app-server-resume");
  expect(f.hub.sendCommand.mock.calls[0][0].sendRoute).toBe("app-server-resume");
  f.session.capabilities = ["read", "send"];
  expect(f.commands.canDispatchSend(input, "app-server-resume")).toBe(false);
  expect((await f.commands.submit(input, 0)).sendRoute).toBe("app-server-resume");
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});

it.each(["capability", "stale", "desktop"])("does not consume an attempt for revoked loaded resume: %s", async change => {
  const f = setup();
  f.session.capabilities = ["read", "send", "resume-send"];
  if (change === "capability") f.session.capabilities = ["read", "send"];
  if (change === "stale") f.session.observedAt = new Date(Date.now() - 60_000).toISOString();
  if (change === "desktop") f.session.desktopObservation = {
    source: "codex-desktop", availability: "available", status: "idle", observedAt: new Date().toISOString(),
  };
  expect(f.commands.canDispatchSend(input, "app-server-resume")).toBe(false);
  await expect(f.commands.submit(input, 0, undefined, "app-server-resume")).rejects.toThrow();
  expect(await f.store.listRecentCommands()).toEqual([]);
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("does not substitute managed resume for a frozen desktop route", async () => {
  const f = setup();
  Object.assign(f.session, { status: "notLoaded", loaded: false, capabilities: ["read", "resume-send"],
    sendAvailability: { ...desktopReady(), state: "unavailable", reason: "unavailable" } });
  await expect(f.commands.submit(input, 0, undefined, "desktop-owner")).rejects.toThrow("route changed");
  expect(await f.store.listRecentCommands()).toEqual([]);
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it.each(["owner", "capability-revoked"])("refuses resume when %s changes before transmission", async change => {
  const f = setup();
  Object.assign(f.session, { status: "notLoaded", loaded: false, capabilities: ["read", "resume-send"] });
  await expect(f.commands.submit(input, 0, async () => {
    if (change === "owner") f.session.desktopObservation = { source: "codex-desktop", availability: "available", status: "active", observedAt: new Date().toISOString() };
    else f.session.capabilities = ["read"];
  }, "app-server-resume")).rejects.toThrow("changed before transmission");
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
  expect(await f.store.findCommandByRequestId(input.requestId)).toMatchObject({ status: "failed", sendRoute: "app-server-resume" });
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
