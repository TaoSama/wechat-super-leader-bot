import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../../src/runtime/state.js";
import { ILinkClient } from "../../src/wechat/client.js";
import { ControllerClient } from "../../src/controller/client.js";
import { WeChatGateway } from "../../src/gateway.js";
import { createMessageTrace, runWithTrace } from "../../src/runtime/telemetry.js";

type Event = Record<string, unknown>;
const PRIVATE_TEXT = "private-inbound-body";
const PRIVATE_REPLY = "private-reply-body";
const BOT_TOKEN = "private-bot-token";
const CONTROLLER_TOKEN = "private-controller-token";
const CONTEXT_TOKEN = "private-context-token";

function capture(t: TestContext): Event[] {
  const events: Event[] = [];
  t.mock.method(fs, "writeSync", (fd: number, value: string | ArrayBufferView) => {
    assert.equal(fd, 2);
    events.push(JSON.parse(String(value)));
    return Buffer.byteLength(String(value));
  });
  return events;
}

function fixture(t: TestContext, chats: string[], forward: (chatId: string) => Promise<Response>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-latency-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credentials = path.join(directory, "account.json");
  const statePath = path.join(directory, "state.json");
  fs.writeFileSync(credentials, JSON.stringify({ token: BOT_TOKEN, accountId: "test-account" }));
  const state = new StateManager(credentials, statePath);
  state.markBaselineEstablished();
  const beforeCursor = state.syncBuf;
  const forwarded: string[] = [], sent: string[] = [];
  const createdAt = Date.now() - 1000;
  const ilink = new ILinkClient({ stateManager: state, fetchImpl: async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.endsWith("/getconfig")) return Response.json({ ret: 0, typing_ticket: "private-typing-ticket" });
    if (url.endsWith("/sendtyping")) return Response.json({ ret: 0 });
    if (url.endsWith("/getupdates")) return Response.json({ ret: 0, errcode: 0, get_updates_buf: "after-batch", msgs: chats.map((chatId, index) => ({
      message_type: 1, create_time_ms: createdAt, from_user_id: chatId, client_id: `message-${index}`,
      context_token: CONTEXT_TOKEN, item_list: [{ type: 1, text_item: { text: PRIVATE_TEXT } }],
    })) });
    if (url.endsWith("/sendmessage")) { sent.push(body.msg.to_user_id); return Response.json({ ret: 0, errcode: 0 }); }
    throw new Error("unexpected iLink fixture endpoint");
  } });
  const controller = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: CONTROLLER_TOKEN,
    maxRetries: 0, fetchImpl: async (input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (String(input).endsWith("/authorize")) return body.chatId === "poison"
        ? Response.json({ code: "CHAT_NOT_ALLOWED" }, { status: 403 }) : Response.json({ allowed: true });
      assert.ok(String(input).endsWith("/v1/messages"));
      forwarded.push(body.chatId);
      return forward(body.chatId);
    } });
  return { gateway: new WeChatGateway({ stateManager: state, ilink, controller }), state, beforeCursor, forwarded, sent };
}

function assertNoPrivateData(events: Event[]): void {
  const serialized = JSON.stringify(events);
  for (const value of [PRIVATE_TEXT, PRIVATE_REPLY, BOT_TOKEN, CONTROLLER_TOKEN, CONTEXT_TOKEN, "private-typing-ticket"]) {
    assert.ok(!serialized.includes(value), `telemetry must not contain ${value}`);
  }
}

test("every message in a batch is recorded before processing and later messages expose batch waiting", async t => {
  const events = capture(t);
  const setup = fixture(t, ["first", "second"], async chatId => {
    if (chatId === "first") {
      assert.equal(events.filter(event => event.stage === "message.received").length, 2);
      await new Promise<void>(resolve => setTimeout(resolve, 20));
    }
    return Response.json({ text: PRIVATE_REPLY });
  });
  const result = await setup.gateway.pollOnce();
  assert.equal(result.processedCount, 2);
  assert.equal(result.skippedCount, 0);
  assert.equal(result.nextSyncBuf, "after-batch");
  assert.deepEqual(setup.forwarded, ["first", "second"]);
  assert.deepEqual(setup.sent, ["first", "second"]);
  const received = events.filter(event => event.stage === "message.received");
  const processing = events.filter(event => event.stage === "message.processing.start");
  assert.equal(received.length, 2);
  assert.equal(processing.length, 2);
  assert.ok(events.indexOf(received[1]) < events.indexOf(processing[0]));
  assert.deepEqual(received.map(event => event.batchIndex), [0, 1]);
  assert.equal(received[0].batchId, received[1].batchId);
  assert.equal(received[0].batchCount, 2);
  assert.ok(Number(processing[1].batchWaitMs) > Number(processing[0].batchWaitMs));
  assert.ok(Number(processing[1].batchWaitMs) > 0);
  for (let index = 0; index < received.length; index++) {
    assert.equal(received[index].traceId, processing[index].traceId);
    const end = events.find(event => event.traceId === received[index].traceId && event.stage === "message.processing.end");
    assert.equal(end?.outcome, "processed");
  }
  assertNoPrivateData(events);
  assert.equal((await setup.gateway.pollOnce()).polledCount, 0, "observability must retain deduplication");
  assert.equal(setup.forwarded.length, 2);
});

