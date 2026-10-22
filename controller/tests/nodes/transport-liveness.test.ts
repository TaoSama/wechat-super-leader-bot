import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { NodeHub } from "../../src/nodes/hub.js";
import { MemoryStore } from "../../src/store/memory.js";

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  closeCode?: number;
  send(_raw: string, callback?: (error?: Error) => void) { callback?.(); }
  close(code?: number) {
    this.closeCode = code;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }
  receive(message: unknown) { this.emit("message", JSON.stringify(message)); }
  ping() { this.emit("ping", Buffer.alloc(0)); }
}

const hello = { type: "hello", version: 1, nodeId: "node", sessions: [], skills: [] };
const watchdogMs = 45_000;
const keepaliveMs = 15_000;
const hubs: NodeHub[] = [];

function fixture() {
  const hub = new NodeHub(new MemoryStore(), new Map());
  const socket = new Socket();
  hubs.push(hub);
  hub.handleConnection(socket as unknown as WebSocket, "node");
  return { hub, socket };
}

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.closeAll();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("daemon fragmented transfer liveness", () => {
  it("keeps a validated socket alive beyond a whole result deadline, then expires a real stall", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { hub, socket } = fixture();
    socket.receive(hello);
    expect(hub.isNodeConnected("node")).toBe(true);
    const started = Date.now();
    const observed = hub.getNodeStatusList()[0].lastHeartbeat;
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(keepaliveMs);
      socket.ping();
      expect(socket.readyState).toBe(WebSocket.OPEN);
    }
    expect(Date.now() - started).toBeGreaterThan(watchdogMs);
    // Control frames are liveness only: the inventory observation stays exact.
    await vi.advanceTimersByTimeAsync(watchdogMs - 1);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(hub.getNodeStatusList()[0].lastHeartbeat).toBe(observed);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.closeCode).toBe(4008);
    expect(hub.isNodeConnected("node")).toBe(false);
  });

  it("does not let control pings replace the authenticated hello", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { hub, socket } = fixture();
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(keepaliveMs);
      socket.ping();
    }
    expect(hub.isNodeConnected("node")).toBe(false);
    await vi.advanceTimersByTimeAsync(keepaliveMs);
    expect(socket.closeCode).toBe(4008);
  });

  it("ignores pings from a replaced socket", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { hub, socket } = fixture();
    socket.receive(hello);
    socket.close();
    const replacement = new Socket();
    hub.handleConnection(replacement as unknown as WebSocket, "node");
    replacement.receive(hello);
    // Make the obsolete fixture look open to check the generation guard itself.
    socket.readyState = WebSocket.OPEN;
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(keepaliveMs);
      socket.ping();
    }
    await vi.advanceTimersByTimeAsync(keepaliveMs);
    expect(replacement.closeCode).toBe(4008);
    await vi.advanceTimersByTimeAsync(watchdogMs);
    expect(socket.closeCode).toBeUndefined();
  });
});
