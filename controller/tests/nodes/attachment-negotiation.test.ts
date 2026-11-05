import { EventEmitter } from "node:events";
import { afterEach, expect, it } from "vitest";
import { WebSocket } from "ws";
import { NodeHub } from "../../src/nodes/hub.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { ControllerCommandMessage } from "../../src/types.js";

const NODE_ID = "attachment-node";
const TTL_MS = 300_000;

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: Record<string, unknown>[] = [];
  send(raw: string, callback?: (error?: Error) => void) { this.sent.push(JSON.parse(raw)); callback?.(); }
  close() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
  receive(message: unknown) { this.emit("message", JSON.stringify(message)); }
}

const hubs: NodeHub[] = [];
afterEach(async () => { for (const hub of hubs.splice(0)) await hub.closeAll(); });

const command = (): ControllerCommandMessage => ({ type: "command", commandId: "cmd_a", nodeId: NODE_ID, sessionId: "s",
  action: "send", prompt: "看图", sendRoute: "control-socket", expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
  attachments: [{ id: "6f1c2a8e-1d2b-4c3d-8e9f-0a1b2c3d4e5f", kind: "image", name: "image.png", mime: "image/png", size: 11, sha256: "a".repeat(64) }] });

async function connect(inputAttachments?: boolean) {
  const hub = new NodeHub(new MemoryStore(), new Map());
  hubs.push(hub);
  const socket = new Socket();
  hub.handleConnection(socket as unknown as WebSocket, NODE_ID);
  socket.receive({ type: "hello", version: 1, nodeId: NODE_ID, sessions: [], skills: [],
    ...(inputAttachments === undefined ? {} : { inputAttachments }) });
  await new Promise<void>(resolve => setImmediate(resolve));
  return { hub, socket };
}

it("refuses attachments for nodes that do not advertise them, because legacy daemons drop unknown fields", async () => {
  const { hub, socket } = await connect();
  expect(await hub.sendCommand(command())).toMatchObject({ delivered: false, rejected: true });
  expect(socket.sent.filter(message => message.type === "command")).toEqual([]);
});

it("forwards frozen attachment descriptors to nodes that advertise support", async () => {
  const { hub, socket } = await connect(true);
  // The transport waits for a daemon receipt; this test only inspects the outbound frame.
  void hub.sendCommand(command());
  await new Promise<void>(resolve => setImmediate(resolve));
  const sent = socket.sent.find(message => message.type === "command");
  expect(sent?.attachments).toEqual(command().attachments);
});
