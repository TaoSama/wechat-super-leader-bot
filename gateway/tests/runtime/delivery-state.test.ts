import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../../src/runtime/state.js";
import { MAX_INBOUND_CLOCK_SKEW_MS, OutboxBackpressureError } from "../../src/runtime/delivery-state.js";
import { LocalSendDeferredError, type ContextPolicy } from "../../src/runtime/context-policy.js";
import type { DeliveryOutboxItem } from "../../src/types.js";

const CHAT_ID = "synthetic-chat";
const SAME_TIMESTAMP_KEY_LIMIT = 256;

function fixture(t: TestContext, policy: Partial<ContextPolicy> = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-delivery-policy-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credentialsPath = path.join(directory, "synthetic-account.json");
  const statePath = path.join(directory, "state.json");
  fs.writeFileSync(credentialsPath, JSON.stringify({ token: "synthetic-token", accountId: "synthetic-account" }));
  const reload = (nextPolicy: Partial<ContextPolicy> = policy) => new StateManager(credentialsPath, statePath, nextPolicy);
  return { state: reload(), reload, statePath, credentialsPath, createdAt: Date.now() - 1000 };
}

function reference(deliveryKey = "reply-reference", overrides: Partial<DeliveryOutboxItem> = {}): DeliveryOutboxItem {
  return {
    kind: "reply", deliveryKey, chatId: CHAT_ID, messageId: "synthetic-message-id",
    splitMaxChars: 1000, splitMultiPart: true, status: "pending", ...overrides,
  };
}

test("send charges persist across restart and a failed charge rolls back both counters", t => {
  const { state, reload, createdAt } = fixture(t);
  assert.equal(state.canSendToChat(CHAT_ID), false);
  assert.throws(() => state.consumeSendBudget(CHAT_ID), LocalSendDeferredError);
  state.recordInboundContext("inbound-one", CHAT_ID, createdAt);
  state.consumeSendBudget(CHAT_ID, "progress");
  assert.equal(reload().contextBudgets[CHAT_ID].remaining, state.policy.sendBudget - 1);
  assert.equal(reload().contextBudgets[CHAT_ID].progressSent, 1);
  const before = structuredClone(state.contextBudgets);
  const failure = new Error("synthetic charge checkpoint failure");
  const save = t.mock.method(state, "saveState", () => { throw failure; });
  assert.throws(() => state.consumeSendBudget(CHAT_ID, "progress"), error => error === failure);
  assert.deepEqual(state.contextBudgets, before);
  assert.deepEqual(reload().contextBudgets, before);
  save.mock.restore();
  state.consumeSendBudget(CHAT_ID);
  assert.equal(reload().contextBudgets[CHAT_ID].remaining, state.policy.sendBudget - 2);
  assert.equal(reload().contextBudgets[CHAT_ID].progressSent, 1);
});

test("restarting with a lower budget accounts for all sends spent under the old policy", t => {
  for (const alreadySpent of [7, 2]) {
    const { state, reload, createdAt } = fixture(t, { sendBudget: 10 });
    state.recordInboundContext("first", CHAT_ID, createdAt);
    assert.equal(reload().contextBudgets[CHAT_ID].grantedBudget, 10);
    for (let count = 0; count < alreadySpent; count++) state.consumeSendBudget(CHAT_ID);
    let restarted = reload({ sendBudget: 5 });
    const allowed = Math.max(0, 5 - alreadySpent);
    for (let count = 0; count < allowed; count++) {
      assert.equal(restarted.canSendToChat(CHAT_ID), true);
      restarted.consumeSendBudget(CHAT_ID);
      assert.equal(restarted.contextBudgets[CHAT_ID].remaining, allowed - count - 1);
      assert.equal(restarted.contextBudgets[CHAT_ID].grantedBudget, 5);
      restarted = reload({ sendBudget: 5 });
    }
    assert.equal(restarted.canSendToChat(CHAT_ID), false);
    assert.throws(() => restarted.consumeSendBudget(CHAT_ID), { reason: "budget_exhausted" });
    assert.equal(reload({ sendBudget: 5 }).canSendToChat(CHAT_ID), false);
  }
});

