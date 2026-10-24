import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { CommandService } from "../../src/commands/service.js";
import { NodeHub } from "../../src/nodes/hub.js";
import { MemoryStore } from "../../src/store/memory.js";
import { DeliveryModeSchema, MAX_DAEMON_CONTROL_MESSAGE_BYTES, SessionSchema,
  type ControllerCommandMessage, type Session } from "../../src/types.js";

const NODE_ID = "steer-node";
const SESSION_ID = "steer-session";
const EXPECTED_TURN_ID = "original-turn";
const TTL_SECONDS = 300;
const LARGE_DELIVERY_MODE_COUNT = 50_000;

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: Record<string, unknown>[] = [];
  send(raw: string, callback?: (error?: Error) => void) { this.sent.push(JSON.parse(raw)); callback?.(); }
  close() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
  receive(message: unknown) { this.emit("message", JSON.stringify(message)); }
  commands() { return this.sent.filter(message => message.type === "command"); }
}

const drain = () => new Promise<void>(resolve => setImmediate(resolve));
const hubs: NodeHub[] = [];
const request = { nodeId: NODE_ID, sessionId: SESSION_ID, action: "send" as const, prompt: "fixture only",
  requestId: "steer-request", deliveryMode: "steer" as const, expectedTurnId: EXPECTED_TURN_ID };
const command = (): ControllerCommandMessage => ({ ...request, type: "command", commandId: "steer-command",
  sendRoute: "control-socket", expiresAt: new Date(Date.now() + TTL_SECONDS * 1000).toISOString() });

function connect(hub: NodeHub, session: Session, deliveryModes?: string[]): Socket {
  const socket = new Socket();
  hub.handleConnection(socket as unknown as WebSocket, NODE_ID);
  socket.receive({ type: "hello", version: 1, nodeId: NODE_ID, sessions: [session], skills: [],
    ...(deliveryModes === undefined ? {} : { deliveryModes }) });
  return socket;
}

async function fixture(deliveryModes?: string[], managed = false) {
  const store = new MemoryStore(), hub = new NodeHub(store, new Map());
  hubs.push(hub);
  const observedAt = new Date().toISOString();
  const session: Session = { id: SESSION_ID, title: "Steer fixture", cwd: "/fixture", provider: "codex-app",
    status: "idle", loaded: true, capabilities: ["read", "send"], observedAt };
  if (managed) Object.assign(session, { status: "active", loaded: true, capabilities: ["read", "resume-send"] });
  const socket = connect(hub, session, deliveryModes);
  await drain();
  return { store, hub, socket, session, service: new CommandService(store, hub, TTL_SECONDS) };
}

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.closeAll();
  vi.restoreAllMocks();
});

it.each([
  { name: "one beyond supported modes", count: DeliveryModeSchema.options.length + 1 },
  { name: "large duplicate array", count: LARGE_DELIVERY_MODE_COUNT },
])("rejects $name before publishing any hello inventory", async ({ count }) => {
  const store = new MemoryStore(), hub = new NodeHub(store, new Map());
  hubs.push(hub);
  const persist = vi.spyOn(store, "upsertNodeSessions");
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const session = SessionSchema.parse({ id: SESSION_ID, observedAt: new Date().toISOString() });
  const digest = "a".repeat(64);
  const hello = { type: "hello", version: 1, nodeId: NODE_ID, sessions: [session],
    skills: [{ id: digest, digest, name: "fixture", description: "", path: "/fixture/SKILL.md" }],
    deliveryModes: Array(count).fill("next-turn") };
  expect(Buffer.byteLength(JSON.stringify(hello))).toBeLessThan(MAX_DAEMON_CONTROL_MESSAGE_BYTES);
  const publications: { session: Session | null; skills: unknown[]; connected: boolean; nextTurn: boolean }[] = [];
  const unsubscribe = hub.subscribeSessionChanges(NODE_ID, () => publications.push({
    session: hub.getNodeSession(NODE_ID, SESSION_ID), skills: hub.getNodeSkills(NODE_ID),
    connected: hub.isNodeConnected(NODE_ID), nextTurn: hub.supportsDeliveryMode(NODE_ID, "next-turn"),
  }));
  const socket = new Socket(), close = vi.spyOn(socket, "close");
  try {
    hub.handleConnection(socket as unknown as WebSocket, NODE_ID);
    socket.receive(hello);
    await drain();
    expect(close).toHaveBeenCalledExactlyOnceWith(4000, "Invalid session inventory");
    expect(publications.length).toBeGreaterThan(0);
    for (const publication of publications) {
      expect(publication).toEqual({ session: null, skills: [], connected: false, nextTurn: false });
    }
    expect(persist).not.toHaveBeenCalled();
    expect(await hub.getAllSessions()).toEqual([]);
    expect(await store.getKnownSession(NODE_ID, SESSION_ID)).toBeNull();
    expect(socket.commands()).toEqual([]);
  } finally {
    unsubscribe();
  }
});

