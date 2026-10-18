import { test } from "node:test";
import assert from "node:assert/strict";
import { ControllerClient } from "../../src/controller/client.js";
import { parseNotification, NOTIFICATION_ATTEMPT_MS, type Notification, type NotificationDeferReason } from "../../src/controller/notification-contract.js";

const ID = "00000000-0000-4000-8000-000000000001";
const ATTEMPT = "00000000-0000-4000-8000-000000000002";
const NEXT_ATTEMPT = "00000000-0000-4000-8000-000000000003";
const REASONS: NotificationDeferReason[] = ["budget_exhausted", "window_expired", "context_changed"];
const PENDING: Notification = { id: ID, source: { type: "plan", id: ID }, chatId: "chat", kind: "completed", text: "完成",
  createdAt: 1000, expiresAt: 1000 + NOTIFICATION_ATTEMPT_MS * 2, status: "pending" };
function deferred(reason: NotificationDeferReason = "budget_exhausted"): Notification {
  return { ...PENDING, lastDeferredAttemptId: ATTEMPT, lastDeferReason: reason };
}
function claimed(): Notification {
  return { ...deferred(), status: "claimed", attemptId: NEXT_ATTEMPT, attemptedAt: 2000, attemptExpiresAt: 2000 + NOTIFICATION_ATTEMPT_MS };
}

test("defer posts exact evidence once and requires the pending projection to retain matching deferred identity", async () => {
  for (const reason of REASONS) {
    let calls = 0;
    const instance = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic", fetchImpl: async (url, init) => {
      calls++;
      assert.equal(String(url), `http://127.0.0.1:8790/v1/notifications/${ID}/defer`);
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer synthetic");
      assert.deepEqual(JSON.parse(String(init?.body)), { attemptId: ATTEMPT, reason });
      return Response.json({ notification: deferred(reason) });
    } });
    assert.deepEqual(await instance.deferNotification(ID, ATTEMPT, reason), deferred(reason));
    assert.equal(calls, 1);
  }
});

test("parser retains paired deferred metadata across pending, expired and newly claimed projections", () => {
  for (const reason of REASONS) assert.deepEqual(parseNotification(deferred(reason)), deferred(reason));
  for (const status of ["claimed", "accepted", "uncertain"] as const) {
    const item = { ...claimed(), status };
    assert.deepEqual(parseNotification(item), item);
  }
  const expired = { ...deferred(), status: "expired" };
  assert.deepEqual(parseNotification(expired), expired);
});

test("parser rejects unpaired or invalid defer metadata, current attempt reuse, and pending attempt fields", () => {
  for (const change of [
    { lastDeferredAttemptId: ATTEMPT }, { lastDeferReason: "budget_exhausted" },
    { lastDeferredAttemptId: undefined, lastDeferReason: undefined },
    { lastDeferredAttemptId: null, lastDeferReason: "budget_exhausted" },
    { lastDeferredAttemptId: "not-a-uuid", lastDeferReason: "budget_exhausted" },
    { lastDeferredAttemptId: ATTEMPT, lastDeferReason: "unknown" },
    { lastDeferredAttemptId: ATTEMPT, lastDeferReason: null },
  ]) assert.throws(() => parseNotification({ ...PENDING, ...change }), /schema invalid/);
  assert.throws(() => parseNotification({ ...claimed(), attemptId: ATTEMPT }), /schema invalid/);
  for (const field of ["attemptId", "attemptedAt", "attemptExpiresAt"]) {
    for (const value of [undefined, null, field === "attemptId" ? ATTEMPT : 2000]) {
      assert.throws(() => parseNotification({ ...deferred(), [field]: value }), /schema invalid/);
    }
  }
  assert.throws(() => parseNotification({ ...deferred(), unknown: true }), /schema invalid/);
});

test("defer rejects mismatched record, attempt, reason, status and malformed responses without retry", async () => {
  const failures: (() => Promise<Response>)[] = [
    async () => { throw new Error("lost defer response"); },
    ...[401, 403, 409, 500, 503].map(status => async () => Response.json({}, { status })),
    async () => new Response("invalid-json"),
    ...[{}, { notification: PENDING }, { notification: claimed() },
      { notification: { ...deferred(), id: NEXT_ATTEMPT, source: { type: "plan", id: NEXT_ATTEMPT } } },
      { notification: { ...deferred(), lastDeferredAttemptId: NEXT_ATTEMPT } },
      { notification: deferred("context_changed") },
      { notification: { ...deferred(), status: "expired" } },
      { notification: { ...deferred(), attemptId: ATTEMPT } },
      { notification: deferred(), extra: true },
    ].map(body => async () => Response.json(body)),
  ];
  for (const failure of failures) {
    let calls = 0;
    const instance = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic",
      fetchImpl: async () => { calls++; return failure(); } });
    await assert.rejects(instance.deferNotification(ID, ATTEMPT, "budget_exhausted"));
    assert.equal(calls, 1);
  }
});

test("invalid defer request evidence is rejected before fetch", async () => {
  let calls = 0;
  const instance = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic",
    fetchImpl: async () => { calls++; return Response.json({ notification: deferred() }); } });
  for (const [id, attemptId, reason] of [["../escape", ATTEMPT, "budget_exhausted"], [ID, "invalid", "budget_exhausted"],
    [ID, ATTEMPT, "unknown"]]) {
    await assert.rejects(instance.deferNotification(id, attemptId, reason as NotificationDeferReason));
  }
  assert.equal(calls, 0);
});

test("new claim retains previous defer identity while binding its new attempt", async () => {
  const instance = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic",
    fetchImpl: async () => Response.json({ notification: claimed() }) });
  assert.deepEqual(await instance.claimNotification(ID, NEXT_ATTEMPT), claimed());
});

test("defer deadline bounds an uncooperative request without retrying", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const instance = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic", timeoutMs: 20,
    fetchImpl: async () => { calls++; return new Promise<Response>(() => {}); } });
  const rejected = assert.rejects(instance.deferNotification(ID, ATTEMPT, "budget_exhausted"), /abort/i);
  t.mock.timers.tick(20);
  await rejected;
  assert.equal(calls, 1);
});
