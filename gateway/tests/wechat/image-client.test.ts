import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { ILinkClient } from "../../src/wechat/client.js";
import { StateManager } from "../../src/runtime/state.js";
import type { ImageAttachment } from "../../src/wechat/media-delivery.js";

const PNG = Buffer.from("89504e470d0a1a0a00000000", "hex");
const IMAGE: ImageAttachment = { id: "image-one", mime: "image/png", size: PNG.length,
  sha256: createHash("sha256").update(PNG).digest("hex") };

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-image-client-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credentials = path.join(directory, "account.json"), statePath = path.join(directory, "state.json");
  fs.writeFileSync(credentials, JSON.stringify({ token: "synthetic-private", accountId: "fixture" }));
  const state = new StateManager(credentials, statePath);
  state.setContextToken("chat", "synthetic-context");
  const calls: string[] = [], sends: Record<string, unknown>[] = [];
  let hook: ((body: Record<string, unknown>) => Promise<Response> | Response) | undefined;
  let uploadHook: (() => Promise<Response> | Response) | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(url.pathname);
    if (url.pathname === "/c2c/upload") {
      assert.equal(url.hostname, "novac2c.cdn.weixin.qq.com");
      assert.equal((init?.headers as Record<string, string>).Authorization, undefined);
      assert.ok(init?.body instanceof Uint8Array);
      return uploadHook ? uploadHook() : new Response("", { headers: { "x-encrypted-param": "synthetic-download" } });
    }
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer synthetic-private");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (url.pathname.endsWith("getconfig")) return Response.json({ ret: 0, typing_ticket: "synthetic-ticket" });
    if (url.pathname.endsWith("sendtyping")) return Response.json({ ret: 0 });
    if (url.pathname.endsWith("getuploadurl")) {
      assert.deepEqual(body.base_info, { channel_version: "0.3.0" });
      assert.equal(body.media_type, 1);
      return Response.json({ ret: 0, upload_param: "synthetic-upload" });
    }
    assert.ok(url.pathname.endsWith("sendmessage"));
    sends.push(body.msg as Record<string, unknown>);
    return hook ? hook(body) : Response.json({ ret: 0 });
  };
  const client = (manager = state) => new ILinkClient({ stateManager: manager, fetchImpl });
  return { state, credentials, statePath, calls, sends, client,
    setSendHook: (next: typeof hook) => { hook = next; },
    setUploadHook: (next: typeof uploadHook) => { uploadHook = next; } };
}

test("image transport types, uploads encrypted bytes and confirms the final WeChat receipt", async t => {
  const f = fixture(t);
  assert.equal(await f.client().sendImageReply("chat", [IMAGE], {
    deliveryKey: "images", getImageBytes: async () => PNG,
  }), 1);
  assert.deepEqual(f.calls, ["/ilink/bot/getconfig", "/ilink/bot/sendtyping", "/ilink/bot/getuploadurl", "/c2c/upload", "/ilink/bot/sendmessage"]);
  const sent = f.sends[0];
  assert.equal(sent.to_user_id, "chat");
  assert.equal(sent.context_token, "synthetic-context");
  const item = (sent.item_list as { type: number; image_item: { media: { encrypt_type: number }; mid_size: number } }[])[0];
  assert.equal(item.type, 2); assert.equal(item.image_item.media.encrypt_type, 1);
  assert.equal(item.image_item.mid_size, 16);
  assert.equal(f.state.replyDeliveries.images.acknowledgedChunks, 1);
  assert.equal(f.state.replyDeliveries.images.inFlight, false);
});

test("CDN acceptance followed by unknown WeChat receipt persists uncertainty and forbids all replay", async t => {
  const f = fixture(t);
  f.setSendHook(() => { throw new TypeError("synthetic response loss"); });
  await assert.rejects(f.client().sendImageReply("chat", [IMAGE], {
    deliveryKey: "unknown", getImageBytes: async () => PNG,
  }), /response loss/);
  assert.equal(f.state.replyDeliveries.unknown.inFlight, true);
  assert.equal(f.state.getReplySentChunks("unknown"), 0);
  const resumed = new StateManager(f.credentials, f.statePath);
  const before = [...f.calls];
  await assert.rejects(f.client(resumed).sendImageReply("chat", [IMAGE], {
    deliveryKey: "unknown", getImageBytes: async () => PNG,
  }), /delivery uncertain/);
  assert.equal(f.sends.length, 1);
  assert.equal(f.calls.filter(url => url === "/c2c/upload").length, 1);
  assert.ok(f.calls.length >= before.length);
});

test("upload failure leaves a safely resumable image intent without claiming WeChat acceptance", async t => {
  const f = fixture(t);
  f.setUploadHook(() => new Response("", { status: 400 }));
  await assert.rejects(f.client().sendImageReply("chat", [IMAGE], {
    deliveryKey: "upload", getImageBytes: async () => PNG,
  }), /upload failed HTTP 400/);
  assert.equal(f.sends.length, 0);
  assert.equal(f.state.replyDeliveries.upload.inFlight, false);
  assert.equal(f.state.getReplySentChunks("upload"), 0);
  f.setUploadHook(undefined);
  assert.equal(await f.client().sendImageReply("chat", [IMAGE], {
    deliveryKey: "upload", getImageBytes: async () => PNG,
  }), 1);
});

test("image send timeout is bounded even if its transport ignores abort", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const f = fixture(t);
  f.setSendHook(() => new Promise<Response>(() => {}));
  const pending = f.client().sendImageReply("chat", [IMAGE], {
    deliveryKey: "timeout", getImageBytes: async () => PNG, timeoutMs: 500,
  });
  const rejected = assert.rejects(pending, /image reply timed out/);
  for (let step = 0; step < 80; step++) await Promise.resolve();
  assert.equal(f.sends.length, 1);
  t.mock.timers.tick(500);
  await rejected;
  assert.equal(f.state.replyDeliveries.timeout.inFlight, true);
});

test("a canceled image queue waiter cannot let a later text send bypass an active image upload", async t => {
  const f = fixture(t);
  const client = f.client();
  let finish!: () => void, started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const first = client.sendImageReply("chat", [IMAGE], { deliveryKey: "first",
    getImageBytes: async () => { started(); await new Promise<void>(resolve => { finish = resolve; }); return PNG; } });
  await began;
  const abort = new AbortController();
  const second = client.sendImageReply("chat", [IMAGE], {
    deliveryKey: "second", getImageBytes: async () => PNG, signal: abort.signal,
  });
  const canceled = assert.rejects(second, /synthetic cancellation/);
  abort.abort(new Error("synthetic cancellation")); await canceled;
  const text = client.sendSingleText("chat", "after images");
  for (let step = 0; step < 20; step++) await Promise.resolve();
  assert.equal(f.sends.length, 0);
  finish(); await first; await text;
  assert.equal(f.sends.length, 2);
  assert.equal((f.sends[0].item_list as { type: number }[])[0].type, 2);
  assert.equal((f.sends[1].item_list as { type: number }[])[0].type, 1);
});

test("account or context changes during image download prevent upload and sending", async t => {
  for (const mode of ["account", "context"]) {
    const f = fixture(t);
    await assert.rejects(f.client().sendImageReply("chat", [IMAGE], {
      deliveryKey: `changed-${mode}`, getImageBytes: async () => {
        if (mode === "account") f.state.account!.token = "replacement";
        else f.state.setContextToken("chat", "replacement-context");
        return PNG;
      },
    }), /image reply interrupted before/);
    assert.equal(f.sends.length, 0);
    assert.equal(f.calls.some(call => call.endsWith("getuploadurl")), false);
  }
});
