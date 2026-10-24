import assert from "node:assert/strict";
import { once } from "node:events";
import { createConnection, type AddressInfo, type Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { ControllerServer } from "../../src/http/server.js";
import { MemoryStore } from "../../src/store/memory.js";

const HOST = "127.0.0.1";
const NODE_ID = "duplicate-error-node";
const NODE_TOKEN = "duplicate-error-node-token-fixture";
const ADMIN_TOKEN = "duplicate-error-admin-token-fixture";
const DUPLICATE_CLOSE_CODE = 4009;
const DEADLINE_MS = 3_000;
const POLL_MS = 10;
// A masked empty text frame with RSV1 set, without negotiated compression.
const INVALID_FRAME = Buffer.from([0xc1, 0x80, 0, 0, 0, 0]);

function readRejection(socket: Socket): Promise<number> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const cleanup = () => { socket.off("data", onData); socket.off("error", onError); socket.off("close", onClose); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error("Socket closed before duplicate rejection")); };
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const headerEnd = received.indexOf("\r\n\r\n");
      if (headerEnd === -1 || received.length < headerEnd + 8) return;
      cleanup();
      try {
        assert.match(received.subarray(0, headerEnd).toString(), /^HTTP\/1\.1 101 /);
        const closeFrame = received.subarray(headerEnd + 4);
        assert.equal(closeFrame[0], 0x88);
        resolve(closeFrame.readUInt16BE(2));
      } catch (error) { reject(error); }
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

const server = new ControllerServer({
  host: HOST, port: 0, persistenceMode: "memory", controllerToken: ADMIN_TOKEN,
  nodeTokens: { [NODE_ID]: NODE_TOKEN }, tokenToNode: new Map([[NODE_TOKEN, NODE_ID]]),
  allowedChatIds: new Set(), commandTtlSeconds: 60,
}, new MemoryStore());
let original: WebSocket | undefined;
let duplicate: Socket | undefined;

try {
  await server.start();
  const { port } = server.getHttpServer().address() as AddressInfo;
  const base = `http://${HOST}:${port}`;
  const readStatus = async () => {
    const response = await fetch(`${base}/v1/status`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` }, signal: AbortSignal.timeout(DEADLINE_MS),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const waitForTitle = async (title: string) => {
    const deadline = Date.now() + DEADLINE_MS;
    while (Date.now() < deadline) {
      const status = await readStatus();
      if (status.sessions.some((session: { title: string }) => session.title === title)) return status;
      await delay(POLL_MS);
    }
    throw new Error(`Original node did not publish ${title}`);
  };
  const session = { id: "original-session", title: "before-error", observedAt: new Date().toISOString(),
    status: "idle", loaded: true, capabilities: ["read"] };
  original = new WebSocket(`ws://${HOST}:${port}/v1/daemon`, { headers: { Authorization: `Bearer ${NODE_TOKEN}` } });
  await once(original, "open");
  original.send(JSON.stringify({ type: "hello", version: 1, nodeId: NODE_ID, sessions: [session], skills: [] }));
  await waitForTitle(session.title);

  duplicate = createConnection({ host: HOST, port });
  await once(duplicate, "connect");
  const rejection = readRejection(duplicate);
  duplicate.write([
    "GET /v1/daemon HTTP/1.1", `Host: ${HOST}:${port}`, "Upgrade: websocket", "Connection: Upgrade",
    "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: AAECAwQFBgcICQoLDA0ODw==",
    `Authorization: Bearer ${NODE_TOKEN}`, "", "",
  ].join("\r\n"));
  const duplicateCloseCode = await rejection;
  assert.equal(duplicateCloseCode, DUPLICATE_CLOSE_CODE);
  const duplicateClosed = once(duplicate, "close");
  duplicate.write(INVALID_FRAME);
  await duplicateClosed;

  const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(DEADLINE_MS) });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");
  assert.equal(original.readyState, WebSocket.OPEN);
  original.send(JSON.stringify({ type: "heartbeat", sessions: [{ ...session, title: "after-error" }], skills: [] }));
  const status = await waitForTitle("after-error");
  assert.equal(status.nodes.length, 1);
  assert.equal(status.nodes[0].nodeId, NODE_ID);
  assert.equal(status.nodes[0].connected, true);
  assert.equal(status.sessions.length, 1);
  console.log(JSON.stringify({ duplicateCloseCode, healthyHttp: health.status, nodeConnected: true, heartbeatAfterError: true }));
} finally {
  duplicate?.destroy();
  original?.terminate();
  await server.stop();
}
