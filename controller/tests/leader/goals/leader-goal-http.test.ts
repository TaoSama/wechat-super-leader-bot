import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { ControllerServer } from "../../../src/http/server.js";
import { MemoryStore } from "../../../src/store/memory.js";
import type { LeaderModel, ModelReply } from "../../../src/leader/model/contracts.js";
import { ExecutionScheduler } from "../../../src/leader/plans/scheduler.js";
import { GoalScheduler } from "../../../src/leader/goals/scheduler.js";

const TOKEN = "synthetic-goal-admin";
const TICK_MS = 2000;
let server: ControllerServer | undefined;
afterEach(async () => { await server?.stop(); server = undefined; vi.useRealTimers(); });

it("stops both server-owned schedulers before waiting for either to drain", async () => {
  let release!: () => void;
  const draining = new Promise<void>(resolve => { release = resolve; });
  const originalStop = ExecutionScheduler.prototype.stop;
  const executionStop = vi.spyOn(ExecutionScheduler.prototype, "stop").mockImplementation(function () {
    return Promise.all([originalStop.call(this), draining]).then(() => undefined);
  });
  const goalStop = vi.spyOn(GoalScheduler.prototype, "stop");
  try {
    server = new ControllerServer({ host: "127.0.0.1", port: 0, controllerToken: TOKEN,
      nodeTokens: {}, tokenToNode: new Map(), allowedChatIds: new Set(["chat"]),
      persistenceMode: "memory", commandTtlSeconds: 60 }, new MemoryStore(), { complete: vi.fn() });
    await server.start();
    const closing = server.stop();
    expect(executionStop).toHaveBeenCalledOnce();
    expect(goalStop).toHaveBeenCalledOnce();
    release();
    await closing;
    server = undefined;
  } finally {
    release();
    executionStop.mockRestore();
    goalStop.mockRestore();
  }
});

class GoalDaemon extends EventEmitter {
  readyState = WebSocket.OPEN;
  commands: Record<string, unknown>[] = [];
  send(raw: string, callback?: (error?: Error) => void) {
    const frame = JSON.parse(raw);
    callback?.();
    if (frame.type !== "command") return;
    this.commands.push(frame);
    setImmediate(() => {
      const turnId = `turn-${frame.commandId}`;
      this.emit("message", JSON.stringify({ type: "result", commandId: frame.commandId, status: "accepted", turnId }));
      setImmediate(() => this.emit("message", JSON.stringify({ type: "result", commandId: frame.commandId,
        status: "completed", turnId, output: `精确动作${this.commands.length}的核查证据` })));
    });
  }
  close() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
}

it("one HTTP confirmation starts a server-owned continuous loop and publishes its exact completion without more messages", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const store = new MemoryStore();
  const decide = [
    { type: "next", target: 1, prompt: "取得初始核查基准", sourceActions: [], reason: "先取得证据" },
    { type: "next", target: 1, prompt: "根据初始结果进行不同的最终核查", sourceActions: [1], reason: "基于上一轮结果决定后继任务" },
    { type: "complete", criteria: [{ criterion: 1, actions: [2] }], reason: "精确最终证据支持条件，属于模型判断" },
  ];
  const model: LeaderModel = { complete: vi.fn(async (_messages, tools): Promise<ModelReply> => {
    const background = tools.some(tool => tool.function.name === "decide_goal");
    const args = background ? decide.shift() : { objective: "持续得到核查结论", criteria: ["完成最终证据核查"],
      targets: [{ nodeId: "air", sessionId: "original" }], constraints: "只读，不外发", maxActions: 3,
      maxDecisions: 4, durationMinutes: 30, shareResults: true };
    if (!args) throw new Error("Unexpected additional goal decision");
    return { content: null, toolCalls: [{ id: "fixture-call", type: "function", function: {
      name: background ? "decide_goal" : "propose_goal", arguments: JSON.stringify(args) } }] };
  }) };
  server = new ControllerServer({ host: "127.0.0.1", port: 0, controllerToken: TOKEN,
    nodeTokens: { air: "synthetic-goal-node" }, tokenToNode: new Map([["synthetic-goal-node", "air"]]),
    allowedChatIds: new Set(["chat"]), persistenceMode: "memory", commandTtlSeconds: 60 }, store, model);
  await server.start();
  const address = server.getHttpServer().address();
  if (!address || typeof address === "string") throw new Error("Missing fixture HTTP port");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (messageId: string, text: string, chatId = "chat") => fetch(`${base}/v1/messages`, { method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ chatId, messageId, text }) });
  expect((await post("denied", "持续目标", "other")).status).toBe(403);
  expect(model.complete).not.toHaveBeenCalled();
  const daemon = new GoalDaemon();
  server.getNodeHub().handleConnection(daemon as unknown as WebSocket, "air");
  daemon.emit("message", JSON.stringify({ type: "hello", version: 1, nodeId: "air", skills: [], sessions: [{ id: "original",
    provider: "codex-app", title: "既有会话", cwd: "/fixture", status: "idle", loaded: true,
    capabilities: ["read", "send"], observedAt: new Date().toISOString() }] }));
  await vi.waitFor(() => expect(server!.getNodeHub().getNodeSession("air", "original")).toBeTruthy());
  expect((await post("proposal", "在明确预算范围内持续核查")).status).toBe(200);
  expect(daemon.commands).toHaveLength(0);
  const pending = (await store.getLeaderState("chat"))!.data.pendingGoal;
  const confirmation = await post("confirm", `确认目标 ${pending.id}`);
  expect(confirmation.status).toBe(200);
  expect((await confirmation.json()).text).toContain("后台将按授权预算持续推进");
  for (let tick = 0; tick < 5; tick++) {
    await vi.advanceTimersByTimeAsync(TICK_MS);
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  await vi.waitFor(async () => expect((await store.getGoal(pending.id))?.status).toBe("completed"));
  expect(daemon.commands).toHaveLength(2);
  expect(daemon.commands[0].prompt).toContain("取得初始核查基准");
  expect(daemon.commands[1].prompt).toContain("不同的最终核查");
  expect(daemon.commands[1].prompt).toContain("精确动作1");
  expect(model.complete).toHaveBeenCalledTimes(4);
  const status = await fetch(`${base}/v1/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
  expect(status.status).toBe(200);
  const snapshot = await status.json();
  expect(snapshot.goals.items[0]).toMatchObject({ id: pending.id, status: "completed", decisionAttempts: 3,
    criteria: [{ supported: true, actions: [2] }], actions: [{ status: "completed" }, { status: "completed" }] });
  expect(JSON.stringify(snapshot.goals)).not.toContain('"lease"');
  expect(JSON.stringify(snapshot.goals)).not.toContain('"attempt"');
  expect((await post("confirm", `确认目标 ${pending.id}`)).status).toBe(200);
  await vi.advanceTimersByTimeAsync(TICK_MS);
  expect(daemon.commands).toHaveLength(2);
});
