import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test, { type TestContext } from "node:test";
import { NotificationOutbox } from "../../src/runtime/notification-outbox.js";
import { StateManager } from "../../src/runtime/state.js";
import { ILinkClient } from "../../src/wechat/client.js";
import type { DeferReason } from "../../src/runtime/context-policy.js";
import type { Notification } from "../../src/controller/notification-contract.js";
import type { DeliveryOutboxItem } from "../../src/types.js";
import { claimed, json, notification } from "../fixtures/notification-fixtures.js";

function setup(t: TestContext, items: Notification[] = [notification()]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "notification-recovery-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const credentialsPath = path.join(dir, "account.json"), statePath = path.join(dir, "state.json");
  fs.writeFileSync(credentialsPath, JSON.stringify({ token: "synthetic", accountId: "synthetic" }));
  let state = new StateManager(credentialsPath, statePath);
  state.markBaselineEstablished();
  for (const item of items) {
    state.setContextToken(item.chatId, "synthetic-context");
    state.recordInboundContext(`inbound:${item.chatId}`, item.chatId, Date.now());
  }
  const records = new Map(items.map(item => [item.id, item]));
  const sends: { chatId: string; text: string; clientId: string }[] = [];
  const calls: string[] = [];
  const hooks: {
    claim?: () => void;
    defer?: () => void;
    receipt?: () => void;
    list?: (chatId: string) => void;
    send?: () => void;
    typing?: () => void | Promise<void>;
  } = {};
  const controller = {
    async listNotifications(chatIds: string[]) {
      calls.push(`list:${chatIds.join(",")}`); hooks.list?.(chatIds[0]);
      return [...records.values()].filter(item => chatIds.includes(item.chatId) && item.status === "pending")
        .sort((a, b) => Number(a.kind === "progress") - Number(b.kind === "progress")).slice(0, 1);
    },
    async getNotification(id: string) {
      calls.push(`get:${id}`);
      const item = records.get(id)!;
      return item.status === "claimed" && item.attemptExpiresAt! <= Date.now() ? { ...item, status: "uncertain" as const } : item;
    },
    async claimNotification(id: string, attemptId: string) {
      calls.push(`claim:${id}`);
      const next = claimed(records.get(id)!, attemptId);
      records.set(id, next); hooks.claim?.(); return next;
    },
    async deferNotification(id: string, attemptId: string, reason: DeferReason) {
      calls.push(`defer:${id}`);
      const { attemptId: _attempt, attemptedAt: _at, attemptExpiresAt: _expires, ...previous } = records.get(id)!;
      const next: Notification = { ...previous, status: "pending", lastDeferredAttemptId: attemptId, lastDeferReason: reason };
      records.set(id, next); hooks.defer?.(); return next;
    },
    async recordNotificationReceipt(id: string, attemptId: string, status: "accepted" | "uncertain") {
      calls.push(`receipt:${id}`);
      assert.equal(records.get(id)!.attemptId, attemptId);
      const next = { ...records.get(id)!, status };
      hooks.receipt?.(); records.set(id, next); return next;
    },
  };
  const create = (maxChars = 3000, shouldContinue = () => true) => {
    const ilink = new ILinkClient({ stateManager: state, fetchImpl: async (url, init) => {
      if (String(url).endsWith("getconfig")) { await hooks.typing?.(); return json({ ret: 0 }); }
      if (String(url).endsWith("sendtyping")) return json({ ret: 0 });
      const msg = JSON.parse(String(init?.body)).msg;
      sends.push({ chatId: msg.to_user_id, text: msg.item_list[0].text_item.text, clientId: msg.client_id });
      hooks.send?.(); return json({ ret: 0 });
    } });
    return new NotificationOutbox({ stateManager: state, ilink, controller, splitMaxChars: maxChars,
      signal: new AbortController().signal, shouldContinue });
  };
  return { get state() { return state; }, controller, records, calls, sends, hooks, create,
    restart() { state = new StateManager(credentialsPath, statePath); return state; },
    durable() { return new StateManager(credentialsPath, statePath); } };
}

