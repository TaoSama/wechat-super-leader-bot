import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { StateManager, MAX_PROCESSED_MESSAGE_KEYS } from "../../src/runtime/state.js";
import { ILinkClient } from "../../src/wechat/client.js";
import { ControllerClient } from "../../src/controller/client.js";
import { WeChatGateway } from "../../src/gateway.js";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const image = { id: "screenshot-1", mime: "image/png", size: png.length,
  sha256: createHash("sha256").update(png).digest("hex") };

function fixture(t: TestContext, includeFollowingChat = false, images = [image]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-image-poll-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credentials = path.join(directory, "account.json"), statePath = path.join(directory, "state.json");
  fs.writeFileSync(credentials, JSON.stringify({ token: "synthetic", accountId: "fixture" }));
  const sent: number[] = [], events: string[] = [];
  const forwarded: string[] = [], downloaded: string[] = [], sentChats: string[] = [];
  let failure: "image" | "text" | undefined;
  let downloadFailureStatus: number | undefined;
  let downloadFailureImageId: string | undefined;
  const ilinkFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/c2c/upload") {
      events.push("cdn-upload");
      return new Response(null, { headers: { "x-encrypted-param": "synthetic" } });
    }
    if (url.pathname.endsWith("getupdates")) return Response.json({ ret: 0, get_updates_buf: "next", msgs: [{
      message_type: 1, from_user_id: "chat", client_id: "message", context_token: "context",
      item_list: [{ type: 1, text_item: { text: "截图" } }],
    }, ...(includeFollowingChat ? [{ message_type: 1, from_user_id: "following-chat", client_id: "following-message",
      context_token: "following-context", item_list: [{ type: 1, text_item: { text: "正常任务" } }] }] : [])] });
    if (url.pathname.endsWith("getconfig")) return Response.json({ ret: 0, typing_ticket: "ticket" });
    if (url.pathname.endsWith("sendtyping")) return Response.json({ ret: 0 });
    if (url.pathname.endsWith("getuploadurl")) return Response.json({ ret: 0, upload_param: "synthetic" });
    assert.ok(url.pathname.endsWith("sendmessage"));
    const body = JSON.parse(String(init?.body));
    const type = body.msg.item_list[0].type;
    sentChats.push(body.msg.to_user_id);
    sent.push(type); events.push(`send:${type}`);
    if (type === 2 && failure === "image") throw new Error("ambiguous image send");
    if (type === 1 && failure === "text") return Response.json({ ret: -1 });
    return Response.json({ ret: 0 });
  };
  const controllerFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/chats/authorize") return Response.json({ allowed: true });
    if (init?.method === "GET") {
      events.push("download");
      const attachment = images.find(item => url.pathname === `/v1/messages/message/images/${item.id}`);
      assert.ok(attachment);
      downloaded.push(attachment.id);
      assert.equal(url.searchParams.get("chatId"), "chat");
      if (downloadFailureStatus !== undefined && (!downloadFailureImageId || attachment.id === downloadFailureImageId)) {
        return new Response(null, { status: downloadFailureStatus });
      }
      return new Response(new Uint8Array(png), { headers: { "content-type": "image/png" } });
    }
    const chatId = JSON.parse(String(init?.body)).chatId;
    forwarded.push(chatId);
    if (chatId === "following-chat") return Response.json({ text: "正常回复" });
    return Response.json({ text: "截图已发送", images });
  };
  const state = new StateManager(credentials, statePath);
  state.markBaselineEstablished();
  const gateway = (manager = state) => new WeChatGateway({ stateManager: manager,
    ilink: new ILinkClient({ stateManager: manager, fetchImpl: ilinkFetch }),
    controller: new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic", fetchImpl: controllerFetch }) });
  return { state, sent, events, forwarded, downloaded, sentChats, gateway, reload: () => new StateManager(credentials, statePath),
    failDownload: (status?: number, imageId?: string) => { downloadFailureStatus = status; downloadFailureImageId = imageId; },
    fail: (value: typeof failure) => { failure = value; } };
}

test("poll sends image before completion text and checkpoints only after both receipts", async t => {
  const f = fixture(t);
  const result = await f.gateway().pollOnce();
  assert.equal(result.processedCount, 1);
  assert.equal(f.state.syncBuf, "next");
  assert.deepEqual(f.sent, [2, 1]);
  assert.deepEqual(f.events, ["download", "cdn-upload", "send:2", "send:1"]);
  await f.gateway().pollOnce();
  assert.deepEqual(f.sent, [2, 1]);
});

test("uncertain image is quarantined with evidence and never emits completion text or repeats after restart", async t => {
  const f = fixture(t);
  f.fail("image");
  const result = await f.gateway().pollOnce();
  assert.equal(result.processedCount, 0);
  assert.equal(result.skippedCount, 1);
  assert.equal(f.state.syncBuf, "next");
  assert.deepEqual(f.sent, [2]);
  assert.equal(Object.values(f.state.replyDeliveries).filter(item => item.inFlight).length, 1);
  f.fail(undefined);
  const resumed = f.reload();
  await f.gateway(resumed).pollOnce();
  assert.equal(Object.values(resumed.replyDeliveries).filter(item => item.inFlight).length, 1);
  assert.deepEqual(f.sent, [2]);
  assert.equal(f.events.filter(event => event === "download").length, 1);
});

test("an uncertain image cannot block a following chat in the same batch", async t => {
  const f = fixture(t, true);
  f.fail("image");
  const result = await f.gateway().pollOnce();
  assert.equal(result.skippedCount, 1);
  assert.equal(result.processedCount, 1);
  assert.equal(f.state.syncBuf, "next");
  assert.deepEqual(f.sent, [2, 1]);
  assert.equal(Object.values(f.state.replyDeliveries).filter(item => item.inFlight).length, 1);
});

test("text rejection resumes text without redownloading or replaying accepted image", async t => {
  const f = fixture(t);
  f.fail("text");
  await assert.rejects(f.gateway().pollOnce(), /RejectedRet/);
  assert.equal(f.state.syncBuf, "");
  f.fail(undefined);
  const state = f.reload();
  await f.gateway(state).pollOnce();
  assert.deepEqual(f.sent, [2, 1, 1]);
  assert.equal(f.events.filter(event => event === "download").length, 1);
  assert.equal(state.syncBuf, "next");
});

test("expired or unavailable attachments persist failure evidence and cannot block following chats or replay after restart", async t => {
  for (const [status, reason] of [[410, "AttachmentExpired"], [404, "AttachmentUnavailable"]] as const) {
    const f = fixture(t, true);
    f.failDownload(status);
    const summary = await f.gateway().pollOnce();
    assert.equal(summary.skippedCount, 1);
    assert.equal(summary.processedCount, 1);
    assert.equal(f.state.syncBuf, "next");
    assert.deepEqual(f.sent, [1], "only the following chat may receive text; the expired image's completion must stay suppressed");
    assert.equal(f.events.includes("cdn-upload"), false);
    const resumed = f.reload();
    assert.ok(Object.values(resumed.replyDeliveries).some(item => "failureReason" in item && item.failureReason === reason));
    assert.ok(Object.values(resumed.replyDeliveries).every(item => !item.inFlight));
    f.failDownload(undefined);
    await f.gateway(resumed).pollOnce();
    assert.equal(f.events.filter(event => event === "download").length, 1);
    assert.deepEqual(f.sent, [1]);
  }
});

test("authentication and server failures remain actionable and do not permanently quarantine an attachment", async t => {
  for (const status of [401, 403, 500, 503]) {
    const f = fixture(t);
    f.failDownload(status);
    await assert.rejects(f.gateway().pollOnce(), new RegExp(`HTTP ${status}`));
    assert.equal(f.state.syncBuf, "");
    assert.deepEqual(f.sent, []);
    assert.ok(Object.values(f.state.replyDeliveries).every(item => !item.inFlight && !("failureReason" in item)));
    f.failDownload(undefined);
    await f.gateway().pollOnce();
    assert.equal(f.state.syncBuf, "next");
    assert.deepEqual(f.sent, [2, 1]);
  }
});

test("an expired second image preserves the first receipt and allows the following chat without completion text or replay", async t => {
  const secondImage = { ...image, id: "screenshot-2" };
  const f = fixture(t, true, [image, secondImage]);
  f.failDownload(410, secondImage.id);
  const summary = await f.gateway().pollOnce();
  assert.equal(summary.skippedCount, 1);
  assert.equal(summary.processedCount, 1);
  assert.equal(f.state.syncBuf, "next");
  assert.deepEqual(f.downloaded, [image.id, secondImage.id]);
  assert.deepEqual(f.sent, [2, 1]);
  assert.deepEqual(f.sentChats, ["chat", "following-chat"], "the failed image reply must not emit completion text");
  assert.deepEqual(f.forwarded, ["chat", "following-chat"]);
  const key = `image-reply:${f.state.computeDeliveryKey("chat", "message")}`;
  assert.deepEqual({ ...f.state.replyDeliveries[key], digest: undefined }, {
    digest: undefined, totalChunks: 2, acknowledgedChunks: 1, inFlight: false, failureReason: "AttachmentExpired",
  });
  const resumed = f.reload();
  assert.equal(resumed.replyDeliveries[key].acknowledgedChunks, 1);
  assert.equal(resumed.replyDeliveries[key].failureReason, "AttachmentExpired");
  f.failDownload(undefined);
  await f.gateway(resumed).pollOnce();
  assert.deepEqual(f.downloaded, [image.id, secondImage.id]);
  assert.deepEqual(f.sent, [2, 1]);
  assert.deepEqual(f.forwarded, ["chat", "following-chat"]);
});

test("permanent image failure remains quarantined after its processed key is evicted and state is reloaded", async t => {
  const f = fixture(t);
  f.failDownload(410);
  assert.equal((await f.gateway().pollOnce()).skippedCount, 1);
  const key = f.state.computeDeliveryKey("chat", "message"), imageKey = `image-reply:${key}`;
  assert.equal(f.state.isMessageProcessed(key), true);
  f.state.processedMessageKeys.push(...Array.from({ length: MAX_PROCESSED_MESSAGE_KEYS }, (_, index) => `later-message-${index}`));
  f.state.recordProcessedMessageKey("last-message");
  assert.equal(f.state.processedMessageKeys.length, MAX_PROCESSED_MESSAGE_KEYS);
  assert.equal(f.state.isMessageProcessed(key), false);
  const resumed = f.reload();
  assert.equal(resumed.isMessageProcessed(key), false, "the replay must reach the durable reply quarantine check");
  assert.equal(resumed.hasPermanentReplyFailure(imageKey), true);
  const before = { forwarded: [...f.forwarded], downloaded: [...f.downloaded], sent: [...f.sent] };
  f.failDownload(undefined);
  const replay = await f.gateway(resumed).pollOnce();
  assert.equal(replay.polledCount, 1);
  assert.equal(replay.skippedCount, 1);
  assert.equal(replay.processedCount, 0);
  assert.equal(resumed.isMessageProcessed(key), true);
  assert.equal(resumed.hasPermanentReplyFailure(imageKey), true);
  assert.deepEqual({ forwarded: f.forwarded, downloaded: f.downloaded, sent: f.sent }, before);
});
