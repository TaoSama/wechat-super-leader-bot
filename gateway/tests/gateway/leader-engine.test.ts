import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateManager } from "../../src/runtime/state.js";
import { ILinkClient } from "../../src/wechat/client.js";
import { ControllerClient } from "../../src/controller/client.js";
import { WeChatGateway } from "../../src/gateway.js";

for (const allowed of [true, false]) {
  test(`Codex reply engine is ${allowed ? 'used and checkpointed' : 'never invoked for an unauthorized chat'}`, async t => {
    const root = mkdtempSync(join(tmpdir(), "leader-gateway-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const credentials = join(root, "account.json");
    writeFileSync(credentials, JSON.stringify({ token: "fake", accountId: "account" }));
    const state = new StateManager(credentials, join(root, "state.json"));
    state.markBaselineEstablished();
    const calls: string[] = [];
    const replies: string[] = [];
    const controller = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "fake",
      fetchImpl: async (url, init) => {
        assert.ok(String(url).endsWith("/v1/chats/authorize"));
        calls.push("authorize");
        return new Response(JSON.stringify(allowed ? { allowed: true } : { code: "CHAT_NOT_ALLOWED" }), { status: allowed ? 200 : 403 });
      } });
    const ilink = new ILinkClient({ stateManager: state, configuredBaseUrl: "https://ilink.example",
      fetchImpl: async (url, init) => {
        if (String(url).endsWith("getupdates")) return new Response(JSON.stringify({ ret: 0, get_updates_buf: "next", msgs: [{
          message_type: 1, from_user_id: "chat", client_id: "message", context_token: "ctx",
          item_list: [{ type: 1, text_item: { text: "记住我喜欢简短回复" } }],
        }] }));
        if (String(url).endsWith("getconfig")) return new Response(JSON.stringify({ ret: 0, typing_ticket: "ticket" }));
        if (String(url).endsWith("sendtyping")) return new Response(JSON.stringify({ ret: 0 }));
        if (String(url).endsWith("sendmessage")) {
          replies.push(JSON.parse(String(init?.body)).msg.item_list[0].text_item.text);
          return new Response(JSON.stringify({ ret: 0 }));
        }
        throw new Error("Unexpected synthetic WeChat route");
      } });
    const gateway = new WeChatGateway({ stateManager: state, ilink, controller, replyEngine: {
      requestBudgetMs: 1000,
      async reply(accountId, request, client) {
        calls.push("codex");
        assert.equal(accountId, "account");
        assert.equal(request.text, "记住我喜欢简短回复");
        assert.equal(request.chatId, "chat");
        assert.equal(request.messageId, "message");
        assert.equal(client, controller);
        return { text: "已经记下简短回复的偏好。" };
      },
    } });
    const first = await gateway.pollOnce();
    assert.deepEqual(calls, allowed ? ["authorize", "codex"] : ["authorize"]);
    assert.deepEqual(replies, allowed ? ["已经记下简短回复的偏好。"] : []);
    assert.equal(first.processedCount, allowed ? 1 : 0);
    assert.equal(state.syncBuf, "next");
    await gateway.pollOnce();
    assert.equal(calls.length, allowed ? 2 : 1);
  });
}
