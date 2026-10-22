import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StateManager } from "../../src/runtime/state.js";
import { ControllerClient } from "../../src/controller/client.js";
import { ILinkClient } from "../../src/wechat/client.js";
import { WeChatGateway } from "../../src/gateway.js";

function fixture(t: TestContext) {
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
  const createState = () => new StateManager(account, statePath, { sendBudget: 1 });
  const state = createState();
  state.markBaselineEstablished();
  const createGateway = (current: StateManager) => new WeChatGateway({ stateManager: current, splitMaxChars: 1,
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