test("claim intent is durable before dispatch and lost response resumes the same attempt via GET", async t => {
  const f = setup(t), item = notification(), key = `notification:${item.id}`;
  f.hooks.claim = () => {
    const ref = f.durable().outbox[key];
    assert.equal(ref.status, "claiming"); assert.equal(ref.attemptId, f.records.get(item.id)!.attemptId);
    throw new TypeError("claim response lost");
  };
  await assert.rejects(f.create().deliverOnce(), /claim response lost/);
  assert.equal(f.sends.length, 0);
  const attempt = f.records.get(item.id)!.attemptId;
  f.hooks.claim = undefined; f.restart(); f.calls.length = 0;
  assert.equal((await f.create().deliverOnce()).accepted, 1);
  assert.equal(f.calls[0], `get:${item.id}`);
  assert.equal(f.calls.some(call => call.startsWith("claim:")), false);
  assert.equal(f.records.get(item.id)!.attemptId, attempt);
  assert.equal(f.sends.length, 1);
});

for (const field of ["source", "text"] as const) test(`recovery rejects changed notification ${field}`, async t => {
  const f = setup(t), item = notification(), key = `notification:${item.id}`;
  f.hooks.claim = () => { throw new TypeError("claim response lost"); };
  await assert.rejects(f.create().deliverOnce(), /claim response lost/);
  const current = f.records.get(item.id)!;
  f.records.set(item.id, field === "source"
    ? { ...current, source: { type: "goal", id: current.source.id } }
    : { ...current, text: "tampered notification" });
  f.restart();
  await assert.rejects(f.create().deliverOnce(), /identity mismatch/);
  assert.equal(f.sends.length, 0);
  assert.equal(f.state.outbox[key].status, "claiming");
});

test("receipt intent survives restart and retries only the receipt", async t => {
  const f = setup(t), item = notification(), key = `notification:${item.id}`;
  f.hooks.receipt = () => {
    assert.equal(f.durable().outbox[key].status, "receipt");
    assert.equal(f.durable().outbox[key].receiptStatus, "accepted");
    throw new TypeError("receipt unavailable");
  };
  await assert.rejects(f.create().deliverOnce(), /receipt unavailable/);
  assert.equal(f.sends.length, 1);
  f.hooks.receipt = undefined; f.restart(); f.calls.length = 0;
  assert.equal((await f.create(2).deliverOnce()).accepted, 1);
  assert.equal(f.calls[0], `get:${item.id}`);
  assert.equal(f.sends.length, 1);
  assert.equal(f.state.outbox[key], undefined);
  assert.equal(f.state.replyDeliveries[key].acknowledgedChunks, 1);
});

test("partial budget exhaustion defers durably and continues frozen chunks after refreshed context", async t => {
  const item = { ...notification(), text: "abcdefghijkl" }, f = setup(t, [item]), key = `notification:${item.id}`;
  f.state.contextBudgets.chat.remaining = 1; f.state.saveState();
  assert.equal((await f.create(4).deliverOnce()).skipped, 1);
  assert.deepEqual(f.sends.map(send => send.text), ["abcd"]);
  assert.equal(f.durable().outbox[key].status, "pending");
  assert.equal(f.records.get(item.id)!.lastDeferReason, "budget_exhausted");
  f.restart(); f.state.recordInboundContext("new-inbound", "chat", Date.now());
  assert.equal((await f.create(999).deliverOnce()).accepted, 1);
  assert.deepEqual(f.sends.map(send => send.text), ["abcd", "efgh", "ijkl"]);
  assert.equal(new Set(f.sends.map(send => send.clientId)).size, 3);
});

