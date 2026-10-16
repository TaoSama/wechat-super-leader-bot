import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { CommandService } from "../../src/commands/service.js";
import { NodeHub } from "../../src/nodes/hub.js";
import { MemoryStore } from "../../src/store/memory.js";
import { CommandRecord, DaemonResultMessageSchema, TurnIdSchema } from "../../src/types.js";

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: Record<string, unknown>[] = [];
  send(raw: string, callback?: (error?: Error) => void) { this.sent.push(JSON.parse(raw)); callback?.(); }
  close() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
  receive(message: unknown) { this.emit("message", JSON.stringify(message)); }
  acks() { return this.sent.filter(message => message.type === "result_ack"); }
}
const hubs: NodeHub[] = [];
const drain = () => new Promise<void>(resolve => setImmediate(resolve));
const command = (id: string, action: CommandRecord["action"] = "send"): CommandRecord => ({
  commandId: id, requestId: id, nodeId: "node", sessionId: "session", action,
  prompt: action === "send" ? "fixture" : undefined, status: "pending",
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 300000).toISOString(),
});
async function fixture() {
  const store = new MemoryStore();
  const hub = new NodeHub(store, new Map());
  hubs.push(hub);
  const ws = new Socket();
  hub.handleConnection(ws as unknown as WebSocket, "node");
  ws.receive({ type: "hello", version: 1, nodeId: "node", skills: [], sessions: [{
    id: "session", observedAt: new Date().toISOString(), status: "idle", loaded: true, capabilities: ["send", "read"],
  }] });
  await drain();
  return { hub, ws, store };
}
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.closeAll();
  vi.restoreAllMocks();
});

