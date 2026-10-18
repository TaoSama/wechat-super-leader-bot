import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "../fixtures/notification-fixtures.js";
import { WeChatGateway } from "../../src/gateway.js";
import { ResultClient } from "../../src/controller/result-client.js";
import { FileResultOutbox } from "../../src/results/outbox.js";

test("a failed resume checkpoint retries the same admitted generation without renewing its quota", async t => {
  const f = harness(t);
  const outbox = new FileResultOutbox(`${f.statePath}.results.json`, () => f.state.getLoginFingerprint());
  const client = new ResultClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic" });
  const gateway = new WeChatGateway({ stateManager: f.state, ilink: f.ilink, controller: f.controller,
    notifications: true, resultClient: client, resultOutbox: outbox });
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
  assert.equal(f.state.contextBudgets.chat.remaining, 8, "retry did not reset 9 back to 10 before its reply");
  assert.deepEqual(outbox.pendingResumes(), [{ chatId: "chat", generation: deliveryKey }]);
  assert.equal(f.state.syncBuf, "next");
});

for (const renewal of ["accepted", "failed"] as const) test(`result failure still attempts one ${renewal} renewal for another chat and preserves the first error`, async t => {
  const f = harness(t);
  const outbox = new FileResultOutbox(`${f.statePath}.results.json`, () => f.state.getLoginFingerprint());
  const client = new ResultClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic" });
  const gateway = new WeChatGateway({ stateManager: f.state, ilink: f.ilink, controller: f.controller,
    notifications: true, resultClient: client, resultOutbox: outbox });
  const failure = new Error("result dispatch unavailable");
  if (renewal === "failed") f.hooks.send = () => { throw new Error("renewal transport response lost"); };
  t.mock.method(client, "notificationInterest", async () => ({ chatIds: ["broken"], interested: ["renewal"] }));
  t.mock.method(client, "listDeliveries", async () => { throw failure; });
  f.state.setContextToken("broken", "broken-context");
  f.state.recordInboundContext("broken-inbound", "broken", Date.now() - 1000);
  f.state.setContextToken("renewal", "renewal-context");
  f.state.recordInboundContext("renewal-inbound", "renewal", Date.now() - 22 * 60 * 60 * 1000 - 1000);
  await assert.rejects(gateway.deliverNotificationsOnce(), error => error === failure);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].to_user_id, "renewal");
  await assert.rejects(gateway.deliverNotificationsOnce(), error => error === failure);
  assert.equal(f.sends.length, 1, "renewal remains deduplicated after another failed result tick");
});
