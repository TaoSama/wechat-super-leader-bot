import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { StateManager } from "../../src/runtime/state.js";
import { ILinkClient, splitWeChatReply } from "../../src/wechat/client.js";
import { ILinkSendReceiptError } from "../../src/wechat/send-receipt.js";

const MULTIPART_TEST_SEND_BUDGET = 1000;

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-reply-delivery-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credentials = path.join(directory, "account.json");
  const statePath = path.join(directory, "state.json");
  fs.writeFileSync(credentials, JSON.stringify({ token: "synthetic", accountId: "fixture" }));
  const state = new StateManager(credentials, statePath, { sendBudget: MULTIPART_TEST_SEND_BUDGET });
  state.setContextToken("chat", "synthetic-context");
  state.recordInboundContext("synthetic-inbound-key", "chat", Date.now() - 1000);
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

test("default delivery formats the complete body and preserves over-budget code and emoji", async t => {
  const f = fixture(t);
  const original = "中".repeat(3799) + "🚀\n\n```ts\n  **literal**\n```\n\t";
  const result = await f.client().sendMarkdownReply("chat", original, { deliveryKey: "default-budget" });
  assert.equal(result, 2);
  assert.equal(f.sent[0].length, 3799);
  assert.equal(f.sent.join(""), "中".repeat(3799) + "🚀\n\n  **literal**\n");
  assert.ok(f.sent.every(chunk => chunk.length <= 3800 && Buffer.from(chunk, "utf8").toString("utf8") === chunk));
  assert.equal(f.state.getReplySentChunks("default-budget"), result);
});

test("transport renders Markdown before splitting and resumes the same display after restart", async t => {
  const f = fixture(t);
  const original = " \n# 标题🚀\n\n**重点** [文档](https://example.test/a_b)\n```ts\n  a_b += 1;\n```\n\t";
  assert.ok(original.length > 9);
  const result = await f.client().sendMarkdownReply("chat", original, {
    deliveryKey: "full", maxCharsPerChunk: 9,
  });
  assert.equal(result, f.sent.length);
  assert.equal(f.sent.join(""), "标题🚀\n\n重点 文档 (https://example.test/a_b)\n  a_b += 1;\n");
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

test("zero-byte HTTP send response persists uncertainty and forbids replay after restart", async t => {
  const f = fixture(t);
  let attempts = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    if (!String(input).endsWith("sendmessage")) return f.fetchImpl(input, init);
    attempts++;
    return new Response("");
  };
  const client = new ILinkClient({ stateManager: f.state, fetchImpl });
  await assert.rejects(client.sendMarkdownReply("chat", "body", { deliveryKey: "empty-body" }), error => {
    assert.ok(error instanceof ILinkSendReceiptError);
    assert.equal(error.reason, "EmptyResponse");
    return true;
  });
  assert.equal(f.state.getReplySentChunks("empty-body"), 0);
  assert.equal(f.state.replyDeliveries["empty-body"].inFlight, true);
  const resumed = new StateManager(f.credentials, f.statePath, f.state.policy);
  assert.equal(resumed.getReplySentChunks("empty-body"), 0);
  assert.equal(resumed.replyDeliveries["empty-body"].inFlight, true);
  await assert.rejects(new ILinkClient({ stateManager: resumed, fetchImpl }).sendMarkdownReply("chat", "body", {
    deliveryKey: "empty-body",
  }), /delivery uncertain/);
  assert.equal(attempts, 1);
});

for (const response of [{}, { errmsg: "" }]) {
  test(`JSON receipt ${JSON.stringify(response)} accepts delivery and prevents replay after restart`, async t => {
    const f = fixture(t);
    f.fail(() => response);
    assert.equal(await f.client().sendMarkdownReply("chat", "body", { deliveryKey: "receipt-accepted" }), 1);
    assert.equal(f.state.getReplySentChunks("receipt-accepted"), 1);
    const resumed = new StateManager(f.credentials, f.statePath);
    f.fail(undefined);
    assert.equal(await f.client(resumed).sendMarkdownReply("chat", "body", { deliveryKey: "receipt-accepted" }), 1);
    assert.equal(f.sent.length, 1);
  });
}

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

test("typing failure leaves formatted body delivery available", async t => {
  const f = fixture(t);
  const client = new ILinkClient({ stateManager: f.state, fetchImpl: async (input, init) => {
    if (!String(input).endsWith("sendmessage")) throw new Error("private-ticket-fetch-error");
    return f.fetchImpl(input, init);
  } });
  assert.equal(await client.sendMarkdownReply("chat", "**原文**", { deliveryKey: "typing-failed" }), 1);
  assert.deepEqual(f.sent, ["原文"]);
});

for (const endpoint of ["getconfig", "sendtyping"]) {
  test(`formatted body delivery completes while ${endpoint} remains unresolved`, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture(t);
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const began = new Promise<void>(resolve => { started = resolve; });
    const client = new ILinkClient({ stateManager: f.state, fetchImpl: async (input, init) => {
      if (String(input).endsWith(endpoint)) { started(); await gate; }
      return f.fetchImpl(input, init);
    } });
    const delivery = client.sendMarkdownReply("chat", "**原文**", { deliveryKey: `background-${endpoint}` });
    try {
      await began;
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(f.sent, ["原文"]);
      assert.equal(f.state.getReplySentChunks(`background-${endpoint}`), 1);
    } finally { release(); await delivery; }
    assert.equal(await delivery, 1);
  });
}

