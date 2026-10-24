import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { ControllerServer } from "../../src/http/server.js";
import type { Config } from "../../src/runtime/config.js";
import { MemoryStore } from "../../src/store/memory.js";

const NODE_ID = "shutdown-node";
const NODE_TOKEN = "shutdown-node-token";
const config: Config = {
  port: 0,
  host: "127.0.0.1",
  controllerToken: "shutdown-controller-token",
  nodeTokens: { [NODE_ID]: NODE_TOKEN },
  tokenToNode: new Map([[NODE_TOKEN, NODE_ID]]),
  allowedChatIds: new Set(),
  persistenceMode: "memory",
  commandTtlSeconds: 60,
};

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function hello(sessionId: string) {
  return JSON.stringify({ type: "hello", version: 1, nodeId: NODE_ID, sessions: [{
    id: sessionId, provider: "codex-app", title: sessionId, cwd: "/fixture",
    status: "idle", capabilities: ["read"], observedAt: new Date().toISOString(),
  }], skills: [] });
}

it.each(["server", "hub"] as const)("rejects reconnects while %s shutdown waits for inventory cleanup", async target => {
  const store = new MemoryStore();
  const server = new ControllerServer(config, store);
  const hub = server.getNodeHub();
  const cleanupEntered = barrier(), cleanupGate = barrier();
  const originalRemove = store.removeNodeSessions.bind(store);
  const remove = vi.spyOn(store, "removeNodeSessions").mockImplementation(async nodeId => {
    cleanupEntered.release();
    await cleanupGate.promise;
    await originalRemove(nodeId);
  });
  const upsert = vi.spyOn(store, "upsertNodeSessions");
  const closeStore = vi.spyOn(store, "close");
  const sockets: WebSocket[] = [];
  let closing: Promise<void> | undefined;
  await server.start();
  const address = server.getHttpServer().address() as AddressInfo;
  const endpoint = `ws://127.0.0.1:${address.port}/v1/daemon`;
  const connect = () => {
    const socket = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${NODE_TOKEN}` } });
    sockets.push(socket);
    return socket;
  };

  const reconnect = async () => {
    const socket = connect();
    const errors: Error[] = [];
    socket.on("error", error => errors.push(error));
    const opened = vi.fn(() => socket.send(hello("replacement")));
    socket.on("open", opened);
    const closed = new Promise<{ code: number; reason: string }>(resolve => {
      socket.on("close", (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    await vi.waitFor(() => expect(socket.readyState).toBe(WebSocket.CLOSED));
    const result = await closed;
    if (target === "server") {
      expect(opened).not.toHaveBeenCalled();
      expect(errors.map(error => error.message)).toEqual(["Unexpected server response: 503"]);
    } else {
      expect(opened).toHaveBeenCalledOnce();
      expect(errors).toEqual([]);
      expect(result).toEqual({ code: 1001, reason: "Server shutting down" });
    }
    expect(hub.getNodeStatusList()).toEqual([]);
    expect(upsert).toHaveBeenCalledTimes(1);
  };

  try {
    const initial = connect();
    await new Promise<void>((resolve, reject) => {
      initial.once("open", resolve);
      initial.once("error", reject);
    });
    initial.send(hello("initial"));
    await vi.waitFor(async () => {
      expect(hub.isNodeConnected(NODE_ID)).toBe(true);
      expect((await store.getKnownSession(NODE_ID, "initial"))?.id).toBe("initial");
    });

    closing = target === "server" ? server.stop() : hub.closeAll();
    await cleanupEntered.promise;
    await vi.waitFor(() => expect(initial.readyState).toBe(WebSocket.CLOSED));
    expect(closeStore).not.toHaveBeenCalled();
    await reconnect();

    cleanupGate.release();
    await closing;
    expect(remove).toHaveBeenCalledOnce();
    expect(await hub.getAllSessions()).toEqual([]);
    expect((await store.getKnownSession(NODE_ID, "initial"))?.id).toBe("initial");
    if (target === "server") {
      expect(server.getHttpServer().listening).toBe(false);
      expect(closeStore).toHaveBeenCalledOnce();
    } else {
      await reconnect();
    }
  } finally {
    cleanupGate.release();
    for (const socket of sockets) {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    }
    await closing;
    if (target === "hub" || !closing) await server.stop();
    vi.restoreAllMocks();
  }
});
