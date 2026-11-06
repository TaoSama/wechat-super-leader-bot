import { EventEmitter } from "node:events";
import { afterEach, vi } from "vitest";
import { WebSocket } from "ws";
import { NodeHub } from "../../src/nodes/hub.js";
import { MemoryStore } from "../../src/store/memory.js";

export class LifecycleSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  closeCalls: { code?: number; reason?: string }[] = [];
  constructor(private readonly closeImmediately = true) { super(); }
  send(_raw: string, callback?: (error?: Error) => void) { callback?.(); }
  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason });
    this.readyState = WebSocket.CLOSING;
    if (this.closeImmediately) this.finishClose(code);
  }
  finishClose(code = 1000, reason = "") {
    this.readyState = WebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason));
  }
  terminate() { this.finishClose(1006); }
  receive(message: unknown) { this.emit("message", JSON.stringify(message)); }
  ping() { this.emit("ping", Buffer.alloc(0)); }
}

export const session = (id: string) => ({ id, title: id, provider: "codex-app", cwd: "/fixture",
  observedAt: new Date().toISOString(), loaded: true, status: "idle", capabilities: ["read", "send"] });
export const hello = (nodeId = "node", sessions = [session("session")]) => ({
  type: "hello", version: 1, nodeId, sessions, skills: [],
});
export const heartbeat = { type: "heartbeat", sessions: [], skills: [] };
export function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

const hubs: NodeHub[] = [];
export function createHub(store = new MemoryStore()) {
  const hub = new NodeHub(store, new Map());
  hubs.push(hub);
  return { hub, store };
}
export function connect(hub: NodeHub, nodeId = "node", closeImmediately = true) {
  const socket = new LifecycleSocket(closeImmediately);
  hub.handleConnection(socket as unknown as WebSocket, nodeId);
  return socket;
}
export function captureLifecycle() {
  const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const events = () => output.mock.calls.flatMap(([raw]) =>
    typeof raw === "string" && raw.startsWith("{") ? [JSON.parse(raw) as Record<string, unknown>] : []);
  return { events, errors };
}

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.closeAll();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});
