import type { AddressInfo } from "node:net";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { ControllerServer } from "../../src/http/server.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { Config } from "../../src/runtime/config.js";
import { createExecution, executionRequestId, EXECUTION_CLAIM_MS } from "../../src/leader/plans/execution.js";
import { createGoal, goalRequestId, GOAL_SEND_CLAIM_MS } from "../../src/leader/goals/goal.js";
import { authorize, lease, commit } from "../fixtures/goals.js";

const ADMIN_TOKEN = "events-admin-token";
const CONSOLE_ORIGIN = "http://127.0.0.1:8790";
const bearer = { Authorization: `Bearer ${ADMIN_TOKEN}` };
let server: ControllerServer;
let store: MemoryStore;
let baseUrl: string;
let cookie: string;
let now: number;
const reads: ReadableStreamDefaultReader<Uint8Array>[] = [];

class LocalDaemon extends EventEmitter {
  readyState = WebSocket.OPEN;
  frames: Record<string, unknown>[] = [];
  send(raw: string, callback?: (error?: Error) => void) {
    this.frames.push(JSON.parse(raw)); callback?.();
  }
  close() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
  report(type: "hello" | "heartbeat", title: string) {
    this.emit("message", JSON.stringify({ type, version: 1, nodeId: "macair", skills: [],
      sessions: [{ id: "thread", provider: "codex-app", title, cwd: "/workspace", status: "idle",
        loaded: true, capabilities: ["read", "send"], observedAt: new Date(now).toISOString() }] }));
  }
}

async function eventStream(headers: Record<string, string> = { Cookie: cookie }) {
  const response = await fetch(`${baseUrl}/v1/events`, { headers });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  reads.push(reader);
  let buffered = "";
  return { response, reader, next: async () => {
    for (;;) {
      const delimiter = buffered.indexOf("\n\n");
      if (delimiter >= 0) {
        const frame = buffered.slice(0, delimiter); buffered = buffered.slice(delimiter + 2);
        if (frame.startsWith(":")) continue;
        return frame;
      }
      const chunk = await reader.read();
      if (chunk.done) return "closed";
      buffered += new TextDecoder().decode(chunk.value);
    }
  } };
}

beforeEach(async () => {
  now = Date.now();
  store = new MemoryStore();
  const config: Config = {
    port: 0, host: "127.0.0.1", controllerToken: ADMIN_TOKEN,
    nodeTokens: { macair: "events-node-token" }, tokenToNode: new Map([["events-node-token", "macair"]]),
    allowedChatIds: new Set(["plan-chat"]), persistenceMode: "memory", commandTtlSeconds: 60,
    consolePublicUrl: CONSOLE_ORIGIN,
    leader: { baseUrl: "https://private-provider.example/v1", apiKey: "private-api-key", model: "configured-model" },
  };
  server = new ControllerServer(config, store, { complete: async () => ({ content: "", toolCalls: [] }) }, () => now);
  await server.start();
  baseUrl = `http://127.0.0.1:${(server.getHttpServer().address() as AddressInfo).port}`;
  const issue = await fetch(`${baseUrl}/v1/console-links`, { method: "POST",
    headers: { ...bearer, "Content-Type": "application/json" }, body: JSON.stringify({ requestId: "events-login" }) });
  const { url } = await issue.json();
  const exchange = await fetch(`${baseUrl}/auth/exchange`, { method: "POST",
    headers: { Origin: CONSOLE_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ token: new URL(url).hash.slice("#login=".length) }) });
  cookie = exchange.headers.get("set-cookie")!.split(";")[0];
});

afterEach(async () => {
  for (const reader of reads.splice(0)) await reader.cancel();
  await server.stop();
  vi.restoreAllMocks();
});

