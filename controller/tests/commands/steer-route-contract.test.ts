import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { CommandService } from "../../src/commands/service.js";
import { LeaderOrchestrator } from "../../src/leader/orchestrator.js";
import { AUTHORIZATION_TOOL_NAME } from "../../src/leader/model/user-authorization.js";
import type { LeaderModel, ModelMessage, ModelReply, ModelTool } from "../../src/leader/model/contracts.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { ControllerCommandMessage, PostCommandRequest, ScopedSession } from "../../src/types.js";
import { acknowledgementFixture } from "../leader/acknowledgement-fixture.js";

interface RouteCase { name: string; supported: boolean; command: ControllerCommandMessage }
const cases: RouteCase[] = JSON.parse(readFileSync(new URL(
  "../../../daemon/pkg/client/testdata/steer-route-contract.json", import.meta.url), "utf8"));
const CHAT_ID = "steer-route-chat";
const NOW = Date.parse("2026-10-23T00:00:00Z");
const TTL_SECONDS = 300;
const FRESHNESS_MS = 45_000;
const iso = (offset = 0) => new Date(NOW + offset).toISOString();

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function fixture(tc: RouteCase) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const { command } = tc;
  const store = new MemoryStore();
  const session: ScopedSession = { nodeId: command.nodeId, id: command.sessionId, title: "Steer fixture",
    cwd: "/fixture", provider: "codex-app", status: "active", loaded: true,
    capabilities: command.sendRoute === "app-server-resume" ? ["read", "resume-send"] : ["read", "send"],
    observedAt: iso() };
  if (command.sendRoute === "desktop-owner") session.sendAvailability = {
    route: "desktop-owner", state: "blocked", reason: "busy", observedAt: iso(), validUntil: iso(FRESHNESS_MS),
  };
  if (command.sendRoute === "terminal-pane") Object.assign(session, { provider: "terminal/codex", status: "idle",
    sendAvailability: { route: "terminal-pane", state: "ready", mode: "non-atomic",
      observedAt: iso(), validUntil: iso(FRESHNESS_MS) } });
  await store.upsertNodeSessions(command.nodeId, [session]);
  const hub = {
    isNodeConnected: vi.fn(() => true), supportsDeliveryMode: vi.fn(() => true),
    getNodeSession: vi.fn((): ScopedSession | undefined => session), getNodeSkills: () => [], getAllSessions: async () => [session],
    getNodeStatusList: () => [], getAllSkills: () => [], readHistory: vi.fn(),
    registerCommandResultWaiter: () => ({ wait: async () => null, cancel: vi.fn() }),
    sendCommand: vi.fn(async (wire: ControllerCommandMessage) => {
      await store.updateCommandStatus(wire.commandId, "accepted", undefined, undefined, wire.expectedTurnId);
      return { delivered: true };
    }),
  };
  const service = new CommandService(store, hub, TTL_SECONDS);
  const request: PostCommandRequest = { nodeId: command.nodeId, sessionId: command.sessionId, action: "send",
    prompt: command.prompt, requestId: command.commandId, deliveryMode: "steer", expectedTurnId: command.expectedTurnId };
  return { store, session, hub, service, request };
}

it.each(cases)("matches the daemon's $name steer route before persistence and dispatch", async tc => {
  const f = await fixture(tc);
  const create = vi.spyOn(f.store, "createCommandIfAbsent");
  const claim = vi.spyOn(f.store, "claimQueuedCommand");
  const guard = vi.fn();
  expect(f.service.canDispatchSend(f.request, tc.command.sendRoute!)).toBe(tc.supported);
  if (!tc.supported) {
    await expect(f.service.submit(f.request, 0, guard, tc.command.sendRoute)).rejects.toMatchObject({ httpStatus: 409 });
    expect(create).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
    expect(guard).not.toHaveBeenCalled();
    expect(f.hub.sendCommand).not.toHaveBeenCalled();
    expect(await f.store.listRecentCommands()).toEqual([]);
    return;
  }
  const result = await f.service.submit(f.request, 0, guard, tc.command.sendRoute);
  expect(result).toMatchObject({ status: "accepted", sendRoute: tc.command.sendRoute, deliveryMode: "steer",
    expectedTurnId: tc.command.expectedTurnId, turnId: tc.command.expectedTurnId });
  const wire = JSON.parse(JSON.stringify(f.hub.sendCommand.mock.calls[0][0]));
  expect(wire).toEqual({ ...tc.command, commandId: result.commandId, expiresAt: result.expiresAt });
  expect(await f.service.submit(f.request, 0, guard, tc.command.sendRoute)).toEqual(result);
  await f.service.dispatchQueued();
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});