test("restarting with a higher budget cannot refill an old window but a new inbound grants the new budget", t => {
  const { state, reload, createdAt } = fixture(t, { sendBudget: 5 });
  state.recordInboundContext("first", CHAT_ID, createdAt);
  state.consumeSendBudget(CHAT_ID);
  state.consumeSendBudget(CHAT_ID);
  let restarted = reload({ sendBudget: 10 });
  assert.equal(restarted.contextBudgets[CHAT_ID].remaining, 3);
  assert.equal(restarted.contextBudgets[CHAT_ID].grantedBudget, 5);
  for (let count = 0; count < 3; count++) {
    restarted.consumeSendBudget(CHAT_ID);
    assert.equal(restarted.contextBudgets[CHAT_ID].grantedBudget, 5);
    restarted = reload({ sendBudget: 10 });
  }
  assert.equal(restarted.canSendToChat(CHAT_ID), false);
  assert.equal(restarted.recordInboundContext("new-window", CHAT_ID, createdAt + 1), true);
  assert.equal(reload({ sendBudget: 10 }).contextBudgets[CHAT_ID].remaining, 10);
  assert.equal(reload({ sendBudget: 10 }).contextBudgets[CHAT_ID].grantedBudget, 10);
});

test("invalid persisted initial grants are rejected before restart can authorize sends", t => {
  const { state, reload, statePath, createdAt } = fixture(t);
  state.recordInboundContext("first", CHAT_ID, createdAt);
  const disk = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
    context_budgets: Record<string, { grantedBudget: unknown }>;
  };
  for (const invalid of [null, -1, 0, 0.5, 1, 1001, "10"]) {
    disk.context_budgets[CHAT_ID].grantedBudget = invalid;
    fs.writeFileSync(statePath, JSON.stringify(disk));
    assert.throws(() => reload(), /Failed to load gateway state/);
  }
});

test("failed inbound checkpoints roll back budgets, tokens and timestamp watermarks", t => {
  const { state, reload, createdAt } = fixture(t);
  const failure = new Error("synthetic inbound checkpoint failure");
  let save = t.mock.method(state, "saveState", () => { throw failure; });
  assert.throws(() => state.recordInboundContext("first", CHAT_ID, createdAt, true, "synthetic-first-context"), error => error === failure);
  assert.deepEqual(state.contextBudgets, {});
  assert.deepEqual(state.inboundWatermarks, {});
  assert.deepEqual(state.contextTokens, {});
  save.mock.restore();
  state.recordInboundContext("first", CHAT_ID, createdAt, true, "synthetic-first-context");
  state.consumeSendBudget(CHAT_ID);
  const before = {
    budgets: structuredClone(state.contextBudgets),
    watermarks: structuredClone(state.inboundWatermarks),
    tokens: { ...state.contextTokens },
  };
  save = t.mock.method(state, "saveState", () => { throw failure; });
  assert.throws(() => state.recordInboundContext("second", CHAT_ID, createdAt + 1, true, "synthetic-second-context"), error => error === failure);
  assert.deepEqual(state.contextBudgets, before.budgets);
  assert.deepEqual(state.inboundWatermarks, before.watermarks);
  assert.deepEqual(state.contextTokens, before.tokens);
  assert.deepEqual(reload().contextBudgets, before.budgets);
  assert.deepEqual(reload().inboundWatermarks, before.watermarks);
  assert.deepEqual(reload().contextTokens, before.tokens);
  save.mock.restore();
  state.recordInboundContext("second", CHAT_ID, createdAt + 1);
  assert.equal(reload().contextBudgets[CHAT_ID].lastInboundKey, "second");
});

