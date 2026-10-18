import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ControllerClient } from "../../src/controller/client.js";
import { PermanentImageDownloadError } from "../../src/controller/image-client.js";
import type { ImageAttachment } from "../../src/wechat/media-delivery.js";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const image: ImageAttachment = { id: "image+1", mime: "image/png", size: png.length,
  sha256: createHash("sha256").update(png).digest("hex") };
const request = { chatId: "chat?subject=other", messageId: "message/opaque?x", image };
const client = (fetchImpl: typeof fetch, timeoutMs?: number) => new ControllerClient({
  controllerUrl: "https://controller.example.test/prefix", controllerToken: "synthetic-private", fetchImpl, timeoutMs,
});

test("attachment download stays on the authenticated fixed Controller path with encoded identities", async () => {
  const instance = client(async (input, init) => {
    assert.equal(String(input), "https://controller.example.test/prefix/v1/messages/message%2Fopaque%3Fx/images/image%2B1?chatId=chat%3Fsubject%3Dother");
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer synthetic-private");
    return new Response(new Uint8Array(png), { headers: { "content-type": "image/png", "content-length": String(png.length) } });
  });
  assert.deepEqual(await instance.downloadImage(request), png);
});

test("download rejects HTTP failures, MIME, body length, and content hash mismatch", async () => {
  const responses = [new Response(null, { status: 302 }), new Response(null, { status: 403 }),
    new Response(new Uint8Array(png), { headers: { "content-type": "text/html" } }),
    new Response(new Uint8Array(png), { headers: { "content-type": "image/png", "content-length": "999" } }),
    new Response(new Uint8Array(Buffer.concat([png, Buffer.alloc(1)])), { headers: { "content-type": "image/png" } }),
    new Response(new Uint8Array(png.subarray(0, 7)), { headers: { "content-type": "image/png" } }),
    new Response(new Uint8Array(Buffer.alloc(png.length)), { headers: { "content-type": "image/png" } })];
  for (const response of responses) {
    await assert.rejects(client(async () => response).downloadImage(request), /Controller image download/);
  }
});

test("only fixed attachment route 404 and 410 are typed permanent download failures", async () => {
  for (const [status, reason] of [[404, "AttachmentUnavailable"], [410, "AttachmentExpired"]] as const) {
    await assert.rejects(client(async () => new Response(null, { status })).downloadImage(request), error => {
      assert.ok(error instanceof PermanentImageDownloadError);
      assert.equal(error.reason, reason);
      return true;
    });
  }
  for (const status of [401, 403, 500, 503]) {
    await assert.rejects(client(async () => new Response(null, { status })).downloadImage(request), error => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof PermanentImageDownloadError));
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      return true;
    });
  }
});

test("fetch and streaming body deadlines stay bounded even if cancellation is ignored", async () => {
  for (const phase of ["fetch", "body"]) {
    let signal: AbortSignal | undefined;
    const instance = client(async (_input, init) => {
      signal = init?.signal ?? undefined;
      return phase === "fetch" ? new Promise<Response>(() => {}) : new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array(png.subarray(0, 4))); },
      }), { headers: { "content-type": "image/png" } });
    }, 15);
    const started = Date.now();
    await assert.rejects(instance.downloadImage(request), /timed out/);
    assert.ok(Date.now() - started < 1000);
    assert.equal(signal?.aborted, true);
  }
});

test("response attachment schema is optional, strict, and malformed metadata is not retried", async () => {
  const good = await client(async () => Response.json({ text: "done", images: [image] }))
    .forwardMessage({ chatId: "chat", messageId: "message", text: "screenshot" });
  assert.deepEqual(good.images, [image]);
  for (const images of [null, "url", [{ ...image, url: "https://arbitrary.test/image" }], [{ ...image, sha256: "bad" }],
    [image, image], [{ ...image, id: ".." }]]) {
    let attempts = 0;
    const instance = client(async () => { attempts++; return Response.json({ text: "done", images }); });
    await assert.rejects(instance.forwardMessage({ chatId: "chat", messageId: "message", text: "screenshot" }), /invalid response schema/);
    assert.equal(attempts, 1);
  }
});
