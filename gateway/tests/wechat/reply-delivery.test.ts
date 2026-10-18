import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StateManager } from "../../src/runtime/state.js";
import { ILinkClient } from "../../src/wechat/client.js";

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-reply-delivery-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credentials = path.join(directory, "account.json");
  const statePath = path.join(directory, "state.json");
  fs.writeFileSync(credentials, JSON.stringify({ token: "synthetic", accountId: "fixture" }));
  const state = new StateManager(credentials, statePath);
  state.setContextToken("chat", "synthetic-context");
  const sent: string[] = [];
  const clientIds: string[] = [];
  let failure: ((index: number) => void | Record<string, unknown>) | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("getconfig")) return Response.json({ ret: 0, typing_ticket: "synthetic-ticket" });
    if (url.endsWith("sendtyping")) return Response.json({ ret: 0 });
    assert.ok(url.endsWith("sendmessage"));
    const payload = JSON.parse(String(init?.body));
    sent.push(payload.msg.item_list[0].text_item.text);
    clientIds.push(payload.msg.client_id);
    return Response.json(failure?.(sent.length) ?? { ret: 0 });
  };
  return { state, sent, clientIds, statePath, credentials, fetchImpl,
    fail: (hook: typeof failure) => { failure = hook; },
    client: (manager = state) => new ILinkClient({ stateManager: manager, fetchImpl }) };
}

test("transport preserves full Markdown, Unicode, code fences and whitespace in every mode", async t => {
  const f = fixture(t);
  const original = " \n# 标题🚀\n\n**重点** [文档](https://example.test/a_b)\n```ts\n  a_b += 1;\n```\n\t";
  assert.ok(original.length > 9);
  const result = await f.client().sendMarkdownReply("chat", original, {
    deliveryKey: "full", maxCharsPerChunk: 9, splitMultiPart: false,
  });
  assert.equal(result, f.sent.length);
  assert.equal(f.sent.join(""), original);
  assert.ok(f.sent.every(chunk => chunk.length <= 9 && Buffer.from(chunk, "utf8").toString("utf8") === chunk));
  const reloaded = new StateManager(f.credentials, f.statePath);
  assert.equal(reloaded.getReplySentChunks("full"), result);
  assert.equal(await f.client(reloaded).sendMarkdownReply("chat", original, {
    deliveryKey: "full", maxCharsPerChunk: 9,
  }), result);
  assert.equal(f.sent.length, result, "completed chunks must not be replayed after restart");
});

test("explicitly rejected chunk resumes after restart without replaying acknowledged chunks", async t => {
  const f = fixture(t);
  f.fail(index => index === 2 ? { ret: -1 } : undefined);
  await assert.rejects(f.client().sendMarkdownReply("chat", "a\nb\nc", {
    deliveryKey: "retry", maxCharsPerChunk: 2,
  }), /RejectedRet/);
  assert.equal(f.state.getReplySentChunks("retry"), 1);
  f.fail(undefined);
  const resumed = new StateManager(f.credentials, f.statePath);
  await f.client(resumed).sendMarkdownReply("chat", "a\nb\nc", { deliveryKey: "retry", maxCharsPerChunk: 2 });
  assert.deepEqual(f.sent, ["a\n", "b\n", "b\n", "c"]);
  assert.equal(f.clientIds[1], f.clientIds[2]);
  assert.equal(resumed.getReplySentChunks("retry"), 3);
});

test("ambiguous network outcome persists pending intent and forbids replay after restart", async t => {
  const f = fixture(t);
  f.fail(index => { if (index === 2) throw new Error("synthetic network failure"); });
  await assert.rejects(f.client().sendMarkdownReply("chat", "a\nb\nc", {
    deliveryKey: "uncertain", maxCharsPerChunk: 2,
  }), /network failure/);
  const resumed = new StateManager(f.credentials, f.statePath);
  assert.equal(resumed.getReplySentChunks("uncertain"), 1);
  assert.equal(resumed.replyDeliveries.uncertain.inFlight, true);
  f.fail(undefined);
  await assert.rejects(f.client(resumed).sendMarkdownReply("chat", "a\nb\nc", {
    deliveryKey: "uncertain", maxCharsPerChunk: 2,
  }), /delivery uncertain/);
  assert.equal(f.sent.length, 2);
});