test("changing the account identity or token clears all delivery state", t => {
  for (const account of [
    { token: "different-synthetic-token", accountId: "synthetic-account" },
    { token: "synthetic-token", accountId: "different-synthetic-account" },
  ]) {
    const { state, reload, credentialsPath, createdAt } = fixture(t);
    state.recordInboundContext("inbound-one", CHAT_ID, createdAt, true, "synthetic-context");
    state.consumeSendBudget(CHAT_ID);
    state.putOutbox(reference());
    fs.writeFileSync(credentialsPath, JSON.stringify(account));
    const changed = reload();
    assert.deepEqual(changed.contextBudgets, {});
    assert.deepEqual(changed.inboundWatermarks, {});
    assert.deepEqual(changed.contextTokens, {});
    assert.deepEqual(changed.outbox, {});
    assert.equal(changed.canSendToChat(CHAT_ID), false);
    changed.saveState();
    assert.deepEqual(reload().contextBudgets, {});
  }
});

test("only timestamped new inbound messages refresh budget across restart", t => {
  const { state, reload, createdAt } = fixture(t);
  state.recordInboundContext("first", CHAT_ID, createdAt);
  state.consumeSendBudget(CHAT_ID, "progress");
  state.recordInboundContext("first", CHAT_ID, createdAt);
  assert.equal(state.contextBudgets[CHAT_ID].remaining, state.policy.sendBudget - 1);
  const restarted = reload();
  restarted.recordInboundContext("first", CHAT_ID, createdAt);
  assert.equal(restarted.contextBudgets[CHAT_ID].remaining, state.policy.sendBudget - 1);
  restarted.recordInboundContext("same-time-new-key", CHAT_ID, createdAt);
  assert.equal(restarted.contextBudgets[CHAT_ID].remaining, state.policy.sendBudget);
  assert.equal(restarted.contextBudgets[CHAT_ID].progressSent, 0);
  restarted.consumeSendBudget(CHAT_ID);
  restarted.recordInboundContext("later", CHAT_ID, createdAt + 1);
  assert.equal(restarted.contextBudgets[CHAT_ID].remaining, state.policy.sendBudget);
  assert.deepEqual(reload().inboundWatermarks[CHAT_ID], { createdAtMs: createdAt + 1, keys: ["later"] });
});

test("missing, invalid, future and older inbound timestamps never refresh quota or block business", t => {
  const { state, reload, createdAt } = fixture(t);
  state.recordInboundContext("missing-first", CHAT_ID);
  assert.equal(state.canSendToChat(CHAT_ID), false);
  state.recordInboundContext("valid", CHAT_ID, createdAt);
  state.consumeSendBudget(CHAT_ID);
  const expected = structuredClone(state.contextBudgets[CHAT_ID]);
  for (const [key, timestamp] of [
    ["missing", undefined], ["nan", NaN], ["infinity", Infinity], ["negative", -1],
    ["fraction", createdAt + 0.5], ["future", Date.now() + 60_000], ["older", createdAt - 1],
  ] as const) {
    assert.doesNotThrow(() => state.recordInboundContext(key, CHAT_ID, timestamp));
    assert.deepEqual(state.contextBudgets[CHAT_ID], expected);
    assert.doesNotThrow(() => state.recordProcessedMessageKey(key));
    assert.equal(state.isMessageProcessed(key), true);
  }
  assert.deepEqual(reload().contextBudgets[CHAT_ID], expected);
  assert.deepEqual(reload().inboundWatermarks[CHAT_ID], { createdAtMs: createdAt, keys: ["valid"] });
});

test("timestamp watermarks prevent replay across restart and isolate chats", t => {
  const { state, reload, createdAt } = fixture(t);
  state.recordInboundContext("first", CHAT_ID, createdAt);
  state.consumeSendBudget(CHAT_ID);
  const restarted = reload();
  restarted.recordInboundContext("first", CHAT_ID, createdAt);
  restarted.recordInboundContext("previous-window", CHAT_ID, createdAt - 1);
  assert.equal(restarted.contextBudgets[CHAT_ID].remaining, state.policy.sendBudget - 1);
  assert.deepEqual(restarted.inboundWatermarks[CHAT_ID], { createdAtMs: createdAt, keys: ["first"] });
  restarted.recordInboundContext("new-chat", "second-chat", createdAt - 1);
  assert.equal(restarted.contextBudgets["second-chat"].remaining, state.policy.sendBudget);
});

