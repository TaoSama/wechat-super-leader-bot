import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateManager } from "../../src/runtime/state.js";
import { ControllerClient } from "../../src/controller/client.js";
import { ILinkClient } from "../../src/wechat/client.js";
import { WeChatGateway, type GatewayReplyEngine } from "../../src/gateway.js";
import { ReplyEngineBackpressureError } from "../../src/leader/contracts.js";

function fixture(t: TestContext, outboxLimit?: number) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-reply-fairness-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const account = path.join(directory, "account.json");
  const statePath = path.join(directory, "state.json");
  fs.writeFileSync(account, JSON.stringify({ token: "synthetic", accountId: "synthetic" }));
  const sends: string[] = [], posts: string[] = [], reads: string[] = [];
  const replies = new Map([["m1", "AB"], ["m2", "C"], ["m3", "D"], ["m4", "E"], ["other", "Z"]]);
  const timestamp = Date.now() - 1000;
  let page = 1;
  let beforeRead: ((messageId: string) => Promise<void>) | undefined;
  const createState = () => new StateManager(account, statePath, { sendBudget: 1,
    ...(outboxLimit === undefined ? {} : { outboxLimit }) });
  const state = createState();
  state.markBaselineEstablished();
  const createGateway = (current: StateManager, replyEngine?: GatewayReplyEngine) => new WeChatGateway({ stateManager: current, splitMaxChars: 1, replyEngine,
    ilink: new ILinkClient({ stateManager: current, fetchImpl: async (input, init) => {
      const url = String(input);
      if (url.endsWith("getupdates")) return Response.json({ ret: 0, get_updates_buf: `cursor-${page}`, msgs: [{
        message_type: 1, from_user_id: "chat", client_id: `m${page}`, create_time_ms: timestamp + page,
        context_token: `context-${page}`, item_list: [{ type: 1, text_item: { text: "request" } }],
      }] });
      if (url.endsWith("getconfig")) return Response.json({ ret: 0, typing_ticket: "ticket" });
      if (url.endsWith("sendtyping")) return Response.json({ ret: 0 });
      assert.ok(url.endsWith("sendmessage"));
      sends.push(JSON.parse(String(init?.body)).msg.item_list[0].text_item.text);
      return Response.json({ ret: 0 });
    } }),
    controller: new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic",
      fetchImpl: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("authorize")) return Response.json({ allowed: true });
        if (init?.method === "POST") {
          const messageId = JSON.parse(String(init.body)).messageId as string;
          posts.push(messageId);
          return Response.json({ text: replies.get(messageId) ?? "" });
        }
        const match = /^\/v1\/messages\/([^/]+)\/reply$/.exec(url.pathname);
        assert.ok(match, `unexpected Controller URL ${url.pathname}`);
        reads.push(match[1]);
        await beforeRead?.(match[1]);
        return Response.json({ text: replies.get(match[1]) ?? "" });
      } }),
  });
  return { state, createState, createGateway, sends, posts, reads, timestamp,
    nextPage: () => { page++; },
    setBeforeRead: (callback: (messageId: string) => Promise<void>) => { beforeRead = callback; } };
}

test("fresh nonempty replies yield budget to deferred chunks, including after restart", async t => {
  const f = fixture(t);
  await f.createGateway(f.state).pollOnce();
  const oldKey = f.state.computeDeliveryKey("chat", "m1");
  assert.deepEqual(f.sends, ["A"]);
  assert.equal(f.state.replyDeliveries[oldKey].acknowledgedChunks, 1);
  assert.equal(f.state.outbox[oldKey].status, "pending");
  assert.ok(Object.keys(f.state.outbox).length < f.state.policy.outboxLimit);

  const restarted = f.createState(), gateway = f.createGateway(restarted);
  // The asynchronous inbox path persists context before processing the admitted message.
  restarted.recordInboundContext(restarted.computeDeliveryKey("chat", "m2"), "chat", f.timestamp + 2, true, "context-2");
  for (const expected of ["B", "C", "D"]) {
    f.nextPage();
    const priorSends = f.sends.length;
    await gateway.pollOnce();
    assert.equal(f.sends.length - priorSends, 1, "each inbound grants only one send");
    assert.equal(f.sends.at(-1), expected);
    assert.equal(restarted.remainingSendBudget("chat"), 0);
  }
  assert.deepEqual(f.sends, ["A", "B", "C", "D"]);
  assert.deepEqual(f.posts, ["m1", "m2", "m3", "m4"]);
  assert.deepEqual(f.reads, ["m1", "m2", "m3"]);
  assert.equal(restarted.outbox[oldKey], undefined);
  assert.equal(restarted.replyDeliveries[oldKey].acknowledgedChunks, 2);
  assert.equal(restarted.syncBuf, "cursor-4");
  await gateway.flushRepliesOnce();
  assert.deepEqual(f.sends, ["A", "B", "C", "D"], "recovery never replenishes budget");
});

