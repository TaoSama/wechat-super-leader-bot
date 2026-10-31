import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { StateManager } from "../../src/runtime/state.js";
import { ControllerClient } from "../../src/controller/client.js";
import { ILinkClient } from "../../src/wechat/client.js";
import { WeChatGateway } from "../../src/gateway.js";

test("real local HTTP: budget defers, new inbound refreshes, restart GET resumes frozen chunks without re-POST", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-http-outbox-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const account = path.join(directory, "account.json"), statePath = path.join(directory, "state.json");
  fs.writeFileSync(account, JSON.stringify({ token: "synthetic", accountId: "synthetic" }));
  const requests: string[] = [], sends: string[] = [];
  const timestamp = Date.now() - 1000;
  let page = 1;
  const server = http.createServer((req, res) => {
    void (async () => {
      let body = "";
      for await (const chunk of req) body += String(chunk);
      const input = body ? JSON.parse(body) as Record<string, any> : {};
      requests.push(`${req.method} ${req.url}`);
      const send = (value: unknown) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
      if (req.url === "/ilink/bot/getupdates") {
        send({ ret: 0, get_updates_buf: `cursor-${page}`, msgs: [{ message_type: 1, from_user_id: "chat", client_id: `m${page}`,
          create_time_ms: timestamp + page, context_token: `context-${page}`, item_list: [{ type: 1, text_item: { text: "request" } }] }] });
      } else if (req.url === "/ilink/bot/getconfig") send({ ret: 0, typing_ticket: "ticket" });
      else if (req.url === "/ilink/bot/sendtyping") send({ ret: 0 });
      else if (req.url === "/ilink/bot/sendmessage") { sends.push(input.msg.item_list[0].text_item.text); send({ ret: 0 }); }
      else if (req.url === "/v1/chats/authorize") send({ allowed: true });
      else if (req.url === "/v1/messages" && req.method === "POST") send({ text: input.messageId === "m1" ? "abcdef" : "" });
      else if (req.url === "/v1/messages/m1/reply?chatId=chat" && req.method === "GET") send({ text: "abcdef" });
      else { res.statusCode = 404; send({}); }
    })().catch(error => { res.statusCode = 500; res.end(String(error)); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const create = (state: StateManager, splitMaxChars: number) => new WeChatGateway({ stateManager: state, splitMaxChars,
    controller: new ControllerClient({ controllerUrl: baseUrl, controllerToken: "synthetic" }),
    ilink: new ILinkClient({ stateManager: state, configuredBaseUrl: "https://synthetic.example", fetchImpl: (input, init) =>
      fetch(`${baseUrl}${new URL(String(input)).pathname}`, init) }) });
  const state = new StateManager(account, statePath, { sendBudget: 2, outboxLimit: 1 });
  state.markBaselineEstablished();
  await create(state, 2).pollOnce();
  const key = state.computeDeliveryKey("chat", "m1");
  assert.deepEqual(sends, ["ab", "cd"]);
  assert.equal(state.syncBuf, "cursor-1");
  assert.equal(state.outbox[key].status, "pending");
  assert.equal(state.replyDeliveries[key].acknowledgedChunks, 2);
  assert.equal(state.replyDeliveries[key].inFlight, false);
  assert.equal(state.outbox[key].splitMaxChars, 2);
  assert.equal(fs.readFileSync(statePath, "utf8").includes("abcdef"), false);
  page = 2;
  const restarted = new StateManager(account, statePath, { sendBudget: 2, outboxLimit: 1 });
  const remove = restarted.removeOutbox.bind(restarted);
  t.mock.method(restarted, "removeOutbox", (deliveryKey: string) => {
    if (deliveryKey === key) throw new Error("injected reference cleanup failure");
    remove(deliveryKey);
  });
  await assert.rejects(create(restarted, 1).pollOnce(), /cleanup failure/);
  assert.deepEqual(sends, ["ab", "cd", "ef"]);
  assert.equal(restarted.outbox[key].status, "pending");
  assert.equal(restarted.replyDeliveries[key].acknowledgedChunks, 3);
  const completed = new StateManager(account, statePath, { sendBudget: 1 });
  assert.equal(completed.canSendToChat("chat"), false);
  await create(completed, 1).pollOnce();
  assert.equal(completed.outbox[key], undefined);
  assert.deepEqual(sends, ["ab", "cd", "ef"]);
  assert.equal(requests.filter(item => item === "POST /v1/messages").length, 2);
  assert.equal(requests.filter(item => item === "GET /v1/messages/m1/reply?chatId=chat").length, 1);
  assert.equal(restarted.syncBuf, "cursor-1");
  assert.equal(completed.syncBuf, "cursor-2");
});

test("unknown legacy context queues reply without creating window or blocking another chat", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-legacy-context-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const account = path.join(directory, "account.json");
  fs.writeFileSync(account, JSON.stringify({ token: "synthetic", accountId: "synthetic" }));
  const state = new StateManager(account);
  state.markBaselineEstablished();
  state.setContextToken("legacy", "old-context");
  state.recordInboundContext("prior", "without-token", Date.now() - 2000, true, "prior-context");
  for (let count = 0; count < 9; count++) state.consumeSendBudget("without-token");
  const posts: string[] = [], sends: string[] = [];
  const ilink = new ILinkClient({ stateManager: state, fetchImpl: async (url, init) => {
    if (String(url).endsWith("getupdates")) return Response.json({ ret: 0, get_updates_buf: "next", msgs: [
      { message_type: 1, from_user_id: "legacy", client_id: "old", item_list: [{ type: 1, text_item: { text: "legacy" } }] },
      { message_type: 1, from_user_id: "fresh", client_id: "new", context_token: "new-context", create_time_ms: Date.now() - 1000,
        item_list: [{ type: 1, text_item: { text: "fresh" } }] },
      { message_type: 1, from_user_id: "without-token", client_id: "new-no-token", create_time_ms: Date.now() - 1000,
        item_list: [{ type: 1, text_item: { text: "no new context" } }] },
    ] });
    if (String(url).endsWith("getconfig")) return Response.json({ ret: 0, typing_ticket: "ticket" });
    if (String(url).endsWith("sendtyping")) return Response.json({ ret: 0 });
    sends.push(JSON.parse(String(init?.body)).msg.to_user_id);
    return Response.json({ ret: 0 });
  } });
  const controller = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic", fetchImpl: async (url, init) => {
    if (String(url).endsWith("authorize")) return Response.json({ allowed: true });
    posts.push(JSON.parse(String(init?.body)).chatId);
    return Response.json({ text: "reply" });
  } });
  await new WeChatGateway({ stateManager: state, controller, ilink }).pollOnce();
  assert.deepEqual(posts, ["legacy", "fresh", "without-token"]);
  assert.deepEqual(sends, ["fresh", "without-token"]);
  assert.equal(state.accountSendBudget!.remaining, 8, "both replies charge the single grant from the fresh recipient");
  assert.equal(state.contextWindows["without-token"].lastInboundKey, "prior", "tokenless input cannot open a new recipient window");
  assert.equal(state.contextTokens["without-token"], "prior-context");
  assert.equal(state.canSendToChat("legacy"), false);
  assert.equal(state.syncBuf, "next");
  assert.equal(Object.values(state.outbox)[0].chatId, "legacy");
});
