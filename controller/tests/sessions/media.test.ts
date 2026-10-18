import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { SessionMediaRequests } from "../../src/sessions/media.js";
import { MAX_MEDIA_CHUNK_BYTES, type MediaDescriptor, type MediaListing } from "../../src/sessions/media-contracts.js";

const target = { nodeId: "node", sessionId: "session" };
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
function fixture(bytes = png) {
  const reader = new SessionMediaRequests();
  const image: MediaDescriptor = { mediaId: randomUUID(), itemId: "item", turnId: "turn", ordinal: 0,
    mime: "image/png", totalSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const listing: MediaListing = { mediaContext: randomUUID(), source: "codex-desktop", media: [image] };
  const messages: Record<string, any>[] = [];
  let mutate: (response: Record<string, any>) => void = () => {};
  const ws = { readyState: WebSocket.OPEN, send: vi.fn((wire: string, done?: (error?: Error) => void) => {
    const request = JSON.parse(wire); messages.push(request); done?.();
    if (request.type === "cancel_media") return;
    const response = request.type === "list_media"
      ? { type: "media_list", requestId: request.requestId, sessionId: target.sessionId, ...listing }
      : { type: "media_chunk", requestId: request.requestId, sessionId: target.sessionId,
        mediaContext: request.mediaContext, mediaId: image.mediaId, offset: request.offset,
        totalSize: image.totalSize, mime: image.mime, sha256: image.sha256,
        data: bytes.subarray(request.offset, request.offset + request.maxBytes).toString("base64"),
        eof: request.offset + request.maxBytes === bytes.length };
    mutate(response); reader.receive(target.nodeId, ws as unknown as WebSocket, response);
  }) } as unknown as WebSocket;
  return { reader, ws, image, listing, messages, mutate: (fn: typeof mutate) => { mutate = fn; } };
}

describe("bounded original session media transport", () => {
  it("lists opaque identities without exposing paths and reads verified bytes", async () => {
    const f = fixture();
    expect(await f.reader.list(target, f.ws)).toEqual(f.listing);
    expect(await f.reader.read(target, f.ws, f.listing, f.image)).toEqual(png);
    expect(JSON.stringify(f.messages)).not.toContain("path");
  });
  it("uses bounded consecutive chunks for a multi-frame image", async () => {
    const bytes = Buffer.concat([png, Buffer.alloc(MAX_MEDIA_CHUNK_BYTES * 2)]);
    const f = fixture(bytes);
    expect(await f.reader.read(target, f.ws, f.listing, f.image)).toEqual(bytes);
    expect(f.messages.map(item => item.offset)).toEqual([0, MAX_MEDIA_CHUNK_BYTES, MAX_MEDIA_CHUNK_BYTES * 2]);
    expect(f.messages.every(item => item.maxBytes <= MAX_MEDIA_CHUNK_BYTES)).toBe(true);
  });
  it.each(["offset", "totalSize", "mediaId", "mediaContext", "sha256", "mime", "eof"])("rejects changed %s", async field => {
    const f = fixture(); f.mutate(response => {
      if (field === "offset" || field === "totalSize") response[field]++;
      else if (field === "eof") response[field] = false;
      else if (field === "mime") response[field] = "image/jpeg";
      else if (field === "sha256") response[field] = "0".repeat(64);
      else response[field] = randomUUID();
    });
    await expect(f.reader.read(target, f.ws, f.listing, f.image)).rejects.toMatchObject({ code: "media_invalid_response" });
  });
  it("rejects corrupted data and disallowed magic even with a correct hash", async () => {
    const f = fixture(); f.mutate(response => { response.data = Buffer.from("corrupted").toString("base64"); });
    await expect(f.reader.read(target, f.ws, f.listing, f.image)).rejects.toMatchObject({ code: "media_invalid_response" });
    const fake = fixture(Buffer.from("<svg/>"));
    await expect(fake.reader.read(target, fake.ws, fake.listing, fake.image)).rejects.toMatchObject({ code: "media_invalid_response" });
  });
  it("never reads an attachment absent from the exact listing", async () => {
    const f = fixture();
    await expect(f.reader.read(target, f.ws, { ...f.listing, media: [] }, f.image)).rejects.toThrow();
    expect(f.messages).toHaveLength(0);
  });
  it("rejects duplicate attachment identities", async () => {
    const f = fixture(); f.mutate(response => { response.media = [f.image, f.image]; });
    await expect(f.reader.list(target, f.ws)).rejects.toMatchObject({ code: "media_invalid_response" });
  });
  it("cancels promptly and ignores replies from another socket", async () => {
    const f = fixture();
    const abort = new AbortController();
    f.ws.send = vi.fn((wire: string) => {
      const request = JSON.parse(wire); f.messages.push(request);
      if (request.type === "cancel_media") return;
      expect(f.reader.receive(target.nodeId, {} as WebSocket, {
        type: "media_list", requestId: request.requestId, sessionId: target.sessionId, ...f.listing,
      })).toBe(false);
    });
    const request = f.reader.list(target, f.ws, abort.signal); abort.abort();
    await expect(request).rejects.toMatchObject({ code: "media_cancelled" });
    expect(f.messages.at(-1)?.type).toBe("cancel_media");
  });
  it("clears pending reads on disconnect", async () => {
    const f = fixture(); f.ws.send = vi.fn();
    const request = f.reader.list(target, f.ws); f.reader.disconnect(f.ws);
    await expect(request).rejects.toMatchObject({ code: "media_disconnected" });
  });
});
