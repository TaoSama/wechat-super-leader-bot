import { afterEach, expect, it, vi } from "vitest";
import { CommandService, type AutomationCommandAuthorizer } from "../../src/commands/service.js";
import { sameAuthority } from "../../src/commands/queue.js";
import { MemoryStore } from "../../src/store/memory.js";
import { CommandAuthoritySchema, type Session } from "../../src/types.js";
import { CreateScheduleSchema } from "../../src/automations/contracts.js";

const START = Date.parse("2026-10-18T00:00:00Z");
const authority = { type: "automation" as const, chatId: "wx-user",
  scheduleId: "aa745ad4-9656-4c37-a285-466c24eb6af9", runId: "8518a17a-de52-490f-b35a-818378a36ee0" };
const input = { nodeId: "node", sessionId: "session", action: "send" as const,
  prompt: "Observe current state", requestId: `automation:${authority.runId}` };

afterEach(() => vi.useRealTimers());

async function fixture() {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(START);
  const store = new MemoryStore();
  const session: Session = { id: "session", title: "Task", cwd: "/task", provider: "codex-app",
    observedAt: new Date().toISOString(), loaded: true, status: "idle", capabilities: ["read", "send"] };
  await store.upsertNodeSessions("node", [session]);
  const hub = {
    isNodeConnected: vi.fn(() => false),
    getNodeSession: vi.fn(() => session), getNodeSkills: vi.fn(() => []),
    registerCommandResultWaiter: vi.fn(() => ({ wait: async () => null, cancel() {} })),
    sendCommand: vi.fn(async (command: { commandId: string }) => {
      await store.updateCommandStatus(command.commandId, "accepted", undefined, undefined, `turn-${command.commandId}`);
      return { delivered: true };
    }),
  };
  let scheduleStatus = "active";
  const authorize = vi.fn<AutomationCommandAuthorizer>(async (frozen, command) => {
    if (frozen.scheduleId !== authority.scheduleId || frozen.runId !== authority.runId || command.requestId !== input.requestId ||
        command.nodeId !== input.nodeId || command.sessionId !== input.sessionId) return false;
    return scheduleStatus === "paused" ? "paused" : scheduleStatus === "active";
  });
  const create = (callback: AutomationCommandAuthorizer | undefined = authorize) =>
    new CommandService(store, hub, 300, undefined, () => true, callback);
  const commands = create();
  const queued = await commands.submit(input, 0, undefined, "control-socket", authority);
  expect(queued.status).toBe("queued");
  return { store, hub, authorize, create, queued, setStatus: (status: string) => { scheduleStatus = status; } };
}

