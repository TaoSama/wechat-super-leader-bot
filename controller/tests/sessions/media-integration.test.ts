import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { ControllerServer } from "../../src/http/server.js";
import { MemoryStore } from "../../src/store/memory.js";
import { SessionSchema } from "../../src/types.js";
import { MESSAGE_IMAGE_TTL_MS } from "../../src/sessions/message-images.js";
import { MEDIA_TIMEOUT_MS } from "../../src/sessions/media-contracts.js";
import type { LeaderModel, ModelReply } from "../../src/leader/model/contracts.js";
import type { Config } from "../../src/runtime/config.js";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 5]);
const ADMIN = "media-admin-fixture";
const headers = { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" };
const target = { nodeId: "media-node", sessionId: "media-session" };
const session = SessionSchema.parse({ id: target.sessionId, title: "MISTY fixture", observedAt: new Date().toISOString(), capabilities: ["read"], status: "notLoaded", loaded: false });
const planned: ModelReply = { content: null, toolCalls: [{ id: "send-images", type: "function",
  function: { name: "send_session_images", arguments: JSON.stringify(target) } }] };
function decision(sendImages: boolean): ModelReply {
  return { content: null, toolCalls: [{ id: "authorize", type: "function", function: {
    name: "classify_image_delivery", arguments: JSON.stringify({ sendImages }),
  } }] };
}
class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: Record<string, any>[] = [];
  context = randomUUID(); mediaId = randomUUID();
  corrupt = false;
  silentReads = false;
  send(raw: string, callback?: (error?: Error) => void) {
    const request = JSON.parse(raw); this.sent.push(request); callback?.();
    const common = { requestId: request.requestId, sessionId: target.sessionId, mediaContext: this.context };
    if (request.type === "list_media") this.emit("message", JSON.stringify({ ...common, type: "media_list", source: "codex-desktop", media: [{
      mediaId: this.mediaId, itemId: "original-item", turnId: "original-turn", ordinal: 0,
      totalSize: png.length, mime: "image/png", sha256: createHash("sha256").update(png).digest("hex"),
    }] }));
    if (request.type === "read_media" && !this.silentReads) this.emit("message", JSON.stringify({ ...common, type: "media_chunk", mediaId: this.mediaId,
      offset: request.offset, totalSize: png.length, mime: "image/png", sha256: createHash("sha256").update(png).digest("hex"),
      data: (this.corrupt ? Buffer.alloc(png.length) : png).toString("base64"), eof: true,
    }));
  }
  close() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
}
const servers: ControllerServer[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.stop(); });

async function fixture(allowed = true) {
  let now = Date.now(); const store = new MemoryStore();
  const replies = [planned, decision(allowed)];
  const model: LeaderModel = { complete: vi.fn(async () => {
    const reply = replies.shift(); if (!reply) throw new Error("Unexpected model continuation"); return reply;
  }) };
  const config: Config = { host: "127.0.0.1", port: 0, controllerToken: ADMIN, nodeTokens: {}, tokenToNode: new Map(),
    allowedChatIds: new Set(["chat", "other"]), persistenceMode: "memory", commandTtlSeconds: 60 };
  const server = new ControllerServer(config, store, model, () => now); servers.push(server);
  const ws = new Socket(); server.getNodeHub().handleConnection(ws as unknown as WebSocket, target.nodeId);
  ws.emit("message", JSON.stringify({ type: "hello", version: 1, nodeId: target.nodeId, sessions: [session], skills: [] }));
  await vi.waitFor(() => expect(server.getNodeHub().isNodeConnected(target.nodeId)).toBe(true));
  await server.start(); const base = `http://127.0.0.1:${(server.getHttpServer().address() as AddressInfo).port}`;
  const post = async (messageId = "message", text = "把原会话图片发到当前微信") => {
    const response = await fetch(base + "/v1/messages", { method: "POST", headers, body: JSON.stringify({ chatId: "chat", messageId, text }) });
    return { status: response.status, body: await response.json() };
  };
  return { server, store, ws, base, model, config, post, advance: (duration: number) => { now += duration; } };
}

