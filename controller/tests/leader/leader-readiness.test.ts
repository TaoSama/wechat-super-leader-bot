import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { NodeHub } from "../../src/nodes/hub.js";
import { CommandService } from "../../src/commands/service.js";
import { MemoryStore } from "../../src/store/memory.js";
import { LeaderOrchestrator } from "../../src/leader/orchestrator.js";
import { ExecutionScheduler } from "../../src/leader/plans/scheduler.js";
import { EXECUTION_TTL_MS, executionRequestId } from "../../src/leader/plans/execution.js";
import { LeaderDataSchema } from "../../src/leader/contracts.js";
import type { LeaderModel, ModelMessage } from "../../src/leader/model/contracts.js";
import type { ControllerCommandMessage, Session } from "../../src/types.js";

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  commands: ControllerCommandMessage[] = [];
  send(raw: string, callback?: (error?: Error) => void) {
    const message = JSON.parse(raw);
    if (message.type === "command") this.commands.push(message);
    callback?.();
  }
  close() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
  receive(message: unknown) { this.emit("message", JSON.stringify(message)); }
}
type Readiness = "ready" | "checking" | "busy" | "unavailable" | "expired";
const AUTHORITY_VALID_MS = 45_000;
function session(id: string, state: Readiness = "checking"): Session {
  const observedAt = new Date().toISOString();
  return { id, provider: "codex-app", title: id, cwd: "/fixture", status: "notLoaded", loaded: false,
    capabilities: ["read"], observedAt,
    desktopObservation: { source: "codex-desktop", availability: "available", status: state === "busy" ? "active" : "idle", observedAt },
    sendAvailability: { route: "desktop-owner", state: state === "unavailable" ? "unavailable" :
      state === "ready" || state === "expired" ? "ready" : "blocked",
      ...(state === "checking" || state === "busy" ? { reason: state } : {}),
      observedAt: state === "expired" ? new Date(Date.now() - AUTHORITY_VALID_MS).toISOString() : observedAt,
      validUntil: new Date(Date.now() + (state === "expired" ? -1 : AUTHORITY_VALID_MS)).toISOString() } };
}
function nativeSession(id: string): Session {
  return { id, provider: "codex-app", title: id, cwd: "/fixture", loaded: true, status: "idle",
    capabilities: ["read", "send"], observedAt: new Date().toISOString() };
}
const actions = ["invest", "research"].map(sessionId => ({ nodeId: "macair", sessionId, prompt: "研究任务" }));
const hubs: NodeHub[] = [];
const schedulers: ExecutionScheduler[] = [];
const schedulerErrors: unknown[] = [];
function fixture(sessions = [session("invest"), session("research")]) {
  const store = new MemoryStore(), hub = new NodeHub(store, new Map()), socket = new Socket();
  hubs.push(hub);
  hub.handleConnection(socket as unknown as WebSocket, "macair");
  socket.receive({ type: "hello", version: 1, nodeId: "macair", sessions, skills: [] });
  const tools: string[] = [];
  let calls = 0;
  const model: LeaderModel = { complete: async (messages: ModelMessage[]) => {
    tools.push(...messages.filter(message => message.role === "tool").map(message => message.content ?? ""));
    if (++calls === 1) return { content: null, toolCalls: [{ id: "plan", type: "function", function: {
      name: "propose_plan", arguments: JSON.stringify({ actions }),
    } }] };
    return { content: "查询已结束", toolCalls: [] };
  } };
  const commands = new CommandService(store, hub, 60);
  const createScheduler = () => {
    const scheduler = new ExecutionScheduler(store, commands, { onError: error => { schedulerErrors.push(error); },
      canDispatch: (execution, index) => {
        const action = execution.plan.actions[index];
        return !!action.sendRoute && commands.canDispatchSend(action, action.sendRoute);
      } });
    schedulers.push(scheduler);
    return scheduler;
  };
  const scheduler = createScheduler();
  const leader = new LeaderOrchestrator(store, hub, commands, model, Date.now, undefined, scheduler);
  const changed = (next: Session[]) => socket.receive({ type: "heartbeat", sessions: next, skills: [] });
  const subscribe = vi.spyOn(hub, "subscribeSessionChanges");
  return { store, hub, socket, commands, scheduler, createScheduler, leader, changed, tools, subscribe };
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await Promise.all(schedulers.splice(0).map(scheduler => scheduler.stop()));
  for (const hub of hubs.splice(0)) await hub.closeAll();
  vi.useRealTimers();
  vi.restoreAllMocks();
  expect(schedulerErrors.splice(0)).toEqual([]);
});

