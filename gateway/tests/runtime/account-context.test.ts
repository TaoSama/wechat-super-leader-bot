import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { harness } from "../fixtures/notification-fixtures.js";
import { StateManager } from "../../src/runtime/state.js";
import { LocalSendDeferredError } from "../../src/runtime/context-policy.js";
import { RenewalNotifier } from "../../src/results/renewal.js";
import { ILinkClient } from "../../src/wechat/client.js";

const HOUR = 60 * 60 * 1000;

test("concurrent sends to different recipients share exactly ten charges and preserve each recipient token", async t => {
  const f = harness(t);
  f.state.recordInboundContext("inbound-b", "b", Date.now(), true, "context-b");
  const results = await Promise.allSettled(Array.from({ length: 24 }, (_, index) =>
    f.ilink.sendSingleText(index % 2 ? "chat" : "b", `message-${index}`)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 10);
  assert.equal(f.sends.length, 10);
  for (const result of results) if (result.status === "rejected") assert(result.reason instanceof LocalSendDeferredError);
  for (const sent of f.sends) assert.equal(sent.context_token, sent.to_user_id === "b" ? "context-b" : "synthetic-context");
  const restarted = new StateManager(f.accountPath, f.statePath);
  assert.equal(restarted.remainingSendBudget("chat"), 0);
  assert.equal(restarted.remainingSendBudget("b"), 0);
  const persisted = JSON.parse(readFileSync(f.statePath, "utf8"));
  assert.equal(persisted.context_budgets, undefined, "new checkpoints contain no per-chat quota allocations");
  assert.equal(persisted.account_send_budget.remaining, 0);
  assert.equal(persisted.context_windows.b.lastInboundKey, "inbound-b");
});

test("a genuine inbound refreshes the shared allowance, but another recipient's older input or replay cannot refill it", t => {
  const f = harness(t), latest = Date.now();
  f.state.recordInboundContext("new-b", "b", latest, true, "context-b");
  for (let index = 0; index < 10; index++) f.state.consumeSendBudget(index % 2 ? "chat" : "b");
  assert.equal(f.state.recordInboundContext("older-c", "c", latest - 1, true, "context-c"), true);
  assert.equal(f.state.remainingSendBudget("c"), 0);
  const restarted = new StateManager(f.accountPath, f.statePath);
  assert.equal(restarted.recordInboundContext("new-b", "b", latest, true, "replayed-token"), false);
  assert.equal(restarted.remainingSendBudget("chat"), 0);
  restarted.recordInboundContext("newest-c", "c", latest + 1, true, "new-context-c");
  assert.equal(restarted.remainingSendBudget("chat"), 10);
  assert.equal(restarted.remainingSendBudget("b"), 10);
  assert.equal(restarted.contextTokens.b, "context-b");
  assert.equal(restarted.contextTokens.c, "new-context-c");
});

test("refreshing the account budget cannot revive an expired recipient token window", t => {
  const f = harness(t);
  f.state.contextWindows.chat.refreshedAt = Date.now() - 23 * HOUR;
  f.state.recordInboundContext("fresh-b", "b", Date.now(), true, "context-b");
  assert.equal(f.state.remainingSendBudget("b"), 10);
  assert.equal(f.state.canSendToChat("chat"), false);
  assert.throws(() => f.state.consumeSendBudget("chat"), { reason: "window_expired" });
  assert.equal(f.state.remainingSendBudget("b"), 10);
});

test("one account reminder across interested recipients survives restart and uses the remaining final send", async t => {
  const f = harness(t), now = Date.now(), refreshedAt = now - 22 * HOUR;
  f.state.recordInboundContext("inbound-b", "b", now, true, "context-b");
  f.state.contextWindows.chat.refreshedAt = refreshedAt;
  f.state.contextWindows.b.refreshedAt = refreshedAt;
  f.state.accountSendBudget!.refreshedAt = refreshedAt;
  f.state.accountSendBudget!.remaining = 2;
  const options = { state: f.state, send: f.ilink.sendMarkdownReply.bind(f.ilink) };
  assert.equal((await new RenewalNotifier(options).deliverOnce(["chat", "b"])).sent, 1);
  assert.equal(f.sends.length, 1);
  const restarted = new StateManager(f.accountPath, f.statePath);
  const ilink = f.createILink(restarted);
  assert.equal((await new RenewalNotifier({ state: restarted,
    send: ilink.sendMarkdownReply.bind(ilink) }).deliverOnce(["b", "chat"])).sent, 0);
  assert.equal(restarted.remainingSendBudget("b"), 1);
});

test("single legacy ledger retains spent quota and clock skew through migration and another restart", t => {
  const f = harness(t), now = Date.now(), disk = JSON.parse(readFileSync(f.statePath, "utf8"));
  delete disk.context_windows; delete disk.account_send_budget;
  disk.context_budgets = { chat: { refreshedAt: now, remaining: 4, grantedBudget: 10, progressSent: 2, lastInboundKey: "old" } };
  disk.inbound_watermarks.chat = { createdAtMs: now + 100, keys: ["old"] };
  writeFileSync(f.statePath, JSON.stringify(disk));
  const migrated = new StateManager(f.accountPath, f.statePath);
  assert.equal(migrated.remainingSendBudget("chat"), 4);
  assert.equal(migrated.accountSendBudget!.inboundCreatedAt, now + 100);
  migrated.consumeSendBudget("chat");
  assert.equal(new StateManager(f.accountPath, f.statePath).remainingSendBudget("chat"), 3);
  migrated.recordInboundContext("older-b", "b", now + 1, true, "context-b");
  assert.equal(migrated.remainingSendBudget("b"), 3);
});

test("multiple legacy ledgers combine known spending conservatively without multiplying account grants", t => {
  const f = harness(t), now = Date.now(), disk = JSON.parse(readFileSync(f.statePath, "utf8"));
  delete disk.context_windows; delete disk.account_send_budget;
  disk.context_budgets = {
    chat: { refreshedAt: now - 10, remaining: 7, grantedBudget: 10, progressSent: 1, lastInboundKey: "old-a" },
    b: { refreshedAt: now, remaining: 8, grantedBudget: 10, progressSent: 0, lastInboundKey: "old-b" },
  };
  writeFileSync(f.statePath, JSON.stringify(disk));
  const migrated = new StateManager(f.accountPath, f.statePath);
  assert.equal(migrated.remainingSendBudget("chat"), 5);
  assert.equal(migrated.remainingSendBudget("b"), 5);
  migrated.saveState();
  assert.equal(new StateManager(f.accountPath, f.statePath).remainingSendBudget("chat"), 5);
  migrated.recordInboundContext("real-inbound", "b", now + 1, true, "context-b");
  assert.equal(migrated.remainingSendBudget("chat"), 10);
});

test("legacy migration honors a lower configured allowance and never tops up a higher configured allowance", t => {
  for (const [grant, remaining, configured, expected] of [[10, 8, 5, 3], [5, 3, 10, 3]] as const) {
    const f = harness(t), now = Date.now(), disk = JSON.parse(readFileSync(f.statePath, "utf8"));
    delete disk.context_windows; delete disk.account_send_budget;
    disk.context_budgets = { chat: { refreshedAt: now, remaining, grantedBudget: grant, progressSent: 0, lastInboundKey: "old" } };
    writeFileSync(f.statePath, JSON.stringify(disk));
    assert.equal(new StateManager(f.accountPath, f.statePath, { sendBudget: configured }).remainingSendBudget("chat"), expected);
  }
});

test("text submission cannot yield between its quota charge and starting the network request", async t => {
  const f = harness(t), epoch = f.state.accountSendBudget!.lastInboundKey;
  const begin = f.state.beginReplyChunk.bind(f.state);
  t.mock.method(f.state, "beginReplyChunk", (key: string, index: number) => {
    begin(key, index);
    queueMicrotask(() => f.state.recordInboundContext("peer-after-intent", "peer", Date.now(), true, "peer-token"));
  });
  f.hooks.send = () => {
    assert.equal(f.state.accountSendBudget!.lastInboundKey, epoch,
      "a ready peer inbound must not replace the charged epoch before this request starts");
    assert.equal(f.state.accountSendBudget!.remaining, 9);
    return { ret: 0, errcode: 0 };
  };
  await f.ilink.sendMarkdownReply("chat", "result from the charged generation", {
    deliveryKey: "synchronous-text-intent",
    shouldContinue: () => f.state.accountSendBudget!.lastInboundKey === epoch,
  });
  assert.equal(f.sends.length, 1);
  assert.equal(f.state.replyDeliveries["synchronous-text-intent"].acknowledgedChunks, 1);
  assert.equal(f.state.accountSendBudget!.lastInboundKey, "peer-after-intent");
  assert.equal(f.state.remainingSendBudget("peer"), 10);
});

test("a peer inbound during image upload defers the image without charging the new account generation", async t => {
  const f = harness(t), png = Buffer.from("89504e470d0a1a0a00000000", "hex");
  const image = { id: "epoch-image", mime: "image/png" as const, size: png.length,
    sha256: createHash("sha256").update(png).digest("hex") };
  let uploaded!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { uploaded = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sends: Record<string, unknown>[] = [];
  const client = new ILinkClient({ stateManager: f.state, fetchImpl: async (input, init) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === "/c2c/upload") {
      uploaded(); await gate;
      return new Response("", { headers: { "x-encrypted-param": "synthetic-download" } });
    }
    if (pathname.endsWith("getuploadurl")) return Response.json({ ret: 0, upload_param: "synthetic-upload" });
    if (pathname.endsWith("getconfig")) return Response.json({ ret: 0, typing_ticket: "synthetic-ticket" });
    if (pathname.endsWith("sendtyping")) return Response.json({ ret: 0 });
    assert.ok(pathname.endsWith("sendmessage"));
    sends.push(JSON.parse(String(init?.body)).msg as Record<string, unknown>);
    return Response.json({ ret: 0, errcode: 0 });
  } });
  const pending = client.sendImageReply("chat", [image], {
    deliveryKey: "peer-epoch-image", getImageBytes: async () => png,
  });
  const rejected = assert.rejects(pending, /image reply interrupted before/);
  try {
    await started;
    f.state.recordInboundContext("peer-during-upload", "peer", Date.now(), true, "peer-token");
    assert.equal(f.state.contextTokens.chat, "synthetic-context");
  } finally { release(); }
  await rejected;
  assert.equal(sends.length, 0);
  assert.equal(f.state.accountSendBudget!.remaining, 10);
  assert.equal(f.state.replyDeliveries["peer-epoch-image"].inFlight, false);
  assert.equal(f.state.replyDeliveries["peer-epoch-image"].acknowledgedChunks, 0);
  assert.equal(await client.sendImageReply("chat", [image], {
    deliveryKey: "peer-epoch-image", getImageBytes: async () => png,
  }), 1);
  assert.equal(sends.length, 1);
  assert.equal(f.state.accountSendBudget!.remaining, 9);
});

test("an interested recipient nearing 23 hours is reminded even after another recipient refreshes the account", async t => {
  const f = harness(t), now = Date.now(), recipientRefreshedAt = now - 22 * HOUR;
  f.state.contextWindows.chat.refreshedAt = recipientRefreshedAt;
  f.state.recordInboundContext("peer-fresh-account", "peer", now, true, "peer-token");
  f.state.accountSendBudget!.remaining = 2;
  const notifier = new RenewalNotifier({ state: f.state, send: f.ilink.sendMarkdownReply.bind(f.ilink) });
  assert.equal((await notifier.deliverOnce(["chat", "peer"])).sent, 1);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].to_user_id, "chat");
  assert.equal(f.sends[0].context_token, "synthetic-context");
  assert.equal(f.state.contextWindows.chat.refreshedAt, recipientRefreshedAt);
  assert.equal(f.state.accountSendBudget!.refreshedAt, now);
  assert.equal(f.state.accountSendBudget!.remaining, 1);
  assert.equal((await notifier.deliverOnce(["chat", "peer"])).sent, 0);
});