it.each(cases.filter(tc => tc.supported))("queues an offline $name steer and preserves its route and exact turn after reconnect", async tc => {
  const f = await fixture(tc);
  f.hub.isNodeConnected.mockReturnValue(false);
  f.hub.getNodeSession.mockReturnValue(undefined);
  const queued = await f.service.submit(f.request, 0, undefined, tc.command.sendRoute);
  expect(queued).toMatchObject({ status: "queued", sendRoute: tc.command.sendRoute, deliveryMode: "steer",
    expectedTurnId: tc.command.expectedTurnId });
  await f.service.dispatchQueued();
  expect(f.hub.sendCommand).not.toHaveBeenCalled();

  f.hub.isNodeConnected.mockReturnValue(true);
  f.hub.getNodeSession.mockReturnValue(f.session);
  await f.service.dispatchQueued();
  await f.service.dispatchQueued();
  expect(await f.store.getCommand(queued.commandId)).toMatchObject({ status: "accepted", turnId: tc.command.expectedTurnId });
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
  expect(f.hub.sendCommand.mock.calls[0][0]).toMatchObject({ commandId: queued.commandId, sendRoute: tc.command.sendRoute,
    deliveryMode: "steer", expectedTurnId: tc.command.expectedTurnId });
});

it("preserves an explicit managed steer route when the loaded session also gains native send capability", async () => {
  const tc = cases.find(value => value.name === "managed")!;
  const f = await fixture(tc);
  f.session.capabilities = ["read", "send", "resume-send"];
  expect(f.service.canDispatchSend(f.request, "app-server-resume")).toBe(true);
  const result = await f.service.submit(f.request, 0, undefined, "app-server-resume");
  expect(result).toMatchObject({ status: "accepted", sendRoute: "app-server-resume", turnId: tc.command.expectedTurnId });
  expect(f.hub.sendCommand.mock.calls[0][0]).toMatchObject({ sendRoute: "app-server-resume", deliveryMode: "steer",
    expectedTurnId: tc.command.expectedTurnId });
});