test("lost defer response recovers matching remote marker without reusing the old attempt", async t => {
  const item = { ...notification(), text: "abcdefgh" }, f = setup(t, [item]), key = `notification:${item.id}`;
  f.state.contextBudgets.chat.remaining = 1;
  f.hooks.defer = () => {
    const ref = f.durable().outbox[key];
    assert.equal(ref.status, "defer"); assert.equal(ref.deferReason, "budget_exhausted");
    throw new TypeError("defer response lost");
  };
  await assert.rejects(f.create(4).deliverOnce(), /defer response lost/);
  const previousAttempt = f.state.outbox[key].attemptId;
  f.hooks.defer = undefined; f.restart(); f.state.recordInboundContext("new-inbound", "chat", Date.now()); f.calls.length = 0;
  await f.create(99).deliverOnce();
  assert.equal(f.state.outbox[key].status, "pending");
  assert.equal(f.calls[0], `get:${item.id}`); assert.equal(f.sends.length, 1);
  assert.equal((await f.create(99).deliverOnce()).accepted, 1);
  assert.notEqual(f.records.get(item.id)!.attemptId, previousAttempt);
  assert.deepEqual(f.sends.map(send => send.text), ["abcd", "efgh"]);
});

test("defer marker mismatch fails closed and preserves the durable intent", async t => {
  const item = { ...notification(), text: "abcdefgh" }, f = setup(t, [item]), key = `notification:${item.id}`;
  f.state.contextBudgets.chat.remaining = 1;
  f.hooks.defer = () => { throw new TypeError("lost"); };
  await assert.rejects(f.create(4).deliverOnce(), /lost/);
  f.records.set(item.id, { ...item, lastDeferredAttemptId: "00000000-0000-4000-8000-999999999999", lastDeferReason: "budget_exhausted" });
  f.hooks.defer = undefined; f.restart();
  await assert.rejects(f.create().deliverOnce(), /defer recovery identity mismatch/);
  assert.equal(f.state.outbox[key].status, "defer"); assert.equal(f.sends.length, 1);
});

test("claimed recovery with exhausted local budget defers without another network send", async t => {
  const f = setup(t), item = notification(), key = `notification:${item.id}`;
  f.hooks.claim = () => { throw new TypeError("lost claim response"); };
  await assert.rejects(f.create().deliverOnce(), /lost claim/);
  f.hooks.claim = undefined; f.restart(); f.state.contextBudgets.chat.remaining = 0;
  assert.equal((await f.create().deliverOnce()).skipped, 1);
  assert.equal(f.sends.length, 0); assert.equal(f.records.get(item.id)!.status, "pending");
  assert.equal(f.durable().outbox[key].status, "pending");
});

test("in-flight uncertainty is sealed before any budget defer can reopen the attempt", async t => {
  const f = setup(t), item = notification(), key = `notification:${item.id}`;
  f.hooks.send = () => { throw new TypeError("send response lost"); };
  f.hooks.receipt = () => { throw new TypeError("receipt lost"); };
  await assert.rejects(f.create().deliverOnce(), /receipt lost/);
  assert.equal(f.durable().hasUncertainReply(key), true);
  f.hooks.send = undefined; f.hooks.receipt = undefined; f.restart(); f.state.contextBudgets.chat.remaining = 0;
  assert.equal((await f.create().deliverOnce()).uncertain, 1);
  assert.equal(f.sends.length, 1); assert.equal(f.records.get(item.id)!.status, "uncertain");
  f.state.recordInboundContext("new-inbound", "chat", Date.now()); await f.create().deliverOnce();
  assert.equal(f.sends.length, 1); assert.equal(f.state.outbox[key].status, "uncertain");
});

test("expired partial delivery keeps outbox and acknowledged reply evidence", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const item = { ...notification(), text: "abcdefgh", expiresAt: Date.now() + 60_000 }, f = setup(t, [item]), key = `notification:${item.id}`;
  f.state.contextBudgets.chat.remaining = 1;
  await f.create(4).deliverOnce();
  t.mock.timers.tick(60_001); f.restart();
  await f.create().deliverOnce();
  assert.equal(f.durable().outbox[key].status, "expired");
  assert.equal(f.durable().replyDeliveries[key].acknowledgedChunks, 1);
  assert.equal(f.records.get(item.id)!.status, "pending");
  assert.equal(f.sends.length, 1);
});

