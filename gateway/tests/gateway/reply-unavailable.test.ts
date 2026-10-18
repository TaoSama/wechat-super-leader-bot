import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ControllerClient } from "../../src/controller/client.js";
import { StateManager } from "../../src/runtime/state.js";
import { ILinkClient } from "../../src/wechat/client.js";
import { WeChatGateway } from "../../src/gateway.js";
import { notification } from "../fixtures/notification-fixtures.js";

const OLD_MESSAGE = "old-message";
const SYNTHETIC_TOKEN = "synthetic";
const DIGEST = "a".repeat(64);

async function mockController(t: TestContext, initialStatus: number | "network") {
  let status = initialStatus;
  let beforeReply: (() => void) | undefined;
  const requests: { method: string; pathname: string; body: Record<string, unknown> }[] = [];
  const progress = { ...notification(2, "chat"), source: notification().source, kind: "progress" as const,
    progress: { sequence: 1, eventKey: "progress:1" } };
  const server = http.createServer((request, response) => {
    void (async () => {
      let raw = "";
      for await (const chunk of request) raw += String(chunk);
      const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      const pathname = new URL(request.url!, "http://localhost").pathname;
      requests.push({ method: request.method!, pathname, body });
      const send = (value: unknown, code = 200) => {
        response.writeHead(code, { "Content-Type": "application/json" });
        response.end(JSON.stringify(value));
      };
      if (pathname === `/v1/messages/${OLD_MESSAGE}/reply`) {
        beforeReply?.();
        if (status === "network") { request.socket.destroy(); return; }
        send(status === 200 ? { text: "recovered" } : { private: "sensitive_body" }, status);
      } else if (pathname.startsWith("/v1/messages/") && pathname.endsWith("/reply")) send({ text: "healthy reply" });
      else if (pathname === "/v1/messages") send({ text: "fresh reply" });
      else if (pathname === "/v1/chats/authorize") send({ allowed: true });
      else if (pathname === "/v1/notifications/pending") {
        send({ items: progress.status === "pending" && (body.chatIds as string[]).includes(progress.chatId) ? [progress] : [] });
      } else if (pathname.endsWith("/claim")) {
        const attemptedAt = Date.now();
        Object.assign(progress, { status: "claimed", attemptId: body.attemptId,
          attemptedAt, attemptExpiresAt: attemptedAt + 60_000 });
        send({ notification: progress });
      } else if (pathname.endsWith("/receipt")) {
        Object.assign(progress, { status: body.status });
        send({ notification: progress });
      } else send({}, 404);
    })().catch(error => { response.writeHead(500); response.end(error instanceof Error ? error.name : "MockControllerError"); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { controller: new ControllerClient({ controllerUrl: `http://127.0.0.1:${address.port}`, controllerToken: SYNTHETIC_TOKEN }),
    requests, progress, setStatus: (next: typeof status) => { status = next; },
    setBeforeReply: (hook: () => void) => { beforeReply = hook; } };
}

async function fixture(t: TestContext, status: number | "network") {
  const mock = await mockController(t, status);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-unavailable-reply-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const accountPath = path.join(directory, "account.json"), statePath = path.join(directory, "state.json");
  fs.writeFileSync(accountPath, JSON.stringify({ token: SYNTHETIC_TOKEN, accountId: "fixture" }));
  const state = new StateManager(accountPath, statePath);
  state.markBaselineEstablished();
  for (const chatId of ["chat", "other-chat"]) {
    state.recordInboundContext(`prior:${chatId}`, chatId, Date.now() - 2000, true, `context:${chatId}`);
  }
  const key = state.computeDeliveryKey("chat", OLD_MESSAGE);
  state.putOutbox({ kind: "reply", deliveryKey: key, chatId: "chat", messageId: OLD_MESSAGE,
    splitMaxChars: 100, splitMultiPart: true, status: "pending" });
  const sends: Record<string, unknown>[] = [];
  let freshInbound = false;
  const create = (current = state) => new WeChatGateway({ stateManager: current, controller: mock.controller, notifications: true,
    ilink: new ILinkClient({ stateManager: current, fetchImpl: async (url, init) => {
      if (String(url).endsWith("getupdates")) return Response.json({ ret: 0, get_updates_buf: "next-cursor", msgs: freshInbound ? [{
        message_type: 1, from_user_id: "chat", client_id: "fresh-message", context_token: "fresh-context",
        create_time_ms: Date.now() - 1000, item_list: [{ type: 1, text_item: { text: "fresh request" } }],
      }] : [] });
      if (String(url).endsWith("getconfig")) return Response.json({ ret: 0, typing_ticket: "ticket" });
      if (String(url).endsWith("sendtyping")) return Response.json({ ret: 0 });
      sends.push(JSON.parse(String(init?.body)).msg as Record<string, unknown>);
      return Response.json({ ret: 0 });
    } }) });
  const lookupCount = () => mock.requests.filter(request => request.pathname === `/v1/messages/${OLD_MESSAGE}/reply`).length;
  return { ...mock, state, statePath, accountPath, key, sends, create, lookupCount,
    enableFreshInbound: () => { freshInbound = true; } };
}

for (const status of [403, 404]) test(`HTTP ${status} expires its reply, unblocks same-chat progress and survives restart with acknowledgements`, async t => {
  const f = await fixture(t, status);
  for (const key of [f.key, `image-reply:${f.key}`]) {
    f.state.prepareReplyDelivery(key, DIGEST, 2);
    f.state.beginReplyChunk(key, 0);
    f.state.confirmReplyChunk(key, 0);
  }
  const deliveries = structuredClone(f.state.replyDeliveries), chunks = { ...f.state.sentReplyProgress };
  const gateway = f.create();
  assert.deepEqual(await gateway.deliverNotificationsOnce(), { accepted: 1, uncertain: 0, skipped: 0 });
  assert.equal(f.state.outbox[f.key].status, "expired");
  assert.equal(f.progress.status, "accepted");
  assert.equal(f.sends[0].to_user_id, "chat");
  assert.deepEqual((f.sends[0].item_list as { text_item: { text: string } }[])[0].text_item.text, f.progress.text);
  for (const key of Object.keys(deliveries)) assert.deepEqual(f.state.replyDeliveries[key], deliveries[key]);
  for (const [key, count] of Object.entries(chunks)) assert.equal(f.state.sentReplyProgress[key], count);
  assert.equal(f.lookupCount(), 1);
  await gateway.flushRepliesOnce();
  const restored = new StateManager(f.accountPath, f.statePath), restarted = f.create(restored);
  assert.equal(restored.outbox[f.key].status, "expired");
  for (const key of Object.keys(deliveries)) assert.deepEqual(restored.replyDeliveries[key], deliveries[key]);
  await restarted.flushRepliesOnce();
  f.enableFreshInbound();
  const summary = await restarted.pollOnce();
  assert.equal(summary.processedCount, 1);
  assert.equal(restored.syncBuf, "next-cursor");
  assert.equal(restored.outbox[f.key].status, "expired");
  assert.equal(f.lookupCount(), 1);
  assert.equal(f.requests.filter(request => request.method === "POST" && request.pathname === "/v1/messages").length, 1);
  assert.deepEqual(f.sends.map(send => send.to_user_id), ["chat", "chat"]);
  assert.deepEqual((f.sends[1].item_list as { text_item: { text: string } }[])[0].text_item.text, "fresh reply");
});

test("unavailable queue head leaves another chat's reply reachable in the next bounded flush", async t => {
  const f = await fixture(t, 404);
  const healthyKey = f.state.computeDeliveryKey("other-chat", "healthy-message");
  f.state.putOutbox({ kind: "reply", deliveryKey: healthyKey, chatId: "other-chat", messageId: "healthy-message",
    splitMaxChars: 100, splitMultiPart: true, status: "pending" });
  const gateway = f.create();
  await gateway.flushRepliesOnce();
  assert.equal(f.state.outbox[f.key].status, "expired");
  assert.equal(f.state.outbox[healthyKey].status, "pending");
  assert.equal(f.sends.length, 0);
  await gateway.flushRepliesOnce();
  assert.equal(f.state.outbox[healthyKey], undefined);
  assert.deepEqual(f.sends.map(send => send.to_user_id), ["other-chat"]);
});

for (const source of ["text", "image"]) test(`${source} uncertain evidence stays quarantined before unavailable lookup`, async t => {
  const f = await fixture(t, 403), evidenceKey = source === "text" ? f.key : `image-reply:${f.key}`;
  f.state.prepareReplyDelivery(evidenceKey, DIGEST, 2);
  f.state.beginReplyChunk(evidenceKey, 0);
  const evidence = { ...f.state.replyDeliveries[evidenceKey] };
  await f.create().flushRepliesOnce();
  assert.equal(f.state.outbox[f.key].status, "uncertain");
  assert.deepEqual(f.state.replyDeliveries[evidenceKey], evidence);
  assert.equal(f.lookupCount(), 0);
  const restored = new StateManager(f.accountPath, f.statePath);
  await f.create(restored).flushRepliesOnce();
  assert.equal(restored.outbox[f.key].status, "uncertain");
  assert.deepEqual(restored.replyDeliveries[evidenceKey], evidence);
  assert.equal(f.sends.length, 0);
});

test("uncertainty recorded while reply GET is in flight takes priority over permanent unavailability", async t => {
  const f = await fixture(t, 404);
  f.state.prepareReplyDelivery(f.key, DIGEST, 2);
  f.state.beginReplyChunk(f.key, 0);
  f.state.confirmReplyChunk(f.key, 0);
  f.setBeforeReply(() => f.state.beginReplyChunk(f.key, 1));
  await f.create().flushRepliesOnce();
  assert.equal(f.lookupCount(), 1);
  assert.equal(f.state.outbox[f.key].status, "uncertain");
  assert.equal(f.state.replyDeliveries[f.key].acknowledgedChunks, 1);
  assert.equal(f.state.replyDeliveries[f.key].inFlight, true);
  assert.equal(f.state.getReplySentChunks(f.key), 1);
  const restored = new StateManager(f.accountPath, f.statePath);
  await f.create(restored).flushRepliesOnce();
  assert.equal(restored.outbox[f.key].status, "uncertain");
  assert.equal(f.lookupCount(), 1);
  assert.equal(f.sends.length, 0);
});

for (const status of [503, "network"] as const) test(`${status} lookup failure remains pending and can recover on the next GET`, async t => {
  const f = await fixture(t, status), gateway = f.create();
  await assert.rejects(gateway.flushRepliesOnce(), status === 503 ? /HTTP 503/ : /fetch failed/);
  assert.equal(f.state.outbox[f.key].status, "pending");
  assert.equal(f.lookupCount(), 1);
  assert.equal(f.sends.length, 0);
  f.setStatus(200);
  const restored = new StateManager(f.accountPath, f.statePath);
  await f.create(restored).flushRepliesOnce();
  assert.equal(f.lookupCount(), 2);
  assert.equal(restored.outbox[f.key], undefined);
  assert.equal(f.sends.length, 1);
});
