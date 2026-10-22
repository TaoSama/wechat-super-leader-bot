import { afterEach, expect, it, vi } from "vitest";
import { CommandService } from "../../src/commands/service.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { ControllerCommandMessage, Session } from "../../src/types.js";

const NOW = Date.parse("2026-10-23T00:00:00Z");
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
afterEach(() => vi.useRealTimers());

it("persists a checking desktop submission, waits through revoked proof, and dispatches once on its fixed route", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const store = new MemoryStore();
  const session: Session = {
    id: "original", provider: "codex-app", title: "Original", cwd: "/fixture", loaded: false,
    status: "notLoaded", capabilities: ["read"], observedAt: iso(),
    desktopObservation: { source: "codex-desktop", status: "idle", availability: "available", observedAt: iso() },
    sendAvailability: { route: "desktop-owner", state: "blocked", reason: "checking",
      observedAt: "1970-01-01T00:00:00Z", validUntil: "1970-01-01T00:00:00Z" },
  };
  await store.upsertNodeSessions("air", [session]);
  const hub = {
    isNodeConnected: vi.fn(() => true), getNodeSession: vi.fn(() => session), getNodeSkills: vi.fn(() => []),
    registerCommandResultWaiter: vi.fn(() => ({ wait: async () => null, cancel: vi.fn() })),
    sendCommand: vi.fn(async (command: ControllerCommandMessage) => {
      await store.updateCommandStatus(command.commandId, "accepted", undefined, undefined, "exact-turn");
      return { delivered: true };
    }),
  };
  const commands = new CommandService(store, hub, 300);
  const input = { nodeId: "air", sessionId: session.id, action: "send" as const,
    requestId: "checking-original", prompt: "Continue" };
  const queued = await commands.submit(input, 0);
  expect(queued).toMatchObject({ status: "queued", sendRoute: "desktop-owner" });
  expect(hub.sendCommand).not.toHaveBeenCalled();

  session.sendAvailability = { route: "desktop-owner", state: "ready", observedAt: iso(), validUntil: iso(45_000) };
  hub.isNodeConnected.mockReturnValue(false);
  await commands.dispatchQueued();
  hub.isNodeConnected.mockReturnValue(true);
  session.desktopObservation!.status = "unknown";
  await commands.dispatchQueued();
  session.desktopObservation!.status = "idle";
  session.desktopObservation!.observedAt = iso(-45_001);
  await commands.dispatchQueued();
  expect(hub.sendCommand).not.toHaveBeenCalled();

  // A newly available managed route cannot consume a desktop owner's queue.
  session.desktopObservation = undefined;
  session.sendAvailability = undefined;
  session.capabilities = ["read", "resume-send"];
  await commands.dispatchQueued();
  expect(hub.sendCommand).not.toHaveBeenCalled();

  session.desktopObservation = { source: "codex-desktop", status: "idle", availability: "available", observedAt: iso() };
  session.sendAvailability = { route: "desktop-owner", state: "ready", observedAt: iso(), validUntil: iso(45_000) };
  await commands.dispatchQueued();
  await commands.dispatchQueued();
  expect(hub.sendCommand).toHaveBeenCalledTimes(1);
  expect(hub.sendCommand.mock.calls[0][0]).toMatchObject({ commandId: queued.commandId, sessionId: session.id,
    sendRoute: "desktop-owner", deliveryMode: "next-turn" });
  expect(await commands.submit(input, 0)).toMatchObject({ commandId: queued.commandId, status: "accepted", turnId: "exact-turn" });
});
