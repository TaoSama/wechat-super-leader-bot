import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateManager } from "../../src/runtime/state.js";
import { ControllerClient } from "../../src/controller/client.js";
import { ILinkClient } from "../../src/wechat/client.js";
import { UNSUPPORTED_MEDIA_REPLY, WeChatGateway } from "../../src/gateway.js";
import { LocalSendDeferredError } from "../../src/runtime/context-policy.js";
import { FileInboundInbox } from "../../src/runtime/inbox.js";

const CHAT = "chat";
const imageMessage = (id: string) => ({ message_type: 1, from_user_id: CHAT, client_id: id, context_token: `ctx-${id}`,
  create_time_ms: Date.now() - 1000, item_list: [{ type: 2, image_item: { mid_size: 16 } }] });
const textMessage = (id: string, text: string) => ({ ...imageMessage(id), item_list: [{ type: 1, text_item: { text } }] });

function fixture(t: TestContext, options: { allowed?: boolean } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-unsupported-media-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const accountPath = path.join(directory, "account.json"), statePath = path.join(directory, "state.json");
  fs.writeFileSync(accountPath, JSON.stringify({ token: "synthetic", accountId: "synthetic" }));
  const sends: string[] = [], requests: string[] = [];
  let pages: unknown[][] = [];
  const ilink = (state: StateManager) => new ILinkClient({ stateManager: state, configuredBaseUrl: "https://wechat.example",
    fetchImpl: async (url, init) => {
      const endpoint = new URL(String(url)).pathname;
      requests.push(endpoint);
      if (endpoint.endsWith("getupdates")) {
        return Response.json({ ret: 0, get_updates_buf: `cursor-${requests.length}`, msgs: pages.shift() ?? [] });
      }
      if (endpoint.endsWith("getconfig")) return Response.json({ ret: 0, typing_ticket: "ticket" });
      if (endpoint.endsWith("sendtyping")) return Response.json({ ret: 0 });
      if (endpoint.endsWith("sendmessage")) {
        sends.push(JSON.parse(String(init?.body)).msg.item_list[0].text_item.text);
        return Response.json({ ret: 0 });
      }
      throw new Error(`Unexpected WeChat endpoint ${endpoint}`);
    } });
  const controller = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic",
    fetchImpl: async url => {
      const endpoint = new URL(String(url)).pathname;
      requests.push(endpoint);
      if (endpoint === "/v1/chats/authorize") {
        return options.allowed === false ? Response.json({ code: "CHAT_NOT_ALLOWED" }, { status: 403 }) : Response.json({ allowed: true });
      }
      if (endpoint === "/v1/messages") return Response.json({ text: "文字回复" });
      throw new Error(`Unexpected Controller endpoint ${endpoint}`);
    } });
  const state = () => new StateManager(accountPath, statePath);
  const gateway = (manager: StateManager) => new WeChatGateway({ stateManager: manager, ilink: ilink(manager), controller });
  return { sends, requests, statePath, state, gateway, setPages: (next: unknown[][]) => { pages = next; } };
}

test("image-only inbound gets one fixed notice without a Controller turn", async t => {
  const f = fixture(t);
  const state = f.state();
  state.markBaselineEstablished();
  f.setPages([[imageMessage("img"), imageMessage("img")], [imageMessage("img")]]);
  const gateway = f.gateway(state);
  const first = await gateway.pollOnce();
  assert.equal(first.processedCount, 1);
  assert.equal((await gateway.pollOnce()).processedCount, 0);
  assert.deepEqual(f.sends, [UNSUPPORTED_MEDIA_REPLY]);
  assert.equal(f.requests.includes("/v1/messages"), false);
  const key = state.computeDeliveryKey(CHAT, "img");
  assert.equal(state.isMessageProcessed(key), true);
  assert.equal(state.outbox[key], undefined);
  assert.equal(state.contextTokens[CHAT], "ctx-img", "a real inbound refreshes the reply context");
});

test("a deferred notice is recovered once after restart and never re-sent for a replay", async t => {
  const f = fixture(t);
  const state = f.state();
  state.markBaselineEstablished();
  f.setPages([[imageMessage("img")]]);
  const gateway = f.gateway(state);
  t.mock.method(gateway.ilink, "sendMarkdownReply", async () => { throw new LocalSendDeferredError("budget_exhausted"); });
  await gateway.pollOnce();
  const key = state.computeDeliveryKey(CHAT, "img");
  assert.equal(state.outbox[key]?.source, "unsupported-media");
  assert.equal(state.outbox[key]?.status, "pending");
  assert.deepEqual(f.sends, []);

  const restored = f.state();
  const restarted = f.gateway(restored);
  await restarted.flushRepliesOnce();
  assert.deepEqual(f.sends, [UNSUPPORTED_MEDIA_REPLY]);
  assert.equal(restored.outbox[key], undefined);
  f.setPages([[imageMessage("img")]]);
  await restarted.pollOnce();
  await restarted.flushRepliesOnce();
  assert.deepEqual(f.sends, [UNSUPPORTED_MEDIA_REPLY]);
  assert.equal(f.requests.includes("/v1/messages"), false);
});