it.each([
  { name: "missing", modes: undefined },
  { name: "empty", modes: [] },
  { name: "next-turn only", modes: ["next-turn"] },
])("rejects steer before any command reaches a legacy v1 node: $name", async ({ modes }) => {
  const f = await fixture(modes);
  expect(f.hub.isNodeConnected(NODE_ID)).toBe(true);
  expect(f.service.canDispatchSend(request, "control-socket")).toBe(false);
  await expect(f.service.submit(request, 0)).rejects.toMatchObject({ httpStatus: 409 });
  expect(await f.store.listRecentCommands()).toEqual([]);
  expect(f.socket.commands()).toEqual([]);

  const next = await f.service.submit({ ...request, deliveryMode: "next-turn", expectedTurnId: undefined }, 0);
  expect(next.status).toBe("pending");
  expect(f.socket.commands()).toHaveLength(1);
  expect(f.socket.commands()[0]).toMatchObject({ deliveryMode: "next-turn" });
});

it.each([false, true])("preserves exact steer delivery on an explicitly capable node (managed=%j)", async managed => {
  const f = await fixture(["next-turn", "steer"], managed);
  const route = managed ? "app-server-resume" : "control-socket";
  expect(f.service.canDispatchSend(request, route)).toBe(true);
  const result = await f.service.submit(request, 0);
  expect(result).toMatchObject({ status: "pending", sendRoute: route, deliveryMode: "steer", expectedTurnId: EXPECTED_TURN_ID });
  expect(f.socket.commands()).toHaveLength(1);
  expect(f.socket.commands()[0]).toMatchObject({ sendRoute: route, deliveryMode: "steer", expectedTurnId: EXPECTED_TURN_ID });
});

it.each([
  { name: "legacy", modes: undefined },
  { name: "steer-capable", modes: ["next-turn", "steer"] },
])("queues a known offline target after a $name connection and waits for a capable reconnect", async ({ modes }) => {
  const f = await fixture(modes);
  f.socket.close();
  await drain();
  expect(f.hub.supportsDeliveryMode(NODE_ID, "steer")).toBe(false);
  const capabilities = vi.spyOn(f.hub, "supportsDeliveryMode");
  expect(f.service.canDispatchSend(request, "control-socket")).toBe(false);
  const queued = await f.service.submit(request, 0);
  expect(queued).toMatchObject({ status: "queued", sendRoute: "control-socket", deliveryMode: "steer",
    expectedTurnId: EXPECTED_TURN_ID });
  expect(capabilities).not.toHaveBeenCalled();
  expect(f.socket.commands()).toEqual([]);

  const legacy = connect(f.hub, f.session);
  await drain();
  await f.service.dispatchQueued();
  expect(await f.store.getCommand(queued.commandId)).toMatchObject({ status: "queued" });
  expect(legacy.commands()).toEqual([]);
  legacy.close();
  await drain();

  const capable = connect(f.hub, f.session, ["next-turn", "steer"]);
  await drain();
  await f.service.dispatchQueued();
  await f.service.dispatchQueued();
  expect(await f.store.getCommand(queued.commandId)).toMatchObject({ status: "pending" });
  expect(capable.commands()).toHaveLength(1);
  expect(capable.commands()[0]).toMatchObject({ commandId: queued.commandId, deliveryMode: "steer", expectedTurnId: EXPECTED_TURN_ID });
});

it("does not accept a delivery-mode upgrade in a heartbeat without a new hello", async () => {
  const f = await fixture();
  f.socket.receive({ type: "heartbeat", sessions: [f.session], skills: [], deliveryModes: ["next-turn", "steer"] });
  await drain();
  await expect(f.service.submit(request, 0)).rejects.toMatchObject({ httpStatus: 409 });
  expect(f.socket.commands()).toEqual([]);
});

it("uses only the current connection's hello when a node upgrades and then downgrades", async () => {
  const f = await fixture();
  expect(await f.hub.sendCommand(command())).toMatchObject({ delivered: false });
  f.socket.close();
  await drain();
  const current = connect(f.hub, f.session, ["next-turn", "steer"]);
  await drain();
  expect(await f.hub.sendCommand(command())).toMatchObject({ delivered: true });
  expect(current.commands()).toHaveLength(1);

  current.close();
  await drain();
  const legacy = connect(f.hub, f.session);
  await drain();
  expect(f.service.canDispatchSend(request, "control-socket")).toBe(false);
  expect(await f.hub.sendCommand(command())).toMatchObject({ delivered: false, rejected: true });
  expect(legacy.commands()).toEqual([]);
  expect(current.commands()).toHaveLength(1);
  expect(f.socket.commands()).toEqual([]);
});

it("rejects at the transport boundary if a legacy node reconnects after the queue claim", async () => {
  const f = await fixture(["next-turn", "steer"]);
  let legacy!: Socket;
  const claim = f.store.claimQueuedCommand.bind(f.store);
  vi.spyOn(f.store, "claimQueuedCommand").mockImplementationOnce(async (...args) => {
    const claimed = await claim(...args);
    f.socket.close();
    await drain();
    legacy = connect(f.hub, f.session);
    await drain();
    return claimed;
  });
  const result = await f.service.submit(request, 0);
  expect(result).toMatchObject({ status: "failed", deliveryMode: "steer", expectedTurnId: EXPECTED_TURN_ID,
    error: expect.stringContaining("does not support steer") });
  expect(f.socket.commands()).toEqual([]);
  expect(legacy.commands()).toEqual([]);
});