describe("original session → message-scoped authenticated images", () => {
  it("downloads exact frozen bytes, persists references and replays without model or daemon reads", async () => {
    const f = await fixture(); const first = await f.post();
    expect(first.status).toBe(200); expect(first.body.images, JSON.stringify({ first, sent: f.ws.sent })).toHaveLength(1);
    expect(first.body.text).not.toContain("已发送");
    const image = first.body.images[0];
    const path = `/v1/messages/message/images/${image.id}?chatId=chat`;
    const response = await fetch(f.base + path, { headers });
    expect(response.status).toBe(200); expect(response.headers.get("content-type")).toContain("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    const reads = f.ws.sent.length;
    expect(await f.post()).toEqual(first); expect(f.ws.sent).toHaveLength(reads);
    expect(f.model.complete).toHaveBeenCalledTimes(2);
    expect((await f.store.getMessage("chat", "message"))?.images).toEqual(first.body.images);
    expect(f.ws.sent.some(item => item.type === "command")).toBe(false);
  });
  it("requires Bearer, exact chat/message/image binding and live allowlist", async () => {
    const f = await fixture(); const { body } = await f.post(); const image = body.images[0];
    for (const [path, extraHeaders, expected] of [
      [`/v1/messages/message/images/${image.id}?chatId=chat`, {}, 401],
      [`/v1/messages/message/images/${image.id}?chatId=chat`, { Cookie: "console=fixture" }, 401],
      [`/v1/messages/message/images/${image.id}?chatId=other`, headers, 404],
      [`/v1/messages/other-message/images/${image.id}?chatId=chat`, headers, 404],
      [`/v1/messages/message/images/${randomUUID()}?chatId=chat`, headers, 404],
      [`/v1/messages/message/images/${image.id}?chatId=chat&url=https://example.com`, headers, 400],
    ] as const) {
      const response = await fetch(f.base + path, { headers: extraHeaders });
      expect(response.status).toBe(expected); await response.arrayBuffer();
    }
    f.config.allowedChatIds.delete("chat");
    const revoked = await fetch(f.base + `/v1/messages/message/images/${image.id}?chatId=chat`, { headers });
    expect(revoked.status).toBe(403); await revoked.arrayBuffer();
  });
  it("reports expired bytes explicitly while retaining stable dedup metadata", async () => {
    const f = await fixture(); const first = await f.post(); f.advance(MESSAGE_IMAGE_TTL_MS + 1);
    const response = await fetch(f.base + `/v1/messages/message/images/${first.body.images[0].id}?chatId=chat`, { headers });
    expect(response.status).toBe(410); await response.arrayBuffer();
    expect(await f.post()).toEqual(first);
  });
  it("rejects planner-triggered image sends when the independent user classifier refuses", async () => {
    const f = await fixture(false); const reply = await f.post("query", "看一下原会话进度");
    expect(reply.status).toBe(200); expect(reply.body.images).toBeUndefined();
    expect(f.ws.sent.some(item => item.type === "list_media" || item.type === "read_media")).toBe(false);
    expect(await f.store.listRecentCommands(10)).toHaveLength(0);
  });
  it("never publishes attachment references after a failed integrity check", async () => {
    const f = await fixture(); f.ws.corrupt = true; const reply = await f.post();
    expect(reply.body.images).toBeUndefined(); expect(reply.body.text).toContain("未发送图片");
  });
  it("reports a silent media daemon as a timeout through the message HTTP entrypoint", async () => {
    const f = await fixture(); f.ws.silentReads = true;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = f.post("media-timeout");
      await vi.waitFor(() => expect(f.ws.sent.some(item => item.type === "read_media")).toBe(true), { timeout: 10000 });
      await vi.advanceTimersByTimeAsync(MEDIA_TIMEOUT_MS);
      const reply = await pending;
      expect(reply.status).toBe(200);
      expect(reply.body.images).toBeUndefined();
      expect(reply.body.text).toContain("media_timeout");
      expect(reply.body.text).not.toContain("media_cancelled");
      const read = f.ws.sent.find(item => item.type === "read_media");
      expect(f.ws.sent.filter(item => item.type === "cancel_media")).toEqual([
        expect.objectContaining({ requestId: read?.requestId }),
      ]);
      expect((await f.store.getMessage("chat", "media-timeout"))?.images).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });
});
