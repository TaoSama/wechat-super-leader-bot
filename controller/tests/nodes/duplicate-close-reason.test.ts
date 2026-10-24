import { isUtf8 } from "node:buffer";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { NodeHub } from "../../src/nodes/hub.js";
import { MemoryStore } from "../../src/store/memory.js";

it.each([
  { label: "short identity", nodeId: "macair", displayed: "macair" },
  { label: "exact byte limit", nodeId: "中".repeat(25) + "ab", displayed: "中".repeat(25) + "ab" },
  { label: "Chinese identity", nodeId: "中".repeat(30), displayed: "中".repeat(24) + "..." },
  { label: "astral identity", nodeId: "😀".repeat(30), displayed: "😀".repeat(18) + "..." },
])("rejects a duplicate $label with a valid bounded close reason", async ({ nodeId, displayed }) => {
  const hub = new NodeHub(new MemoryStore(), new Map());
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const failures: unknown[] = [];
  const clients: WebSocket[] = [];
  server.on("connection", socket => {
    try {
      hub.handleConnection(socket, nodeId);
    } catch (error) {
      failures.push(error);
      socket.terminate();
    }
  });
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP server address");
    const url = `ws://127.0.0.1:${address.port}`;
    const original = new WebSocket(url);
    clients.push(original);
    await once(original, "open");
    original.send(JSON.stringify({ type: "hello", version: 1, nodeId, sessions: [], skills: [] }));
    await vi.waitFor(() => expect(hub.isNodeConnected(nodeId)).toBe(true));

    const duplicate = new WebSocket(url);
    clients.push(duplicate);
    const closed = once(duplicate, "close");
    const [code, reason] = await closed as [number, Buffer];
    expect(failures).toEqual([]);
    expect(code).toBe(4009);
    expect(reason.toString("utf8")).toBe(`Node identity '${displayed}' is already actively connected`);
    expect(reason.byteLength).toBeLessThanOrEqual(123);
    expect(isUtf8(reason)).toBe(true);
    expect(original.readyState).toBe(WebSocket.OPEN);
    expect(hub.isNodeConnected(nodeId)).toBe(true);
  } finally {
    await hub.closeAll();
    for (const client of clients) client.terminate();
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