test("small server clock skew grants a usable window while preserving its original timestamp for replay detection", t => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ["Date"], now });
  for (const skew of [1, MAX_INBOUND_CLOCK_SKEW_MS]) {
    const { state, reload } = fixture(t);
    const serverTime = now + skew;
    assert.equal(state.recordInboundContext("skewed", CHAT_ID, serverTime, true, "synthetic-context"), true);
    assert.equal(state.canSendToChat(CHAT_ID), true);
    assert.equal(state.contextBudgets[CHAT_ID].refreshedAt, now);
    assert.deepEqual(reload().inboundWatermarks[CHAT_ID], { createdAtMs: serverTime, keys: ["skewed"] });
    state.consumeSendBudget(CHAT_ID);
    const restarted = reload();
    assert.equal(restarted.recordInboundContext("skewed", CHAT_ID, serverTime, true, "replayed-context"), false);
    assert.equal(restarted.contextBudgets[CHAT_ID].remaining, state.policy.sendBudget - 1);
    assert.equal(restarted.contextTokens[CHAT_ID], "synthetic-context");
    assert.equal(restarted.recordInboundContext("beyond-tolerance", CHAT_ID, now + MAX_INBOUND_CLOCK_SKEW_MS + 1), false);
    assert.equal(restarted.contextBudgets[CHAT_ID].remaining, state.policy.sendBudget - 1);
  }
});

test("clock rollback and later replay never refill or extend a window granted from a skewed timestamp", t => {
  const now = 1_800_000_000_000;
  t.mock.timers.enable({ apis: ["Date"], now });
  const { state, reload } = fixture(t);
  const serverTime = now + MAX_INBOUND_CLOCK_SKEW_MS;
  state.recordInboundContext("skewed", CHAT_ID, serverTime, true, "synthetic-context");
  state.consumeSendBudget(CHAT_ID);
  const original = structuredClone(state.contextBudgets[CHAT_ID]);
  t.mock.timers.setTime(now - 1);
  const restarted = reload();
  assert.equal(restarted.recordInboundContext("skewed", CHAT_ID, serverTime), false);
  assert.deepEqual(restarted.contextBudgets[CHAT_ID], original);
  assert.equal(restarted.canSendToChat(CHAT_ID), false);
  t.mock.timers.setTime(serverTime);
  assert.equal(restarted.recordInboundContext("skewed", CHAT_ID, serverTime), false);
  assert.deepEqual(restarted.contextBudgets[CHAT_ID], original);
  t.mock.timers.setTime(now + state.policy.contextWindowMs - 1);
  assert.equal(restarted.canSendToChat(CHAT_ID), true);
  t.mock.timers.setTime(now + state.policy.contextWindowMs);
  assert.equal(restarted.canSendToChat(CHAT_ID), false);
  assert.equal(reload().contextBudgets[CHAT_ID].refreshedAt, now);
});

test("baseline inbound checkpoints tokens and watermarks without granting quota or accepting stale tokens", t => {
  const { state, reload, createdAt } = fixture(t);
  assert.equal(state.recordInboundContext("baseline", CHAT_ID, createdAt, false, "synthetic-baseline-token"), true);
  const restarted = reload();
  assert.equal(restarted.contextBudgets[CHAT_ID], undefined);
  assert.equal(restarted.contextTokens[CHAT_ID], "synthetic-baseline-token");
  assert.deepEqual(restarted.inboundWatermarks[CHAT_ID], { createdAtMs: createdAt, keys: ["baseline"] });
  assert.equal(restarted.recordInboundContext("baseline", CHAT_ID, createdAt, true, "synthetic-replayed-token"), false);
  assert.equal(restarted.canSendToChat(CHAT_ID), false);
  assert.equal(restarted.recordInboundContext("active", CHAT_ID, createdAt + 1, true, "synthetic-active-token"), true);
  restarted.consumeSendBudget(CHAT_ID);
  assert.equal(restarted.recordInboundContext("older", CHAT_ID, createdAt, true, "synthetic-stale-token"), false);
  const persisted = reload();
  assert.equal(persisted.contextTokens[CHAT_ID], "synthetic-active-token");
  assert.equal(persisted.contextBudgets[CHAT_ID].remaining, state.policy.sendBudget - 1);
});