describe("Leader durable readiness waits", () => {
  it.each(["checking", "busy", "unavailable", "expired"] as const)("previews known %s desktop targets without waiting or dispatching", async state => {
    const f = fixture([session("invest", state), session("research", "ready")]);
    expect((await f.leader.handle("chat", "plan", "分别给投资和研究发任务")).text).toContain("待执行计划");
    const pending = LeaderDataSchema.parse((await f.store.getLeaderState("chat"))?.data).pending;
    expect(pending?.actions.map(action => [action.sessionId, action.sendRoute])).toEqual([
      ["invest", "desktop-owner"], ["research", "desktop-owner"],
    ]);
    expect(f.subscribe).not.toHaveBeenCalled();
    expect(await f.store.getLatestExecution("chat")).toBeNull();
    expect(f.socket.commands).toEqual([]);
  });

  it("rejects read-only targets without an independent send route", async () => {
    const readOnly = nativeSession("invest");
    readOnly.capabilities = ["read"];
    const f = fixture([readOnly, session("research", "ready")]);
    await f.leader.handle("chat", "plan", "发任务");
    expect(f.tools.join()).toContain("read-only");
    expect((await f.store.getLeaderState("chat"))?.data.pending).toBeUndefined();
    expect(await f.store.getLatestExecution("chat")).toBeNull();
    expect(f.socket.commands).toEqual([]);
  });

  it("rejects an unknown target rather than queueing against a different known session", async () => {
    const f = fixture([session("unrelated", "ready"), session("research", "ready")]);
    await f.leader.handle("chat", "plan", "发任务");
    expect(f.tools.join()).toContain("read-only");
    expect((await f.store.getLeaderState("chat"))?.data.pending).toBeUndefined();
    expect(await f.store.getLatestExecution("chat")).toBeNull();
    expect(f.socket.commands).toEqual([]);
  });

  it("persists a busy native target and retains its independent control-socket capability", async () => {
    const busy = nativeSession("invest");
    busy.status = "active";
    const f = fixture([busy, session("research")]);
    await f.leader.handle("chat", "plan", "发任务");
    await f.leader.handle("chat", "confirm", "确认执行");
    const execution = (await f.store.getLatestExecution("chat"))!;
    expect(execution).toMatchObject({ status: "active", attempts: [null, null] });
    expect(execution.plan.actions[0].sendRoute).toBe("control-socket");
    expect(f.socket.commands).toEqual([]);
    f.changed([nativeSession("invest"), session("research")]);
    await f.scheduler.advance(execution.id);
    expect(f.socket.commands).toHaveLength(1);
    expect(f.socket.commands[0]).toMatchObject({ sessionId: "invest", sendRoute: "control-socket" });
  });

  it("persists confirmation and dispatches a ready independent root while its peer keeps waiting", async () => {
    const f = fixture([session("invest"), session("research", "ready")]);
    await f.leader.handle("chat", "plan", "发任务");
    expect((await f.leader.handle("chat", "confirm", "确认执行")).text).toContain("自动推进中");
    const execution = (await f.store.getLatestExecution("chat"))!;
    expect(execution.status).toBe("active");
    expect(execution.attempts[0]).toBeNull();
    expect(execution.attempts[1]).not.toBeNull();
    expect(await f.store.findCommandByRequestId(executionRequestId(execution, 0))).toBeNull();
    expect(f.socket.commands.map(command => command.sessionId)).toEqual(["research"]);
    expect(await f.scheduler.view(execution.id, "chat")).toMatchObject({
      steps: [{ sessionId: "invest", status: "waiting" }, { sessionId: "research", status: "pending" }],
    });
    await f.leader.handle("chat", "confirm", "确认执行");
    expect(f.socket.commands).toHaveLength(1);
  });

  it("recovers persisted waiting steps after scheduler restart, only on their original targets and once", async () => {
    const f = fixture([session("invest", "busy"), session("research")]);
    await f.leader.handle("chat", "plan", "发任务");
    await f.leader.handle("chat", "confirm", "确认执行");
    const execution = (await f.store.getLatestExecution("chat"))!;
    expect(execution.attempts).toEqual([null, null]);
    expect(f.socket.commands).toEqual([]);
    await f.scheduler.stop();
    const recovered = f.createScheduler();
    f.changed([session("unrelated", "ready"), session("invest", "busy"), session("research")]);
    await recovered.advance(execution.id);
    expect((await f.store.getExecution(execution.id))?.attempts).toEqual([null, null]);
    f.changed([session("unrelated", "ready"), session("invest", "ready"), session("research")]);
    await recovered.advance(execution.id);
    await recovered.advance(execution.id);
    expect(f.socket.commands.map(command => [command.nodeId, command.sessionId, command.sendRoute])).toEqual([
      ["macair", "invest", "desktop-owner"],
    ]);
    f.changed([session("invest", "ready"), session("research", "ready")]);
    await recovered.advance(execution.id);
    await recovered.advance(execution.id);
    expect(f.socket.commands.map(command => command.sessionId)).toEqual(["invest", "research"]);
    for (const index of execution.plan.actions.keys()) {
      const command = await f.store.findCommandByRequestId(executionRequestId(execution, index));
      expect(command).toMatchObject({ commandId: f.socket.commands[index].commandId, status: "pending",
        authority: { type: "plan", id: execution.id, chatId: "chat" } });
    }
  });

  it.each(["cancelled", "expired"] as const)("never dispatches a %s waiting execution after readiness recovers", async status => {
    const f = fixture();
    await f.leader.handle("chat", "plan", "发任务");
    await f.leader.handle("chat", "confirm", "确认执行");
    const execution = (await f.store.getLatestExecution("chat"))!;
    if (status === "cancelled") await f.leader.handle("chat", "cancel", "取消计划");
    else vi.setSystemTime(Date.now() + EXECUTION_TTL_MS);
    f.changed([session("invest", "ready"), session("research", "ready")]);
    await f.scheduler.advance(execution.id);
    await f.commands.dispatchQueued();
    expect(await f.store.getExecution(execution.id)).toMatchObject({ status, attempts: [null, null] });
    for (const index of execution.plan.actions.keys()) {
      expect(await f.store.findCommandByRequestId(executionRequestId(execution, index))).toBeNull();
    }
    expect(f.socket.commands).toEqual([]);
  });

  it("rejects an expired preview before publishing an execution", async () => {
    const f = fixture();
    await f.leader.handle("chat", "plan", "发任务");
    const state = (await f.store.getLeaderState("chat"))!;
    vi.setSystemTime(LeaderDataSchema.parse(state.data).pending!.expiresAt);
    f.changed([session("invest", "ready"), session("research", "ready")]);
    expect((await f.leader.handle("chat", "confirm", "确认执行")).text).toContain("计划已过期");
    expect(await f.store.getLatestExecution("chat")).toBeNull();
    expect(f.socket.commands).toEqual([]);
  });

  it("checks the confirmation claim atomically even when every target is waiting", async () => {
    const f = fixture();
    await f.leader.handle("chat", "plan", "发任务");
    const confirmExecution = f.store.confirmExecution.bind(f.store);
    const confirm = vi.spyOn(f.store, "confirmExecution").mockImplementation(async (...args) => {
      const state = (await f.store.getLeaderState("chat"))!;
      await f.store.compareAndSetLeaderState("chat", state.revision, state.data);
      return confirmExecution(...args);
    });
    await expect(f.leader.handle("chat", "confirm", "确认执行")).rejects.toThrow("聊天状态发生变化");
    expect(confirm).toHaveBeenCalledOnce();
    expect(await f.store.getLatestExecution("chat")).toBeNull();
    expect(f.socket.commands).toEqual([]);
  });

  it("does not confirm a preview whose original target changed routes", async () => {
    const f = fixture();
    await f.leader.handle("chat", "plan", "发任务");
    f.changed([nativeSession("invest"), session("research")]);
    expect((await f.leader.handle("chat", "confirm", "确认执行")).text).toContain("没有派发");
    expect(await f.store.getLatestExecution("chat")).toBeNull();
    expect(f.socket.commands).toEqual([]);
  });

  it("keeps the confirmed route frozen and waits until that route recovers", async () => {
    const f = fixture();
    await f.leader.handle("chat", "plan", "发任务");
    await f.leader.handle("chat", "confirm", "确认执行");
    const execution = (await f.store.getLatestExecution("chat"))!;
    f.changed([nativeSession("invest"), session("research")]);
    await f.scheduler.advance(execution.id);
    expect((await f.store.getExecution(execution.id))?.attempts).toEqual([null, null]);
    expect(f.socket.commands).toEqual([]);
    f.changed([session("invest", "ready"), session("research")]);
    await f.scheduler.advance(execution.id);
    expect(f.socket.commands).toHaveLength(1);
    expect(f.socket.commands[0]).toMatchObject({ sessionId: "invest", sendRoute: "desktop-owner" });
    expect((await f.store.getExecution(execution.id))?.plan).toEqual(execution.plan);
  });
});
