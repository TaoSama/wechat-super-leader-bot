import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { ControllerServer } from "../../src/http/server.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { Config } from "../../src/runtime/config.js";
import type { Session } from "../../src/types.js";
import type { LeaderModel } from "../../src/leader/model/contracts.js";
import { ACTIVE_PLAN_LIMIT_TEXT } from "../../src/leader/plans/active.js";
import { LeaderDataSchema } from "../../src/leader/contracts.js";
import { createExecution } from "../../src/leader/plans/execution.js";
import type { ConsoleAuthService } from "../../src/console/auth.js";

const CONTROLLER_TOKEN = "authorization-admin-token";
const NODE_TOKEN = "authorization-node-token";
const CONSOLE_ORIGIN = "http://127.0.0.1:8791";
const CHAT = "allowed-chat";
const OTHER_CHAT = "other-chat";
const PLAN_INTENT = "plan-authorization";
const GOAL_INTENT = "goal-authorization";
const SESSIONS = ["thread-a", "thread-b"];

type Frame = Record<string, unknown>;
// Goal reasoning is asynchronous; creation and cancellation never wait for a model decision.
const idleModel: LeaderModel = { complete: () => new Promise(() => undefined) };

describe("Console plan and goal authorizations", () => {
  let server: ControllerServer;
  let store: MemoryStore;
  let baseUrl: string;
  let cookie: string;
  const sockets: WebSocket[] = [];

  const session = (id: string): Session => ({ id, provider: "codex-app", title: id, cwd: "/w", status: "idle",
    capabilities: ["read", "send"], observedAt: new Date().toISOString(), loaded: true });

  function headers(intent = PLAN_INTENT, overrides: Record<string, string | undefined> = {}): Record<string, string> {
    const all: Record<string, string | undefined> = { Cookie: cookie, Origin: CONSOLE_ORIGIN, "Content-Type": "application/json",
      "X-Super-Leader-Intent": intent, "Sec-Fetch-Site": "same-origin", ...overrides };
    return Object.fromEntries(Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== undefined));
  }
  const post = (path: string, body: unknown, requestHeaders = headers(path.startsWith("/v1/goals") ? GOAL_INTENT : PLAN_INTENT)) =>
    fetch(baseUrl + path, { method: "POST", headers: requestHeaders, body: JSON.stringify(body) });
  const plan = (requestId: string, prompt = "整理测试结果") => ({ requestId, steps: [
    { nodeId: "macair", sessionId: "thread-a", prompt, dependsOn: [], resultFrom: [] },
    { nodeId: "macair", sessionId: "thread-b", prompt: "根据步骤 1 修复", dependsOn: [1], resultFrom: [1] },
  ] });
  const goal = (requestId: string) => ({ requestId, objective: "让测试全部通过", criteria: ["CI 通过"],
    targets: [{ nodeId: "macair", sessionId: "thread-a" }], constraints: "", maxActions: 4, maxDecisions: 8, durationMinutes: 60 });

  async function login(chatId?: string): Promise<string> {
    const auth = (server as unknown as { consoleAuth: ConsoleAuthService }).consoleAuth;
    const link = await auth.issueLink(`login-${chatId ?? "unbound"}`, chatId);
    const exchange = await fetch(baseUrl + "/auth/exchange", { method: "POST", headers: { Origin: CONSOLE_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ token: new URL(link.url).hash.slice("#login=".length) }) });
    return exchange.headers.get("set-cookie")!.split(";")[0];
  }

  async function connect(): Promise<Frame[]> {
    const ws = new WebSocket(baseUrl.replace("http:", "ws:") + "/v1/daemon", { headers: { Authorization: `Bearer ${NODE_TOKEN}` } });
    sockets.push(ws);
    const frames: Frame[] = [];
    ws.on("message", raw => {
      const frame = JSON.parse(raw.toString()) as Frame;
      frames.push(frame);
      if (frame.type === "command") ws.send(JSON.stringify({ type: "result", commandId: frame.commandId, status: "accepted", turnId: `turn-${frames.length}` }));
    });
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "hello", version: 1, nodeId: "macair", sessions: SESSIONS.map(session), skills: [] }));
    await vi.waitFor(() => expect(server.getNodeHub().isNodeConnected("macair")).toBe(true));
    return frames;
  }

  beforeEach(async () => {
    store = new MemoryStore();
    const config: Config = { port: 0, host: "127.0.0.1", controllerToken: CONTROLLER_TOKEN,
      nodeTokens: { macair: NODE_TOKEN }, tokenToNode: new Map([[NODE_TOKEN, "macair"]]),
      allowedChatIds: new Set([CHAT, OTHER_CHAT]), persistenceMode: "memory", commandTtlSeconds: 60, consolePublicUrl: CONSOLE_ORIGIN };
    server = new ControllerServer(config, store, idleModel);
    await server.start();
    baseUrl = `http://127.0.0.1:${(server.getHttpServer().address() as AddressInfo).port}`;
    cookie = await login(CHAT);
  });

  afterEach(async () => {
    await server.stop();
    for (const ws of sockets.splice(0)) if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  });

  it.each([
    ["missing Cookie", { Cookie: undefined }],
    ["missing Origin", { Origin: undefined }],
    ["foreign Origin", { Origin: "https://foreign.example" }],
    ["missing intent", { "X-Super-Leader-Intent": undefined }],
    ["message intent", { "X-Super-Leader-Intent": "session-message" }],
    ["goal intent on a plan path", { "X-Super-Leader-Intent": GOAL_INTENT }],
    ["cross-site fetch", { "Sec-Fetch-Site": "cross-site" }],
  ])("rejects %s without creating a plan", async (_label, overrides) => {
    await connect();
    expect([401, 403]).toContain((await post("/v1/plans", plan("auth-1"), headers(PLAN_INTENT, overrides))).status);
    expect(await store.listRecentExecutions([CHAT], 5)).toEqual([]);
  });

  it("requires a console login bound to the issuing chat", async () => {
    await connect();
    cookie = await login();
    const response = await post("/v1/plans", plan("unbound-1"));
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("console_chat_unbound");
    const admin = await fetch(baseUrl + "/v1/plans", { method: "POST", body: JSON.stringify(plan("admin-1")),
      headers: { Authorization: `Bearer ${CONTROLLER_TOKEN}`, "Content-Type": "application/json" } });
    expect(admin.status).toBe(403);
    expect(await store.listRecentExecutions([CHAT], 5)).toEqual([]);
  });

  it("creates a frozen plan once per idempotency key and records the console receipt", async () => {
    const frames = await connect();
    const response = await post("/v1/plans", plan("create-1"));
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created).toMatchObject({ outcome: "created", replayed: false });
    const execution = await store.getExecution(created.id);
    expect(execution).toMatchObject({ chatId: CHAT, status: "active" });
    expect(execution!.plan.actions.map(action => [action.sessionId, action.sendRoute, action.dependsOn, action.resultFrom ?? []]))
      .toEqual([["thread-a", "control-socket", [], []], ["thread-b", "control-socket", [1], [1]]]);
    await vi.waitFor(() => expect(frames.filter(frame => frame.type === "command")).toHaveLength(1));

    const replay = await post("/v1/plans", plan("create-1"));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ outcome: "created", id: created.id, replayed: true });
    expect(await store.listRecentExecutions([CHAT], 5)).toHaveLength(1);
    expect((await post("/v1/plans", plan("create-1", "不同内容"))).status).toBe(409);

    const state = LeaderDataSchema.parse((await store.getLeaderState(CHAT))!.data);
    expect(state.inflight).toBeUndefined();
    expect(state.receipts.at(-1)).toMatchObject({ source: "console", authorizationId: created.id });
  });

  it("records a persisted plan when the request fails afterwards so a retry never recreates it", async () => {
    await connect();
    const confirm = vi.spyOn(store, "confirmExecution");
    vi.spyOn(store, "getExecution").mockRejectedValueOnce(new Error("read lost after commit"));
    expect((await post("/v1/plans", plan("lost-1"))).status).toBeGreaterThanOrEqual(500);
    expect(confirm).toHaveBeenCalledTimes(1);
    const retry = await post("/v1/plans", plan("lost-1"));
    expect(retry.status).toBe(200);
    const receipt = await retry.json();
    expect(receipt).toMatchObject({ outcome: "created", replayed: true });
    expect(await store.listRecentExecutions([CHAT], 5)).toEqual([expect.objectContaining({ id: receipt.id })]);
  });

  it("does not take over a live WeChat claim", async () => {
    await connect();
    await store.compareAndSetLeaderState(CHAT, 0, { inflight: { messageId: "wechat-1", inputHash: "h", expiresAt: Date.now() + 60_000 } });
    expect((await post("/v1/plans", plan("busy-1"))).status).toBe(409);
    expect(await store.listRecentExecutions([CHAT], 5)).toEqual([]);
  });

  it("rejects plans through the leader's dependency and eligibility validation", async () => {
    await connect();
    const forward = await post("/v1/plans", { requestId: "bad-1", steps: [
      { nodeId: "macair", sessionId: "thread-a", prompt: "x", dependsOn: [2], resultFrom: [] },
      { nodeId: "macair", sessionId: "thread-b", prompt: "y", dependsOn: [], resultFrom: [] }] });
    expect(forward.status).toBe(422);
    expect((await forward.json()).message).toMatch(/Invalid plan dependencies/);
    const unknown = await post("/v1/plans", { requestId: "bad-2", steps: [{ nodeId: "macair", sessionId: "missing", prompt: "x", dependsOn: [], resultFrom: [] }] });
    expect(unknown.status).toBe(422);
    expect((await unknown.json()).message).toMatch(/unavailable, busy or read-only/);
    expect((await post("/v1/plans", { requestId: "bad-3", steps: [{ nodeId: "macair", sessionId: "thread-a", prompt: "x", dependsOn: [], resultFrom: [], sendRoute: "control-socket" }] })).status).toBe(400);
    expect(await store.listRecentExecutions([CHAT], 5)).toEqual([]);
    expect(LeaderDataSchema.parse((await store.getLeaderState(CHAT))!.data).inflight).toBeUndefined();
  });

  it("enforces the active plan cap with the leader's Chinese error", async () => {
    await connect();
    for (const index of [1, 2, 3]) expect((await post("/v1/plans", plan(`cap-${index}`))).status).toBe(201);
    const capped = await post("/v1/plans", plan("cap-4"));
    expect(capped.status).toBe(422);
    expect((await capped.json()).message).toBe(ACTIVE_PLAN_LIMIT_TEXT);
    expect((await store.listRecentExecutions([CHAT], 5)).filter(item => item.status === "active")).toHaveLength(3);
  });

  it("cancels only this chat's plans by id", async () => {
    await connect();
    const { id } = await (await post("/v1/plans", plan("cancel-src"))).json();
    const foreign = createExecution(OTHER_CHAT, { id: "00000000-0000-4000-8000-0000000000aa", expiresAt: Date.now() + 60_000,
      actions: [{ nodeId: "macair", sessionId: "thread-b", prompt: "x", dependsOn: [], sendRoute: "control-socket" }] }, Date.now());
    await store.createExecutionIfAbsent(foreign);
    expect((await post(`/v1/plans/${foreign.id}/cancel`, { requestId: "cancel-foreign" })).status).toBe(404);
    expect((await store.getExecution(foreign.id))!.status).toBe("active");
    const cancelled = await post(`/v1/plans/${id}/cancel`, { requestId: "cancel-1" });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ outcome: "cancelled", id });
    expect((await store.getExecution(id))!.status).toBe("cancelled");
    expect((await post(`/v1/plans/${id}/cancel`, { requestId: "cancel-1" })).status).toBe(200);
    expect((await post(`/v1/plans/${id}/cancel`, { requestId: "cancel-2" })).status).toBe(404);
  });

  it("creates and cancels goals while keeping the goal and plan exclusion", async () => {
    await connect();
    const created = await post("/v1/goals", goal("goal-1"));
    expect(created.status).toBe(201);
    const { id } = await created.json();
    expect(await store.getGoal(id)).toMatchObject({ chatId: CHAT, status: "active", proposal: { maxActions: 4, maxDecisions: 8, durationMinutes: 60, shareResults: true } });
    const second = await post("/v1/goals", goal("goal-2"));
    expect(second.status).toBe(422);
    expect((await second.json()).message).toMatch(/已有未结束/);
    const blockedPlan = await post("/v1/plans", plan("goal-plan"));
    expect(blockedPlan.status).toBe(422);
    expect((await blockedPlan.json()).message).toMatch(/goal already exists/);
    expect((await post("/v1/goals", { ...goal("goal-3"), maxActions: 13 })).status).toBe(400);

    const cancelled = await post(`/v1/goals/${id}/cancel`, { requestId: "goal-cancel" });
    expect(cancelled.status).toBe(200);
    expect((await store.getGoal(id))!.status).toBe("cancelled");
    expect((await post("/v1/plans", plan("after-goal"))).status).toBe(201);
    const excluded = await post("/v1/goals", goal("goal-4"));
    expect(excluded.status).toBe(422);
    expect((await excluded.json()).message).toMatch(/固定计划/);
  });
});
