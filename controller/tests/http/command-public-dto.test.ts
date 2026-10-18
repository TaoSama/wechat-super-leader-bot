import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { ControllerServer } from "../../src/http/server.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { Config } from "../../src/runtime/config.js";
import type { CommandRecord } from "../../src/types.js";

const ADMIN_TOKEN = "public-dto-admin";
const CONSOLE_ORIGIN = "http://127.0.0.1:8790";
const OUTPUT_PREVIEW_POINTS = 512;
const LARGE_OUTPUT_BYTES = 8 * 1024 * 1024;
const STATUS_LIMIT_BYTES = 2 * 1024 * 1024;
const COMMAND_COUNT = 50;
const MESSAGE_PATH = "/v1/sessions/macair/thread/messages";
const bearer = { Authorization: `Bearer ${ADMIN_TOKEN}` };
let server: ControllerServer;
let store: MemoryStore;
let baseUrl: string;
let cookie: string;
let now: number;
const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];

class BusyDaemon extends EventEmitter {
  readyState = WebSocket.OPEN;
  send(_raw: string, callback?: (error?: Error) => void) { callback?.(); }
  close() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
}

function command(id: string, overrides: Partial<CommandRecord> = {}): CommandRecord {
  return {
    commandId: id, requestId: `request-${id}`, nodeId: "macair", sessionId: "thread",
    action: "send", prompt: "public prompt", sendRoute: "control-socket", status: "completed",
    authority: { type: "chat", chatId: "private-chat-authority" },
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(), ...overrides,
  };
}

function expectPublic(record: Record<string, unknown>) {
  expect(record).not.toHaveProperty("authority");
  expect(record).not.toHaveProperty("queueOrder");
}

async function initialEvent() {
  const response = await fetch(`${baseUrl}/v1/events`, { headers: bearer });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  readers.push(reader);
  let buffered = "";
  const decoder = new TextDecoder();
  for (;;) {
    const delimiter = buffered.indexOf("\n\n");
    if (delimiter >= 0) {
      const frame = buffered.slice(0, delimiter);
      buffered = buffered.slice(delimiter + 2);
      const data = frame.split("\n").find(line => line.startsWith("data: "));
      if (data) return { raw: frame, data: JSON.parse(data.slice("data: ".length)) };
      continue;
    }
    const chunk = await reader.read();
    if (chunk.done) throw new Error("Status stream closed before its initial snapshot");
    buffered += decoder.decode(chunk.value, { stream: true });
  }
}

beforeEach(async () => {
  now = Date.now();
  store = new MemoryStore();
  const config: Config = {
    port: 0, host: "127.0.0.1", controllerToken: ADMIN_TOKEN,
    nodeTokens: { macair: "public-dto-node" }, tokenToNode: new Map([["public-dto-node", "macair"]]),
    allowedChatIds: new Set(["allowed-chat"]), persistenceMode: "memory", commandTtlSeconds: 60,
    consolePublicUrl: CONSOLE_ORIGIN,
  };
  server = new ControllerServer(config, store, undefined, () => now);
  await server.start();
  baseUrl = `http://127.0.0.1:${(server.getHttpServer().address() as AddressInfo).port}`;
  const issue = await fetch(`${baseUrl}/v1/console-links`, {
    method: "POST", headers: { ...bearer, "Content-Type": "application/json" },
    body: JSON.stringify({ requestId: "public-dto-login" }),
  });
  expect(issue.status).toBe(200);
  const { url } = await issue.json();
  const exchange = await fetch(`${baseUrl}/auth/exchange`, {
    method: "POST", headers: { Origin: CONSOLE_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ token: new URL(url).hash.slice("#login=".length) }),
  });
  expect(exchange.status).toBe(200);
  cookie = exchange.headers.get("set-cookie")!.split(";")[0];
});

afterEach(async () => {
  for (const reader of readers.splice(0)) await reader.cancel();
  await server.stop();
  vi.restoreAllMocks();
});

it("status and SSE expose Unicode-safe summaries with explicit empty-output presence", async () => {
  const unicodeOutput = "😀".repeat(OUTPUT_PREVIEW_POINTS - 1) + "尾😺suffix";
  await store.createCommandIfAbsent(command("missing-output"));
  await store.createCommandIfAbsent(command("empty-output", { output: "" }));
  await store.createCommandIfAbsent(command("exact-preview", { output: "😀".repeat(OUTPUT_PREVIEW_POINTS) }));
  await store.createCommandIfAbsent(command("long-output", { output: unicodeOutput, turnId: "turn-public" }));

  const response = await fetch(`${baseUrl}/v1/status`, { headers: bearer });
  expect(response.status).toBe(200);
  const status = await response.json();
  const byId = new Map<string, Record<string, unknown>>(status.commands.map((item: Record<string, unknown>) => [item.commandId, item]));
  expect(byId.get("missing-output")).toMatchObject({ hasOutput: false, outputTruncated: false });
  expect(byId.get("empty-output")).toMatchObject({ hasOutput: true, outputPreview: "", outputTruncated: false });
  expect(byId.get("exact-preview")).toMatchObject({ hasOutput: true, outputPreview: "😀".repeat(OUTPUT_PREVIEW_POINTS), outputTruncated: false });
  expect(byId.get("long-output")).toMatchObject({
    hasOutput: true, outputPreview: "😀".repeat(OUTPUT_PREVIEW_POINTS - 1) + "尾",
    outputTruncated: true, turnId: "turn-public", prompt: "public prompt",
  });
  for (const summary of byId.values()) {
    expectPublic(summary);
    expect(summary).not.toHaveProperty("output");
    if (typeof summary.outputPreview === "string") expect(Array.from(summary.outputPreview).length).toBeLessThanOrEqual(OUTPUT_PREVIEW_POINTS);
  }
  const event = await initialEvent();
  expect(event.data.commands).toEqual(status.commands);
  expect(event.raw).not.toContain("private-chat-authority");
});

