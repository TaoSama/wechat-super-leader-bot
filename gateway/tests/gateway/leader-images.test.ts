import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateManager } from "../../src/runtime/state.js";
import { ControllerClient } from "../../src/controller/client.js";
import { ILinkClient } from "../../src/wechat/client.js";
import { WeChatGateway, type GatewayReplyEngine } from "../../src/gateway.js";
import type { InboundImage } from "../../src/leader/inbound-images.js";
import type { ControllerMessageRequest } from "../../src/types.js";

const KEY = "2b7e151628aed2a6abf7158809cf4f3c";
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("pixels")]);
const ATTACHMENT_ID = "6f1c2a8e-1d2b-4c3d-8e9f-0a1b2c3d4e5f";
const STEER_WAIT_MS = 2_000;
const imageItem = { type: 2, image_item: { aeskey: KEY, media: { encrypt_query_param: "img" } } };
const textItem = (text: string) => ({ type: 1, text_item: { text } });
const message = (id: string, items: unknown[]) => ({ message_type: 1, from_user_id: "chat", client_id: id,
  context_token: `ctx-${id}`, create_time_ms: Date.now(), item_list: items });

function encrypted(): Uint8Array {
  const cipher = createCipheriv("aes-128-ecb", Buffer.from(KEY, "hex"), null);
  return new Uint8Array(Buffer.concat([cipher.update(PNG), cipher.final()]));
}

/** Runs the real poll loop; the second page arrives only after the first leader turn has started. */
function fixture(t: TestContext, pages: [unknown[], unknown[]], engine: (gateway: () => WeChatGateway) => GatewayReplyEngine,
  started: Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "gateway-leader-images-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const credentials = join(directory, "account.json");
  writeFileSync(credentials, JSON.stringify({ token: "test", accountId: "test-account" }));
  const state = new StateManager(credentials, join(directory, "state.json"));
  state.markBaselineEstablished();
  const sends: string[] = [], uploads: string[] = [];
  let polls = 0;
  const controller = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "test",
    fetchImpl: async (url, init) => {
      const parsed = new URL(String(url));
      if (parsed.pathname === "/v1/chats/authorize") return Response.json({ allowed: true });
      if (parsed.pathname === "/v1/notifications/pending") return Response.json({ items: [] });
      if (parsed.pathname === "/v1/inbound-attachments") {
        uploads.push(parsed.searchParams.get("messageId")!);
        return Response.json({ attachment: { id: ATTACHMENT_ID, size: (init?.body as Uint8Array).byteLength,
          sha256: parsed.searchParams.get("sha256") } });
      }
      throw new Error(`Unexpected controller endpoint: ${parsed.pathname}`);
    } });
  const ilink = new ILinkClient({ stateManager: state, configuredBaseUrl: "https://wechat.example",
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("getupdates")) {
        polls++;
        if (polls === 1) return Response.json({ ret: 0, get_updates_buf: "one", msgs: pages[0] });
        if (polls === 2) { await started; return Response.json({ ret: 0, get_updates_buf: "two", msgs: pages[1] }); }
        await new Promise(resolve => setTimeout(resolve, 1));
        return Response.json({ ret: 0, get_updates_buf: "done", msgs: [] });
      }
      if (String(url).endsWith("getconfig")) return Response.json({ ret: 0, typing_ticket: "ticket" });
      if (String(url).endsWith("sendtyping")) return Response.json({ ret: 0 });
      if (String(url).endsWith("sendmessage")) {
        sends.push(JSON.parse(String(init?.body)).msg.item_list[0].text_item.text);
        gateway.stop();
        return Response.json({ ret: 0 });
      }
      throw new Error("Unexpected WeChat endpoint");
    } });
  const gateway: WeChatGateway = new WeChatGateway({ stateManager: state, ilink, controller,
    mediaFetch: async () => new Response(encrypted()), replyEngine: engine(() => gateway) });
  t.after(() => gateway.stop());
  return { gateway, state, sends, uploads };
}

test("an image sent right after its question joins the running leader turn as pixels", { timeout: 30_000 }, async t => {
  let ready!: () => void, complete!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const completion = new Promise<void>(resolve => { complete = resolve; });
  const events: string[] = [];
  const staged: Array<{ messageId: string; images: readonly InboundImage[] }> = [];
  const steered: ControllerMessageRequest[] = [];
  let active = false;
  const f = fixture(t, [[message("ask", [textItem("帮我看下这张截图")])], [message("picture", [imageItem])]], () => ({
    requestBudgetMs: 1000,
    async reply() {
      active = true;
      ready();
      // Without image steering the picture waits behind this turn; give up instead of hanging the test.
      await Promise.race([completion, new Promise(resolve => setTimeout(resolve, STEER_WAIT_MS))]);
      active = false;
      return { text: steered.length ? "截图里是部署失败的报错" : "没有收到图片" };
    },
    async stageImages(_account, _chat, messageId, images) { events.push(`stage:${messageId}`); staged.push({ messageId, images }); },
    hasActiveTurn: () => active,
    async steer(_account, request) {
      events.push(`steer:${request.messageId}`);
      steered.push(request);
      complete();
      return true;
    },
    async getReply() { throw new Error("A live turn must not be read as completed"); },
    async ackReply() {},
  }), started);
  const failures: Error[] = [];
  await f.gateway.runLoop(1, error => { failures.push(error); complete(); f.gateway.stop(); });
  assert.deepEqual(failures, []);
  assert.deepEqual(events, ["stage:picture", "steer:picture"], "the image must be stored and staged before it is steered");
  assert.deepEqual(f.uploads, ["picture"], "the attachment record is created while the turn is still running");
  assert.deepEqual(steered.map(request => request.text), [""]);
  assert.deepEqual(staged[0].images.map(image => [image.mime, image.bytes.equals(PNG)]), [["image/png", true]]);
  assert.deepEqual(f.sends, ["截图里是部署失败的报错"]);
  assert.equal(f.state.processedMessageKeys.length, 2);
});

test("an image sent before its question is staged for the leader turn that answers it", { timeout: 30_000 }, async t => {
  const events: string[] = [];
  const requests: ControllerMessageRequest[] = [];
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const f = fixture(t, [[message("picture", [imageItem])], [message("ask", [textItem("图里是什么？")])]], () => ({
    requestBudgetMs: 1000,
    async reply(_account, request) { events.push(`reply:${request.messageId}`); requests.push(request); return { text: "一张截图" }; },
    async stageImages(_account, _chat, messageId, images) {
      events.push(`stage:${messageId}:${images.length}`);
      ready();
    },
    hasActiveTurn: () => false,
    async steer() { return false; },
    async getReply() { throw new Error("unexpected recovery"); },
    async ackReply() {},
  }), started);
  const failures: Error[] = [];
  await f.gateway.runLoop(1, error => { failures.push(error); f.gateway.stop(); });
  assert.deepEqual(failures, []);
  assert.deepEqual(events, ["stage:picture:1", "reply:ask"]);
  assert.deepEqual(requests.map(request => request.text), ["图里是什么？"]);
  assert.deepEqual(f.sends, ["一张截图"]);
});