test("an exhausted chat cannot occupy the notification queue head", async t => {
  const f = setup(t, [notification(1, "a"), notification(2, "b")]);
  f.state.contextBudgets.a.remaining = 0;
  assert.equal((await f.create().deliverOnce()).accepted, 1);
  assert.deepEqual(f.sends.map(send => send.chatId), ["b"]);
  assert.equal(f.calls.includes("claim:00000000-0000-4000-8000-000000000001"), false);
  assert.deepEqual(f.calls.filter(call => call.startsWith("list:")), ["list:b"]);
});

test("chat lookup network failure still gives an independent chat a delivery turn", async t => {
  const f = setup(t, [notification(1, "a"), notification(2, "b")]);
  f.hooks.list = chatId => { if (chatId === "a") throw new TypeError("chat a unavailable"); };
  await assert.rejects(f.create().deliverOnce(), /chat a unavailable/);
  assert.deepEqual(f.sends.map(send => send.chatId), ["b"]);
});

test("pending ordinary reply reserves its chat budget against progress notifications", async t => {
  const base = notification(1), item: Notification = { ...notification(2), source: base.source,
    kind: "progress", progress: { sequence: 1, eventKey: "started" } }, f = setup(t, [item]);
  f.state.putOutbox({ kind: "reply", deliveryKey: "ordinary-reply", chatId: "chat", messageId: "message",
    splitMaxChars: 100, status: "pending" });
  assert.equal((await f.create().deliverOnce()).skipped, 1);
  assert.equal(f.sends.length, 0); assert.equal(f.calls.some(call => call.startsWith("claim:")), false);
  f.state.removeOutbox("ordinary-reply");
  assert.equal((await f.create().deliverOnce()).accepted, 1);
  assert.equal(f.state.contextBudgets.chat.progressSent, 1);
});

test("pending ordinary reply does not block a final notification", async t => {
  const f = setup(t);
  f.state.putOutbox({ kind: "reply", deliveryKey: "ordinary-reply", chatId: "chat", messageId: "message",
    splitMaxChars: 100, status: "pending" });
  assert.equal((await f.create().deliverOnce()).accepted, 1);
  assert.equal(f.state.contextBudgets.chat.progressSent, 0);
});

test("an existing blocked progress reference does not hide a new final notification", async t => {
  const final = notification(1), progress: Notification = { ...notification(2), source: final.source,
    kind: "progress", progress: { sequence: 1, eventKey: "started" } }, f = setup(t, [progress]);
  f.state.putOutbox({ kind: "reply", deliveryKey: "ordinary", chatId: "chat", messageId: "message",
    splitMaxChars: 100, status: "pending" });
  assert.equal((await f.create().deliverOnce()).skipped, 1);
  f.records.set(final.id, final);
  assert.equal((await f.create().deliverOnce()).accepted, 1);
  assert.equal(f.sends.length, 1); assert.equal(f.sends[0].text, final.text);
  assert.equal(f.state.outbox[`notification:${progress.id}`].status, "pending");
});

test("crash before receipt intent preserves in-flight evidence and never defers an ambiguous send", async t => {
  const item = notification(), f = setup(t, [item]), key = `notification:${item.id}`;
  f.hooks.send = () => { throw new TypeError("ambiguous send"); };
  const originalUpdate = f.state.updateOutbox.bind(f.state);
  const update = t.mock.method(f.state, "updateOutbox", (deliveryKey: string, patch: Partial<DeliveryOutboxItem>) => {
    if (patch.status === "receipt") throw new Error("receipt intent disk failure");
    return originalUpdate(deliveryKey, patch);
  });
  await assert.rejects(f.create().deliverOnce(), /receipt intent disk failure/);
  assert.equal(f.durable().outbox[key].status, "claimed");
  assert.equal(f.durable().hasUncertainReply(key), true);
  update.mock.restore(); f.hooks.send = undefined; f.restart(); f.state.contextBudgets.chat.remaining = 0;
  assert.equal((await f.create().deliverOnce()).uncertain, 1);
  assert.equal(f.sends.length, 1); assert.equal(f.calls.some(call => call.startsWith("defer:")), false);
  assert.equal(f.state.outbox[key].status, "uncertain");
});