test("watermark-only inbound preserves an existing budget and token across restart", t => {
  const { state, reload, createdAt } = fixture(t);
  state.recordInboundContext("active", CHAT_ID, createdAt, true, "synthetic-active-token");
  state.consumeSendBudget(CHAT_ID, "progress");
  const previous = structuredClone(state.contextBudgets[CHAT_ID]);
  assert.equal(state.recordInboundContext("no-context-token", CHAT_ID, createdAt + 1, false, undefined), true);
  const restarted = reload();
  assert.deepEqual(restarted.contextBudgets[CHAT_ID], previous);
  assert.equal(restarted.contextTokens[CHAT_ID], "synthetic-active-token");
  assert.deepEqual(restarted.inboundWatermarks[CHAT_ID], { createdAtMs: createdAt + 1, keys: ["no-context-token"] });
  assert.equal(restarted.recordInboundContext("no-context-token", CHAT_ID, createdAt + 1, true, "synthetic-replayed-token"), false);
  assert.deepEqual(reload().contextBudgets[CHAT_ID], previous);
  assert.equal(reload().contextTokens[CHAT_ID], "synthetic-active-token");
});

test("a saturated timestamp key set withholds refresh without blocking messages and advances on newer time", t => {
  const { state, reload, createdAt } = fixture(t);
  for (let index = 0; index < SAME_TIMESTAMP_KEY_LIMIT; index++) {
    state.recordInboundContext(`same-time-${index}`, CHAT_ID, createdAt);
  }
  assert.equal(state.inboundWatermarks[CHAT_ID].keys.length, SAME_TIMESTAMP_KEY_LIMIT);
  state.consumeSendBudget(CHAT_ID);
  assert.doesNotThrow(() => state.recordInboundContext("overflow", CHAT_ID, createdAt));
  assert.equal(state.contextBudgets[CHAT_ID].remaining, state.policy.sendBudget - 1);
  assert.equal(state.inboundWatermarks[CHAT_ID].keys.length, SAME_TIMESTAMP_KEY_LIMIT);
  state.recordProcessedMessageKey("overflow");
  assert.equal(state.isMessageProcessed("overflow"), true);
  const restarted = reload();
  restarted.recordInboundContext("overflow-after-restart", CHAT_ID, createdAt);
  assert.equal(restarted.contextBudgets[CHAT_ID].remaining, state.policy.sendBudget - 1);
  restarted.recordInboundContext("newer", CHAT_ID, createdAt + 1);
  assert.equal(restarted.contextBudgets[CHAT_ID].remaining, state.policy.sendBudget);
  assert.deepEqual(reload().inboundWatermarks[CHAT_ID], { createdAtMs: createdAt + 1, keys: ["newer"] });
});

test("outbox capacity retains existing references and permits idempotent retry at capacity", t => {
  const { state, reload } = fixture(t, { outboxLimit: 1 });
  state.commitCursor("retained-cursor");
  state.putOutbox(reference());
  assert.doesNotThrow(() => state.putOutbox(reference()));
  assert.doesNotThrow(() => state.assertOutboxCapacity("reply-reference"));
  assert.throws(() => state.putOutbox(reference("second-reference")), OutboxBackpressureError);
  assert.throws(() => state.assertOutboxCapacity(), OutboxBackpressureError);
  assert.equal(reload().syncBuf, "retained-cursor");
  assert.deepEqual(Object.keys(reload().outbox), ["reply-reference"]);
  assert.throws(() => state.putOutbox(reference("reply-reference", { messageId: "changed-message" })), /identity changed/);
  state.removeOutbox("reply-reference");
  state.putOutbox(reference("second-reference"));
  assert.deepEqual(Object.keys(reload().outbox), ["second-reference"]);
});

