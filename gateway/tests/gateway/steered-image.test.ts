import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControllerClient } from "../../src/controller/client.js";
import { WeChatGateway } from "../../src/gateway.js";
import { StateManager } from "../../src/runtime/state.js";
import { ILinkClient } from "../../src/wechat/client.js";
import type { ImageAttachment } from "../../src/wechat/media-delivery.js";

const CHAT_ID = "steered-image-chat";
const ROOT_MESSAGE_ID = "root-message";
const IMAGE_SOURCE_MESSAGE_ID = "follow-up-message";
const FINAL_TEXT = "已结合补充要求取得截图。";
const PNG = Buffer.from("89504e470d0a1a0a00000000", "hex");
const IMAGE: ImageAttachment = { id: "follow-up-screenshot", mime: "image/png", size: PNG.length,
  sha256: createHash("sha256").update(PNG).digest("hex") };

test("steered image downloads use the follow-up identity while final delivery belongs to the root query", async t => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-steered-image-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const credentials = join(directory, "account.json");
  writeFileSync(credentials, JSON.stringify({ token: "synthetic-image-token", accountId: "image-account" }));
  const state = new StateManager(credentials, join(directory, "state.json"));
  state.markBaselineEstablished();
  const rootKey = state.computeDeliveryKey(CHAT_ID, ROOT_MESSAGE_ID);
  const followUpKey = state.computeDeliveryKey(CHAT_ID, IMAGE_SOURCE_MESSAGE_ID);
  const downloads: Array<{ chatId: string; messageId: string; image: ImageAttachment }> = [];
  const acknowledgements: Array<{ chatId: string; messageId: string; status: string }> = [];
  const sentTypes: number[] = [];
  const controller = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic-controller",
    fetchImpl: async url => {
      assert.equal(new URL(String(url)).pathname, "/v1/chats/authorize");
      return Response.json({ allowed: true });
    } });
  t.mock.method(controller, "downloadImage", async (request: typeof downloads[number]) => {
    downloads.push({ chatId: request.chatId, messageId: request.messageId, image: request.image });
    assert.equal(state.outbox[rootKey]?.messageId, ROOT_MESSAGE_ID);
    assert.equal(state.outbox[followUpKey], undefined);
    return PNG;
  });
  const ilink = new ILinkClient({ stateManager: state, configuredBaseUrl: "https://wechat.example",
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/c2c/upload") {
        assert.ok(init?.body instanceof Uint8Array);
        return new Response("", { headers: { "x-encrypted-param": "synthetic-download" } });
      }
      if (url.pathname.endsWith("getupdates")) return Response.json({ ret: 0, get_updates_buf: "next", msgs: [{
        message_type: 1, from_user_id: CHAT_ID, client_id: ROOT_MESSAGE_ID, context_token: "synthetic-context",
        create_time_ms: Date.now(), item_list: [{ type: 1, text_item: { text: "先查看状态" } }],
      }] });
      if (url.pathname.endsWith("getconfig")) return Response.json({ ret: 0, typing_ticket: "synthetic-ticket" });
      if (url.pathname.endsWith("sendtyping")) return Response.json({ ret: 0 });
      if (url.pathname.endsWith("getuploadurl")) return Response.json({ ret: 0, upload_param: "synthetic-upload" });
      assert.ok(url.pathname.endsWith("sendmessage"));
      const item = JSON.parse(String(init?.body)).msg.item_list[0];
      sentTypes.push(item.type);
      if (item.type === 1) {
        assert.equal(item.text_item.text, FINAL_TEXT);
        assert.equal(state.outbox[rootKey]?.messageId, ROOT_MESSAGE_ID);
        assert.equal(state.outbox[followUpKey], undefined);
      }
      return Response.json({ ret: 0 });
    } });
  const gateway = new WeChatGateway({ stateManager: state, ilink, controller, replyEngine: {
    requestBudgetMs: 1000,
    async reply(_account, request) {
      assert.equal(request.messageId, ROOT_MESSAGE_ID);
      return { text: FINAL_TEXT, images: [IMAGE], imageSourceMessageId: IMAGE_SOURCE_MESSAGE_ID };
    },
    async getReply() { throw new Error("Fresh delivery must use the live engine result"); },
    async ackReply(_account, chatId, messageId, status) { acknowledgements.push({ chatId, messageId, status }); },
  } });
  const summary = await gateway.pollOnce();
  assert.equal(summary.processedCount, 1);
  assert.deepEqual(downloads, [{ chatId: CHAT_ID, messageId: IMAGE_SOURCE_MESSAGE_ID, image: IMAGE }]);
  assert.deepEqual(sentTypes, [2, 1]);
  assert.deepEqual(acknowledgements, [{ chatId: CHAT_ID, messageId: ROOT_MESSAGE_ID, status: "accepted" }]);
  assert.equal(state.isMessageProcessed(rootKey), true);
  assert.equal(state.replyDeliveries[`image-reply:${rootKey}`]?.acknowledgedChunks, 1);
  assert.equal(state.replyDeliveries[rootKey]?.acknowledgedChunks, 1);
  assert.equal(state.replyDeliveries[followUpKey], undefined);
  assert.equal(state.outbox[rootKey], undefined);
});
