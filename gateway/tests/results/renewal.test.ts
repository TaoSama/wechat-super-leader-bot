import { test } from "node:test";
import assert from "node:assert/strict";
import { RenewalNotifier, renewalDeliveryKey, type RenewalOptions, type RenewalState } from "../../src/results/renewal.js";

const HOUR = 60 * 60 * 1000;
const REFRESHED_AT = 1_800_000_000_000;
function fixture() {
  let now = REFRESHED_AT + 22 * HOUR, remaining = 2, allowed = true, account = "account";
  const sent: { chatId: string; text: string; deliveryKey: string }[] = [];
  const state: RenewalState = {
    contextBudgets: { chat: { refreshedAt: REFRESHED_AT } }, contextTokens: { chat: "context" },
    policy: { contextWindowMs: 23 * HOUR }, replyDeliveries: {},
    getLoginFingerprint: () => account, canSendToChat: () => allowed, remainingSendBudget: () => remaining,
  };
  const options: RenewalOptions = {
    state, now: () => now,
    send: async (chatId, text, opts) => {
      assert.equal(opts.kind, "final");
      assert.equal(opts.shouldContinue(), true);
      sent.push({ chatId, text, deliveryKey: opts.deliveryKey });
      state.replyDeliveries[opts.deliveryKey] = { digest: "digest", totalChunks: 1, acknowledgedChunks: 1, inFlight: false };
      remaining--;
      return 1;
    },
  };
  return { state, sent, options, notifier: new RenewalNotifier(options), setNow: (value: number) => { now = value; },
    setRemaining: (value: number) => { remaining = value; },
    setAllowed: (value: boolean) => { allowed = value; }, setAccount: (value: string) => { account = value; } };
}

test("reminder becomes eligible exactly one hour before expiry and never after the window", async () => {
  for (const age of [0, 21 * HOUR, 22 * HOUR - 1, 23 * HOUR, 24 * HOUR, -1]) {
    const f = fixture(); f.setNow(REFRESHED_AT + age);
    assert.equal((await f.notifier.deliverOnce(["chat"])).sent, 0);
    assert.equal(f.sent.length, 0);
  }
  const f = fixture();
  assert.deepEqual(await f.notifier.deliverOnce(["chat"]), { sent: 1, skipped: 0 });
  assert.match(f.sent[0].text, /发一条消息/);
  assert.doesNotMatch(f.sent[0].text, /已续期|已刷新/);
});

test("uninterested chats, short windows and inadmissible chats never get a reminder", async () => {
  const f = fixture();
  assert.equal((await f.notifier.deliverOnce([])).sent, 0);
  assert.equal(f.sent.length, 0);
  for (const windowMs of [HOUR, HOUR - 1, 0]) {
    f.state.policy.contextWindowMs = windowMs;
    assert.equal((await f.notifier.deliverOnce(["chat"])).sent, 0);
  }
  f.state.policy.contextWindowMs = 23 * HOUR;
  f.setAllowed(false);
  assert.equal((await f.notifier.deliverOnce(["chat"])).sent, 0);
  assert.equal(f.sent.length, 0);
});

test("effective budget sends reminders only with one or two sends left even if raw persisted remaining is higher", async () => {
  const f = fixture();
  Object.assign(f.state.contextBudgets.chat, { remaining: 10 });
  for (const effective of [10, 4, 3, 0, -1, NaN, 1.5]) {
    f.setRemaining(effective);
    assert.equal((await f.notifier.deliverOnce(["chat"])).sent, 0);
  }
  for (const remaining of [1, 2]) {
    const low = fixture(); low.setRemaining(remaining);
    assert.equal((await low.notifier.deliverOnce(["chat"])).sent, 1);
  }
});