test("unconfirmed receipt forbids replay rather than treating unknown shape as rejection", async t => {
  const f = fixture(t);
  f.fail(() => ({ error: "synthetic-private" }));
  await assert.rejects(f.client().sendMarkdownReply("chat", "body", { deliveryKey: "receipt" }), /UnsupportedShape/);
  await assert.rejects(f.client().sendMarkdownReply("chat", "body", { deliveryKey: "receipt" }), /delivery uncertain/);
  assert.equal(f.sent.length, 1);
});

test("confirmed send followed by failed checkpoint remains uncertain in memory and on disk", async t => {
  const f = fixture(t);
  const confirm = t.mock.method(f.state, "confirmReplyChunk", () => { throw new Error("checkpoint failed"); });
  await assert.rejects(f.client().sendMarkdownReply("chat", "body", { deliveryKey: "checkpoint" }), /checkpoint failed/);
  confirm.mock.restore();
  await assert.rejects(f.client().sendMarkdownReply("chat", "body", { deliveryKey: "checkpoint" }), /delivery uncertain/);
  const resumed = new StateManager(f.credentials, f.statePath);
  assert.equal(resumed.replyDeliveries.checkpoint.inFlight, true);
  assert.equal(f.sent.length, 1);
});

test("changed reply body, recipient or chunk budget fails closed", async t => {
  const f = fixture(t);
  await f.client().sendMarkdownReply("chat", "body", { deliveryKey: "fixed", maxCharsPerChunk: 2 });
  for (const [chatId, body, budget] of [["chat", "else", 2], ["chat", "body", 3], ["other", "body", 2]] as const) {
    await assert.rejects(f.client().sendMarkdownReply(chatId, body, { deliveryKey: "fixed", maxCharsPerChunk: budget }), /content or chunk plan changed/);
  }
  assert.equal(f.sent.length, 2);
});

test("typing failure leaves raw body delivery available", async t => {
  const f = fixture(t);
  const client = new ILinkClient({ stateManager: f.state, fetchImpl: async (input, init) => {
    if (!String(input).endsWith("sendmessage")) throw new Error("private-ticket-fetch-error");
    return f.fetchImpl(input, init);
  } });
  assert.equal(await client.sendMarkdownReply("chat", "**原文**", { deliveryKey: "typing-failed" }), 1);
  assert.deepEqual(f.sent, ["**原文**"]);
});

test("multipart timeout bounds an uncooperative send and persists its unknown outcome", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const f = fixture(t);
  let attempts = 0;
  const client = new ILinkClient({ stateManager: f.state, fetchImpl: async (input, init) => {
    if (!String(input).endsWith("sendmessage")) return f.fetchImpl(input, init);
    attempts++;
    return new Promise<Response>(() => {});
  } });
  const pending = client.sendMarkdownReply("chat", "body", { deliveryKey: "timeout", timeoutMs: 500 });
  const rejected = assert.rejects(pending, /reply timed out/);
  for (let step = 0; step < 50; step++) await Promise.resolve();
  assert.equal(attempts, 1);
  t.mock.timers.tick(500);
  await rejected;
  assert.equal(f.state.replyDeliveries.timeout.inFlight, true);
  await assert.rejects(client.sendMarkdownReply("chat", "body", { deliveryKey: "timeout" }), /uncertain/);
  assert.equal(attempts, 1);
});

test("concurrent logical replies serialize individual sends while preserving both contents", async t => {
  const f = fixture(t);
  let outstanding = 0, maximum = 0;
  const client = new ILinkClient({ stateManager: f.state, fetchImpl: async (input, init) => {
    if (!String(input).endsWith("sendmessage")) return f.fetchImpl(input, init);
    outstanding++;
    maximum = Math.max(maximum, outstanding);
    await Promise.resolve();
    try { return await f.fetchImpl(input, init); }
    finally { outstanding--; }
  } });
  await Promise.all([
    client.sendMarkdownReply("chat", "甲\n甲\n甲", { deliveryKey: "first", maxCharsPerChunk: 2 }),
    client.sendMarkdownReply("chat", "乙\n乙\n乙", { deliveryKey: "second", maxCharsPerChunk: 2 }),
  ]);
  assert.equal(maximum, 1);
  assert.equal(f.sent.filter(text => text.startsWith("甲")).join(""), "甲\n甲\n甲");
  assert.equal(f.sent.filter(text => text.startsWith("乙")).join(""), "乙\n乙\n乙");
});
