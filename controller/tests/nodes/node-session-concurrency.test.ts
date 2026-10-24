import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { NodeHub } from "../../src/nodes/hub.js";
import { MemoryStore } from "../../src/store/memory.js";
import { InvalidSessionInventoryError } from "../../src/store/node-sessions.js";
import type { Session } from "../../src/types.js";

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  closeCode?: number;
  send(_raw: string, callback?: (error?: Error) => void) { callback?.(); }
  close(code?: number) { this.closeCode = code; this.readyState = WebSocket.CLOSED; this.emit("close"); }
  receive(message: unknown) { this.emit("message", JSON.stringify(message)); }
}
const session = (id: string, title = id): Session => ({ id, title, provider: "codex-app", cwd: "/fixture",
  observedAt: new Date().toISOString(), loaded: true, status: "idle", capabilities: ["read", "send"] });
const hello = (nodeId: string, sessions: Session[]) => ({ type: "hello", version: 1, nodeId, sessions, skills: [] });
const heartbeat = (sessions: Session[]) => ({ type: "heartbeat", sessions, skills: [] });
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const hubs: NodeHub[] = [];
function fixture() {
  const store = new MemoryStore(), hub = new NodeHub(store, new Map()), socket = new Socket();
  hubs.push(hub);
  hub.handleConnection(socket as unknown as WebSocket, "node");
  return { store, hub, socket };
}
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.closeAll();
  vi.restoreAllMocks();
});