it("bounds HTTP and SSE snapshots with fifty real 8 MiB stored outputs without loading full records", async () => {
  const output = "x".repeat(LARGE_OUTPUT_BYTES);
  const { command: stored } = await store.createCommandIfAbsent(command("large-0", { output }));
  expect(stored.output).toHaveLength(LARGE_OUTPUT_BYTES);
  // Share the immutable string in MemoryStore's real map to avoid allocating 400 MiB just to seed fixtures.
  const records = (store as unknown as { commands: Map<string, CommandRecord> }).commands;
  for (let index = 1; index < COMMAND_COUNT; index++) {
    const id = `large-${index}`;
    records.set(id, { ...stored, commandId: id, requestId: `request-${id}`, output });
  }
  const fullRead = vi.spyOn(store, "listRecentCommands").mockRejectedValue(new Error("Status must read bounded summaries"));
  const response = await fetch(`${baseUrl}/v1/status`, { headers: bearer });
  expect(response.status).toBe(200);
  const raw = await response.text();
  expect(Buffer.byteLength(raw)).toBeLessThan(STATUS_LIMIT_BYTES);
  const status = JSON.parse(raw);
  expect(status.commands).toHaveLength(COMMAND_COUNT);
  for (const summary of status.commands) {
    expectPublic(summary);
    expect(summary).not.toHaveProperty("output");
    expect(summary).toMatchObject({ hasOutput: true, outputPreview: "x".repeat(OUTPUT_PREVIEW_POINTS), outputTruncated: true });
  }
  const event = await initialEvent();
  expect(Buffer.byteLength(event.raw)).toBeLessThan(STATUS_LIMIT_BYTES);
  expect(event.data.commands).toEqual(status.commands);
  expect(fullRead).not.toHaveBeenCalled();
});

it("returns complete output in command detail while excluding internal authority and queue order", async () => {
  const output = "😀完整\n" + "x".repeat(LARGE_OUTPUT_BYTES);
  const { command: stored } = await store.createCommandIfAbsent(command("detail", { output }));
  expect(stored).toHaveProperty("authority");
  expect(stored).toHaveProperty("queueOrder");
  const response = await fetch(`${baseUrl}/v1/commands/detail`, { headers: bearer });
  expect(response.status).toBe(200);
  const detail = await response.json();
  expectPublic(detail);
  expect(detail.output).toBe(output);
  expect(detail.commandId).toBe(stored.commandId);
  expect((await store.getCommand(stored.commandId))?.authority).toEqual(stored.authority);
});

it("admin cancellation exposes a public command while retaining its stored authority", async () => {
  const { command: stored } = await store.createCommandIfAbsent(command("admin-cancel", { status: "queued", deliveryMode: "next-turn" }));
  const response = await fetch(`${baseUrl}/v1/commands/${stored.commandId}/cancel`, { method: "POST", headers: bearer });
  expect(response.status).toBe(200);
  const cancelled = await response.json();
  expectPublic(cancelled);
  expect(cancelled).toMatchObject({ commandId: stored.commandId, status: "cancelled" });
  expect((await store.getCommand(stored.commandId))?.authority).toEqual(stored.authority);
});

it("console submission, request lookup and cancellation all return public commands", async () => {
  const daemon = new BusyDaemon();
  server.getNodeHub().handleConnection(daemon as unknown as WebSocket, "macair");
  daemon.emit("message", JSON.stringify({ type: "hello", version: 1, nodeId: "macair", skills: [], sessions: [{
    id: "thread", provider: "codex-app", title: "Busy thread", cwd: "/workspace", status: "busy", loaded: true,
    capabilities: ["read", "send"], observedAt: new Date(now).toISOString(),
  }] }));
  await vi.waitFor(async () => expect(await store.getNodeSessions("macair")).toHaveLength(1));
  const headers = { Cookie: cookie, Origin: CONSOLE_ORIGIN, "Content-Type": "application/json", "X-Super-Leader-Intent": "session-message" };
  const submitted = await fetch(baseUrl + MESSAGE_PATH, {
    method: "POST", headers, body: JSON.stringify({ prompt: "queued public message", requestId: "public-console-request" }),
  });
  expect(submitted.status).toBe(202);
  const queued = await submitted.json();
  expectPublic(queued);
  expect(queued.status).toBe("queued");
  const internal = await store.getCommand(queued.commandId);
  expect(internal?.authority).toMatchObject({ type: "console" });
  const recovered = await fetch(baseUrl + MESSAGE_PATH + "/public-console-request", { headers: { Cookie: cookie } });
  expect(recovered.status).toBe(200);
  const lookup = await recovered.json();
  expectPublic(lookup);
  expect(lookup).toEqual(queued);
  const cancelled = await fetch(baseUrl + MESSAGE_PATH, {
    method: "POST", headers, body: JSON.stringify({ cancelCommandId: queued.commandId }),
  });
  expect(cancelled.status).toBe(200);
  const result = await cancelled.json();
  expectPublic(result);
  expect(result).toMatchObject({ commandId: queued.commandId, status: "cancelled" });
  expect((await store.getCommand(queued.commandId))?.authority).toEqual(internal?.authority);
});
