import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { NodeHub } from "../../src/nodes/hub.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { CommandRecord } from "../../src/types.js";

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: Record<string, unknown>[] = [];
  send(raw: string, callback?: (error?: Error) => void) { this.sent.push(JSON.parse(raw)); callback?.(); }
  close() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
  receive(message: unknown) { this.emit("message", JSON.stringify(message)); }
}

const NODE_ID = "inspection-node";
const TURN_ID = "accepted-turn";
const COMMAND_TTL_MS = 60_000;
const heartbeat = { type: "heartbeat", sessions: [], skills: [] };
const record = (id: string, nodeId = NODE_ID): CommandRecord => ({
  commandId: id, requestId: id, nodeId, sessionId: "session", action: "send", status: "pending", prompt: "fixture",
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + COMMAND_TTL_MS).toISOString(),
});

async function connect(bound = false) {
  const store = new MemoryStore();
  for (const command of [record("a"), record("b"), record("foreign", "other-node")]) {
    await store.createCommandIfAbsent(command);
  }
  if (bound) await store.updateCommandStatus("a", "accepted", undefined, undefined, TURN_ID);
  const changed = vi.fn();
  const hub = new NodeHub(store, new Map(), changed);
  const ws = new Socket();
  hub.handleConnection(ws as unknown as WebSocket, NODE_ID);
  const receive = async (message: unknown) => {
    const calls = changed.mock.calls.length;
    ws.receive(message);
    await vi.waitFor(() => expect(changed).toHaveBeenCalledTimes(calls + 1));
  };
  await receive({ type: "hello", version: 1, nodeId: NODE_ID, sessions: [], skills: [] });
  expect(ws.sent[0]).toMatchObject({ type: bound ? "inspect_turn" : "inspect_command", commandId: "a" });
  return { store, hub, ws, receive };
}

afterEach(() => { vi.restoreAllMocks(); });

it("releases an unbound inspection after persisted acceptance binds a new turn", async () => {
  const { store, hub, ws, receive } = await connect();
  try {
    await receive({ type: "result", commandId: "a", status: "accepted", turnId: TURN_ID });
    expect((await store.getCommand("a"))?.turnId).toBe(TURN_ID);
    await receive(heartbeat);
    expect(ws.sent.filter(message => message.type === "inspect_command")).toEqual([
      expect.objectContaining({ commandId: "a" }), expect.objectContaining({ commandId: "b" }),
    ]);
  } finally { await hub.closeAll(); }
});

it("releases a bound inspection only after the matching persisted turn receipt", async () => {
  const { hub, ws, receive } = await connect(true);
  try {
    await receive({ type: "result", commandId: "a", status: "uncertain", turnId: TURN_ID });
    await receive(heartbeat);
    expect(ws.sent.filter(message => message.type === "inspect_command")).toEqual([
      expect.objectContaining({ commandId: "b" }),
    ]);
  } finally { await hub.closeAll(); }
});

it.each([
  { name: "wrong bound turn", bound: true, commandId: "a", status: "completed", turnId: "wrong-turn" },
  { name: "missing bound turn", bound: true, commandId: "a", status: "uncertain", turnId: undefined },
  { name: "unaccepted completed turn", bound: false, commandId: "a", status: "completed", turnId: TURN_ID },
  { name: "different command", bound: false, commandId: "b", status: "accepted", turnId: TURN_ID },
  { name: "foreign node command", bound: false, commandId: "foreign", status: "accepted", turnId: TURN_ID },
  { name: "unknown command", bound: false, commandId: "unknown", status: "accepted", turnId: TURN_ID },
])("keeps the outstanding inspection for $name", async ({ bound, ...result }) => {
  const { hub, ws, receive } = await connect(bound);
  try {
    await receive({ ...result, type: "result" });
    await receive(heartbeat);
    expect(ws.sent.filter(message => message.type === "inspect_command" || message.type === "inspect_turn")).toHaveLength(1);
  } finally { await hub.closeAll(); }
});

it("keeps the unbound inspection after persistence fails and releases it after a durable retry", async () => {
  const { store, hub, ws, receive } = await connect();
  const result = { type: "result", commandId: "a", status: "accepted", turnId: TURN_ID };
  try {
    vi.spyOn(store, "updateCommandStatus").mockRejectedValueOnce(new Error("fixture persistence failure"));
    await receive(result);
    await receive(heartbeat);
    expect(ws.sent.filter(message => message.type === "inspect_command")).toHaveLength(1);
    expect(ws.sent.filter(message => message.type === "result_ack")).toHaveLength(0);
    await receive(result);
    await receive(heartbeat);
    expect(ws.sent.filter(message => message.type === "inspect_command")).toHaveLength(2);
  } finally { await hub.closeAll(); }
});
