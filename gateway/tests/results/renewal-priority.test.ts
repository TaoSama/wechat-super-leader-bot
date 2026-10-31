import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { harness } from "../fixtures/notification-fixtures.js";
import { WeChatGateway } from "../../src/gateway.js";
import { StateManager } from "../../src/runtime/state.js";
import { ResultClient } from "../../src/controller/result-client.js";
import { FileResultOutbox, resultIdentity } from "../../src/results/outbox.js";
import type { ResultDelivery } from "../../src/results/contracts.js";
import { accountRenewalDeliveryKey } from "../../src/results/renewal.js";
import { LocalSendDeferredError } from "../../src/runtime/context-policy.js";

const HOUR = 60 * 60 * 1000;
const text = (sent: Record<string, unknown>) => (sent.item_list as { text_item: { text: string } }[])[0].text_item.text;

function fixture(t: TestContext, remaining: number, body = "ordinary", source: "engine" | "controller" = "engine") {
  const f = harness(t);
  const client = new ResultClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic" });
  t.mock.method(client, "notificationInterest", async () => ({ chatIds: [], interested: [] }));
  const reads: string[] = [], acknowledgements: string[] = [];
  const replyEngine = {
    requestBudgetMs: 1_000,
    reply: async () => { throw new Error("must not re-execute"); },
    getReply: async (_account: string, _chat: string, messageId: string) => { reads.push(messageId); return { text: body }; },
    ackReply: async (_account: string, _chat: string, _message: string, status: string) => { acknowledgements.push(status); },
  };
  t.mock.method(f.controller, "getMessageReply", async (_chat: string, messageId: string) => { reads.push(messageId); return { text: body }; });
  f.state.contextWindows.chat.refreshedAt = Date.now() - 22 * HOUR - 1_000;
  f.state.accountSendBudget!.refreshedAt = f.state.contextWindows.chat.refreshedAt;
  f.state.accountSendBudget!.remaining = remaining;
  f.state.putOutbox({ kind: "reply", source, chatId: "chat", messageId: "message", deliveryKey: "ordinary",
    splitMaxChars: 2_000, status: "pending" });
  const create = (state = f.state) => new WeChatGateway({ stateManager: state, ilink: state === f.state ? f.ilink : f.createILink(state),
    controller: f.controller, replyEngine, resultClient: client,
    resultOutbox: new FileResultOutbox(`${f.statePath}.results.json`, () => state.getLoginFingerprint()) });
  return { ...f, client, reads, acknowledgements, create, gateway: create() };
}

for (const source of ["engine", "controller"] as const) {
  for (const remaining of [1, 2]) test(`${source} pending reply qualifies without Controller interest; reminder wins with ${remaining} sends`, async t => {
    const f = fixture(t, remaining, "ordinary", source);
    await f.gateway.deliverNotificationsOnce();
    assert.match(text(f.sends[0]), /发一条消息/);
    assert.equal(f.sends.length, remaining);
    assert.equal(f.state.accountSendBudget!.remaining, 0);
    if (remaining === 1) {
      assert.equal(f.state.outbox.ordinary.status, "pending");
      assert.equal(f.acknowledgements.length, 0);
    } else {
      assert.equal(text(f.sends[1]), "ordinary");
      assert.equal(f.state.outbox.ordinary, undefined);
    }
  });
}

for (const remaining of [3, 10]) test(`ordinary reply is not blocked by a reminder with ${remaining} sends remaining`, async t => {
  const f = fixture(t, remaining);
  await f.gateway.deliverNotificationsOnce();
  assert.deepEqual(f.sends.map(text), ["ordinary"]);
  assert.equal(f.state.accountSendBudget!.remaining, remaining - 1);
  assert.equal(f.state.outbox.ordinary, undefined);
  const key = accountRenewalDeliveryKey(f.state.getLoginFingerprint(), f.state.accountSendBudget!);
  assert.equal(f.state.replyDeliveries[key], undefined);
});

test("multipart 3 -> 2 yields its suffix, sends priority reminder, then resumes frozen text across restart and refresh", async t => {
  const f = fixture(t, 3, "abcdefgh");
  f.state.updateOutbox("ordinary", { splitMaxChars: 2 });
  await f.gateway.deliverNotificationsOnce();
  assert.equal(text(f.sends[0]), "ab");
  assert.match(text(f.sends[1]), /主动发一条消息/);
  assert.equal(f.state.replyDeliveries.ordinary.acknowledgedChunks, 1);
  assert.equal(f.state.replyDeliveries.ordinary.inFlight, false);
  assert.equal(f.state.outbox.ordinary.status, "pending");
  const restarted = new StateManager(f.accountPath, f.statePath);
  await f.create(restarted).deliverNotificationsOnce();
  assert.equal(text(f.sends[2]), "cd");
  assert.equal(f.sends.length, 3, "one persisted reminder survives restart");
  assert.equal(restarted.replyDeliveries.ordinary.acknowledgedChunks, 2);
  assert.equal(restarted.outbox.ordinary.status, "pending");
  restarted.recordInboundContext("new-inbound", "chat", Date.now() - 100, true, "new-context");
  await f.create(restarted).deliverNotificationsOnce();
  assert.deepEqual(f.sends.slice(3).map(text), ["ef", "gh"]);
  assert.equal(restarted.outbox.ordinary, undefined);
  assert.deepEqual(f.acknowledgements, ["accepted"]);
});

