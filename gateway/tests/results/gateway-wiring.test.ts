import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { harness } from "../fixtures/notification-fixtures.js";
import { WeChatGateway } from "../../src/gateway.js";
import { ResultClient } from "../../src/controller/result-client.js";
import { FileResultOutbox } from "../../src/results/outbox.js";
import type { MaterializedResultDelivery, ResultDelivery } from "../../src/results/contracts.js";

test("a failed resume checkpoint retries the same admitted generation without renewing its quota", async t => {
  const f = harness(t);
  const outbox = new FileResultOutbox(`${f.statePath}.results.json`, () => f.state.getLoginFingerprint());
  const client = new ResultClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic" });
  const gateway = new WeChatGateway({ stateManager: f.state, ilink: f.ilink, controller: f.controller,
    resultClient: client, resultOutbox: outbox });
  const createdAtMs = Date.now(), deliveryKey = "admitted-generation";
  t.mock.method(f.ilink, "pollBatch", async () => ({ messages: [{ chatId: "chat", deliveryKey,
    messageId: "message", text: "hello", contextToken: "new-context", createdAtMs }],
    rawMessageCount: 1, nextSyncBuf: "next" }));
  const forward = t.mock.method(f.controller, "forwardMessage", async () => ({ text: "reply" }));
  const checkpoint = t.mock.method(outbox, "queueResume", () => { throw new Error("injected resume disk failure"); });
  await assert.rejects(gateway.pollOnce(), /injected resume disk failure/);
  assert.equal(forward.mock.callCount(), 0);
  f.state.consumeSendBudget("chat");
  checkpoint.mock.restore();
  await gateway.pollOnce();
  assert.equal(forward.mock.callCount(), 1);
  assert.equal(f.state.accountSendBudget!.remaining, 8, "retry did not reset 9 back to 10 before its reply");
  assert.deepEqual(outbox.pendingResumes(), [{ chatId: "chat", generation: deliveryKey }]);
  assert.equal(f.state.syncBuf, "next");
});

test("an inbox checkpoint failure does not release result resumes before admission", async t => {
  const f = harness(t);
  const outbox = new FileResultOutbox(`${f.statePath}.results.json`, () => f.state.getLoginFingerprint());
  const client = new ResultClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic" });
  const gateway = new WeChatGateway({ stateManager: f.state, ilink: f.ilink, controller: f.controller,
    resultClient: client, resultOutbox: outbox });
  const createdAtMs = Date.now(), deliveryKey = "inbox-admission";
  const previousBudget = { ...f.state.contextWindows.chat };
  t.mock.method(f.ilink, "pollBatch", async () => ({ messages: [{ chatId: "chat", deliveryKey,
    messageId: "message", text: "hello", contextToken: "new-context", createdAtMs }],
    rawMessageCount: 1, nextSyncBuf: "next" }));
  const inbox = (gateway as unknown as { inbox: { put: (message: unknown) => void } }).inbox;
  const checkpoint = t.mock.method(inbox, "put", () => { throw new Error("injected inbox disk failure"); });
  await assert.rejects(gateway.pollOnce(false), /injected inbox disk failure/);
  assert.deepEqual(f.state.contextWindows.chat, previousBudget, "failed inbox admission must not refresh the context budget");
  assert.equal(f.state.contextTokens.chat, "synthetic-context", "failed inbox admission must not replace the context token");
  assert.deepEqual(outbox.pendingResumes(), []);
  checkpoint.mock.restore();
  await gateway.pollOnce(false);
  assert.deepEqual(outbox.pendingResumes(), [{ chatId: "chat", generation: deliveryKey }]);
  assert.equal(f.state.syncBuf, "next");
});

for (const renewal of ["accepted", "failed"] as const) test(`result failure still attempts one ${renewal} renewal for another chat and preserves the first error`, async t => {
  const f = harness(t);
  const outbox = new FileResultOutbox(`${f.statePath}.results.json`, () => f.state.getLoginFingerprint());
  const client = new ResultClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic" });
  const gateway = new WeChatGateway({ stateManager: f.state, ilink: f.ilink, controller: f.controller,
    resultClient: client, resultOutbox: outbox });
  const failure = new Error("result dispatch unavailable");
  if (renewal === "failed") f.hooks.send = () => { throw new Error("renewal transport response lost"); };
  t.mock.method(client, "notificationInterest", async () => ({ chatIds: ["broken"], interested: ["renewal"] }));
  t.mock.method(client, "listDeliveries", async () => { throw failure; });
  f.state.setContextToken("broken", "broken-context");
  f.state.recordInboundContext("broken-inbound", "broken", Date.now() - 1000);
  f.state.setContextToken("renewal", "renewal-context");
  f.state.recordInboundContext("renewal-inbound", "renewal", Date.now() - 22 * 60 * 60 * 1000 - 1000);
  f.state.accountSendBudget!.refreshedAt = f.state.contextWindows.renewal.refreshedAt;
  f.state.accountSendBudget!.remaining = 2;
  await assert.rejects(gateway.deliverNotificationsOnce(), error => error === failure);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].to_user_id, "renewal");
  await assert.rejects(gateway.deliverNotificationsOnce(), error => error === failure);
  assert.equal(f.sends.length, 1, "renewal remains deduplicated after another failed result tick");
});

