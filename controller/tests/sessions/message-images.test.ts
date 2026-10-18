import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MemoryMessageImages, prepareMessageImages, type StoredMessageImage } from "../../src/sessions/message-images.js";
import { authorizeImageDelivery } from "../../src/leader/queries/session-images.js";
import type { LeaderModel } from "../../src/leader/model/contracts.js";

const data = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 5]);
const image = (): StoredMessageImage => ({ id: randomUUID(), mime: "image/png", size: data.length,
  sha256: createHash("sha256").update(data).digest("hex"), data: Buffer.from(data) });

describe("immutable message image storage", () => {
  it("scopes exact chat/message and copies bytes on input and output", async () => {
    const store = new MemoryMessageImages(() => 1000); const original = image();
    await store.recordMessageImages("chat", "message", [original], 2000); original.data.fill(0);
    const saved = await store.getMessageImage("chat", "message", original.id, 1000);
    expect(saved?.data).toEqual(data); saved!.data.fill(0);
    expect((await store.getMessageImage("chat", "message", original.id, 1000))?.data).toEqual(data);
    expect(await store.getMessageImage("other-chat", "message", original.id, 1000)).toBeNull();
    expect(await store.getMessageImage("chat", "other-message", original.id, 1000)).toBeNull();
    expect(await store.getMessageImage("chat", "message", original.id, 2000)).toBeNull();
  });
  it("returns the original IDs on idempotent replay and refuses changed content", async () => {
    const store = new MemoryMessageImages(() => 1000); const original = image();
    const prior = await store.recordMessageImages("chat", "message", [original], 2000);
    expect(await store.recordMessageImages("chat", "message", [image()], 2000)).toEqual(prior);
    const other = image(); other.data[8] = 9; other.sha256 = createHash("sha256").update(other.data).digest("hex");
    await expect(store.recordMessageImages("chat", "message", [other], 2000)).rejects.toMatchObject({ code: "media_message_conflict" });
  });
  it("refuses forged MIME and hash metadata", async () => {
    const store = new MemoryMessageImages();
    await expect(store.recordMessageImages("chat", "message", [{ ...image(), mime: "image/jpeg" }], Date.now() + 10000)).rejects.toThrow();
    await expect(store.recordMessageImages("chat", "message", [{ ...image(), sha256: "0".repeat(64) }], Date.now() + 10000)).rejects.toThrow();
  });
  it("prepares all verified attachments before returning any references", async () => {
    const store = new MemoryMessageImages(() => 1000); const original = image();
    const descriptor = { mediaId: randomUUID(), itemId: "item", turnId: "turn", ordinal: 0,
      mime: original.mime, totalSize: original.size, sha256: original.sha256 };
    const hub = { listMedia: vi.fn(async () => ({ mediaContext: randomUUID(), source: "codex-desktop" as const, media: [descriptor] })),
      readMedia: vi.fn(async () => data) };
    const prepared = await prepareMessageImages(hub, store, "chat", "message", { nodeId: "node", sessionId: "session" }, new AbortController().signal, () => 1000);
    expect(prepared.images).toHaveLength(1);
    expect((await store.getMessageImage("chat", "message", prepared.images[0].id, 1000))?.data).toEqual(data);
  });
});

describe("isolated current-user image authorization", () => {
  it("passes only the current user and fixed classifier prompt", async () => {
    const complete = vi.fn(async () => ({ content: null, toolCalls: [{ id: "auth", type: "function" as const,
      function: { name: "classify_image_delivery", arguments: '{"sendImages":true}' } }] }));
    const model: LeaderModel = { complete };
    expect(await authorizeImageDelivery(model, "把那三张图发过来", new AbortController().signal)).toBe(true);
    expect(complete.mock.calls[0][0]).toHaveLength(2);
    expect(complete.mock.calls[0][0][1]).toEqual({ role: "user", content: "把那三张图发过来" });
  });
  it.each(['{}', '{"sendImages":"true"}', '{"sendImages":true,"recipient":"other"}', 'not-json'])("fails closed on %s", async argumentsValue => {
    const model: LeaderModel = { complete: async () => ({ content: null, toolCalls: [{ id: "a", type: "function", function: { name: "classify_image_delivery", arguments: argumentsValue } }] }) };
    expect(await authorizeImageDelivery(model, "发图", new AbortController().signal)).toBe(false);
  });
});