it("does not transmit a cancelled schedule's queued command after reconnect/restart", async () => {
  const f = await fixture();
  f.setStatus("cancelled"); f.hub.isNodeConnected.mockReturnValue(true);
  await f.create().dispatchQueued();
  expect(await f.store.getCommand(f.queued.commandId)).toMatchObject({ status: "cancelled", authority });
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("retains a paused occurrence and sends it once after resume through a new service", async () => {
  const f = await fixture();
  f.setStatus("paused"); f.hub.isNodeConnected.mockReturnValue(true);
  await f.create().dispatchQueued();
  expect(await f.store.getCommand(f.queued.commandId)).toMatchObject({ status: "queued", queueOrder: f.queued.queueOrder });
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
  f.setStatus("active"); await f.create().dispatchQueued(); await f.create().dispatchQueued();
  expect(await f.store.getCommand(f.queued.commandId)).toMatchObject({ status: "accepted" });
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});

it("requeues an unsubmitted claim when pause races with claim, retaining its original FIFO order", async () => {
  const f = await fixture();
  f.hub.isNodeConnected.mockReturnValue(true);
  const original = f.store.claimQueuedCommand.bind(f.store);
  let pauseOnce = true;
  f.store.claimQueuedCommand = async (...args) => {
    const claimed = await original(...args);
    if (pauseOnce) { pauseOnce = false; f.setStatus("paused"); }
    return claimed;
  };
  await f.create().dispatchQueued();
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
  expect(await f.store.getCommand(f.queued.commandId)).toMatchObject({ status: "queued", queueOrder: f.queued.queueOrder });
  f.setStatus("active"); await f.create().dispatchQueued(); await f.create().dispatchQueued();
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});

it.each(["accepted", "uncertain", "expired"] as const)("never requeues a %s command as an unsubmitted claim", async status => {
  const f = await fixture();
  await f.store.claimQueuedCommand(f.queued.commandId, "control-socket");
  await f.store.updateCommandStatus(f.queued.commandId, status, undefined, undefined, status === "accepted" ? "exact-turn" : undefined);
  expect(await f.store.requeueClaimedCommand(f.queued.commandId)).toBeNull();
  expect(await f.store.getCommand(f.queued.commandId)).toMatchObject({ status });
});

it("does not requeue an unsubmitted claim past its original expiration deadline", async () => {
  const f = await fixture();
  await f.store.claimQueuedCommand(f.queued.commandId, "control-socket");
  vi.setSystemTime(START + 300_000);
  expect(await f.store.requeueClaimedCommand(f.queued.commandId)).toBeNull();
});

it("recovers an active automation's persisted queued command through a new service", async () => {
  const f = await fixture();
  f.hub.isNodeConnected.mockReturnValue(true);
  await f.create().dispatchQueued(); await f.create().dispatchQueued();
  expect(await f.store.getCommand(f.queued.commandId)).toMatchObject({ status: "accepted", authority });
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
  expect(f.authorize).toHaveBeenLastCalledWith(authority, expect.objectContaining({ commandId: f.queued.commandId }));
});

it("rechecks schedule authorization after atomic queue claim before sending", async () => {
  const f = await fixture();
  f.hub.isNodeConnected.mockReturnValue(true);
  const original = f.store.claimQueuedCommand.bind(f.store);
  f.store.claimQueuedCommand = async (...args) => {
    const claimed = await original(...args);
    f.setStatus("cancelled");
    return claimed;
  };
  await f.create().dispatchQueued();
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
  expect(await f.store.getCommand(f.queued.commandId)).toMatchObject({ status: "failed", error: "Dispatch authority revoked before transmission" });
});

it("fails closed when a restarted service lacks an automation authority resolver", async () => {
  const f = await fixture();
  f.hub.isNodeConnected.mockReturnValue(true);
  const restarted = new CommandService(f.store, f.hub, 300, undefined, () => true);
  await restarted.dispatchQueued();
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
  expect(await f.store.getCommand(f.queued.commandId)).toMatchObject({ status: "cancelled" });
});

it("keeps frozen schedule and occurrence identities in persisted authorization and idempotency checks", async () => {
  expect(CommandAuthoritySchema.parse(authority)).toEqual(authority);
  expect(sameAuthority(authority, { ...authority })).toBe(true);
  expect(sameAuthority(authority, { ...authority, scheduleId: "other" })).toBe(false);
  expect(sameAuthority(authority, { ...authority, runId: "other" })).toBe(false);
  const f = await fixture();
  await expect(f.create().submit(input, 0, undefined, "control-socket", {
    ...authority, runId: "14251418-2713-462e-be26-7478a63a11ee",
  })).rejects.toThrow("different command payload");
});

it("rejects session schedules whose instructions or target cannot pass the command transport contract", () => {
  const sessionSchedule = { kind: "session", title: "report", prompt: "work", nodeId: "node", sessionId: "session",
    timezone: "UTC", timing: { type: "cron", expression: "0 9 * * *" } };
  expect(CreateScheduleSchema.safeParse({ ...sessionSchedule, prompt: "a".repeat(16_000), sessionId: "s".repeat(64) }).success).toBe(true);
  expect(CreateScheduleSchema.safeParse({ ...sessionSchedule, prompt: "a".repeat(16_001) }).success).toBe(false);
  expect(CreateScheduleSchema.safeParse({ ...sessionSchedule, sessionId: "s".repeat(65) }).success).toBe(false);
  const { nodeId: _node, sessionId: _session, prompt: _prompt, ...base } = sessionSchedule;
  expect(CreateScheduleSchema.safeParse({ ...base, kind: "reminder", text: "a".repeat(128_000) }).success).toBe(true);
});