it.each(["blocked", "ready"] as const)("rejects desktop steer with %s proof without falling back to a native capability", async state => {
  const tc = cases.find(value => value.name === "desktop")!;
  const f = await fixture(tc);
  f.session.capabilities = ["read", "send", "resume-send"];
  f.session.sendAvailability = { route: "desktop-owner", state, observedAt: iso(), validUntil: iso(FRESHNESS_MS),
    ...(state === "blocked" ? { reason: "busy" } : {}) };
  await expect(f.service.submit(f.request, 0)).rejects.toMatchObject({ httpStatus: 409 });
  expect(await f.store.listRecentCommands()).toEqual([]);
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("does not claim an unsupported desktop steer persisted by an older controller", async () => {
  const tc = cases.find(value => value.name === "desktop")!;
  const f = await fixture(tc);
  const claim = vi.spyOn(f.store, "claimQueuedCommand");
  const record = { ...f.request, commandId: tc.command.commandId, sendRoute: tc.command.sendRoute, status: "queued" as const,
    createdAt: iso(), updatedAt: iso(), expiresAt: iso(TTL_SECONDS * 1000), authority: { type: "admin" as const } };
  await f.store.createCommandIfAbsent(record);
  await f.service.dispatchQueued();
  expect(claim).not.toHaveBeenCalled();
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

class PlanModel implements LeaderModel {
  private proposed = false;
  constructor(private request: PostCommandRequest, private tool: "execute_plan" | "propose_plan") {}
  async complete(messages: ModelMessage[], tools: ModelTool[]): Promise<ModelReply> {
    if (tools.length === 1 && tools[0].function.name === AUTHORIZATION_TOOL_NAME) return { content: null,
      toolCalls: [{ id: "intent", type: "function", function: { name: AUTHORIZATION_TOOL_NAME,
        arguments: JSON.stringify({ intent: this.tool === "execute_plan" ? "task" : "preview" }) } }] };
    const acknowledgement = acknowledgementFixture(messages);
    if (acknowledgement) return acknowledgement;
    if (!this.proposed) {
      this.proposed = true;
      const { nodeId, sessionId, prompt, deliveryMode, expectedTurnId } = this.request;
      return { content: null, toolCalls: [{ id: "plan", type: "function", function: { name: this.tool,
        arguments: JSON.stringify({ actions: [{ nodeId, sessionId, prompt, deliveryMode, expectedTurnId }] }) } }] };
    }
    const result = messages.findLast(message => message.role === "tool");
    if (!result?.content) throw new Error("Route rejection fixture did not receive a tool result");
    const error: unknown = JSON.parse(result.content).error;
    if (typeof error !== "string") throw new Error("Route rejection fixture expected a tool error");
    return { content: error, toolCalls: [] };
  }
}

it.each(["execute_plan", "propose_plan"] as const)("rejects unsupported desktop steer during %s preparation", async tool => {
  const f = await fixture(cases.find(tc => tc.name === "desktop")!);
  const submit = vi.spyOn(f.service, "submit");
  const leader = new LeaderOrchestrator(f.store, f.hub, f.service, new PlanModel(f.request, tool));
  const result = await leader.handle(CHAT_ID, tool, "仅给原会话当前轮 active-turn 补充检查，直接补充");
  expect(result.text).toContain("目标原路线不支持补充当前轮");
  expect((await f.store.getLeaderState(CHAT_ID))?.data.pending).toBeUndefined();
  expect(await f.store.getLatestExecution(CHAT_ID)).toBeNull();
  expect(await f.store.listRecentCommands()).toEqual([]);
  expect(submit).not.toHaveBeenCalled();
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("rejects confirmation of an unsupported desktop steer preview created by an older controller", async () => {
  const tc = cases.find(value => value.name === "desktop")!;
  const f = await fixture(tc);
  const { nodeId, sessionId, prompt, deliveryMode, expectedTurnId } = f.request;
  await f.store.compareAndSetLeaderState(CHAT_ID, 0, { pending: { id: randomUUID(), expiresAt: NOW + FRESHNESS_MS,
    actions: [{ nodeId, sessionId, prompt, deliveryMode, expectedTurnId, dependsOn: [], sendRoute: tc.command.sendRoute }] } });
  const submit = vi.spyOn(f.service, "submit");
  const leader = new LeaderOrchestrator(f.store, f.hub, f.service, new PlanModel(f.request, "execute_plan"));
  expect((await leader.handle(CHAT_ID, "confirm-old-preview", "确认")).text).toContain("目标原路线不支持补充当前轮");
  expect(submit).not.toHaveBeenCalled();
  expect(await f.store.listRecentCommands()).toEqual([]);
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it.each(cases.filter(tc => tc.supported))("keeps the exact $name route and turn from Leader through command dispatch", async tc => {
  const f = await fixture(tc);
  const leader = new LeaderOrchestrator(f.store, f.hub, f.service, new PlanModel(f.request, "execute_plan"));
  const result = await leader.handle(CHAT_ID, "exact-route-steer", "给原会话当前轮 active-turn 补充检查，直接补充");
  expect(result.commandId).toBeTruthy();
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
  expect(f.hub.sendCommand.mock.calls[0][0]).toMatchObject({ sendRoute: tc.command.sendRoute,
    sessionId: tc.command.sessionId, deliveryMode: "steer", expectedTurnId: tc.command.expectedTurnId });
  expect(await f.store.getLatestExecution(CHAT_ID)).toBeNull();
  expect(await leader.handle(CHAT_ID, "exact-route-steer", "给原会话当前轮 active-turn 补充检查，直接补充")).toEqual(result);
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});