describe("node inventory persistence ordering", () => {
  it("serializes overlapping hello/heartbeats per node without delaying cached authority or other nodes", async () => {
    const f = fixture(), gate = barrier(), entered: string[] = [];
    const original = f.store.upsertNodeSessions.bind(f.store);
    vi.spyOn(f.store, "upsertNodeSessions").mockImplementation(async (nodeId, sessions) => {
      entered.push(`${nodeId}:${sessions[0]?.id}`);
      if (sessions[0]?.id === "initial") await gate.promise;
      await original(nodeId, sessions);
    });
    try {
      f.socket.receive(hello("node", [session("initial")]));
      await vi.waitFor(() => expect(entered).toEqual(["node:initial"]));
      f.socket.receive(heartbeat([session("middle")]));
      f.socket.receive(heartbeat([session("latest")]));
      const other = new Socket();
      f.hub.handleConnection(other as unknown as WebSocket, "other");
      other.receive(hello("other", [session("independent")]));
      await vi.waitFor(() => expect(entered).toContain("other:independent"));
      expect(entered.filter(item => item.startsWith("node:"))).toEqual(["node:initial"]);
      expect(f.hub.getNodeSession("node", "initial")).toBeNull();
      expect(f.hub.getNodeSession("node", "latest")).toBeDefined();
      gate.release();
      await vi.waitFor(async () => expect((await f.store.getKnownSession("node", "latest"))?.id).toBe("latest"));
      expect((await f.hub.getAllSessions()).filter(item => item.nodeId === "node").map(item => item.id)).toEqual(["latest"]);
      expect(entered.filter(item => item.startsWith("node:"))).toEqual(["node:initial", "node:middle", "node:latest"]);
    } finally { gate.release(); }
  });

  it("queues old disconnect cleanup before replacement hello and drops stale queued heartbeats", async () => {
    const f = fixture(), gate = barrier(), operations: string[] = [];
    const original = f.store.upsertNodeSessions.bind(f.store), remove = f.store.removeNodeSessions.bind(f.store);
    vi.spyOn(f.store, "upsertNodeSessions").mockImplementation(async (nodeId, sessions) => {
      operations.push(sessions[0]?.id ?? "empty");
      if (sessions[0]?.id === "old") await gate.promise;
      await original(nodeId, sessions);
    });
    vi.spyOn(f.store, "removeNodeSessions").mockImplementation(async nodeId => {
      operations.push("remove"); await remove(nodeId);
    });
    try {
      f.socket.receive(hello("node", [session("old")]));
      await vi.waitFor(() => expect(operations).toEqual(["old"]));
      f.socket.receive(heartbeat([session("stale")]));
      f.socket.close();
      const replacement = new Socket();
      f.hub.handleConnection(replacement as unknown as WebSocket, "node");
      replacement.receive(hello("node", [session("replacement")]));
      gate.release();
      await vi.waitFor(async () => expect((await f.store.getKnownSession("node", "replacement"))?.id).toBe("replacement"));
      expect(operations).toEqual(["old", "remove", "replacement"]);
      expect(f.hub.isNodeConnected("node")).toBe(true);
    } finally { gate.release(); }
  });

  it("shutdown waits for pending observations and preserves their offline identity", async () => {
    const f = fixture(), gate = barrier();
    const original = f.store.upsertNodeSessions.bind(f.store);
    const write = vi.spyOn(f.store, "upsertNodeSessions").mockImplementation(async (nodeId, sessions) => {
      await gate.promise; await original(nodeId, sessions);
    });
    try {
      f.socket.receive(hello("node", [session("pending")]));
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      const closing = f.hub.closeAll();
      gate.release();
      await closing;
      expect(await f.hub.getAllSessions()).toEqual([]);
      expect((await f.store.getKnownSession("node", "pending"))?.id).toBe("pending");
    } finally { gate.release(); }
  });

  it("reports a failed write and allows the following inventory to persist", async () => {
    const f = fixture();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(f.store, "upsertNodeSessions").mockRejectedValueOnce(new Error("synthetic database failure"));
    f.socket.receive(hello("node", [session("failed")]));
    f.socket.receive(heartbeat([session("recovered")]));
    await vi.waitFor(async () => expect((await f.store.getKnownSession("node", "recovered"))?.id).toBe("recovered"));
    expect(error).toHaveBeenCalledWith("[node] Error upserting node sessions on hello:", expect.any(Error));
  });

  it("shutdown drains already disconnected inventory and waits for its uncertain marking", async () => {
    const f = fixture(), writeGate = barrier(), uncertainGate = barrier();
    const original = f.store.upsertNodeSessions.bind(f.store);
    const write = vi.spyOn(f.store, "upsertNodeSessions").mockImplementation(async (nodeId, sessions) => {
      await writeGate.promise; await original(nodeId, sessions);
    });
    const marking = vi.spyOn(f.store, "markNodeActiveCommandsUncertain").mockImplementation(async () => {
      await uncertainGate.promise;
    });
    let returned = false;
    try {
      f.socket.receive(hello("node", [session("pending")]));
      await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
      f.socket.close();
      expect(f.hub.getNodeStatusList()).toEqual([]);
      const closing = f.hub.closeAll().then(() => { returned = true; });
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(returned).toBe(false);
      writeGate.release();
      await vi.waitFor(() => expect(marking).toHaveBeenCalledTimes(1));
      expect(await f.hub.getAllSessions()).toEqual([]);
      expect(returned).toBe(false);
      uncertainGate.release();
      await closing;
      expect(returned).toBe(true);
    } finally { writeGate.release(); uncertainGate.release(); }
  });

  it.each(["hello", "heartbeat"])("rejects duplicate identities in %s without choosing conflicting capabilities", async type => {
    const f = fixture();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    if (type === "heartbeat") {
      f.socket.receive(hello("node", [session("prior")]));
      await vi.waitFor(async () => expect((await f.store.getKnownSession("node", "prior"))?.id).toBe("prior"));
    }
    const duplicate = [session("same"), { ...session("same"), capabilities: [] }];
    f.socket.receive(type === "hello" ? hello("node", duplicate) : heartbeat(duplicate));
    expect(f.socket.closeCode).toBe(4000);
    expect(f.hub.isNodeConnected("node")).toBe(false);
    expect(f.hub.getNodeSession("node", "same")).toBeNull();
    expect(await f.hub.getAllSessions()).toEqual([]);
    expect(await f.store.getKnownSession("node", "same")).toBeNull();
  });

  it("rejects duplicate IDs in MemoryStore before recording conflicting identities", async () => {
    const store = new MemoryStore();
    await store.upsertNodeSessions("node", [session("prior")]);
    await expect(store.upsertNodeSessions("node", [session("same"), session("same")])).rejects.toBeInstanceOf(InvalidSessionInventoryError);
    expect((await store.getKnownSession("node", "prior"))?.id).toBe("prior");
    expect(await store.getKnownSession("node", "same")).toBeNull();
  });
});
