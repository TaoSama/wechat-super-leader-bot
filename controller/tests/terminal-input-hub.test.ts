import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { NodeHub } from "../src/hub.js";
import { MemoryStore } from "../src/store/memory.js";
import type { CommandRecord, InputReceipt } from "../src/types.js";

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: Record<string, unknown>[] = [];
  send(raw: string, callback?: (error?: Error) => void) { this.sent.push(JSON.parse(raw)); callback?.(); }
  close() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
  receive(message: unknown) { this.emit("message", JSON.stringify(message)); }
}
const sessionId = `terminal:${"a".repeat(43)}`;
const proof: InputReceipt = { kind: "terminal-input-written", sessionId,
  requestId: "e09a35c8-7290-41f0-8fc5-9701183d82a6", promptSHA256: "a".repeat(64), responseRevision: 0, observedRevision: 1 };
const command = (overrides: Partial<CommandRecord> = {}): CommandRecord => ({ commandId: "cmd", requestId: "http-request", nodeId: "node",
  sessionId, sendRoute: "terminal-pane", action: "send", status: "pending", prompt: "synthetic",
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), ...overrides });
const hello = { type: "hello", version: 1, nodeId: "node", sessions: [], skills: [] };
const result = { type: "result", commandId: "cmd", status: "input-written", output: "", inputReceipt: proof };
const acks = (ws: Socket) => ws.sent.filter(message => message.type === "result_ack");
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

describe("terminal input hub persistence boundary", () => {
  it("does not ACK a terminal status that lost to an already persisted final failure", async () => {
    const store = new MemoryStore();
    await store.createCommandIfAbsent(command({ status: "failed", error: "synthetic rejection" }));
    const hub = new NodeHub(store, new Map());
    const ws = new Socket();
    hub.handleConnection(ws as unknown as WebSocket, "node");
    try {
      ws.receive(hello);
      const mutation = vi.spyOn(store, "updateCommandStatus");
      ws.receive({ type: "result", commandId: "cmd", status: "uncertain", output: "", error: "synthetic uncertainty" });
      await vi.waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));
      await flush();
      expect(acks(ws)).toEqual([]);
      expect((await store.getCommand("cmd"))?.status).toBe("failed");
      ws.receive({ type: "result", commandId: "cmd", status: "failed", output: "", error: "synthetic rejection" });
      await vi.waitFor(() => expect(acks(ws)).toHaveLength(1));
      expect(acks(ws)[0].status).toBe("failed");
      mutation.mockRestore();
    } finally { await hub.closeAll(); }
  });
  it("ACKs only an exact persisted proof, rejects cross-node/native/read/mismatched proof and never inspects terminal receipts", async () => {
    const store = new MemoryStore();
    await store.createCommandIfAbsent(command());
    await store.createCommandIfAbsent(command({ commandId: "foreign", requestId: "foreign", nodeId: "other" }));
    await store.createCommandIfAbsent(command({ commandId: "native", requestId: "native", sessionId: "native", sendRoute: "desktop-owner" }));
    await store.createCommandIfAbsent(command({ commandId: "read", requestId: "read", action: "read", sendRoute: undefined }));
    const hub = new NodeHub(store, new Map());
    const ws = new Socket();
    hub.handleConnection(ws as unknown as WebSocket, "node");
    try {
      ws.receive(hello);
      const mutation = vi.spyOn(store, "updateCommandStatus").mockRejectedValueOnce(new Error("synthetic database loss"));
      ws.receive(result);
      await vi.waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));
      await flush();
      expect(acks(ws)).toEqual([]);
      ws.receive(result);
      await vi.waitFor(() => expect(acks(ws)).toHaveLength(1));
      expect(acks(ws)[0]).toEqual({ type: "result_ack", commandId: "cmd", status: "input-written", inputReceipt: proof });
      expect((await store.getCommand("cmd"))?.inputReceipt).toEqual(proof);
      ws.receive({ ...result, inputReceipt: { ...proof, observedRevision: 2 } });
      ws.receive({ ...result, commandId: "foreign" });
      ws.receive({ ...result, commandId: "native" });
      ws.receive({ ...result, commandId: "read" });
      ws.receive({ ...result, status: "completed", inputReceipt: undefined, turnId: "native-turn" });
      await flush();
      expect(acks(ws)).toHaveLength(1);
      expect(mutation).toHaveBeenCalledTimes(2);
      ws.receive({ ...result, inputReceipt: { ...proof } });
      await vi.waitFor(() => expect(acks(ws)).toHaveLength(2));
      ws.receive({ type: "heartbeat", sessions: [], skills: [] });
      await flush();
      expect(ws.sent.some(message => message.type === "inspect_turn" || message.type === "command")).toBe(false);
      mutation.mockRestore();
    } finally { await hub.closeAll(); }
  });

  it("rechecks socket ownership after the post-write await, ACKing replay only on the current connection", async () => {
    const store = new MemoryStore();
    await store.createCommandIfAbsent(command());
    const hub = new NodeHub(store, new Map());
    const old = new Socket();
    hub.handleConnection(old as unknown as WebSocket, "node");
    old.receive(hello);
    const get = store.getCommand.bind(store);
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    const delayed = vi.spyOn(store, "getCommand").mockImplementation(async id => {
      reads++;
      if (reads === 2) await barrier;
      return get(id);
    });
    try {
      old.receive(result);
      await vi.waitFor(() => expect(reads).toBe(2));
      old.close();
      const current = new Socket();
      hub.handleConnection(current as unknown as WebSocket, "node");
      current.receive(hello);
      release();
      await flush();
      expect(acks(old)).toEqual([]);
      expect(acks(current)).toEqual([]);
      expect((await get("cmd"))?.status).toBe("input-written");
      current.receive(result);
      await vi.waitFor(() => expect(acks(current)).toHaveLength(1));
      expect(current.sent.some(message => message.type === "inspect_turn" || message.type === "command")).toBe(false);
    } finally { release(); delayed.mockRestore(); await hub.closeAll(); }
  });
});