test("outbox insertion, update and removal roll back if a durable checkpoint fails", t => {
  const { state, reload } = fixture(t);
  state.saveState();
  const failure = new Error("synthetic outbox checkpoint failure");
  let save = t.mock.method(state, "saveState", () => { throw failure; });
  assert.throws(() => state.putOutbox(reference()), error => error === failure);
  assert.deepEqual(state.outbox, {});
  assert.deepEqual(reload().outbox, {});
  save.mock.restore();
  state.putOutbox(reference());
  const expected = structuredClone(state.outbox);
  save = t.mock.method(state, "saveState", () => { throw failure; });
  assert.throws(() => state.updateOutbox("reply-reference", { status: "claimed", attemptId: "attempt" }), error => error === failure);
  assert.deepEqual(state.outbox, expected);
  assert.deepEqual(reload().outbox, expected);
  assert.throws(() => state.removeOutbox("reply-reference"), error => error === failure);
  assert.deepEqual(state.outbox, expected);
  assert.deepEqual(reload().outbox, expected);
  save.mock.restore();
  state.updateOutbox("reply-reference", { status: "defer", deferReason: "budget_exhausted" });
  assert.equal(reload().outbox["reply-reference"].status, "defer");
  state.removeOutbox("reply-reference");
  assert.deepEqual(reload().outbox, {});
});

test("the durable outbox stores delivery references and receipts without message bodies", t => {
  const { state, reload, statePath } = fixture(t);
  state.putOutbox(reference("notification-reference", {
    kind: "notification", notificationKind: "completed", expiresAt: Date.now() + 60_000,
  }));
  state.updateOutbox("notification-reference", { status: "receipt", attemptId: "attempt", receiptStatus: "accepted" });
  const disk = JSON.parse(fs.readFileSync(statePath, "utf8")) as { delivery_outbox: Record<string, Record<string, unknown>> };
  const stored = disk.delivery_outbox["notification-reference"];
  assert.deepEqual(stored, reload().outbox["notification-reference"]);
  assert.deepEqual(Object.keys(stored).sort(), [
    "attemptId", "chatId", "deliveryKey", "expiresAt", "kind", "messageId", "notificationKind",
    "receiptStatus", "source", "splitMaxChars", "splitMultiPart", "status",
  ].sort());
  for (const bodyField of ["text", "body", "content", "images", "attachments"]) assert.equal(Object.hasOwn(stored, bodyField), false);
});

test("outbox source survives restart and legacy references default to controller", t => {
  const { state, reload, statePath } = fixture(t);
  for (const source of ["controller", "engine", "codex-conflict"] as const) {
    state.putOutbox(reference(`reply-${source}`, { source }));
    assert.equal(reload().outbox[`reply-${source}`].source, source);
  }
  state.putOutbox(reference("legacy-reference"));
  assert.equal(state.outbox["legacy-reference"].source, "controller");
  const disk = JSON.parse(fs.readFileSync(statePath, "utf8")) as { delivery_outbox: Record<string, DeliveryOutboxItem> };
  delete disk.delivery_outbox["legacy-reference"].source;
  fs.writeFileSync(statePath, JSON.stringify(disk));
  const restarted = reload();
  assert.equal(restarted.outbox["legacy-reference"].source, "controller");
  restarted.updateOutbox("legacy-reference", { status: "defer", source: undefined });
  assert.equal(reload().outbox["legacy-reference"].source, "controller");
});

test("outbox rejects unknown source values before storing or restoring them", t => {
  const { state, reload, statePath } = fixture(t);
  state.putOutbox(reference());
  const expected = structuredClone(state.outbox);
  const disk = JSON.parse(fs.readFileSync(statePath, "utf8")) as { delivery_outbox: Record<string, Record<string, unknown>> };
  for (const source of [null, "", "fallback", "Controller", 1, {}, []]) {
    assert.throws(() => state.putOutbox(reference("invalid", { source } as Partial<DeliveryOutboxItem>)), /Invalid delivery outbox source/);
    assert.throws(() => state.updateOutbox("reply-reference", { source } as Partial<DeliveryOutboxItem>), /Invalid delivery outbox source/);
    assert.deepEqual(state.outbox, expected);
    disk.delivery_outbox["reply-reference"].source = source;
    fs.writeFileSync(statePath, JSON.stringify(disk));
    assert.throws(() => reload(), /Failed to load gateway state/);
  }
});