test("poison-chat telemetry does not block valid messages or cursor progress", async t => {
  const events = capture(t);
  const setup = fixture(t, ["poison", "valid"], async () => Response.json({ text: PRIVATE_REPLY }));
  const result = await setup.gateway.pollOnce();
  assert.equal(result.processedCount, 1);
  assert.equal(result.skippedCount, 1);
  assert.equal(setup.state.syncBuf, "after-batch");
  assert.deepEqual(setup.forwarded, ["valid"]);
  assert.deepEqual(setup.sent, ["valid"]);
  const received = events.filter(event => event.stage === "message.received");
  const poisonEnd = events.find(event => event.traceId === received[0].traceId && event.stage === "message.processing.end");
  assert.equal(poisonEnd?.outcome, "skipped");
  assert.ok(!events.some(event => event.traceId === received[0].traceId && event.stage === "controller.http.start"));
  assertNoPrivateData(events);
});

test("a failed Controller request retains the cursor and does not falsely record acceptance", async t => {
  const events = capture(t);
  const failure = new Error("private-controller-failure-body");
  const setup = fixture(t, ["first", "second"], async () => { throw failure; });
  await assert.rejects(setup.gateway.pollOnce(), error => error === failure);
  assert.equal(setup.state.syncBuf, setup.beforeCursor);
  assert.deepEqual(setup.forwarded, ["first"]);
  assert.deepEqual(setup.sent, []);
  assert.equal(events.filter(event => event.stage === "message.received").length, 2);
  assert.equal(events.filter(event => event.stage === "message.processing.start").length, 1);
  assert.equal(events.find(event => event.stage === "message.processing.end")?.outcome, "error");
  assert.ok(!events.some(event => event.receiptStatus === "wechat_api_accepted"));
  assert.ok(!JSON.stringify(events).includes(failure.message));
  assertNoPrivateData(events);
});

test("a throwing telemetry sink preserves real Gateway success and failure semantics", async t => {
  t.mock.method(fs, "writeSync", () => { throw new Error("private-sink-failure"); });
  const success = fixture(t, ["valid"], async () => Response.json({ text: PRIVATE_REPLY }));
  assert.equal((await success.gateway.pollOnce()).processedCount, 1);
  assert.deepEqual(success.sent, ["valid"]);
  assert.equal(success.state.syncBuf, "after-batch");
  const failure = new Error("original-controller-error");
  const failed = fixture(t, ["valid"], async () => { throw failure; });
  await assert.rejects(failed.gateway.pollOnce(), error => error === failure);
  assert.equal(failed.state.syncBuf, failed.beforeCursor);
  assert.deepEqual(failed.sent, []);
});

test("Controller HTTP retries keep message trace and a valid attempt header without logging request data", async () => {
  const events: Event[] = [], headers: Headers[] = [], bodies: unknown[] = [];
  const trace = createMessageTrace("chat", "message", event => events.push(event));
  const controller = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: CONTROLLER_TOKEN,
    maxRetries: 1, fetchImpl: async (_input, init) => {
      headers.push(new Headers(init?.headers));
      bodies.push(JSON.parse(String(init?.body)));
      return headers.length === 1 ? Response.json({ error: PRIVATE_TEXT }, { status: 503 }) : Response.json({ text: PRIVATE_REPLY });
    } });
  const request = { chatId: "chat", messageId: "message", text: PRIVATE_TEXT };
  assert.equal((await runWithTrace(trace, () => controller.forwardMessage(request))).text, PRIVATE_REPLY);
  assert.equal(headers.length, 2);
  assert.deepEqual(bodies, [request, request]);
  for (const header of headers) {
    assert.equal(header.get("X-Latency-Attempt"), trace.attemptId);
    assert.match(header.get("X-Latency-Attempt")!, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
  }
  const starts = events.filter(event => event.stage === "controller.http.start");
  const ends = events.filter(event => event.stage === "controller.http.end");
  assert.deepEqual(starts.map(event => event.attempt), [0, 1]);
  assert.deepEqual(ends.map(event => event.outcome), ["retry", "ok"]);
  assert.ok(events.every(event => event.traceId === trace.traceId && event.attemptId === trace.attemptId));
  assertNoPrivateData(events);
});