test("shared persisted acknowledgement, unknown and terminal failures suppress all repeat sends", async () => {
  for (const patch of [{ acknowledgedChunks: 1, inFlight: false }, { acknowledgedChunks: 0, inFlight: true },
    { acknowledgedChunks: 0, inFlight: false, failureReason: "AttachmentUnavailable" as const }]) {
    const f = fixture();
    f.state.replyDeliveries[renewalDeliveryKey("account", "chat", REFRESHED_AT)] = {
      digest: "digest", totalChunks: 1, ...patch,
    };
    assert.equal((await f.notifier.deliverOnce(["chat"])).sent, 0);
    assert.equal(f.sent.length, 0);
  }
  const f = fixture();
  await f.notifier.deliverOnce(["chat", "chat"]);
  assert.equal((await new RenewalNotifier(f.options).deliverOnce(["chat"])).sent, 0, "restart reuses persisted checkpoint");
  assert.equal(f.sent.length, 1);
});

test("a genuine new refreshedAt produces one new stable reminder after its own lead time", async () => {
  const f = fixture();
  await f.notifier.deliverOnce(["chat"]);
  f.state.contextBudgets.chat.refreshedAt = REFRESHED_AT + 22 * HOUR;
  assert.equal((await f.notifier.deliverOnce(["chat"])).sent, 0);
  f.setRemaining(2);
  f.setNow(REFRESHED_AT + 44 * HOUR);
  assert.equal((await f.notifier.deliverOnce(["chat"])).sent, 1);
  assert.notEqual(f.sent[0].deliveryKey, f.sent[1].deliveryKey);
  assert.equal((await f.notifier.deliverOnce(["chat"])).sent, 0);
});

test("queued send aborts on context, account, window or effective budget changes", async () => {
  const mutations = [
    (f: ReturnType<typeof fixture>) => { f.state.contextTokens.chat = "new-context"; },
    (f: ReturnType<typeof fixture>) => { f.setAccount("new-account"); },
    (f: ReturnType<typeof fixture>) => { f.state.contextBudgets.chat.refreshedAt++; },
    (f: ReturnType<typeof fixture>) => { f.state.policy.contextWindowMs++; },
    (f: ReturnType<typeof fixture>) => { f.setRemaining(3); },
    (f: ReturnType<typeof fixture>) => { f.setNow(REFRESHED_AT + 23 * HOUR); },
  ];
  for (const mutate of mutations) {
    const f = fixture();
    f.options.send = async (_chatId, _text, options) => {
      assert.equal(options.shouldContinue(), true);
      mutate(f);
      assert.equal(options.shouldContinue(), false);
      return 0;
    };
    assert.equal((await f.notifier.deliverOnce(["chat"])).sent, 0);
    assert.equal(f.sent.length, 0);
  }
});

test("unknown network failure remains visible and never resubmits its persisted in-flight item", async () => {
  const f = fixture(); let calls = 0;
  f.options.send = async (_chatId, _text, options) => {
    calls++;
    f.state.replyDeliveries[options.deliveryKey] = { digest: "digest", totalChunks: 1, acknowledgedChunks: 0, inFlight: true };
    throw new Error("synthetic unknown send");
  };
  await assert.rejects(f.notifier.deliverOnce(["chat"]), /synthetic unknown send/);
  assert.equal((await f.notifier.deliverOnce(["chat"])).sent, 0);
  assert.equal(calls, 1);
});

test("single notifier does not enqueue concurrent duplicate reminders", async () => {
  const f = fixture(); let release!: () => void;
  const original = f.options.send;
  f.options.send = async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return original(...args); };
  const first = f.notifier.deliverOnce(["chat"]);
  assert.deepEqual(await f.notifier.deliverOnce(["chat"]), { sent: 0, skipped: 0 });
  release();
  assert.equal((await first).sent, 1);
});


test("priority admission yields without deadlocking and terminal evidence releases ordinary sends", async () => {
  const f = fixture();
  assert.equal(f.notifier.shouldYield("chat", "ordinary"), true);
  assert.equal(f.notifier.shouldYield("chat", renewalDeliveryKey("account", "chat", REFRESHED_AT)), false);
  await f.notifier.deliverOnce(["chat"]);
  assert.equal(f.notifier.shouldYield("chat", "ordinary"), false);
  const unknown = fixture();
  unknown.state.replyDeliveries[renewalDeliveryKey("account", "chat", REFRESHED_AT)] = {
    digest: "digest", totalChunks: 1, acknowledgedChunks: 0, inFlight: true,
  };
  assert.equal(unknown.notifier.shouldYield("chat", "ordinary"), false);
});