test("legacy unsent renewal checkpoint upgrades without permanently blocking ordinary replies", async t => {
  const f = fixture(t, 2);
  const key = accountRenewalDeliveryKey(f.state.getLoginFingerprint(), f.state.accountSendBudget!);
  f.state.replyDeliveries[key] = { digest: "a".repeat(64), totalChunks: 1, acknowledgedChunks: 0, inFlight: false };
  await assert.rejects(
    f.ilink.sendMarkdownReply("chat", "ordinary", { deliveryKey: "ordinary", maxCharsPerChunk: 2_000 }),
    LocalSendDeferredError,
  );
  await f.gateway.deliverNotificationsOnce();
  assert.equal(f.state.replyDeliveries[key].acknowledgedChunks, 1);
  assert.match(text(f.sends[0]), /主动发一条消息/);
  await f.ilink.sendMarkdownReply("chat", "ordinary", { deliveryKey: "ordinary", maxCharsPerChunk: 2_000 });
  assert.equal(text(f.sends[1]), "ordinary");
});

test("queued ordinary callers yield under the shared lock while concurrent notification passes send one reminder", async t => {
  const f = fixture(t, 2);
  const ordinary = f.ilink.sendMarkdownReply("chat", "ordinary", { deliveryKey: "ordinary", maxCharsPerChunk: 2_000 });
  const rejected = assert.rejects(ordinary, LocalSendDeferredError);
  await Promise.all([rejected, f.gateway.deliverNotificationsOnce(), f.gateway.deliverNotificationsOnce()]);
  assert.equal(f.sends.length, 2);
  assert.match(text(f.sends[0]), /发一条消息/);
  assert.equal(text(f.sends[1]), "ordinary");
  assert.equal(f.state.replyDeliveries.ordinary.inFlight, false);
});

test("unknown reminder never repeats or blocks a pending ordinary reply after restart", async t => {
  const f = fixture(t, 2);
  let calls = 0;
  f.hooks.send = () => { if (++calls === 1) throw new Error("renewal response lost"); return { ret: 0 }; };
  await assert.rejects(f.gateway.deliverNotificationsOnce(), /renewal response lost/);
  assert.equal(f.sends.length, 2);
  assert.equal(text(f.sends[1]), "ordinary");
  const key = accountRenewalDeliveryKey(f.state.getLoginFingerprint(), f.state.accountSendBudget!);
  assert.equal(f.state.replyDeliveries[key].inFlight, true);
  const restarted = new StateManager(f.accountPath, f.statePath);
  await f.create(restarted).deliverNotificationsOnce();
  assert.equal(f.sends.length, 2);
});

test("local pending reply still receives reminder when Controller interest lookup is unavailable", async t => {
  const f = fixture(t, 1);
  t.mock.method(f.client, "notificationInterest", async () => { throw new Error("interest unavailable"); });
  await assert.rejects(f.gateway.deliverNotificationsOnce(), /interest unavailable/);
  assert.equal(f.sends.length, 1);
  assert.match(text(f.sends[0]), /发一条消息/);
  assert.equal(f.state.outbox.ordinary.status, "pending");
});

for (const evidence of ["unknown", "permanent-image-failure", "accepted"] as const) {
  test(`a local ${evidence} reply awaiting bookkeeping does not qualify for a reminder`, async t => {
    const f = fixture(t, 2);
    const key = evidence === "permanent-image-failure" ? "image-reply:ordinary" : "ordinary";
    f.state.prepareReplyDelivery(key, "a".repeat(64), 1);
    if (evidence === "permanent-image-failure") f.state.recordReplyFailure(key, "AttachmentUnavailable");
    else {
      f.state.beginReplyChunk(key, 0);
      if (evidence === "accepted") f.state.confirmReplyChunk(key, 0);
    }
    const restarted = new StateManager(f.accountPath, f.statePath);
    await f.create(restarted).deliverNotificationsOnce();
    assert.equal(f.sends.length, 0);
    assert.equal(restarted.accountSendBudget!.remaining, 2);
    assert.deepEqual(f.acknowledgements, [evidence === "accepted" ? "accepted" : "uncertain"]);
  });
}

for (const terminal of ["expired", "uncertain", "superseded"] as const) {
  test(`a local stale ${terminal} result reference does not qualify without Controller interest`, async t => {
    const f = fixture(t, 2);
    f.state.removeOutbox("ordinary");
    const now = Date.now(), id = randomUUID(), attemptId = randomUUID();
    const item: ResultDelivery = { id, key: id, chatId: "chat", source: { type: "plan", id: "old-plan" },
      kind: "completed", status: terminal === "expired" ? "ready" : terminal, mode: "text", messages: ["old result"],
      artifact: { id: randomUUID(), chatId: "chat", name: "result.md", size: 10, sha256: "a".repeat(64), expiresAt: now + HOUR },
      createdAt: now - HOUR, expiresAt: terminal === "expired" ? now - 1_000 : now + HOUR, retainedUntil: now + HOUR,
      ...(terminal === "uncertain" ? { attemptId, attemptedAt: now - 2_000, attemptExpiresAt: now - 1_000 } : {}) };
    const outbox = new FileResultOutbox(`${f.statePath}.results.json`, () => f.state.getLoginFingerprint());
    outbox.put({ id, chatId: "chat", identity: resultIdentity(item), status: "pending" });
    t.mock.method(f.client, "getDelivery", async () => item);
    await f.create().deliverNotificationsOnce();
    assert.equal(f.sends.length, 0);
    assert.equal(f.state.accountSendBudget!.remaining, 2);
    const reconciled = new FileResultOutbox(`${f.statePath}.results.json`, () => f.state.getLoginFingerprint());
    assert.deepEqual(reconciled.references(), [], "normal dispatcher still reconciles the stale reference");
  });
}
