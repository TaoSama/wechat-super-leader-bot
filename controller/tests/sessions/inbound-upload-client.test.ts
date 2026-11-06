import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ControllerServer } from "../../src/http/server.js";
import { MemoryStore } from "../../src/store/memory.js";
import { uploadInboundAttachment } from "../../../gateway/src/controller/attachment-client.js";

const CHAT = "c".repeat(38);
const TOKEN = "synthetic-upload-token";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const image = { kind: "image" as const, name: "image.png", mime: "image/png", bytes: PNG, sha256: sha(PNG) };

describe("Gateway attachment client against the Controller HTTP boundary", () => {
  const store = new MemoryStore();
  const server = new ControllerServer({ host: "127.0.0.1", port: 0, controllerToken: TOKEN,
    nodeTokens: {}, tokenToNode: new Map(), allowedChatIds: new Set([CHAT]), persistenceMode: "memory", commandTtlSeconds: 60 }, store);
  let baseUrl: string;

  beforeAll(async () => {
    await server.start();
    baseUrl = `http://127.0.0.1:${(server.getHttpServer().address() as AddressInfo).port}`;
  });
  afterAll(async () => { await server.stop(); });

  const upload = (messageId: string, media = image, ordinal = 0, chatId = CHAT, token = TOKEN) =>
    uploadInboundAttachment({ baseUrl, token, fetchImpl: fetch }, { chatId, messageId, ordinal, media });

  it.each([128, 129, 145])("stores a %i-character message ID and retries the same slot idempotently", async length => {
    const messageId = "m".repeat(length);
    const first = await upload(messageId);
    expect(await upload(messageId)).toEqual(first);
    const stored = await store.getInboundAttachment(CHAT, first.id, Date.now());
    expect(stored?.data).toEqual(PNG);
    expect(stored?.sha256).toBe(image.sha256);
    expect(stored?.messageId.length).toBeLessThanOrEqual(128);
    if (length <= 128) expect(stored?.messageId).toBe(messageId);
  });

  it("keeps messages with the same long prefix, literal hash IDs and ordinals distinct", async () => {
    const long = "same-prefix-" + "x".repeat(132);
    const first = await upload(long);
    const other = await upload(long + "y");
    const literalId = "sha256:" + sha(Buffer.from(JSON.stringify(long)));
    const literal = await upload(literalId);
    const secondOrdinal = await upload(long, image, 1);
    expect(new Set([first.id, other.id, literal.id, secondOrdinal.id]).size).toBe(4);
    expect(await upload(long)).toEqual(first);
    expect(await upload(literalId)).toEqual(literal);
  });

  it("preserves distinct Unicode IDs when hashing", async () => {
    const prefix = "u".repeat(144);
    const first = await upload(prefix + "\ud800");
    const second = await upload(prefix + "\ufffd");
    expect(first.id).not.toBe(second.id);
  });

  it("retains same-slot conflict detection for changed bytes", async () => {
    const id = "conflict-" + "x".repeat(137);
    await upload(id);
    const bytes = Buffer.concat([PNG, Buffer.from([1])]);
    await expect(upload(id, { ...image, bytes, sha256: sha(bytes) })).rejects.toThrow("HTTP 409");
  });

  it("retains hash, MIME, chat and authentication checks", async () => {
    await expect(upload("bad-hash", { ...image, sha256: "0".repeat(64) })).rejects.toThrow("HTTP 400");
    await expect(upload("bad-mime", { ...image, mime: "image/jpeg" })).rejects.toThrow("HTTP 400");
    await expect(upload("bad-chat", image, 0, "c".repeat(65))).rejects.toThrow("HTTP 400");
    await expect(upload("foreign-chat", image, 0, "foreign")).rejects.toThrow("HTTP 403");
    await expect(upload("bad-token", image, 0, CHAT, "wrong-token")).rejects.toThrow("HTTP 403");
  });
});