describe("turn receipt binding", () => {
  it.each([undefined, "", "recorded"])("preserves output presence through wire parsing, hub persistence and ACK: %j", async output => {
    const { ws, store } = await fixture();
    await store.createCommandIfAbsent(command("output-presence"));
    ws.receive({ type: "result", commandId: "output-presence", status: "accepted", turnId: "turn", output: "acceptance only" });
    await drain();
    const receipt = { type: "result", commandId: "output-presence", status: "completed", turnId: "turn",
      ...(output === undefined ? {} : { output }) };
    expect(DaemonResultMessageSchema.parse(receipt).output).toBe(output);
    ws.receive(receipt);
    await drain();
    expect((await store.getCommand("output-presence"))?.output).toBe(output);
    expect(ws.acks()).toHaveLength(2);
  });

  it("uses the same UTF-8, whitespace and control boundary without normalizing identifiers", () => {
    for (const invalid of ["", " ", "turn id", "turn\t", "turn\n", "turn\u0000", "turn\u007f", "turn\u0085",
      "turn\u2007", "\ud800", "turn\ufffd", "x".repeat(129), "é".repeat(65)]) {
      expect(TurnIdSchema.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
      expect(DaemonResultMessageSchema.safeParse({ type: "result", commandId: "c", status: "accepted", turnId: invalid }).success).toBe(false);
    }
    for (const valid of ["x".repeat(128), "é".repeat(64), "😀".repeat(32), "turn\ufeff"]) {
      expect(TurnIdSchema.parse(valid)).toBe(valid);
    }
    expect(DaemonResultMessageSchema.safeParse({ type: "result", commandId: "c", status: "accepted" }).success).toBe(false);
  });

  it("rejects missing or malformed send IDs without persistence, ACK or retransmission, then expires uncertain", async () => {
    const { hub, ws, store } = await fixture();
    const service = new CommandService(store, hub, 300);
    const input = { nodeId: "node", sessionId: "session", action: "send" as const, prompt: "fixture", requestId: "same-request" };
    const initial = await service.submit(input, 0);
    const update = vi.spyOn(store, "updateCommandStatus");
    for (const status of ["accepted", "completed"]) {
      for (const turnId of [undefined, "", "turn\u0000", "turn id", "\ud800", "turn\ufffd"]) {
        ws.receive({ type: "result", commandId: initial.commandId, status, turnId, output: "untrusted result" });
        await drain();
      }
    }
    expect(update).not.toHaveBeenCalled();
    expect(ws.acks()).toHaveLength(0);
    expect(await store.getCommand(initial.commandId)).toMatchObject({ status: "pending" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(initial.expiresAt) + 1);
    const repeated = await service.submit(input, 0);
    clock.mockRestore();
    expect(repeated).toMatchObject({ commandId: initial.commandId, status: "uncertain" });
    expect(ws.sent.filter(message => message.type === "command")).toHaveLength(1);
  });

  it("requires accepted before completion and exact bindings even for late terminal receipts", async () => {
    const { ws, store } = await fixture();
    await store.createCommandIfAbsent(command("send"));
    const emit = async (status: string, turnId?: string, output = status) => {
      ws.receive({ type: "result", commandId: "send", status, turnId, output });
      await drain();
    };
    await emit("completed", "turn");
    expect(ws.acks()).toHaveLength(0);
    expect((await store.getCommand("send"))?.status).toBe("pending");
    await emit("accepted", "turn");
    await emit("completed", "wrong");
    await emit("completed");
    expect(ws.acks()).toHaveLength(1);
    expect((await store.getCommand("send"))?.status).toBe("accepted");
    await emit("completed", "turn", "final output");
    await emit("completed", "turn", "duplicate cannot replace output");
    await emit("accepted", "turn", "late cannot regress output");
    await emit("failed", "wrong");
    await emit("accepted", "wrong");
    expect(ws.acks()).toHaveLength(4);
    expect(await store.getCommand("send")).toMatchObject({ status: "completed", turnId: "turn", output: "final output" });
  });

  it("allows unbound preflight failures and uncertain, allows read completion, rejects read accepted/turn bindings", async () => {
    const { ws, store } = await fixture();
    for (const id of ["failed", "uncertain", "read"]) await store.createCommandIfAbsent(command(id, id === "read" ? "read" : "send"));
    for (const [commandId, status] of [["failed", "failed"], ["uncertain", "uncertain"]]) {
      ws.receive({ type: "result", commandId, status });
    }
    ws.receive({ type: "result", commandId: "read", status: "accepted", turnId: "turn" });
    ws.receive({ type: "result", commandId: "read", status: "completed", turnId: "turn" });
    await drain();
    expect(ws.acks()).toHaveLength(2);
    expect((await store.getCommand("read"))?.status).toBe("pending");
    ws.receive({ type: "result", commandId: "read", status: "completed", output: "read output" });
    await drain();
    expect(ws.acks()).toHaveLength(3);
    expect(await store.getCommand("read")).toMatchObject({ status: "completed", output: "read output" });
    expect((await store.getCommand("failed"))?.status).toBe("failed");
    expect((await store.getCommand("uncertain"))?.status).toBe("uncertain");
  });

  it("keeps an accepted binding through ID-less uncertainty and disconnect without inventing a successful receipt", async () => {
    const { ws, store } = await fixture();
    await store.createCommandIfAbsent(command("send"));
    ws.receive({ type: "result", commandId: "send", status: "accepted", turnId: "turn" });
    await drain();
    ws.receive({ type: "result", commandId: "send", status: "uncertain", error: "native output unavailable" });
    await drain();
    expect(await store.getCommand("send")).toMatchObject({ status: "uncertain", turnId: "turn" });
    expect(ws.acks()).toHaveLength(2);
    expect(await store.listInspectableCommands("node")).toHaveLength(1);
    await store.createCommandIfAbsent(command("unbound"));
    ws.receive({ type: "result", commandId: "unbound", status: "completed", output: "invalid success" });
    await drain();
    ws.close();
    await drain();
    expect((await store.getCommand("unbound"))?.status).toBe("uncertain");
    expect(ws.acks()).toHaveLength(2);
  });
});