test("a failed admission recovery read does not reject the new message or erase its old reply", async t => {
  const f = fixture(t), gateway = f.createGateway(f.state);
  await gateway.pollOnce();
  const oldKey = f.state.computeDeliveryKey("chat", "m1");
  f.setBeforeRead(async () => { throw new Error("synthetic frozen read failure"); });
  f.nextPage();
  const result = await gateway.pollOnce();
  assert.equal(result.processedCount, 1);
  assert.equal(f.state.isMessageProcessed(f.state.computeDeliveryKey("chat", "m2")), true);
  assert.equal(f.state.outbox[oldKey].status, "pending");
  assert.equal(f.state.replyDeliveries[oldKey].acknowledgedChunks, 1);
  assert.deepEqual(f.posts, ["m1", "m2"]);
  assert.deepEqual(f.sends, ["A", "C"]);
  assert.equal(f.state.syncBuf, "cursor-2");
  f.state.recordInboundContext("retry-old", "chat", Date.now(), true, "retry-context");
  await assert.rejects(gateway.flushRepliesOnce(), /synthetic frozen read failure/,
    "ordinary recovery must continue reporting its failures");
  f.setBeforeRead(async () => undefined);
  await gateway.flushRepliesOnce();
  assert.deepEqual(f.sends, ["A", "C", "B"]);
  assert.equal(f.state.outbox[oldKey], undefined);
  assert.deepEqual(f.posts, ["m1", "m2"]);
});

test("a failed admission engine acknowledgement admits new work and retries only its receipt", async t => {
  const f = fixture(t), modelRequests: string[] = [], reads: string[] = [];
  let oldAcknowledgements = 0;
  const engine: GatewayReplyEngine = { requestBudgetMs: 1000,
    reply: async (_account, input) => {
      modelRequests.push(input.messageId);
      return { text: input.messageId === "m1" ? "AB" : "C" };
    },
    getReply: async (_account, _chat, messageId) => { reads.push(messageId); return { text: "AB" }; },
    ackReply: async (_account, _chat, messageId) => {
      if (messageId === "m1" && ++oldAcknowledgements === 1) throw new Error("synthetic receipt persistence failure");
    },
  };
  const gateway = f.createGateway(f.state, engine);
  await gateway.pollOnce();
  f.nextPage();
  await gateway.pollOnce();
  assert.deepEqual(modelRequests, ["m1", "m2"]);
  assert.deepEqual(reads, ["m1"]);
  assert.equal(oldAcknowledgements, 2, "the failed acknowledgement is retried without reading or sending again");
  assert.deepEqual(f.sends, ["A", "B"]);
  assert.equal(f.state.outbox[f.state.computeDeliveryKey("chat", "m1")], undefined);
  assert.equal(f.state.outbox[f.state.computeDeliveryKey("chat", "m2")].status, "pending");
  assert.equal(f.state.isMessageProcessed(f.state.computeDeliveryKey("chat", "m2")), true);
  assert.equal(f.state.syncBuf, "cursor-2");
  assert.deepEqual(f.posts, []);
});