test("upgrading a partially acknowledged raw Markdown plan preserves its original boundaries", async t => {
  const f = fixture(t);
  const original = "**旧标题**\n①第一项 ②第二项\n```ts\n  a_b += 1;\n```\n";
  const budget = 12, chunks = splitWeChatReply(original, budget), key = "legacy-raw";
  const digest = createHash("sha256").update(JSON.stringify([
    f.state.getLoginFingerprint(), "chat", budget, original,
  ])).digest("hex");
  f.state.prepareReplyDelivery(key, digest, chunks.length);
  f.state.beginReplyChunk(key, 0);
  f.state.confirmReplyChunk(key, 0);
  const resumed = new StateManager(f.credentials, f.statePath, f.state.policy);
  await f.client(resumed).sendMarkdownReply("chat", original, { deliveryKey: key, maxCharsPerChunk: budget });
  assert.deepEqual(f.sent, chunks.slice(1));
  assert.equal(resumed.getReplySentChunks(key), chunks.length);
  await f.client(resumed).sendMarkdownReply("chat", original, { deliveryKey: key, maxCharsPerChunk: budget });
  assert.equal(f.sent.length, chunks.length - 1, "old acknowledged prefix must never be repeated");
});

test("frozen result fragments remain verbatim and occupy exactly their planned message", async t => {
  const f = fixture(t);
  const original = "**原文**\n①" + "正文".repeat(1895);
  assert.ok(original.length <= 3800);
  await f.client().sendMarkdownReply("chat", original, { deliveryKey: "result-fragment", verbatim: true });
  assert.deepEqual(f.sent, [original]);
});

test("an unknown old Markdown send remains quarantined through the renderer upgrade", async t => {
  const f = fixture(t);
  const original = "**已开始**", key = "legacy-unknown";
  const digest = createHash("sha256").update(JSON.stringify([
    f.state.getLoginFingerprint(), "chat", 3800, original,
  ])).digest("hex");
  f.state.prepareReplyDelivery(key, digest, 1);
  f.state.beginReplyChunk(key, 0);
  const resumed = new StateManager(f.credentials, f.statePath, f.state.policy);
  await assert.rejects(f.client(resumed).sendMarkdownReply("chat", original, { deliveryKey: key }), /uncertain/);
  assert.equal(f.sent.length, 0);
});

test("an old formatted plan with citation-looking text resumes its frozen chunks unchanged", async t => {
  const f = fixture(t);
  const token = "\uE200cite\uE202turn6search1\uE201";
  const original = `前${token}后`, budget = 4, key = "legacy-formatted";
  const chunks = splitWeChatReply(original, budget);
  const digest = createHash("sha256").update(JSON.stringify([
    f.state.getLoginFingerprint(), "chat", budget, original,
    "wechat-plain-v1", original,
  ])).digest("hex");
  f.state.prepareReplyDelivery(key, digest, chunks.length);
  f.state.beginReplyChunk(key, 0);
  f.state.confirmReplyChunk(key, 0);
  const resumed = new StateManager(f.credentials, f.statePath);
  await f.client(resumed).sendMarkdownReply("chat", original, { deliveryKey: key, maxCharsPerChunk: budget });
  assert.deepEqual(f.sent, chunks.slice(1));
});

test("a legacy verbatim plan resumes its sanitized chunks without changing new deliveries", async t => {
  const f = fixture(t);
  const token = "\uE200cite\uE202turn6search1\uE201";
  const original = `前${token}后`, legacyBody = "前后", budget = 1, key = "legacy-verbatim";
  const chunks = splitWeChatReply(legacyBody, budget);
  const digest = createHash("sha256").update(JSON.stringify([
    f.state.getLoginFingerprint(), "chat", budget, original,
    "wechat-verbatim-v2", legacyBody,
  ])).digest("hex");
  f.state.prepareReplyDelivery(key, digest, chunks.length);
  f.state.beginReplyChunk(key, 0);
  f.state.confirmReplyChunk(key, 0);
  const resumed = new StateManager(f.credentials, f.statePath);
  await f.client(resumed).sendMarkdownReply("chat", original, { deliveryKey: key, maxCharsPerChunk: budget });
  assert.deepEqual(f.sent, chunks.slice(1));

  const fresh = fixture(t);
  await fresh.client().sendMarkdownReply("chat", original, { deliveryKey: "new-verbatim", verbatim: true });
  await fresh.client().sendMarkdownReply("chat", original, { deliveryKey: "new-verbatim" });
  assert.deepEqual(fresh.sent, [original]);
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