test("failed durable claim intent prevents the Controller claim request", async t => {
  const item = notification(), f = setup(t, [item]), key = `notification:${item.id}`;
  const originalUpdate = f.state.updateOutbox.bind(f.state);
  t.mock.method(f.state, "updateOutbox", (deliveryKey: string, patch: Partial<DeliveryOutboxItem>) => {
    if (patch.status === "claiming") throw new Error("claim intent disk failure");
    return originalUpdate(deliveryKey, patch);
  });
  await assert.rejects(f.create().deliverOnce(), /claim intent disk failure/);
  assert.equal(f.calls.some(call => call.startsWith("claim:")), false);
  assert.equal(f.durable().outbox[key].status, "pending");
  assert.equal(f.sends.length, 0);
});

test("progress claim recovery yields to a pending ordinary reply through durable defer", async t => {
  const base = notification(1), progress: Notification = { ...notification(2), source: base.source,
    kind: "progress", progress: { sequence: 1, eventKey: "started" } }, f = setup(t, [progress]);
  f.hooks.claim = () => { throw new TypeError("claim response lost"); };
  await assert.rejects(f.create().deliverOnce(), /claim response lost/);
  f.hooks.claim = undefined; f.restart();
  f.state.putOutbox({ kind: "reply", deliveryKey: "ordinary", chatId: "chat", messageId: "message",
    splitMaxChars: 100, status: "pending" });
  await f.create().deliverOnce();
  assert.equal(f.sends.length, 0); assert.equal(f.records.get(progress.id)!.status, "pending");
  assert.equal(f.records.get(progress.id)!.lastDeferReason, "budget_exhausted");
  assert.equal(f.state.outbox[`notification:${progress.id}`].status, "pending");
});

test("claim cancellation before send produces a durable defer without an uncertain receipt", async t => {
  const f = setup(t), item = notification();
  let running = true;
  f.hooks.claim = () => { running = false; };
  assert.equal((await f.create(3000, () => running).deliverOnce()).skipped, 1);
  assert.equal(f.records.get(item.id)!.status, "pending");
  assert.equal(f.records.get(item.id)!.lastDeferReason, "context_changed");
  assert.equal(f.sends.length, 0); assert.equal(f.calls.some(call => call.startsWith("receipt:")), false);
});

test("context changes during typing safely defer before any message request", async t => {
  const f = setup(t), item = notification();
  f.hooks.typing = () => f.state.setContextToken("chat", "new-context");
  assert.equal((await f.create().deliverOnce()).skipped, 1);
  assert.equal(f.records.get(item.id)!.status, "pending");
  assert.equal(f.records.get(item.id)!.lastDeferReason, "context_changed");
  assert.equal(f.sends.length, 0); assert.equal(f.calls.some(call => call.startsWith("receipt:")), false);
});

test("TTL expiry between chunks retains acknowledged partial evidence without fabricating a receipt", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const item = { ...notification(), text: "abcdefgh", expiresAt: Date.now() + 60_000 }, f = setup(t, [item]), key = `notification:${item.id}`;
  f.hooks.send = () => t.mock.timers.tick(60_001);
  assert.equal((await f.create(4).deliverOnce()).skipped, 1);
  assert.equal(f.durable().outbox[key].status, "expired");
  assert.equal(f.durable().replyDeliveries[key].acknowledgedChunks, 1);
  assert.equal(f.sends.length, 1); assert.equal(f.calls.some(call => call.startsWith("receipt:")), false);
});

for (const expiredLease of [false, true]) test(`complete chunk acknowledgements recover a failed receipt-intent write with exhausted budget${expiredLease ? " and projected uncertainty" : ""}`, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const f = setup(t), item = notification(), key = `notification:${item.id}`;
  f.state.contextBudgets.chat.remaining = 1;
  const originalUpdate = f.state.updateOutbox.bind(f.state);
  const update = t.mock.method(f.state, "updateOutbox", (deliveryKey: string, patch: Partial<DeliveryOutboxItem>) => {
    if (patch.status === "receipt") throw new Error("receipt intent disk failure");
    return originalUpdate(deliveryKey, patch);
  });
  await assert.rejects(f.create().deliverOnce(), /receipt intent disk failure/);
  assert.equal(f.durable().outbox[key].status, "claimed");
  assert.equal(f.durable().replyDeliveries[key].acknowledgedChunks, 1);
  assert.equal(f.durable().contextBudgets.chat.remaining, 0);
  update.mock.restore(); f.restart();
  if (expiredLease) t.mock.timers.tick(60_001);
  assert.equal((await f.create().deliverOnce()).accepted, 1);
  assert.equal(f.sends.length, 1); assert.equal(f.state.outbox[key], undefined);
  assert.equal(f.records.get(item.id)!.status, "accepted");
  assert.equal(f.calls.some(call => call.startsWith("defer:")), false);
});

