import { test } from "node:test";
import assert from "node:assert/strict";
import { WeChatGateway } from "../../src/gateway.js";
import { NOTIFICATION_ATTEMPT_MS } from "../../src/controller/notification-contract.js";
import { harness, notification } from "../fixtures/notification-fixtures.js";

test("notification worker checks for new progress while getupdates remains in flight", async t => {
  const f = harness(t);
  let pollStarted = false;
  let finishPoll!: () => void;
  t.mock.method(f.ilink, "pollBatch", async () => {
    pollStarted = true;
    await new Promise<void>(resolve => { finishPoll = resolve; });
    return { nextSyncBuf: "cursor", messages: [], rawMessageCount: 0 };
  });
  let lists = 0;
  f.hooks.pending = () => {
    if (++lists < 2) throw new Error("synthetic transient list failure");
    assert.equal(pollStarted, true);
  };
  f.hooks.send = () => { f.gateway.stop(); finishPoll(); return { ret: 0 }; };
  await f.gateway.runLoop(1, error => { throw error; }, () => {});
  assert.equal(lists, 2);
  assert.equal(f.sends.length, 1);
  assert.equal(f.records.get(notification().id)?.status, "uncertain", "stop interrupts the in-flight response confirmation");
});

test("three progress events and the final result each trigger typing and preserve original Markdown", async t => {
  const terminal = notification();
  const progress = [1, 2, 3].map(sequence => ({
    ...notification(sequence + 1), source: terminal.source, kind: "progress" as const,
    progress: { sequence, eventKey: `step:${sequence}` }, text: `**进度 ${sequence}**\n\`代码🚀\``,
  }));
  const items = [...progress, { ...terminal, text: "# 最终结果\n\n完整的 **原文**。" }];
  const f = harness(t, { items });
  for (let index = 0; index < items.length; index++) {
    assert.deepEqual(await f.gateway.deliverNotificationsOnce(), { accepted: 1, uncertain: 0, skipped: 0 });
    assert.equal(f.state.contextBudgets.chat.remaining, f.state.policy.sendBudget - index - 1);
    assert.equal(f.state.contextBudgets.chat.progressSent, Math.min(index + 1, progress.length));
  }
  assert.equal(f.typings.length, 4);
  assert.ok(f.typings.every(item => item.status === 1));
  assert.deepEqual(f.sends.map(item => (item.item_list as { text_item: { text: string } }[])[0].text_item.text), items.map(item => item.text));
  assert.ok([...f.records.values()].every(item => item.status === "accepted"));
  await f.gateway.deliverNotificationsOnce();
  assert.equal(f.sends.length, 4);
  assert.equal(f.typings.length, 4);
});

test("terminal outbox parts retain pure whitespace continuations without truncation or summaries", async t => {
  const terminal = notification();
  const items = [
    { ...terminal, text: "# 原始结果\n```ts\n  run();\n```", part: { index: 1, total: 2 } },
    { ...notification(2), source: terminal.source, text: " \n\t\n  ", part: { index: 2, total: 2 } },
  ];
  const f = harness(t, { items });
  for (const item of items) {
    assert.equal((await f.gateway.deliverNotificationsOnce()).accepted, 1);
    assert.equal(f.records.get(item.id)?.status, "accepted");
  }
  assert.equal(f.sends.map(item => (item.item_list as { text_item: { text: string } }[])[0].text_item.text).join(""),
    items.map(item => item.text).join(""));
  assert.equal(f.typings.length, 2);
});

test("new claim permits a complete multipart notification beyond the ordinary 60 second budget", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const item = { ...notification(), text: "abcdefghi" };
  const f = harness(t, { items: [item] });
  f.hooks.claim = claimed => ({ ...claimed, attemptExpiresAt: Math.min(claimed.expiresAt, claimed.attemptedAt! + NOTIFICATION_ATTEMPT_MS) });
  f.hooks.send = () => new Promise(resolve => setTimeout(() => resolve({ ret: 0 }), 14_000));
  const gateway = new WeChatGateway({ stateManager: f.state, controller: f.controller, ilink: f.ilink,
    splitMaxChars: 1 });
  const pending = gateway.deliverNotificationsOnce();
  for (let step = 0; step < 80; step++) await Promise.resolve();
  for (let part = 0; part < item.text.length; part++) {
    t.mock.timers.tick(14_000);
    for (let step = 0; step < 80; step++) await Promise.resolve();
  }
  assert.deepEqual(await pending, { accepted: 1, uncertain: 0, skipped: 0 });
  assert.equal(f.sends.length, item.text.length);
  assert.equal(f.state.getReplySentChunks(`notification:${item.id}`), item.text.length);
});

test("legacy claim reserves receipt time and records incomplete multipart timeout as uncertain", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_800_000_000_000 });
  const item = { ...notification(), text: "abcdefghi" };
  const f = harness(t, { items: [item] });
  f.hooks.send = () => new Promise(resolve => setTimeout(() => resolve({ ret: 0 }), 14_000));
  const gateway = new WeChatGateway({ stateManager: f.state, controller: f.controller, ilink: f.ilink,
    splitMaxChars: 1 });
  const pending = gateway.deliverNotificationsOnce();
  for (let step = 0; step < 80; step++) await Promise.resolve();
  for (let part = 0; part < 2; part++) {
    t.mock.timers.tick(14_000);
    for (let step = 0; step < 80; step++) await Promise.resolve();
  }
  t.mock.timers.tick(2_000);
  for (let step = 0; step < 80; step++) await Promise.resolve();
  assert.deepEqual(await pending, { accepted: 0, uncertain: 1, skipped: 0 });
  assert.equal(f.state.getReplySentChunks(`notification:${item.id}`), 2);
  assert.equal(f.state.replyDeliveries[`notification:${item.id}`].inFlight, true);
  assert.equal(f.records.get(item.id)?.status, "uncertain");
});
