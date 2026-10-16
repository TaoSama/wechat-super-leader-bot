import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { NodeHub } from "../../src/nodes/hub.js";
import { CommandService } from "../../src/commands/service.js";
import { MemoryStore } from "../../src/store/memory.js";
import { LeaderOrchestrator } from "../../src/leader/orchestrator.js";
import { SEND_READINESS_WAIT_MS } from "../../src/sessions/send-readiness.js";
import type { LeaderModel, ModelMessage } from "../../src/leader/model/contracts.js";
import type { Session } from "../../src/types.js";

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  commands: unknown[] = [];
  send(raw: string, callback?: (error?: Error) => void) {
    const message = JSON.parse(raw);
    if (message.type === "command") this.commands.push(message);
    callback?.();
  }
  close() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
  receive(message: unknown) { this.emit("message", JSON.stringify(message)); }
}
function session(id: string, state: "ready" | "blocked" = "blocked"): Session {
  const observedAt = new Date().toISOString();
  return { id, provider: "codex-app", title: id, cwd: "/fixture", status: "notLoaded", loaded: false,
    capabilities: ["read"], observedAt,
    desktopObservation: { source: "codex-desktop", availability: "available", status: "idle", observedAt },
    sendAvailability: { route: "desktop-owner", state, ...(state === "blocked" ? { reason: "checking" as const } : {}),
      observedAt, validUntil: new Date(Date.now() + 45000).toISOString() } };
}
const actions = ["invest", "research"].map(sessionId => ({ nodeId: "demoair", sessionId, prompt: "研究任务" }));
const hubs: NodeHub[] = [];
function fixture(sessions = [session("invest"), session("research")]) {
  const store = new MemoryStore(), hub = new NodeHub(store, new Map()), socket = new Socket();
  hubs.push(hub);
  hub.handleConnection(socket as unknown as WebSocket, "demoair");
  socket.receive({ type: "hello", version: 1, nodeId: "demoair", sessions, skills: [] });
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
  const leader = new LeaderOrchestrator(store, hub, commands, model);
  const changed = (next: Session[]) => socket.receive({ type: "heartbeat", sessions: next, skills: [] });
  const subscribe = vi.spyOn(hub, "subscribeSessionChanges");
  return { store, hub, socket, leader, changed, tools, subscribe };
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.closeAll();
  vi.useRealTimers();
});

