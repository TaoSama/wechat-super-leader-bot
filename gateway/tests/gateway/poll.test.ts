import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../../src/runtime/state.js";
import { ILinkClient } from "../../src/wechat/client.js";
import { ControllerClient } from "../../src/controller/client.js";
import { WeChatGateway } from "../../src/gateway.js";

test("WeChatGateway end-to-end pollOnce, deduplication across chats, and cursor checkpointing", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-e2e-"));
  const credPath = path.join(tmpDir, "account.json");
  const statePath = path.join(tmpDir, "state.json");
  fs.writeFileSync(credPath, JSON.stringify({ token: "bot-tok", accountId: "bot-acc", baseUrl: "https://ilink.example" }));

  const sentToWeChat: Array<{ to: string; text: string; contextToken: string }> = [];
  const forwardedToController: Array<{ chatId: string; messageId: string; text: string }> = [];

  const ilinkFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body || "{}"));
    if (url.endsWith("/ilink/bot/getupdates")) {
      return new Response(JSON.stringify({
        ret: 0,
        errcode: 0,
        get_updates_buf: "cursor-after-batch-1",
        msgs: [
          {
            message_type: 1,
            from_user_id: "chat-a",
            client_id: "same-client-id",
            context_token: "ctx-a",
            item_list: [{ type: 1, text_item: { text: "status on macair" } }],
          },
          {
            message_type: 1,
            from_user_id: "chat-b",
            client_id: "same-client-id",
            context_token: "ctx-b",
            item_list: [{ type: 1, text_item: { text: "hello from b" } }],
          },
        ],
      }), { status: 200 });
    }
    if (url.endsWith("/ilink/bot/sendmessage")) {
      sentToWeChat.push({
        to: body.msg.to_user_id,
        text: body.msg.item_list[0].text_item.text,
        contextToken: body.msg.context_token,
      });
      return new Response(JSON.stringify({ ret: 0, errcode: 0 }), { status: 200 });
    }
    throw new Error("unexpected URL " + url);
  };

  const controllerFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    forwardedToController.push(body);
    return new Response(JSON.stringify({ text: "**Reply** to " + body.chatId }), { status: 200 });
  };

  const sm = new StateManager(credPath, statePath);
  sm.markBaselineEstablished();

  const ilink = new ILinkClient({ stateManager: sm, fetchImpl: ilinkFetch as typeof globalThis.fetch });
  const ctrl = new ControllerClient({
    controllerUrl: "http://127.0.0.1:8790",
    controllerToken: "ctrl-token",
    fetchImpl: controllerFetch as typeof globalThis.fetch,
  });
  const gateway = new WeChatGateway({ stateManager: sm, ilink, controller: ctrl });

  const summary1 = await gateway.pollOnce();
  assert.equal(summary1.polledCount, 2);
  assert.equal(summary1.processedCount, 2);
  assert.equal(summary1.nextSyncBuf, "cursor-after-batch-1");
  assert.equal(sm.syncBuf, "cursor-after-batch-1");
  assert.equal(forwardedToController.length, 2);
  assert.equal(sentToWeChat.length, 2);
  assert.equal(sentToWeChat[0].text, "Reply to chat-a");
  assert.equal(sentToWeChat[1].text, "Reply to chat-b");

  // Second poll with same messages must deduplicate both and not forward again
  const summary2 = await gateway.pollOnce();
  assert.equal(summary2.polledCount, 0);
  assert.equal(forwardedToController.length, 2);
  assert.equal(sentToWeChat.length, 2);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Poison batch: CHAT_NOT_ALLOWED skips unallowed chat and lets cursor advance for valid chat", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-poison-"));
  const credPath = path.join(tmpDir, "account.json");
  const statePath = path.join(tmpDir, "state.json");
  fs.writeFileSync(credPath, JSON.stringify({ token: "bot-tok", accountId: "bot-acc" }));

  const ilinkFetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/ilink/bot/getupdates")) {
      return new Response(JSON.stringify({
        ret: 0,
        errcode: 0,
        get_updates_buf: "cursor-past-poison",
        msgs: [
          {
            message_type: 1,
            from_user_id: "unauthorized-stranger",
            client_id: "poison-msg-1",
            item_list: [{ type: 1, text_item: { text: "spam" } }],
          },
          {
            message_type: 1,
            from_user_id: "authorized-owner",
            client_id: "valid-msg-2",
            context_token: "ctx-owner",
            item_list: [{ type: 1, text_item: { text: "legit task" } }],
          },
        ],
      }), { status: 200 });
    }
    if (url.endsWith("/ilink/bot/sendmessage")) {
      return new Response(JSON.stringify({ ret: 0, errcode: 0 }), { status: 200 });
    }
    throw new Error("unexpected URL");
  };

  const controllerFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    if (body.chatId === "unauthorized-stranger") {
      return new Response(JSON.stringify({ error: "chat not allowed", code: "CHAT_NOT_ALLOWED" }), { status: 403 });
    }
    return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
  };

  const sm = new StateManager(credPath, statePath);
  sm.markBaselineEstablished();

  const ilink = new ILinkClient({ stateManager: sm, fetchImpl: ilinkFetch as typeof globalThis.fetch });
  const ctrl = new ControllerClient({
    controllerUrl: "http://127.0.0.1:8790",
    controllerToken: "ctrl-token",
    fetchImpl: controllerFetch as typeof globalThis.fetch,
  });
  const gateway = new WeChatGateway({ stateManager: sm, ilink, controller: ctrl });

  const summary = await gateway.pollOnce();
  assert.equal(summary.polledCount, 2);
  assert.equal(summary.processedCount, 1);
  assert.equal(summary.skippedCount, 1);
  assert.equal(summary.nextSyncBuf, "cursor-past-poison");
  assert.equal(sm.syncBuf, "cursor-past-poison");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Multi-part reply partial failure resumes from unsent chunk without duplicating sent chunks or advancing cursor prematurely", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-multipart-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const credPath = path.join(tmpDir, "account.json");
  const statePath = path.join(tmpDir, "state.json");
  fs.writeFileSync(credPath, JSON.stringify({ token: "bot-tok", accountId: "bot-acc" }));

  const sentChunks: Array<{ text: string; clientId: string }> = [];
  let failSecondChunkOnce = true;

  const ilinkFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body || "{}"));
    if (url.endsWith("/ilink/bot/getupdates")) {
      return new Response(JSON.stringify({
        ret: 0,
        errcode: 0,
        get_updates_buf: "cursor-next",
        msgs: [
          {
            message_type: 1,
            from_user_id: "owner",
            client_id: "msg-multipart-1",
            context_token: "ctx-owner",
            item_list: [{ type: 1, text_item: { text: "give long output" } }],
          },
        ],
      }), { status: 200 });
    }
    if (url.endsWith("/ilink/bot/sendmessage")) {
      const text = body.msg.item_list[0].text_item.text;
      const clientId = body.msg.client_id;
      if (text === "Part2\n" && failSecondChunkOnce) {
        failSecondChunkOnce = false;
        throw new Error("simulated network drop on chunk 2");
      }
      sentChunks.push({ text, clientId });
      return new Response(JSON.stringify({ ret: 0, errcode: 0 }), { status: 200 });
    }
    throw new Error("unexpected URL " + url);
  };

  const controllerFetch = async () => {
    return new Response(JSON.stringify({ text: "Part1\nPart2\nPart3" }), { status: 200 });
  };

  const sm1 = new StateManager(credPath, statePath);
  sm1.markBaselineEstablished();

  const ilink1 = new ILinkClient({ stateManager: sm1, fetchImpl: ilinkFetch as typeof globalThis.fetch });
  const ctrl1 = new ControllerClient({
    controllerUrl: "http://127.0.0.1:8790",
    controllerToken: "ctrl-token",
    fetchImpl: controllerFetch as typeof globalThis.fetch,
  });
  // Set maxChars=6; separators remain part of each transmitted fragment.
  const gw1 = new WeChatGateway({ stateManager: sm1, ilink: ilink1, controller: ctrl1, splitMaxChars: 6 });

  await assert.rejects(() => gw1.pollOnce(), /simulated network drop on chunk 2/);
  assert.equal(sm1.syncBuf, "");
  assert.deepEqual(sentChunks.map((c) => c.text), ["Part1\n"]);

  // Simulate restart by loading a fresh StateManager from disk
  const sm2 = new StateManager(credPath, statePath);
  assert.equal(sm2.baselineEstablished, true);
  assert.equal(sm2.syncBuf, "");
  const ilink2 = new ILinkClient({ stateManager: sm2, fetchImpl: ilinkFetch as typeof globalThis.fetch });
  const ctrl2 = new ControllerClient({
    controllerUrl: "http://127.0.0.1:8790",
    controllerToken: "ctrl-token",
    fetchImpl: controllerFetch as typeof globalThis.fetch,
  });
  const gw2 = new WeChatGateway({ stateManager: sm2, ilink: ilink2, controller: ctrl2, splitMaxChars: 6 });

  const summary = await gw2.pollOnce();
  assert.equal(summary.processedCount, 1);
  assert.equal(sm2.syncBuf, "cursor-next");
  assert.deepEqual(sentChunks.map((c) => c.text), ["Part1\n", "Part2\n", "Part3"]);
  assert.equal(sentChunks.map((c) => c.text).join(""), "Part1\nPart2\nPart3");
  assert.deepEqual(sm2.sentReplyProgress, {});

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
