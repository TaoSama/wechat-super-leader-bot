import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { NodeHub } from "../../src/nodes/hub.js";
import { COMMAND_WRITE_TIMEOUT_MS, MAX_COMMAND_BUFFERED_BYTES, MAX_PENDING_COMMANDS_PER_SOCKET } from "../../src/nodes/command-transport.js";
import { CommandService } from "../../src/commands/service.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { CommandRecord, ControllerCommandMessage, Session } from "../../src/types.js";

const SESSION_ID = "transport-session";
const PRIME_CHUNK_BYTES = 64 * 1024;
const MAX_PRIME_BYTES = 64 * 1024 * 1024;
const WAIT_OPTIONS = { timeout: 5000, interval: 10 };
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

const session = (): Session => ({ id: SESSION_ID, title: "Transport fixture", provider: "codex-app", cwd: "/fixture",
  observedAt: new Date().toISOString(), loaded: true, status: "idle", capabilities: ["read", "send"] });
const command = (nodeId = "slow", expiresInMs = 300_000): ControllerCommandMessage => ({
  type: "command", commandId: "transport-command", nodeId, sessionId: SESSION_ID, action: "send",
  prompt: "fixture", sendRoute: "control-socket", expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
});

async function fixture() {
  const store = new MemoryStore();
  const hub = new NodeHub(store, new Map());
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
  const peers = new Map<string, WebSocket>();
  const clients: WebSocket[] = [];
  const errors: Error[] = [];
  server.on("connection", (ws, request) => {
    const nodeId = request.url!.slice(1);
    peers.set(nodeId, ws);
    hub.handleConnection(ws, nodeId);
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
  cleanups.push(async () => {
    for (const client of clients) client.terminate();
    await hub.closeAll();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    expect(errors).toEqual([]);
  });
  const connect = async (nodeId: string) => {
    const client = new WebSocket(`ws://127.0.0.1:${address.port}/${nodeId}`, { perMessageDeflate: false });
    client.on("error", error => errors.push(error));
    clients.push(client);
    await once(client, "open");
    client.send(JSON.stringify({ type: "hello", version: 1, nodeId, sessions: [session()], skills: [] }));
    await vi.waitFor(() => expect(hub.isNodeConnected(nodeId)).toBe(true), WAIT_OPTIONS);
    return { client, peer: peers.get(nodeId)! };
  };
  return { store, hub, connect };
}

/** Fill a real TCP connection until its queue survives an event-loop turn. */
async function stall(client: WebSocket, peer: WebSocket): Promise<number> {
  client.pause();
  const padding = Buffer.alloc(PRIME_CHUNK_BYTES);
  let primed = 0;
  while (primed < MAX_PRIME_BYTES) {
    while (peer.bufferedAmount === 0 && primed < MAX_PRIME_BYTES) {
      peer.send(padding);
      primed += padding.length;
    }
    await delay(20);
    if (peer.bufferedAmount > 0) {
      expect(peer.bufferedAmount).toBeLessThan(MAX_COMMAND_BUFFERED_BYTES / 2);
      return primed;
    }
  }
  throw new Error("Unable to create TCP backpressure within the fixture byte budget");
}

/** Hold command callbacks after establishing a live socket so deadline tests do not depend on OS buffer timing. */
function holdCommandWrites(peer: WebSocket): void {
  const send = peer.send.bind(peer);
  vi.spyOn(peer, "send").mockImplementation((data, ...args) => {
    if (typeof data === "string" && data.includes('"type":"command"')) return;
    return send(data, ...args);
  });
}

it("expires a stalled write despite live heartbeats and never retries its uncertain side effects", async () => {
  const f = await fixture(), slow = await f.connect("slow");
  await stall(slow.client, slow.peer);
  holdCommandWrites(slow.peer);
  const before = f.hub.getNodeStatusList()[0].lastHeartbeat;
  slow.client.send(JSON.stringify({ type: "heartbeat", sessions: [session()], skills: [] }));
  await vi.waitFor(() => expect(f.hub.getNodeStatusList()[0].lastHeartbeat).not.toBe(before), WAIT_OPTIONS);
  expect(f.hub.isNodeConnected("slow")).toBe(true);
  const deadlineMs = 300;
  const service = new CommandService(f.store, f.hub, deadlineMs / 1000);
  const request = { nodeId: "slow", sessionId: SESSION_ID, action: "send" as const,
    prompt: "fixture", requestId: "expired-write" };
  const started = Date.now();
  const result = await service.submit(request, 0);
  expect(result).toMatchObject({ status: "uncertain" });
  expect(Date.now() - started).toBeGreaterThanOrEqual(deadlineMs - 20);
  expect(Date.now() - started).toBeLessThan(1500);
  expect(slow.peer.readyState).not.toBe(WebSocket.OPEN);

  const replacement = await f.connect("slow");
  const writes = vi.spyOn(replacement.peer, "send");
  const restarted = new CommandService(f.store, f.hub, 300);
  expect(await restarted.submit(request, 0)).toMatchObject({ commandId: result.commandId, status: "uncertain" });
  await restarted.dispatchQueued();
  expect(writes.mock.calls.filter(([raw]) => JSON.parse(String(raw)).type === "command")).toHaveLength(0);
});

it("bounds a stalled write even when the command has a distant expiry", async () => {
  const f = await fixture(), slow = await f.connect("slow");
  await stall(slow.client, slow.peer);
  holdCommandWrites(slow.peer);
  const started = Date.now();
  expect(await f.hub.sendCommand(command())).toMatchObject({ delivered: false, error: "Command write deadline exceeded" });
  expect(Date.now() - started).toBeGreaterThanOrEqual(COMMAND_WRITE_TIMEOUT_MS - 20);
  expect(Date.now() - started).toBeLessThan(COMMAND_WRITE_TIMEOUT_MS + 1500);
}, COMMAND_WRITE_TIMEOUT_MS + 5000);

it("caps concurrent writes per socket and settles every admitted write on overflow", async () => {
  const f = await fixture(), slow = await f.connect("slow");
  await stall(slow.client, slow.peer);
  const writes = vi.spyOn(slow.peer, "send");
  const sends = Array.from({ length: MAX_PENDING_COMMANDS_PER_SOCKET + 1 }, (_, index) =>
    f.hub.sendCommand({ ...command(), commandId: `count-${index}` }));
  const results = await Promise.all(sends);
  expect(writes).toHaveBeenCalledTimes(MAX_PENDING_COMMANDS_PER_SOCKET);
  expect(results.every(result => !result.delivered)).toBe(true);
  expect(results.some(result => result.error === "Command transport backpressure limit exceeded")).toBe(true);
  expect(slow.peer.readyState).not.toBe(WebSocket.OPEN);
});

it("caps buffered UTF-8 bytes before the command count limit", async () => {
  const f = await fixture(), slow = await f.connect("slow");
  await stall(slow.client, slow.peer);
  const writes = vi.spyOn(slow.peer, "send");
  const sends = [];
  let peakBuffered = slow.peer.bufferedAmount;
  for (let index = 0; index < MAX_PENDING_COMMANDS_PER_SOCKET; index++) {
    sends.push(f.hub.sendCommand({ ...command(), commandId: `bytes-${index}`, prompt: "界".repeat(16000) }));
    peakBuffered = Math.max(peakBuffered, slow.peer.bufferedAmount);
  }
  const results = await Promise.all(sends);
  expect(writes.mock.calls.length).toBeLessThan(MAX_PENDING_COMMANDS_PER_SOCKET);
  expect(peakBuffered).toBeLessThanOrEqual(MAX_COMMAND_BUFFERED_BYTES);
  expect(results.every(result => !result.delivered)).toBe(true);
});

it("dispatches another node while one is stalled, stops promptly, and never retries uncertain delivery", async () => {
  const f = await fixture(), slow = await f.connect("slow"), healthy = await f.connect("healthy");
  await stall(slow.client, slow.peer);
  const received: ControllerCommandMessage[] = [];
  healthy.client.on("message", raw => {
    const message = JSON.parse(raw.toString());
    if (message.type === "command") received.push(message);
  });
  const now = new Date().toISOString();
  const records: CommandRecord[] = ["slow", "healthy"].map((nodeId, index) => ({
    ...command(nodeId), commandId: `cmd-${index}`, requestId: `request-${nodeId}`, status: "queued",
    createdAt: now, updatedAt: now, authority: { type: "admin" }, deliveryMode: "next-turn",
  }));
  for (const record of records) await f.store.createCommandIfAbsent(record);
  const service = new CommandService(f.store, f.hub, 300);
  let finished = false;
  const tick = service.dispatchQueued().then(() => { finished = true; });
  await vi.waitFor(() => expect(received).toHaveLength(1), WAIT_OPTIONS);
  expect(received[0].nodeId).toBe("healthy");
  expect(finished).toBe(false);
  const started = Date.now();
  await service.stop();
  await tick;
  expect(Date.now() - started).toBeLessThan(1500);
  expect(await f.store.getCommand(records[0].commandId)).toMatchObject({ status: "uncertain" });
  expect(await f.store.getCommand(records[1].commandId)).toMatchObject({ status: "pending" });

  const replacement = await f.connect("slow");
  const replacementWrites = vi.spyOn(replacement.peer, "send");
  const restarted = new CommandService(f.store, f.hub, 300);
  await restarted.dispatchQueued();
  const replay = await restarted.submit({ nodeId: "slow", sessionId: SESSION_ID, action: "send",
    prompt: records[0].prompt, requestId: records[0].requestId }, 0);
  expect(replay).toMatchObject({ commandId: records[0].commandId, status: "uncertain" });
  expect(replacementWrites.mock.calls.filter(([raw]) => JSON.parse(String(raw)).type === "command")).toHaveLength(0);
});

it("hub shutdown releases stalled sends without waiting for command deadlines", async () => {
  const f = await fixture(), slow = await f.connect("slow");
  await stall(slow.client, slow.peer);
  const sent = f.hub.sendCommand(command());
  await f.hub.closeAll();
  expect(await sent).toMatchObject({ delivered: false, error: "Command transport stopped" });
  expect(slow.peer.readyState).not.toBe(WebSocket.OPEN);
});
