import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { SessionMediaRequests } from "../../src/sessions/media.js";
import { MAX_MEDIA_CHUNK_BYTES, MAX_SESSION_MEDIA, MEDIA_TIMEOUT_MS, MediaError, type MediaDescriptor, type MediaListing } from "../../src/sessions/media-contracts.js";

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
  it.each([0, 255, 256, Number.MAX_SAFE_INTEGER])("lists and reads original image position %s", async ordinal => {
    const f = fixture(); f.image.ordinal = ordinal;
    const listing = await f.reader.list(target, f.ws);
    expect(listing.media[0].ordinal).toBe(ordinal);
    expect(await f.reader.read(target, f.ws, listing, listing.media[0])).toEqual(png);
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid original image position %s", async ordinal => {
    const f = fixture(); f.image.ordinal = ordinal;
    await expect(f.reader.list(target, f.ws)).rejects.toMatchObject({ code: "media_invalid_response" });
  });
  it("preserves sparse original positions while bounding the attachment count", async () => {
    const f = fixture();
    const ordinals = [256, 258, 259];
    f.listing.media = ordinals.map(ordinal => ({ ...f.image, mediaId: randomUUID(), ordinal }));
    expect((await f.reader.list(target, f.ws)).media.map(image => image.ordinal)).toEqual(ordinals);
    expect(f.listing.media).toHaveLength(MAX_SESSION_MEDIA);
    f.listing.media.push({ ...f.image, mediaId: randomUUID(), ordinal: 260 });
    await expect(f.reader.list(target, f.ws)).rejects.toMatchObject({ code: "media_invalid_response" });
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

describe("media read deadlines and caller cancellation", () => {
  afterEach(() => vi.useRealTimers());

  function silentFixture() {
    const f = fixture();
    f.ws.send = vi.fn((wire: string) => { f.messages.push(JSON.parse(wire)); });
    return f;
  }

  it.each([false, true])("reports a silent daemon as a timeout (caller signal: %s)", async withSignal => {
    vi.useFakeTimers();
    const f = silentFixture();
    const signal = withSignal ? new AbortController().signal : undefined;
    const request = Promise.allSettled([f.reader.read(target, f.ws, f.listing, f.image, signal)]);
    const read = f.messages[0];
    expect(vi.getTimerCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(MEDIA_TIMEOUT_MS);
    expect(await request).toEqual([{ status: "rejected",
      reason: expect.objectContaining({ code: "media_timeout", httpStatus: 504 }),
    }]);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.messages.map(item => item.type)).toEqual(["read_media", "cancel_media"]);
    expect(f.messages[1].requestId).toBe(read.requestId);
    expect(f.reader.receive(target.nodeId, f.ws, {
      type: "media_chunk", requestId: read.requestId, sessionId: target.sessionId,
    })).toBe(false);

    const retries = [f.reader.list(target, f.ws), f.reader.list(target, f.ws)];
    const settled = Promise.allSettled(retries);
    expect(f.messages.slice(2).map(item => item.type)).toEqual(["list_media", "list_media"]);
    f.reader.closeAll();
    expect(await settled).toEqual([
      { status: "rejected", reason: expect.objectContaining({ code: "media_disconnected" }) },
      { status: "rejected", reason: expect.objectContaining({ code: "media_disconnected" }) },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps arbitrary caller abort reasons as cancellation and releases every read slot", async () => {
    vi.useFakeTimers();
    const f = silentFixture();
    const caller = new AbortController();
    const requests = [
      f.reader.read(target, f.ws, f.listing, f.image, caller.signal),
      f.reader.read(target, f.ws, f.listing, f.image, caller.signal),
    ];
    const settled = Promise.allSettled(requests);
    caller.abort(new MediaError(504, "media_timeout"));
    expect(await settled).toEqual(requests.map(() => ({ status: "rejected",
      reason: expect.objectContaining({ code: "media_cancelled", httpStatus: 499 }),
    })));
    expect(f.messages.filter(item => item.type === "cancel_media")).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);

    await expect(f.reader.read(target, f.ws, f.listing, f.image, caller.signal))
      .rejects.toMatchObject({ code: "media_cancelled", httpStatus: 499 });
    expect(f.messages.filter(item => item.type === "read_media")).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("retains the deadline reason after a chunk settles (eof: %s)", async eof => {
    vi.useFakeTimers();
    const f = fixture();
    if (!eof) f.mutate(response => { response.data = png.subarray(0, 1).toString("base64"); response.eof = false; });
    const send = f.ws.send.bind(f.ws);
    f.ws.send = vi.fn((wire: string) => {
      send(wire);
      vi.advanceTimersByTime(MEDIA_TIMEOUT_MS);
    });
    await expect(f.reader.read(target, f.ws, f.listing, f.image))
      .rejects.toMatchObject({ code: "media_timeout", httpStatus: 504 });
    expect(vi.getTimerCount()).toBe(0);
    expect(f.messages.map(item => item.type)).toEqual(["read_media"]);
  });
});