it("rejects unauthenticated/query-token and cross-origin streams; Cookie is limited to the exact named path", async () => {
  expect((await fetch(`${baseUrl}/v1/events`)).status).toBe(401);
  expect((await fetch(`${baseUrl}/v1/events?token=${ADMIN_TOKEN}`)).status).toBe(401);
  expect((await fetch(`${baseUrl}/v1/events?token=forbidden`, { headers: bearer })).status).toBe(400);
  expect((await fetch(`${baseUrl}/v1/events/`, { headers: { Cookie: cookie } })).status).toBe(401);
  expect((await fetch(`${baseUrl}/v1/events`, { headers: { Cookie: cookie, Origin: "https://other.example" } })).status).toBe(403);
  expect((await fetch(`${baseUrl}/v1/events`, { headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
});

it("sends exactly the status DTO, only the model name, no CORS permission, and accepts read-only Bearer", async () => {
  const stream = await eventStream(bearer);
  const initial = await stream.next();
  const status = await (await fetch(`${baseUrl}/v1/status`, { headers: { Cookie: cookie } })).json();
  expect(JSON.parse(initial.split("data: ")[1])).toEqual(status);
  expect(status.leaderModel).toBe("configured-model");
  expect(initial).not.toContain("private-provider");
  expect(initial).not.toContain("private-api-key");
  expect(stream.response.headers.get("x-accel-buffering")).toBe("no");
  expect(stream.response.headers.get("cache-control")).toBe("no-store");
  expect(stream.response.headers.get("access-control-allow-origin")).toBeNull();
});

it("pushes hello/heartbeat/disconnect changes and command receipts without retransmitting commands", async () => {
  const stream = await eventStream();
  await stream.next();
  const daemon = new LocalDaemon();
  server.getNodeHub().handleConnection(daemon as unknown as WebSocket, "macair");
  daemon.report("hello", "初始标题");
  expect(await stream.next()).toContain("初始标题");
  daemon.report("heartbeat", "修改后的标题");
  expect(await stream.next()).toContain("修改后的标题");
  const sent = await fetch(`${baseUrl}/v1/sessions/macair/thread/messages`, {
    method: "POST", headers: { Cookie: cookie, Origin: CONSOLE_ORIGIN, "Content-Type": "application/json",
      "X-Super-Leader-Intent": "session-message" }, body: JSON.stringify({ prompt: "hello", requestId: "same-message" }),
  });
  const command = await sent.json();
  expect(sent.status).toBe(202);
  expect(await stream.next()).toContain(command.commandId);
  daemon.emit("message", JSON.stringify({ type: "result", commandId: command.commandId,
    status: "accepted", output: "", turnId: "turn-realtime" }));
  expect(await stream.next()).toContain('"status":"accepted"');
  expect(daemon.frames.filter(frame => frame.type === "command")).toHaveLength(1);
  daemon.close();
  const closed = await stream.next();
  expect(closed).toContain('"nodes":[]');
  expect(closed).toContain('"status":"uncertain"');
});

it("logout sends auth-expired and closes the stream immediately", async () => {
  const stream = await eventStream();
  await stream.next();
  const logout = await fetch(`${baseUrl}/auth/logout`, { method: "POST", headers: { Cookie: cookie, Origin: CONSOLE_ORIGIN } });
  expect(logout.status).toBe(200);
  expect(await stream.next()).toBe("event: auth-expired\ndata: {}");
  expect(await stream.next()).toBe("closed");
});

it("expiry is detected before the next sensitive status even after a successful initial Cookie authentication", async () => {
  const stream = await eventStream();
  await stream.next();
  now += 3601_000;
  const daemon = new LocalDaemon();
  server.getNodeHub().handleConnection(daemon as unknown as WebSocket, "macair");
  daemon.report("hello", "禁止过期泄漏");
  expect(await stream.next()).toBe("event: auth-expired\ndata: {}");
  expect(await stream.next()).toBe("closed");
});

it("Controller.stop ends open streams instead of waiting for the browser to disconnect", async () => {
  const stream = await eventStream();
  await stream.next();
  await server.stop();
  expect(await stream.next()).toBe("closed");
});

async function seedPlan(chatId = "plan-chat", id = "00000000-0000-4000-8000-000000000001") {
  const record = createExecution(chatId, { id, expiresAt: now + 600_000,
    actions: [{ nodeId: "fixture-node", sessionId: "fixture-session", prompt: "plan-visible-marker", dependsOn: [], sendRoute: "control-socket" },
      { nodeId: "another-node", sessionId: "next-session", prompt: "next task", dependsOn: [1], sendRoute: "control-socket" }] }, now);
  await store.createExecutionIfAbsent(record);
  record.revision++;
  record.attempts[0] = { token: "00000000-0000-4000-8000-000000000099", startedAt: now, expiresAt: now + EXECUTION_CLAIM_MS };
  await store.compareAndSetExecution(record, 1);
  await store.createCommandIfAbsent({ commandId: `command-${id}`, requestId: executionRequestId(record, 0),
    nodeId: "fixture-node", sessionId: "fixture-session", action: "send", prompt: "plan-visible-marker", sendRoute: "control-socket",
    status: "accepted", turnId: "plan-exact-turn", output: "private-output", error: "private-error",
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), expiresAt: new Date(now + 600_000).toISOString() });
  return record;
}

it("HTTP and Cookie/Bearer SSE expose the same allowed-only execution DTO without dispatch or authority leakage", async () => {
  const record = await seedPlan();
  await seedPlan("forbidden-chat", "00000000-0000-4000-8000-000000000002");
  const dispatch = vi.spyOn(store, "createCommandIfAbsent");
  const cas = vi.spyOn(store, "compareAndSetExecution");
  const status = await (await fetch(`${baseUrl}/v1/status`, { headers: { Cookie: cookie } })).json();
  expect(status.executions).toMatchObject({ observedAt: now, limit: 12, hasMore: false,
    items: [{ id: record.id, status: "active", steps: [{ status: "accepted", turnId: "plan-exact-turn" }, { status: "waiting", dependsOn: [1] }] }] });
  expect(status.executions.items).toHaveLength(1);
  for (const headers of [{ Cookie: cookie }, bearer]) {
    const stream = await eventStream(headers);
    const data = JSON.parse((await stream.next()).split("data: ")[1]);
    expect(data.executions).toEqual(status.executions);
  }
  for (const secret of ["plan-chat", "forbidden-chat", "attempts", "token", "requestId", "private-output", "private-error"])
    expect(JSON.stringify(status.executions)).not.toContain(secret);
  expect(dispatch).not.toHaveBeenCalled();
  expect(cas).not.toHaveBeenCalled();
  expect((await fetch(`${baseUrl}/v1/executions`, { method: "POST", headers: { Cookie: cookie } })).status).toBe(401);
});

it("malformed execution data fails HTTP explicitly and closes SSE without masquerading as an empty list", async () => {
  const record = await seedPlan();
  vi.spyOn(store, "listRecentExecutions").mockResolvedValue([{ ...record, attempts: [] }]);
  const response = await fetch(`${baseUrl}/v1/status`, { headers: { Cookie: cookie } });
  expect(response.status).toBe(503);
  const body = await response.text();
  expect(body).not.toContain("plan-visible-marker");
  expect(body).not.toContain('"executions"');
  const stream = await eventStream();
  expect(await stream.next()).toBe("closed");
});

it("execution receipt changes reuse the existing stream and expired Cookie cannot receive another plan", async () => {
  const record = await seedPlan();
  const stream = await eventStream();
  expect(await stream.next()).toContain('"turnId":"plan-exact-turn"');
  await store.updateCommandStatus(`command-${record.id}`, "completed", "private-finished-output", undefined, "plan-exact-turn");
  const daemon = new LocalDaemon();
  server.getNodeHub().handleConnection(daemon as unknown as WebSocket, "macair");
  daemon.report("hello", "receipt update");
  const updated = JSON.parse((await stream.next()).split("data: ")[1]);
  expect(updated.executions.items[0]).toMatchObject({ status: "active", steps: [{ status: "completed" }, { status: "waiting" }] });
  now += 3601_000;
  daemon.report("heartbeat", "expired marker");
  expect(await stream.next()).toBe("event: auth-expired\ndata: {}");
  expect(await stream.next()).toBe("closed");
  expect((await fetch(`${baseUrl}/v1/status`, { headers: { Cookie: cookie } })).status).toBe(401);
});

it.each(["plan", "goal"] as const)("keeps the existing SSE stream open when a %s command is queued before dispatch", async kind => {
  const stream = await eventStream();
  await stream.next();
  const id = "00000000-0000-4000-8000-000000000088";
  const commandId = `queued-${kind}-command`;
  const action = { nodeId: "queued-node", sessionId: "queued-thread", prompt: "queued task",
    dependsOn: [], sendRoute: "control-socket" as const };
  let requestId: string;
  let prompt = action.prompt;
  if (kind === "plan") {
    const record = createExecution("plan-chat", { id, expiresAt: now + 600_000, actions: [action] }, now);
    await store.createExecutionIfAbsent(record);
    record.attempts[0] = { token: "00000000-0000-4000-8000-000000000099", startedAt: now,
      expiresAt: now + EXECUTION_CLAIM_MS };
    await store.compareAndSetExecution({ ...record, revision: 2 }, 1);
    requestId = executionRequestId(record, 0);
  } else {
    const record = createGoal("plan-chat", { id, expiresAt: now + 600_000, objective: "queue fixture",
      criteria: ["exact result"], targets: [{ nodeId: action.nodeId, sessionId: action.sessionId, sendRoute: action.sendRoute }],
      constraints: "fixture only", maxActions: 1, maxDecisions: 2, durationMinutes: 10, shareResults: true }, now);
    await store.confirmGoal(record, await authorize(store, record), () => now);
    const deciding = lease(record, now);
    deciding.lease!.input.availableTargets = [1];
    expect(await store.compareAndSetGoal(deciding, record.revision, () => now)).not.toBeNull();
    const planned = commit(deciding, { type: "next", target: 1, prompt: action.prompt, sourceActions: [], reason: "queue fixture" });
    expect(await store.compareAndSetGoal(planned, deciding.revision, () => now)).not.toBeNull();
    const sending = structuredClone(planned);
    sending.revision++;
    sending.actions[0].attempt = { token: "00000000-0000-4000-8000-000000000099", startedAt: now,
      expiresAt: now + GOAL_SEND_CLAIM_MS };
    expect(await store.compareAndSetGoal(sending, planned.revision, () => now)).not.toBeNull();
    prompt = sending.actions[0].input.prompt;
    requestId = goalRequestId(sending, 0);
  }
  await store.createCommandIfAbsent({ commandId, requestId, nodeId: action.nodeId, sessionId: action.sessionId,
    action: "send", prompt, sendRoute: action.sendRoute, status: "queued", deliveryMode: "next-turn",
    authority: { type: kind, id, chatId: "plan-chat" }, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 600_000).toISOString() });
  const daemon = new LocalDaemon();
  server.getNodeHub().handleConnection(daemon as unknown as WebSocket, "macair");
  daemon.report("hello", "queued snapshot");
  const queuedFrame = await stream.next();
  expect(queuedFrame).not.toBe("closed");
  const queued = JSON.parse(queuedFrame.split("data: ")[1]);
  const projected = kind === "plan" ? queued.executions.items[0].steps : queued.goals.items[0].actions;
  expect(projected[0]).toMatchObject({ commandId, status: "queued" });
  const status = await fetch(`${baseUrl}/v1/status`, { headers: { Cookie: cookie } });
  expect(status.status).toBe(200);
  const http = await status.json();
  expect(kind === "plan" ? http.executions : http.goals).toEqual(kind === "plan" ? queued.executions : queued.goals);
  await store.claimQueuedCommand(commandId, action.sendRoute);
  await store.updateCommandStatus(commandId, "accepted", undefined, undefined, "queued-exact-turn");
  daemon.report("heartbeat", "accepted snapshot");
  const acceptedFrame = await stream.next();
  expect(acceptedFrame).not.toBe("closed");
  const accepted = JSON.parse(acceptedFrame.split("data: ")[1]);
  expect((kind === "plan" ? accepted.executions.items[0].steps : accepted.goals.items[0].actions)[0])
    .toMatchObject({ commandId, status: "accepted", turnId: "queued-exact-turn" });
});