test("accepted receipt intent survives TTL expiry and projected uncertainty without another send", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const f = setup(t), item = notification();
  f.hooks.receipt = () => { throw new TypeError("receipt network failure"); };
  await assert.rejects(f.create().deliverOnce(), /receipt network failure/);
  f.hooks.receipt = undefined; t.mock.timers.tick(86_400_001); f.restart();
  assert.equal((await f.create().deliverOnce()).accepted, 1);
  assert.equal(f.sends.length, 1); assert.equal(f.records.get(item.id)!.status, "accepted");
});

test("a successful final chunk crossing TTL records its real receipt without resending", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const item = { ...notification(), expiresAt: Date.now() + 60_000 }, f = setup(t, [item]);
  f.hooks.send = () => t.mock.timers.tick(60_001);
  assert.equal((await f.create().deliverOnce()).accepted, 1);
  assert.equal(f.sends.length, 1); assert.equal(f.records.get(item.id)!.status, "accepted");
});

test("an unsendable pending reference skips large Controller GET bodies until the budget is refreshed", async t => {
  const item = { ...notification(), text: "abcdefgh" }, f = setup(t, [item]);
  f.state.contextBudgets.chat.remaining = 1;
  await f.create(4).deliverOnce(); f.calls.length = 0;
  await f.create(4).deliverOnce();
  assert.deepEqual(f.calls, []);
  f.state.recordInboundContext("new-inbound", "chat", Date.now());
  assert.equal((await f.create(999).deliverOnce()).accepted, 1);
  assert.equal(f.calls[0], `get:${item.id}`);
  assert.deepEqual(f.sends.map(send => send.text), ["abcd", "efgh"]);
});

test("a stale progress claim conflict cannot starve a final notification in the same chat", async t => {
  const final = notification(1), progress: Notification = { ...notification(2), source: final.source,
    kind: "progress", progress: { sequence: 1, eventKey: "started" } }, f = setup(t, [progress]);
  f.state.putOutbox({ kind: "reply", deliveryKey: "ordinary", chatId: "chat", messageId: "message",
    splitMaxChars: 100, status: "pending" });
  await f.create().deliverOnce(); f.state.removeOutbox("ordinary"); f.records.set(final.id, final);
  const claim = f.controller.claimNotification.bind(f.controller);
  t.mock.method(f.controller, "claimNotification", (id: string, attemptId: string) => {
    if (id === progress.id) throw new Error("Controller notification request HTTP 409");
    return claim(id, attemptId);
  });
  await assert.rejects(f.create().deliverOnce(), /HTTP 409/);
  assert.equal(f.records.get(final.id)!.status, "accepted");
  assert.deepEqual(f.sends.map(send => send.text), [final.text]);
});

test("a notification with little send time remaining is delivered while typing stays pending", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const item = { ...notification(), createdAt: Date.now() - 60_000 }, f = setup(t, [item]);
  f.hooks.claim = () => {
    const current = f.records.get(item.id)!;
    current.attemptedAt = Date.now() - 29_990;
    current.attemptExpiresAt = current.attemptedAt + 60_000;
  };
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const began = new Promise<void>(resolve => { started = resolve; });
  f.hooks.typing = async () => { started(); await gate; };
  const delivery = f.create().deliverOnce();
  try {
    await began;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.sends.length, 1);
    assert.equal(f.records.get(item.id)!.status, "accepted");
  } finally { release(); await delivery; }
  assert.equal((await delivery).accepted, 1);
});