test("the same outbox identity cannot switch reply stores through put or update", t => {
  const { state, reload } = fixture(t);
  for (const original of ["controller", "engine", "codex-conflict"] as const) {
    const key = `reply-${original}`;
    state.putOutbox(reference(key, { source: original }));
    for (const replacement of [undefined, "controller", "engine", "codex-conflict"] as const) {
      if ((replacement ?? "controller") === original) continue;
      assert.throws(() => state.putOutbox(reference(key, { source: replacement })), /identity changed/);
      assert.throws(() => state.updateOutbox(key, { source: replacement }), /identity changed/);
      assert.equal(state.outbox[key].source, original);
      assert.equal(reload().outbox[key].source, original);
    }
    assert.doesNotThrow(() => state.putOutbox(reference(key, { source: original })));
    state.updateOutbox(key, { status: "defer" });
    assert.equal(reload().outbox[key].source, original);
  }
});

test("engine acknowledgement marker persists and legacy references remain unacknowledged", t => {
  const { state, reload } = fixture(t);
  state.putOutbox(reference("legacy"));
  assert.equal(reload().outbox.legacy.engineAcked, undefined);
  state.putOutbox(reference("engine", { source: "engine", status: "expired" }));
  state.updateOutbox("engine", { engineAcked: true });
  assert.equal(reload().outbox.engine.engineAcked, true);
  state.putOutbox(reference("false-controller", { engineAcked: false }));
  assert.equal(reload().outbox["false-controller"].engineAcked, false);
});

test("engine acknowledgement rejects malformed markers and acknowledgement of non-engine sources", t => {
  const { state, reload, statePath } = fixture(t);
  state.putOutbox(reference("engine", { source: "engine" }));
  state.putOutbox(reference("controller"));
  state.putOutbox(reference("conflict", { source: "codex-conflict" }));
  const expected = structuredClone(state.outbox);
  for (const engineAcked of [null, "true", 1, {}, []]) {
    const invalid = { engineAcked } as Partial<DeliveryOutboxItem>;
    assert.throws(() => state.putOutbox(reference("invalid", { source: "engine", ...invalid })), /Invalid delivery outbox engine acknowledgement/);
    assert.throws(() => state.updateOutbox("engine", invalid), /Invalid delivery outbox engine acknowledgement/);
    assert.deepEqual(state.outbox, expected);
  }
  for (const source of [undefined, "controller", "codex-conflict"] as const) {
    assert.throws(() => state.putOutbox(reference("invalid", { source, engineAcked: true })), /Invalid delivery outbox engine acknowledgement/);
  }
  for (const key of ["controller", "conflict"]) {
    assert.throws(() => state.updateOutbox(key, { engineAcked: true }), /Invalid delivery outbox engine acknowledgement/);
  }
  const disk = JSON.parse(fs.readFileSync(statePath, "utf8")) as { delivery_outbox: Record<string, Record<string, unknown>> };
  for (const [key, marker] of [["engine", "true"], ["engine", null], ["controller", true], ["conflict", true]] as const) {
    const corrupt = structuredClone(disk);
    corrupt.delivery_outbox[key].engineAcked = marker;
    fs.writeFileSync(statePath, JSON.stringify(corrupt));
    assert.throws(() => reload(), /Failed to load gateway state/);
  }
});

test("a failed engine acknowledgement checkpoint rolls back the in-memory marker", t => {
  const { state, reload } = fixture(t);
  state.putOutbox(reference("engine", { source: "engine", status: "uncertain" }));
  const failure = new Error("synthetic acknowledgement checkpoint failure");
  t.mock.method(state, "saveState", () => { throw failure; });
  assert.throws(() => state.updateOutbox("engine", { engineAcked: true }), error => error === failure);
  assert.equal(state.outbox.engine.engineAcked, undefined);
  assert.equal(reload().outbox.engine.engineAcked, undefined);
});
