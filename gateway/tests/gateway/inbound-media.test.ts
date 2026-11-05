import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateManager } from "../../src/runtime/state.js";
import { ControllerClient } from "../../src/controller/client.js";
import { ILinkClient } from "../../src/wechat/client.js";
import { MEDIA_FAILED_NOTE, UNSUPPORTED_MEDIA_REPLY, WeChatGateway } from "../../src/gateway.js";

const CHAT = "chat";
const KEY = "2b7e151628aed2a6abf7158809cf4f3c";
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("pixels")]);
const ATTACHMENT_ID = "6f1c2a8e-1d2b-4c3d-8e9f-0a1b2c3d4e5f";
const imageItem = { type: 2, image_item: { aeskey: KEY, media: { encrypt_query_param: "img" } } };
const message = (id: string, items: unknown[]) => ({ message_type: 1, from_user_id: CHAT, client_id: id, context_token: `ctx-${id}`,
  create_time_ms: Date.now() - 1000, item_list: items });

function encrypted(): Uint8Array {
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(KEY, "hex"), null);
  return new Uint8Array(Buffer.concat([cipher.update(PNG), cipher.final()]));
}

function fixture(t: TestContext, cdn: () => Promise<Response>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-inbound-media-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const accountPath = path.join(directory, "account.json");
  fs.writeFileSync(accountPath, JSON.stringify({ token: "synthetic", accountId: "synthetic" }));
  const state = new StateManager(accountPath, path.join(directory, "state.json"));
  state.markBaselineEstablished();
  const sends: string[] = [], uploads: URLSearchParams[] = [], forwarded: string[] = [];
  let pages: unknown[][] = [];
  const ilink = new ILinkClient({ stateManager: state, configuredBaseUrl: "https://wechat.example", fetchImpl: async (url, init) => {
    const endpoint = new URL(String(url)).pathname;
    if (endpoint.endsWith("getupdates")) return Response.json({ ret: 0, get_updates_buf: "next", msgs: pages.shift() ?? [] });
    if (endpoint.endsWith("getconfig")) return Response.json({ ret: 0, typing_ticket: "ticket" });
    if (endpoint.endsWith("sendtyping")) return Response.json({ ret: 0 });
    if (endpoint.endsWith("sendmessage")) { sends.push(JSON.parse(String(init?.body)).msg.item_list[0].text_item.text); return Response.json({ ret: 0 }); }
    throw new Error(`Unexpected WeChat endpoint ${endpoint}`);
  } });
  const controller = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic", fetchImpl: async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/v1/chats/authorize") return Response.json({ allowed: true });
    if (parsed.pathname === "/v1/inbound-attachments") {
      uploads.push(parsed.searchParams);
      const size = (init?.body as Uint8Array).byteLength;
      return Response.json({ attachment: { id: ATTACHMENT_ID, size, sha256: parsed.searchParams.get("sha256") } });
    }
    if (parsed.pathname === "/v1/messages") { forwarded.push(JSON.parse(String(init?.body)).text); return Response.json({ text: "看到了" }); }
    throw new Error(`Unexpected Controller endpoint ${parsed.pathname}`);
  } });
  const gateway = new WeChatGateway({ stateManager: state, ilink, controller, mediaFetch: cdn });
  return { state, gateway, sends, uploads, forwarded, setPages: (next: unknown[][]) => { pages = next; } };
}

test("an image alone is stored as chat context without any WeChat reply", async t => {
  const f = fixture(t, async () => new Response(encrypted()));
  f.setPages([[message("img", [imageItem])]]);
  assert.equal((await f.gateway.pollOnce()).processedCount, 1);
  assert.deepEqual(f.sends, []);
  assert.deepEqual(f.forwarded, []);
  assert.equal(f.uploads.length, 1);
  assert.equal(f.uploads[0].get("kind"), "image");
  assert.equal(f.uploads[0].get("mime"), "image/png");
  assert.equal(f.state.isMessageProcessed(f.state.computeDeliveryKey(CHAT, "img")), true);
});

test("a failed image download falls back to the fixed notice", async t => {
  const f = fixture(t, async () => new Response("gone", { status: 404 }));
  f.setPages([[message("img", [imageItem])]]);
  await f.gateway.pollOnce();
  assert.deepEqual(f.uploads, []);
  assert.deepEqual(f.sends, [UNSUPPORTED_MEDIA_REPLY]);
});

test("text with an image is forwarded after storing it, and a failed image is flagged to the leader", async t => {
  const ok = fixture(t, async () => new Response(encrypted()));
  ok.setPages([[message("both", [imageItem, { type: 1, text_item: { text: "帮我看看这张图" } }])]]);
  await ok.gateway.pollOnce();
  assert.equal(ok.uploads.length, 1);
  assert.deepEqual(ok.forwarded, ["帮我看看这张图"]);
  assert.deepEqual(ok.sends, ["看到了"]);

  const failed = fixture(t, async () => { throw new TypeError("network"); });
  failed.setPages([[message("both", [imageItem, { type: 1, text_item: { text: "帮我看看这张图" } }])]]);
  await failed.gateway.pollOnce();
  assert.deepEqual(failed.forwarded, ["帮我看看这张图" + MEDIA_FAILED_NOTE]);
});