for (const status of ["pending", "receipt"] as const) {
  test(`global recovery skips another active chat's ${status} engine item until its query finishes`, async t => {
    const f = fixture(t);
    const oldKey = f.state.computeDeliveryKey("chat", "old");
    f.state.putOutbox({ kind: "reply", source: "engine", chatId: "chat", messageId: "old", deliveryKey: oldKey,
      splitMaxChars: 1, splitMultiPart: true, status, ...(status === "receipt" ? { receiptStatus: "accepted" as const } : {}) });
    let started!: () => void, release!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const releasePromise = new Promise<void>(resolve => { release = resolve; });
    let oldOperations = 0, queryActive = false;
    const recoverOld = async () => {
      oldOperations++;
      if (oldOperations === 1) throw new Error("synthetic admission recovery failure");
      if (queryActive) await releasePromise; // An engine recovery takes the same chat lock as reply().
    };
    const engine: GatewayReplyEngine = { requestBudgetMs: 1000,
      reply: async () => {
        queryActive = true;
        started();
        await releasePromise;
        queryActive = false;
        return { text: "C" };
      },
      getReply: async () => { await recoverOld(); return { text: "Q" }; },
      ackReply: async (_account, _chat, messageId) => {
        if (status === "receipt" && messageId === "old") await recoverOld();
      },
    };
    const gateway = f.createGateway(f.state, engine);
    const polling = gateway.pollOnce();
    await Promise.race([startedPromise, polling.then(() => assert.fail("query must start and wait at the release gate"))]);
    let recoveryFinished = false;
    const recovery = gateway.flushRepliesOnce().then(() => { recoveryFinished = true; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(recoveryFinished, true, "global recovery cannot wait for another active query's chat lock");
      assert.equal(oldOperations, 1, "neither frozen reads nor terminal receipts may touch an unrelated active chat");
      assert.equal(f.state.outbox[oldKey].status, status);
    } finally {
      release();
      await Promise.all([polling, recovery]);
    }
    if (status === "pending") {
      assert.equal(f.state.outbox[oldKey].status, "pending");
      f.state.recordInboundContext("retry-old", "chat", Date.now(), true, "retry-context");
      await gateway.flushRepliesOnce();
      assert.deepEqual(f.sends, ["C", "Q"]);
    } else assert.deepEqual(f.sends, ["C"]);
    assert.equal(f.state.outbox[oldKey], undefined);
    assert.equal(f.state.syncBuf, "cursor-1");
  });
}

for (const pressure of ["outbox", "engine"] as const) {
  test(`${pressure} backpressure recovery keeps the caller's active chat eligible`, async t => {
    const f = fixture(t, pressure === "outbox" ? 1 : undefined);
    const oldKey = f.state.computeDeliveryKey("chat", "old");
    f.state.putOutbox({ kind: "reply", source: "engine", chatId: "chat", messageId: "old", deliveryKey: oldKey,
      splitMaxChars: 1, splitMultiPart: true, status: "pending" });
    let reads = 0, requests = 0, released = false;
    const engine: GatewayReplyEngine = { requestBudgetMs: 1000,
      reply: async () => {
        requests++;
        if (pressure === "engine" && requests === 1) throw new ReplyEngineBackpressureError();
        assert.equal(released, true, "global backpressure recovery must release the caller's own old reply");
        return { text: "C" };
      },
      getReply: async () => {
        if (++reads === 1) throw new Error("synthetic admission recovery failure");
        return { text: "Q" };
      },
      ackReply: async (_account, _chat, messageId) => { if (messageId === "old") released = true; },
    };
    await f.createGateway(f.state, engine).pollOnce();
    assert.equal(reads, 2);
    assert.equal(requests, pressure === "engine" ? 2 : 1);
    assert.equal(f.state.outbox[oldKey], undefined);
    assert.equal(f.state.outbox[f.state.computeDeliveryKey("chat", "m1")].status, "pending");
    assert.equal(f.state.isMessageProcessed(f.state.computeDeliveryKey("chat", "m1")), true);
    assert.deepEqual(f.sends, ["Q"]);
    assert.deepEqual(f.posts, []);
    assert.equal(f.state.syncBuf, "cursor-1");
  });
}

test("fresh budget quarantines uncertain old chunks without GET, resend or re-POST", async t => {
  const f = fixture(t);
  await f.createGateway(f.state).pollOnce();
  const oldKey = f.state.computeDeliveryKey("chat", "m1");
  f.state.beginReplyChunk(oldKey, 1);
  const restarted = f.createState();
  f.nextPage();
  await f.createGateway(restarted).pollOnce();
  assert.deepEqual(f.sends, ["A", "C"]);
  assert.deepEqual(f.posts, ["m1", "m2"]);
  assert.deepEqual(f.reads, []);
  assert.equal(restarted.outbox[oldKey].status, "uncertain");
  assert.equal(restarted.hasUncertainReply(oldKey), true);
  assert.equal(restarted.replyDeliveries[oldKey].acknowledgedChunks, 1);
  assert.equal(restarted.syncBuf, "cursor-2");
});

test("a concurrent unrelated recovery cannot bypass refreshed chat's deferred reply", async t => {
  const f = fixture(t), gateway = f.createGateway(f.state);
  await gateway.pollOnce();
  const otherKey = f.state.computeDeliveryKey("other-chat", "other");
  f.state.recordInboundContext(otherKey, "other-chat", f.timestamp, true, "other-context");
  f.state.putOutbox({ kind: "reply", source: "controller", chatId: "other-chat", messageId: "other",
    deliveryKey: otherKey, splitMaxChars: 1, splitMultiPart: true, status: "pending" });
  let entered!: () => void, release!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const releasePromise = new Promise<void>(resolve => { release = resolve; });
  f.setBeforeRead(async messageId => {
    if (messageId !== "other") return;
    entered();
    await releasePromise;
  });
  const recovery = gateway.flushRepliesOnce();
  await enteredPromise;
  f.nextPage();
  const polling = gateway.pollOnce();
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(f.posts, ["m1"], "new query waits for its fair recovery turn");
  } finally {
    release();
    await Promise.all([recovery, polling]);
  }
  assert.deepEqual(f.sends, ["A", "Z", "B"]);
  assert.deepEqual(f.posts, ["m1", "m2"]);
  assert.deepEqual(f.reads, ["other", "m1"]);
  assert.equal(f.state.remainingSendBudget("chat"), 0);
  assert.equal(f.state.remainingSendBudget("other-chat"), 0);
});
