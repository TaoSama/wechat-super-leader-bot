import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControllerServer } from "../../src/http/server.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { LeaderModel } from "../../src/leader/model/contracts.js";
import { ExecutionScheduler } from "../../src/leader/plans/scheduler.js";
import { GoalScheduler } from "../../src/leader/goals/scheduler.js";

describe("direct business tools HTTP boundary", () => {
  let server: ControllerServer | undefined;
  let events: Record<string, unknown>[];
  beforeEach(() => {
    events = [];
    vi.spyOn(fs, "writeSync").mockImplementation((_fd: number, message: string | ArrayBufferView) => {
      events.push(JSON.parse(String(message)));
      return Buffer.byteLength(String(message));
    });
  });
  afterEach(async () => { if (server) await server.stop(); server = undefined; vi.restoreAllMocks(); });

  async function start(model?: LeaderModel) {
    const store = new MemoryStore();
    server = new ControllerServer({ host: "127.0.0.1", port: 0, controllerToken: "private-token",
      nodeTokens: {}, tokenToNode: new Map(), allowedChatIds: new Set(["private-chat"]),
      persistenceMode: "memory", commandTtlSeconds: 60, consolePublicUrl: "https://console.example.test" }, store, model);
    await server.start();
    const address = server.getHttpServer().address();
    if (!address || typeof address === "string") throw new Error("Missing test address");
    const origin = `http://127.0.0.1:${address.port}`;
    const post = (operation: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${origin}/v1/tools/${operation}`, {
      method: "POST", headers: { authorization: "Bearer private-token", "content-type": "application/json", ...headers }, body: JSON.stringify(body),
    });
    return { store, origin, post };
  }
  const request = { chatId: "private-chat", messageId: "private-message", text: "查看节点" };
  const call = { ...request, callId: "private-call", name: "list_nodes", arguments: {} };

  it("checks bearer, strict schema and chat allowlist before touching business state", async () => {
    const { post, store } = await start();
    const read = vi.spyOn(store, "getMessage");
    expect((await post("list", request, { authorization: "Bearer wrong" })).status).toBe(403);
    expect((await post("list", { ...request, injected: true })).status).toBe(400);
    expect((await post("call", { ...call, authorization: { intent: "invented" } })).status).toBe(400);
    expect((await post("list", { ...request, chatId: "denied" })).status).toBe(403);
    expect(read).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it("offers and executes direct queries with no model while retaining rule-mode messages", async () => {
    const executions = vi.spyOn(ExecutionScheduler.prototype, "start");
    const goals = vi.spyOn(GoalScheduler.prototype, "start");
    const { post, origin } = await start();
    const discovered = await post("list", request);
    expect(discovered.status).toBe(200);
    const { tools } = await discovered.json();
    expect(tools.some((tool: { name: string }) => tool.name === "list_nodes")).toBe(true);
    expect(tools.some((tool: { name: string }) => tool.name === "execute_goal")).toBe(false);
    const response = await post("call", call);
    expect(response.status).toBe(200);
    expect((await response.json()).result).toEqual([]);
    expect(executions).toHaveBeenCalledOnce();
    expect(goals).not.toHaveBeenCalled();
    const legacy = await fetch(`${origin}/v1/messages`, { method: "POST", headers: {
      authorization: "Bearer private-token", "content-type": "application/json",
    }, body: JSON.stringify({ ...request, messageId: "legacy-message", text: "会话列表" }) });
    expect(legacy.status).toBe(200);
    expect((await legacy.json()).text).toContain("已观测快照");
  });

  it("makes zero synchronous model calls and records only real direct spans", async () => {
    const model: LeaderModel = { complete: vi.fn(async () => { throw new Error("Model must not run"); }) };
    const { post } = await start(model);
    const parentAttemptId = randomUUID();
    expect((await post("list", request, { "x-latency-attempt": parentAttemptId })).status).toBe(200);
    expect((await post("call", call, { "x-latency-attempt": parentAttemptId })).status).toBe(200);
    expect(model.complete).not.toHaveBeenCalled();
    expect(events.find(event => event.stage === "controller.tools.list.end")).toMatchObject({ outcome: "ok", parentAttemptId });
    expect(events.find(event => event.stage === "controller.tools.call.end")).toMatchObject({ outcome: "ok", parentAttemptId });
    expect(events.filter(event => event.stage === "controller.response.finish")).toHaveLength(2);
    expect(events.some(event => String(event.stage).includes("model") || event.stage === "controller.leader.start")).toBe(false);
    expect(JSON.stringify(events)).not.toMatch(/private-/);
  });

  it("recovers exact directory and console replies under the original message ID", async () => {
    const { post, origin } = await start();
    for (const [messageId, text, name] of [["directory", "会话列表", "list_sessions"], ["console", "打开控制台", "get_console_link"], ["mixed-console", "查原会话进度并给我控制台链接", "get_console_link"]]) {
      const response = await post("call", { ...call, messageId, text, name });
      expect(response.status).toBe(200);
      const { reply } = await response.json();
      expect(reply?.text).toBeTruthy();
      if (name === "get_console_link") expect(reply.text).toContain("https://console.example.test");
      const recovered = await fetch(`${origin}/v1/messages/${messageId}/reply?chatId=private-chat`, { headers: { authorization: "Bearer private-token" } });
      expect(recovered.status).toBe(200);
      expect((await recovered.json()).text).toBe(reply.text);
    }
  });

  it("reports a conflicting replay as a finished 409", async () => {
    const { post } = await start();
    expect((await post("call", call)).status).toBe(200);
    expect((await post("call", { ...call, text: "替换原文" })).status).toBe(409);
    expect(events.filter(event => event.stage === "controller.response.finish").at(-1)).toMatchObject({ httpStatus: 409, outcome: "error" });
  });

  it("returns 400 for business schema errors and allows corrected arguments with the same call ID", async () => {
    const { post, store } = await start();
    const planCall = { ...call, name: "execute_plan", authorization: { intent: "task" }, arguments: { actions: "invalid" } };
    const invalid = await post("call", planCall);
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toBe("Invalid business tool arguments");
    expect(await store.getLeaderState(request.chatId)).toBeNull();
    const corrected = await post("call", { ...planCall, arguments: { actions: [
      { nodeId: "unavailable-node", sessionId: "unavailable-session", prompt: "检查构建" },
    ] } });
    expect(corrected.status).toBe(200);
    // Valid arguments reach the deterministic target gate; no dispatch occurs to an unknown target.
    expect((await corrected.json()).result).toMatchObject({ error: expect.stringContaining("unavailable") });
    expect(events.filter(event => event.stage === "controller.response.finish").map(event => event.httpStatus)).toEqual([400, 200]);
  });

  it("enters two independent read tools concurrently over real HTTP", async () => {
    const { post } = await start();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const hub = server!.getNodeHub();
    const sessions = vi.spyOn(hub, "getAllSessions").mockImplementation(async () => { await gate; return []; });
    const nodes = vi.spyOn(hub, "getNodeStatusList").mockReturnValue([]);
    const listing = post("call", { ...call, name: "list_sessions", callId: "list-sessions" });
    let nodeListing: Promise<Response> | undefined;
    try {
      await vi.waitFor(() => expect(sessions).toHaveBeenCalledOnce());
      nodeListing = post("call", { ...call, callId: "list-nodes" });
      // The session read is still blocked. A chat-wide lock would prevent this underlying read.
      await vi.waitFor(() => expect(nodes).toHaveBeenCalledOnce());
      release();
      const responses = await Promise.all([listing, nodeListing]);
      expect(responses.map(response => response.status)).toEqual([200, 200]);
    } finally {
      release();
      await Promise.all([listing, ...(nodeListing ? [nodeListing] : [])]);
    }
  });
});
