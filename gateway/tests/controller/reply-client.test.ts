import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { ControllerClient } from "../../src/controller/client.js";
import { MESSAGE_REPLY_TIMEOUT_MS, PermanentReplyUnavailableError } from "../../src/controller/reply-client.js";
import type { FetchLike } from "../../src/wechat/client.js";

const BASE_URL = "http://127.0.0.1:8790/prefix";
const TOKEN = "synthetic";
const image = { id: "image-1", mime: "image/png", size: 10, sha256: "a".repeat(64) };
function client(fetchImpl: FetchLike, timeoutMs?: number): ControllerClient {
  return new ControllerClient({ controllerUrl: BASE_URL, controllerToken: TOKEN, fetchImpl, ...(timeoutMs ? { timeoutMs } : {}) });
}

test("stored message replies use only one authenticated GET with escaped identity and direct immutable projection", async () => {
  const body = { text: "已完成", commandId: "command", images: [image] };
  let calls = 0;
  const instance = client(async (url, init) => {
    calls++;
    assert.equal(String(url), `${BASE_URL}/v1/messages/message%2Fopaque%3Fx/reply?chatId=chat%3Fsubject%3Dother`);
    assert.equal(init?.method, "GET");
    assert.equal(init?.body, undefined);
    assert.equal(init?.redirect, "error");
    assert.deepEqual(init?.headers, { Authorization: `Bearer ${TOKEN}` });
    return Response.json(body);
  });
  assert.deepEqual(await instance.getMessageReply("chat?subject=other", "message/opaque?x"), body);
  assert.equal(calls, 1);
});

test("reply lookups validate identity before issuing a request", async () => {
  let calls = 0;
  const instance = client(async () => { calls++; return Response.json({ text: "ok" }); });
  for (const [chatId, messageId] of [["", "message"], ["  ", "message"], ["chat", ""], ["chat", " "], ["chat", "."], ["chat", ".."]]) {
    await assert.rejects(instance.getMessageReply(chatId, messageId), /identity/);
  }
  assert.equal(calls, 0);
});

test("reply lookup rejects HTTP failures and malformed projections without replay or sensitive body output", async () => {
  const failures: (() => Promise<Response>)[] = [
    async () => { throw new Error("network unavailable"); },
    ...[401, 403, 404, 409, 500, 503].map(status => async () => new Response("sensitive_body", { status })),
    async () => new Response("sensitive_body"),
    ...[{}, { reply: { text: "nested" } }, { text: 123 }, { text: "ok", images: null },
      { text: "ok", images: [{ ...image, url: "https://untrusted.test" }] }].map(body => async () => Response.json(body)),
  ];
  for (const failure of failures) {
    let calls = 0;
    const instance = client(async () => { calls++; return failure(); });
    await assert.rejects(instance.getMessageReply("chat", "message"), error => {
      assert.ok(!String(error).includes("sensitive_body"));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test("immutable reply 403 and 404 expose permanent typed reasons without reading the body", async t => {
  for (const [status, reason] of [[403, "Revoked"], [404, "Unavailable"]] as const) {
    let bodyReads = 0;
    const instance = client(async () => {
      const response = new Response("sensitive_body", { status });
      t.mock.method(response, "json", async () => { bodyReads++; throw new Error("sensitive_body"); });
      return response;
    });
    await assert.rejects(instance.getMessageReply("chat", "message"), error => {
      assert.ok(error instanceof PermanentReplyUnavailableError);
      assert.equal(error.reason, reason);
      assert.ok(!error.message.includes("sensitive_body"));
      return true;
    });
    assert.equal(bodyReads, 0);
  }
});

test("temporary HTTP and network failures do not become permanent unavailable errors", async () => {
  for (const failure of [
    async () => new Response("sensitive_body", { status: 503 }),
    async () => { throw new TypeError("network unavailable"); },
  ]) {
    await assert.rejects(client(failure).getMessageReply("chat", "message"), error => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof PermanentReplyUnavailableError, false);
      return true;
    });
  }
});

test("reply lookup bounds uncooperative fetch and body parsing at the smaller configured deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const phase of ["fetch", "body"]) {
    for (const timeoutMs of [25, undefined]) {
      let calls = 0;
      let signal!: AbortSignal;
      let finishBody: ReadableStreamDefaultController<Uint8Array> | undefined;
      const instance = client(async (_url, init) => {
        calls++;
        signal = init?.signal as AbortSignal;
        if (phase === "fetch") return new Promise<Response>(() => {});
        return new Response(new ReadableStream<Uint8Array>({ start(controller) {
          finishBody = controller;
          controller.enqueue(new TextEncoder().encode("{"));
        } }));
      }, timeoutMs);
      const pending = instance.getMessageReply("chat", "message");
      const rejected = assert.rejects(pending, /message reply timed out/);
      for (let step = 0; step < 12; step++) await Promise.resolve();
      t.mock.timers.tick(timeoutMs ?? MESSAGE_REPLY_TIMEOUT_MS);
      await rejected;
      finishBody?.close();
      assert.equal(calls, 1);
      assert.equal(signal.aborted, true);
      assert.equal(getEventListeners(signal, "abort").length, 0);
    }
  }
});

test("reply lookup checks cancellation after a success resolves at the deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish!: (response: Response) => void;
  const instance = client(async () => new Promise<Response>(resolve => { finish = resolve; }));
  const pending = instance.getMessageReply("chat", "message");
  const rejected = assert.rejects(pending, /timed out/);
  t.mock.timers.tick(MESSAGE_REPLY_TIMEOUT_MS);
  finish(Response.json({ text: "late" }));
  await rejected;
});
