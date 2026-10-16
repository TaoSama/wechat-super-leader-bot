import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import { WebSocket } from "ws";
import { NodeHub } from "../../src/nodes/hub.js";
import { MemoryStore } from "../../src/store/memory.js";
import { CommandRecord } from "../../src/types.js";

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: Record<string, unknown>[] = [];
  send(raw: string, callback?: (error?: Error) => void) { this.sent.push(JSON.parse(raw)); callback?.(); }
  close() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
  receive(message: unknown) { this.emit("message", JSON.stringify(message)); }
}

const record = (id: string, nodeId = "demoair"): CommandRecord => ({ commandId: id, requestId: id,
  nodeId, sessionId: "session", action: "send", status: "pending", prompt: "fixture",
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString() });
const hello = { type: "hello", version: 1, nodeId: "demoair", sessions: [], skills: [] };
const heartbeat = { type: "heartbeat", sessions: [], skills: [] };

describe("Turn reconciliation hub", () => {
  it("acks only persisted results, retries DB failure, rejects mismatched identity, preserves terminal output", async () => {
    const store = new MemoryStore();
    await store.createCommandIfAbsent(record("command"));
    await store.createCommandIfAbsent(record("foreign", "other"));
    const hub = new NodeHub(store, new Map());
    const ws = new Socket();
    hub.handleConnection(ws as unknown as WebSocket, "demoair");
    ws.receive(hello);
    const result = { type: "result", commandId: "command", status: "accepted", turnId: "turn", output: "accepted" };
    try {
      const failure = vi.spyOn(store, "updateCommandStatus").mockRejectedValueOnce(new Error("fixture storage failure"));
      ws.receive(result);
      await vi.waitFor(() => expect(failure).toHaveBeenCalledTimes(1));
      expect(ws.sent.filter(m => m.type === "result_ack")).toHaveLength(0);
      ws.receive(result);
      await vi.waitFor(() => expect(ws.sent.filter(m => m.type === "result_ack")).toHaveLength(1));
      expect((await store.getCommand("command"))?.turnId).toBe("turn");
      ws.receive({ ...result, turnId: "wrong", status: "completed" });
      ws.receive({ ...result, commandId: "foreign" });
      ws.receive({ ...result, status: "completed", output: "final output" });
      await vi.waitFor(async () => expect((await store.getCommand("command"))?.status).toBe("completed"));
      ws.receive(result);
      await vi.waitFor(() => expect(ws.sent.filter(m => m.type === "result_ack")).toHaveLength(3));
      expect((await store.getCommand("command"))?.output).toBe("final output");
      expect((await store.getCommand("foreign"))?.status).toBe("pending");
      failure.mockRestore();
    } finally { await hub.closeAll(); }
  });

  it("reconciles stored turns after reconnect using only inspect, bounds outstanding queries and rotates fairly", async () => {
    const store = new MemoryStore();
    for (const id of ["a", "b"]) {
      await store.createCommandIfAbsent(record(id));
      await store.updateCommandStatus(id, "accepted", "", undefined, `turn-${id}`);
    }
    await store.markNodeActiveCommandsUncertain("demoair", "restart fixture");
    const hub = new NodeHub(store, new Map());
    const ws = new Socket();
    hub.handleConnection(ws as unknown as WebSocket, "demoair");
    try {
      ws.receive(hello);
      await vi.waitFor(() => expect(ws.sent.filter(m => m.type === "inspect_turn")).toHaveLength(1));
      expect(ws.sent[0]).toMatchObject({ commandId: "a", turnId: "turn-a", sessionId: "session" });
      ws.receive(heartbeat); ws.receive(heartbeat);
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(ws.sent.filter(m => m.type === "inspect_turn")).toHaveLength(1);
      ws.receive({ type: "result", commandId: "a", turnId: "turn-a", status: "uncertain", error: "unavailable" });
      await vi.waitFor(() => expect(ws.sent.some(m => m.type === "result_ack")).toBe(true));
      ws.receive(heartbeat);
      await vi.waitFor(() => expect(ws.sent.filter(m => m.type === "inspect_turn")).toHaveLength(2));
      expect(ws.sent.filter(m => m.type === "inspect_turn")[1]).toMatchObject({ commandId: "b", turnId: "turn-b" });
      const later = Date.now() + 21000;
      const now = vi.spyOn(Date, "now").mockReturnValue(later);
      try {
        ws.receive(heartbeat); // b never replies: timeout must not starve a.
        await vi.waitFor(() => expect(ws.sent.filter(m => m.type === "inspect_turn")).toHaveLength(3));
        expect(ws.sent.filter(m => m.type === "inspect_turn")[2]).toMatchObject({ commandId: "a" });
      } finally { now.mockRestore(); }
      expect(ws.sent.some(m => m.type === "command")).toBe(false);
    } finally { await hub.closeAll(); }
  });
});
