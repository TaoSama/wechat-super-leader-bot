import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_REFERENCE_WINDOW_MS, INBOUND_ATTACHMENT_TTL_MS, MAX_INBOUND_IMAGE_BYTES, MemoryInboundAttachments,
  newInboundAttachment, recentAttachmentContext, resolveAttachmentIds,
} from "../../src/sessions/inbound-attachments.js";
import { createAttachmentUploadRouter, createDaemonAttachmentRouter } from "../../src/sessions/attachment-routes.js";
import { sameCommandPayload } from "../../src/commands/queue.js";
import type { CommandRecord } from "../../src/types.js";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const upload = (chatId: string, now: number, ordinal = 0, data = png) => newInboundAttachment({ chatId, messageId: "m1", ordinal,
  kind: "image", name: "image.png", mime: "image/png", sha256: sha(data), data }, now);

async function serve(app: express.Express) {
  const server = app.listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

describe("inbound attachment storage", () => {
  it("is idempotent per message slot, refuses changed bytes and scopes reads to the chat", async () => {
    const store = new MemoryInboundAttachments(() => 1000);
    const first = await store.recordInboundAttachment(upload("chat-a", 1000));
    expect(await store.recordInboundAttachment(upload("chat-a", 1000))).toEqual(first);
    const changed = Buffer.concat([png, Buffer.from([9])]);
    await expect(store.recordInboundAttachment(upload("chat-a", 1000, 0, changed))).rejects.toMatchObject({ code: "attachment_conflict" });
    expect(await store.getInboundAttachment("chat-b", first.id, 1000)).toBeNull();
    expect((await store.getInboundAttachment("chat-a", first.id, 1000))?.data).toEqual(png);
    expect(await store.getInboundAttachment("chat-a", first.id, 1000 + INBOUND_ATTACHMENT_TTL_MS)).toBeNull();
  });

  it("refuses an image whose bytes do not match the declared format or hash", () => {
    expect(() => newInboundAttachment({ chatId: "c", messageId: "m", ordinal: 0, kind: "image", name: "image.png",
      mime: "image/jpeg", sha256: sha(png), data: png }, 1)).toThrow();
    expect(() => newInboundAttachment({ chatId: "c", messageId: "m", ordinal: 0, kind: "file", name: "a.txt",
      mime: "text/plain", sha256: "0".repeat(64), data: png }, 1)).toThrow();
    expect(() => newInboundAttachment({ chatId: "c", messageId: "m", ordinal: 0, kind: "file", name: "../a.txt",
      mime: "text/plain", sha256: sha(png), data: png }, 1)).toThrow();
  });

  it("resolves only this chat's attachments inside the reference window", async () => {
    const now = 10 * ATTACHMENT_REFERENCE_WINDOW_MS;
    const store = new MemoryInboundAttachments(() => now);
    const own = await store.recordInboundAttachment(upload("chat-a", now));
    const other = await store.recordInboundAttachment(upload("chat-b", now));
    const stale = await store.recordInboundAttachment(upload("chat-a", now - ATTACHMENT_REFERENCE_WINDOW_MS - 1, 1));
    expect(await resolveAttachmentIds(store, "chat-a", [own.id], now)).toEqual([own]);
    await expect(resolveAttachmentIds(store, "chat-a", [other.id], now)).rejects.toMatchObject({ code: "attachment_unavailable" });
    await expect(resolveAttachmentIds(store, "chat-a", [stale.id], now)).rejects.toMatchObject({ code: "attachment_unavailable" });
    await expect(resolveAttachmentIds(store, "chat-a", [own.id, own.id], now)).rejects.toMatchObject({ code: "attachment_invalid" });
    const context = await recentAttachmentContext(store, "chat-a", now);
    expect(context.map(item => item.id)).toEqual([own.id]);
    expect(context[0]).not.toHaveProperty("sha256");
  });

  it("binds attachments into the durable command identity", () => {
    const ref = { id: "6f1c2a8e-1d2b-4c3d-8e9f-0a1b2c3d4e5f", kind: "image" as const, name: "image.png", mime: "image/png", size: 11, sha256: sha(png) };
    const base = { nodeId: "n", sessionId: "s", action: "send" as const, prompt: "看图", requestId: "r" };
    const record = { ...base, commandId: "c", status: "pending", attachments: [ref], expiresAt: "", createdAt: "", updatedAt: "" } as CommandRecord;
    expect(sameCommandPayload(record, { ...base, attachments: [ref] })).toBe(true);
    expect(sameCommandPayload(record, base)).toBe(false);
  });
});

describe("attachment routes", () => {
  it("accepts Gateway uploads only for allowed chats and within the image cap", async () => {
    const store = new MemoryInboundAttachments();
    const app = express();
    app.use(createAttachmentUploadRouter(store, () => new Set(["chat-a"])));
    const { base, close } = await serve(app);
    try {
      const post = (chatId: string, body: Buffer) => fetch(`${base}/inbound-attachments?${new URLSearchParams({ chatId, messageId: "m1",
        ordinal: "0", kind: "image", name: "image.png", mime: "image/png", sha256: sha(body) })}`, {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(body) });
      expect((await post("chat-b", png)).status).toBe(403);
      expect((await post("chat-a", Buffer.alloc(MAX_INBOUND_IMAGE_BYTES + 1, 1))).status).toBe(413);
      const ok = await post("chat-a", png);
      expect(ok.status).toBe(200);
      const { attachment } = await ok.json() as { attachment: { id: string; sha256: string } };
      expect(attachment.sha256).toBe(sha(png));
      expect(await store.getInboundAttachment("chat-a", attachment.id, Date.now())).not.toBeNull();
    } finally { await close(); }
  });

  it("serves bytes only to the node of an in-flight command frozen with that attachment", async () => {
    const now = Date.now();
    const store = new MemoryInboundAttachments(() => now);
    const ref = await store.recordInboundAttachment(upload("chat-a", now));
    const foreign = await store.recordInboundAttachment(upload("chat-b", now));
    const command = (overrides: Partial<CommandRecord>): CommandRecord => ({ commandId: "cmd_1", requestId: "r", nodeId: "node-a",
      sessionId: "s", action: "send", prompt: "看图", status: "pending", attachments: [ref], authority: { type: "chat", chatId: "chat-a" },
      expiresAt: new Date(now + 60_000).toISOString(), createdAt: "", updatedAt: "", ...overrides } as CommandRecord);
    const commands = new Map<string, CommandRecord>([
      ["cmd_1", command({})],
      ["cmd_done", command({ commandId: "cmd_done", status: "accepted" })],
      ["cmd_admin", command({ commandId: "cmd_admin", authority: { type: "admin" } })],
      ["cmd_forged", command({ commandId: "cmd_forged", attachments: [foreign] })],
    ]);
    const daemonStore = Object.assign(store, { getCommand: async (id: string) => commands.get(id) ?? null });
    const app = express();
    app.use("/v1/daemon/attachments", createDaemonAttachmentRouter(daemonStore,
      token => ({ "token-a": "node-a", "token-b": "node-b" })[token] ?? null, () => new Set(["chat-a", "chat-b"]), () => now));
    const { base, close } = await serve(app);
    try {
      const get = (commandId: string, id: string, token?: string) => fetch(`${base}/v1/daemon/attachments/${commandId}/${id}`,
        token ? { headers: { Authorization: `Bearer ${token}` } } : {});
      expect((await get("cmd_1", ref.id)).status).toBe(401);
      expect((await get("cmd_1", ref.id, "token-b")).status).toBe(404);
      expect((await get("cmd_1", foreign.id, "token-a")).status).toBe(404);
      expect((await get("cmd_done", ref.id, "token-a")).status).toBe(404);
      expect((await get("cmd_admin", ref.id, "token-a")).status).toBe(404);
      // A command claiming another chat's attachment still reads only from its authorizing chat.
      expect((await get("cmd_forged", foreign.id, "token-a")).status).toBe(410);
      const ok = await get("cmd_1", ref.id, "token-a");
      expect(ok.status).toBe(200);
      expect(Buffer.from(await ok.arrayBuffer())).toEqual(png);
    } finally { await close(); }
  });
});