test("a notice whose send completed before a crash is not delivered again", async t => {
  const f = fixture(t);
  const state = f.state();
  state.markBaselineEstablished();
  f.setPages([[imageMessage("img")]]);
  const key = state.computeDeliveryKey(CHAT, "img");
  const remove = state.removeOutbox.bind(state);
  t.mock.method(state, "removeOutbox", (deliveryKey: string) => {
    if (deliveryKey === key) throw new Error("injected crash before outbox cleanup");
    remove(deliveryKey);
  });
  await assert.rejects(f.gateway(state).pollOnce(), /injected crash/);
  assert.deepEqual(f.sends, [UNSUPPORTED_MEDIA_REPLY]);
  const restored = f.state();
  await f.gateway(restored).flushRepliesOnce();
  assert.equal(restored.outbox[key], undefined);
  assert.deepEqual(f.sends, [UNSUPPORTED_MEDIA_REPLY]);
});

test("unauthorized chats and baseline history never receive the notice", async t => {
  const denied = fixture(t, { allowed: false });
  const state = denied.state();
  state.markBaselineEstablished();
  denied.setPages([[imageMessage("img")]]);
  assert.equal((await denied.gateway(state).pollOnce()).skippedCount, 1);
  assert.deepEqual(denied.sends, []);
  assert.equal(state.isMessageProcessed(state.computeDeliveryKey(CHAT, "img")), true);

  const history = fixture(t);
  const fresh = history.state();
  history.setPages([[imageMessage("old")], []]);
  const gateway = history.gateway(fresh);
  await gateway.establishBaseline();
  history.setPages([[imageMessage("old")]]);
  await gateway.pollOnce();
  assert.deepEqual(history.sends, []);
  assert.equal(history.requests.includes("/v1/chats/authorize"), false);
});

test("unsupported content arriving during a running turn is not steered and is answered after it", { timeout: 30_000 }, async t => {
  const f = fixture(t);
  const state = f.state();
  state.markBaselineEstablished();
  let started!: () => void, release!: () => void;
  const running = new Promise<void>(resolve => { started = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const steered: string[] = [], failures: Error[] = [];
  let polls = 0;
  const gateway: WeChatGateway = new WeChatGateway({ stateManager: state, ilink: new ILinkClient({ stateManager: state,
    configuredBaseUrl: "https://wechat.example", fetchImpl: async (url, init) => {
      const endpoint = new URL(String(url)).pathname;
      if (endpoint.endsWith("getupdates")) {
        polls++;
        if (polls === 1) return Response.json({ ret: 0, get_updates_buf: "one", msgs: [textMessage("text", "查一下部署")] });
        if (polls === 2) {
          await running;
          return Response.json({ ret: 0, get_updates_buf: "two", msgs: [imageMessage("img")] });
        }
        // The image is durable in the inbox by now; let the running turn finish.
        release();
        await new Promise(resolve => setTimeout(resolve, 1));
        return Response.json({ ret: 0, get_updates_buf: "done", msgs: [] });
      }
      if (endpoint.endsWith("getconfig")) return Response.json({ ret: 0, typing_ticket: "ticket" });
      if (endpoint.endsWith("sendtyping")) return Response.json({ ret: 0 });
      if (endpoint.endsWith("sendmessage")) {
        f.sends.push(JSON.parse(String(init?.body)).msg.item_list[0].text_item.text);
        if (f.sends.length === 2) gateway.stop();
        return Response.json({ ret: 0 });
      }
      throw new Error(`Unexpected WeChat endpoint ${endpoint}`);
    } }),
    controller: new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic",
      fetchImpl: async url => {
        if (String(url).endsWith("/v1/chats/authorize")) return Response.json({ allowed: true });
        if (String(url).endsWith("/v1/notifications/pending")) return Response.json({ items: [] });
        throw new Error(`Unexpected Controller endpoint ${new URL(String(url)).pathname}`);
      } }),
    replyEngine: {
      requestBudgetMs: 1000,
      async reply() { started(); await blocked; return { text: "部署正常" }; },
      async steer(_account, request) { steered.push(request.text); return true; },
      async getReply() { throw new Error("Live query must not be read as a completed reply"); },
      async ackReply() {},
    } });
  t.after(() => { release(); gateway.stop(); });
  await gateway.runLoop(1, error => { failures.push(error); release(); gateway.stop(); });
  assert.deepEqual(failures, []);
  assert.deepEqual(steered, []);
  assert.deepEqual(f.sends, ["部署正常", UNSUPPORTED_MEDIA_REPLY]);
  assert.equal(state.isMessageProcessed(state.computeDeliveryKey(CHAT, "img")), true);
  assert.deepEqual(new FileInboundInbox(`${f.statePath}.inbox.json`, () => state.getLoginFingerprint(), 1000).list(), []);
});