describe("Leader readiness waits", () => {
  it("waits for both exact targets before proposing and never dispatches on proposal", async () => {
    const f = fixture();
    const pending = f.leader.handle("chat", "plan", "分别给投资和研究发任务");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.subscribe).toHaveBeenCalledTimes(1);
    f.changed([session("invest", "ready"), session("research")]);
    await vi.advanceTimersByTimeAsync(0);
    expect((await f.store.getLeaderState("chat"))?.data.pending).toBeUndefined();
    f.changed([session("invest", "ready"), session("research", "ready")]);
    expect((await pending).text).toContain("待执行计划");
    expect(f.socket.commands).toEqual([]);
  });

  it("reports the checking target after the bounded timeout with no pending plan or command", async () => {
    const f = fixture();
    const pending = f.leader.handle("chat", "plan", "发任务");
    await vi.advanceTimersByTimeAsync(SEND_READINESS_WAIT_MS);
    await pending;
    expect(f.tools.join()).toContain("invest");
    expect(f.tools.join()).toContain("检查超时");
    expect(f.tools.join()).not.toContain("clarify");
    expect((await f.store.getLeaderState("chat"))?.data.pending).toBeUndefined();
    expect(f.socket.commands).toEqual([]);
  });

  it("stops on disconnect rather than accepting a replacement connection", async () => {
    const f = fixture();
    const pending = f.leader.handle("chat", "plan", "发任务");
    await vi.advanceTimersByTimeAsync(0);
    f.socket.close();
    await pending;
    expect(f.tools.join()).toContain("节点已断开");
    expect(f.socket.commands).toEqual([]);
  });

  it("rejects a busy peer immediately while another target is checking", async () => {
    const busy = session("research");
    busy.sendAvailability!.reason = "busy";
    const f = fixture([session("invest"), busy]);
    await f.leader.handle("chat", "plan", "发任务");
    expect(f.subscribe).not.toHaveBeenCalled();
    expect(f.tools.join()).toContain("research");
    expect(f.tools.join()).toContain("会话忙碌");
    expect(f.socket.commands).toEqual([]);
  });

  it("waits during confirmation and dispatches each frozen action only once after recovery", async () => {
    const f = fixture([session("invest", "ready"), session("research", "ready")]);
    await f.leader.handle("chat", "plan", "发任务");
    f.changed([session("invest"), session("research", "ready")]);
    const pending = f.leader.handle("chat", "confirm", "确认执行");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.socket.commands).toEqual([]);
    f.changed([session("invest", "ready"), session("research", "ready")]);
    await pending;
    expect(f.socket.commands).toHaveLength(2);
    await f.leader.handle("chat", "confirm", "确认执行");
    expect(f.socket.commands).toHaveLength(2);
  });

  it("does not dispatch when the confirmed plan expires during the wait", async () => {
    const f = fixture([session("invest", "ready"), session("research", "ready")]);
    await f.leader.handle("chat", "plan", "发任务");
    const state = (await f.store.getLeaderState("chat"))!;
    state.data.pending!.expiresAt = Date.now() + 1000;
    await f.store.compareAndSetLeaderState("chat", state.revision, state.data);
    f.changed([session("invest"), session("research", "ready")]);
    const pending = f.leader.handle("chat", "confirm", "确认执行");
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    f.changed([session("invest", "ready"), session("research", "ready")]);
    expect(f.socket.commands).toEqual([]);
    expect(await f.store.getLatestExecution("chat")).toBeNull();
  });

  it.each(["busy", "unavailable", "timeout"])("creates no command for either target when confirmation ends with %s", async change => {
    const f = fixture([session("invest", "ready"), session("research", "ready")]);
    await f.leader.handle("chat", "plan", "发任务");
    f.changed([session("invest"), session("research", "ready")]);
    const pending = f.leader.handle("chat", "confirm", "确认执行");
    await vi.advanceTimersByTimeAsync(0);
    if (change === "timeout") await vi.advanceTimersByTimeAsync(SEND_READINESS_WAIT_MS);
    else {
      const blocked = session("research");
      if (change === "busy") blocked.sendAvailability!.reason = "busy";
      else blocked.sendAvailability!.state = "unavailable";
      f.changed([session("invest"), blocked]);
    }
    expect((await pending).text).toContain("没有派发");
    expect(f.socket.commands).toEqual([]);
    expect(await f.store.getLatestExecution("chat")).toBeNull();
  });

  it("revalidates the original claim after readiness recovers", async () => {
    const f = fixture([session("invest", "ready"), session("research", "ready")]);
    await f.leader.handle("chat", "plan", "发任务");
    f.changed([session("invest"), session("research", "ready")]);
    const pending = f.leader.handle("chat", "confirm", "确认执行");
    await vi.advanceTimersByTimeAsync(0);
    const state = (await f.store.getLeaderState("chat"))!;
    await f.store.compareAndSetLeaderState("chat", state.revision, state.data);
    f.changed([session("invest", "ready"), session("research", "ready")]);
    await expect(pending).rejects.toThrow("聊天状态发生变化");
    expect(f.socket.commands).toEqual([]);
    expect(await f.store.getLatestExecution("chat")).toBeNull();
  });

  it.each(["during-wait", "before-binding"])("rejects a ready peer switching routes %s with zero dispatch", async timing => {
    const f = fixture([session("invest", "ready"), session("research")]);
    const pending = f.leader.handle("chat", "plan", "发任务");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.subscribe).toHaveBeenCalledTimes(1);
    if (timing === "before-binding") {
      // Resolve the wait, then replace the inventory before its awaiting caller resumes.
      f.changed([session("invest", "ready"), session("research", "ready")]);
    }
    const native = session("invest", "ready");
    delete native.sendAvailability;
    Object.assign(native, { loaded: true, status: "idle", capabilities: ["read", "send"] });
    f.changed([native, session("research", timing === "before-binding" ? "ready" : "blocked")]);
    await pending;
    expect(f.tools.join()).toContain("invest");
    expect(f.tools.join()).toContain("发送路线已变化");
    expect((await f.store.getLeaderState("chat"))?.data.pending).toBeUndefined();
    expect(f.socket.commands).toEqual([]);
  });
});