function readyResultGateway(t: TestContext) {
  const f = harness(t), now = Date.now(), id = randomUUID(), artifactId = randomUUID();
  let item: ResultDelivery = { id, key: id, chatId: "chat", source: { type: "plan", id: "ready-plan" },
    kind: "completed", status: "ready", mode: "text", messages: ["ready task result"],
    createdAt: now - 1000, expiresAt: now + 120_000, retainedUntil: now + 120_000,
    artifact: { id: artifactId, chatId: "chat", name: "result.md", size: 1, sha256: "a".repeat(64), expiresAt: now + 120_000 } };
  const outbox = new FileResultOutbox(`${f.statePath}.results.json`, () => f.state.getLoginFingerprint());
  const client = new ResultClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic" });
  t.mock.method(client, "notificationInterest", async () => ({ chatIds: ["chat"], interested: [] }));
  t.mock.method(client, "resumeDeliveries", async () => {});
  t.mock.method(client, "listDeliveries", async () => item.status === "ready" ? [structuredClone(item)] : []);
  t.mock.method(client, "getDelivery", async () => structuredClone(item));
  t.mock.method(client, "claimDelivery", async (_id: string, attemptId: string) => {
    item = { ...item, status: "claimed", attemptId, attemptedAt: Date.now(), attemptExpiresAt: Date.now() + 60_000 };
    return structuredClone(item);
  });
  t.mock.method(client, "materializeDelivery", async () => ({ ...structuredClone(item), artifact: { ...item.artifact,
    downloadUrl: `http://127.0.0.1:8790/v1/result-artifacts/${artifactId}/download?expires=${item.retainedUntil}&signature=${"b".repeat(64)}`,
  } }) as MaterializedResultDelivery);
  t.mock.method(client, "recordReceipt", async (_id: string, _attemptId: string, status: "accepted" | "uncertain") => {
    item = { ...item, status }; return structuredClone(item);
  });
  const gateway = new WeChatGateway({ stateManager: f.state, ilink: f.ilink, controller: f.controller,
    resultClient: client, resultOutbox: outbox });
  t.after(() => gateway.stop());
  return { ...f, gateway, current: () => item };
}

test("a ready result yields shared quota to another recipient's active inbound reply", { timeout: 10_000 }, async t => {
  const f = readyResultGateway(t);
  let began!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(f.controller, "forwardMessage", async () => {
    began(); await gate; return { text: "ordinary peer reply" };
  });
  t.mock.method(f.ilink, "pollBatch", async () => ({ messages: [{ chatId: "peer", deliveryKey: "peer-active-inbound",
    messageId: "peer-message", text: "hello", contextToken: "peer-token", createdAtMs: Date.now() }],
    rawMessageCount: 1, nextSyncBuf: "peer-cursor" }));
  try {
    assert.equal((await f.gateway.pollOnce(false)).processedCount, 1);
    await started;
    assert.deepEqual(await f.gateway.deliverNotificationsOnce(), { accepted: 0, uncertain: 0, skipped: 0 });
    assert.equal(f.sends.length, 0, "the ready task must not consume an active peer reply's shared quota");
    assert.equal(f.current().status, "ready");
  } finally { release(); }
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].to_user_id, "peer");
  assert.deepEqual(await f.gateway.deliverNotificationsOnce(), { accepted: 1, uncertain: 0, skipped: 0 });
  assert.deepEqual(f.sends.map(message => message.to_user_id), ["peer", "chat"]);
  assert.equal(f.state.accountSendBudget!.remaining, 8);
});

test("an expired recipient's pending reply does not block another recipient's ready result", async t => {
  const f = readyResultGateway(t);
  f.state.recordInboundContext("expired-peer-inbound", "expired-peer", Date.now() - 24 * 60 * 60 * 1000, true, "expired-token");
  f.state.putOutbox({ kind: "reply", source: "controller", chatId: "expired-peer", messageId: "old-message",
    deliveryKey: "expired-peer-reply", splitMaxChars: 2000, status: "pending" });
  assert.equal(f.state.canSendToChat("expired-peer"), false);
  assert.deepEqual(await f.gateway.deliverNotificationsOnce(), { accepted: 1, uncertain: 0, skipped: 0 });
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].to_user_id, "chat");
  assert.equal(f.state.outbox["expired-peer-reply"].status, "pending");
});
