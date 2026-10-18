import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateManager } from "../../src/runtime/state.js";
import { FileResultOutbox } from "../../src/results/outbox.js";
import { ResultDeliveryRunner } from "../../src/results/delivery.js";
import { ResultDispatcher, type ResultDispatcherOptions } from "../../src/results/dispatcher.js";
import type { ResultDelivery, MaterializedResultDelivery } from "../../src/results/contracts.js";

function harness(t: { after(callback: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), "result-dispatch-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const accountPath = join(directory, "account.json"), statePath = join(directory, "state.json"), outboxPath = join(directory, "results.json");
  writeFileSync(accountPath, JSON.stringify({ accountId: "synthetic", token: "synthetic" }));
  const state = new StateManager(accountPath, statePath), id = randomUUID(), artifactId = randomUUID();
  const f = { now: 1_800_000_000_000, loss: "", sends: 0, claims: 0, receipts: 0, blocked: 0, pendingReply: false, allowRunner: true, unknown: false,
    records: new Map<string, ResultDelivery>(), state, outboxPath, store: new FileResultOutbox(outboxPath, () => state.getLoginFingerprint()) };
  const item: ResultDelivery = { id, key: id, chatId: "chat", source: { type: "plan", id: "task" }, kind: "completed", status: "ready", mode: "text", messages: ["完整成果"],
    artifact: { id: artifactId, chatId: "chat", name: "result.md", size: 12, sha256: "a".repeat(64), expiresAt: f.now + 1_000_000 },
    createdAt: f.now - 1000, expiresAt: f.now + 500_000, retainedUntil: f.now + 1_000_000 };
  f.records.set(id, item);
  const lost = (stage: string) => { if (f.loss === stage) { f.loss = ""; throw new Error(`${stage} response lost`); } };
  const controller: ResultDispatcherOptions["controller"] = {
    listDeliveries: async chats => [...f.records.values()].filter(item => chats.includes(item.chatId) && item.status === "ready").map(item => structuredClone(item)),
    getDelivery: async id => structuredClone(f.records.get(id)!),
    claimDelivery: async (id, attemptId) => {
      f.claims++;
      const claimed: ResultDelivery = { ...f.records.get(id)!, status: "claimed", attemptId, attemptedAt: f.now, attemptExpiresAt: f.now + 100_000 };
      f.records.set(id, claimed); lost("claim"); return structuredClone(claimed);
    },
    materializeDelivery: async id => {
      const item = f.records.get(id)!;
      return { ...structuredClone(item), artifact: { ...item.artifact,
        downloadUrl: `https://controller.test/v1/result-artifacts/${item.artifact.id}/download?expires=${f.now + 1000}&signature=${"a".repeat(64)}` } } as MaterializedResultDelivery;
    },
    recordReceipt: async (id, attemptId, status) => {
      f.receipts++;
      const item = f.records.get(id)!;
      assert.equal(item.attemptId, attemptId);
      const accepted: ResultDelivery = { ...item, status };
      f.records.set(id, accepted); lost("receipt"); return structuredClone(accepted);
    },
    deferDelivery: async (id, attemptId, reason, submittedMessages = 0) => {
      const item = f.records.get(id)!;
      assert.equal(item.attemptId, attemptId);
      const { attemptId: _id, attemptedAt: _at, attemptExpiresAt: _until, ...rest } = item;
      const deferred: ResultDelivery = { ...rest, status: "waiting_for_user", submittedMessages,
        lastDeferredAttemptId: attemptId, lastDeferReason: reason, lastDeferredAt: f.now };
      f.records.set(id, deferred); lost("defer"); return structuredClone(deferred);
    },
    resumeDeliveries: async chatId => { for (const [id, item] of f.records) if (item.chatId === chatId && item.status === "waiting_for_user") f.records.set(id, { ...item, status: "ready" }); },
    blockChatDeliveries: async (chatId, reason) => {
      f.blocked++;
      let blocked = 0;
      for (const [id, item] of f.records) if (item.chatId === chatId && item.status === "ready") {
        f.records.set(id, { ...item, status: "waiting_for_user", deferReason: reason }); blocked++;
      }
      return blocked;
    },
  };
  const runner = new ResultDeliveryRunner({ state, now: () => f.now, contextFingerprint: () => "context",
    budget: () => ({ allowed: f.allowRunner, remaining: 10, reason: "window_expired" }), isReplyPending: () => f.pendingReply,
    downloadArtifact: async () => Buffer.from("artifact"),
    transport: {
      sendText: async (_chat, text, options) => {
        const delivery = state.prepareReplyDelivery(options.deliveryKey, createHash("sha256").update(text).digest("hex"), 1);
        if (delivery.acknowledgedChunks) return;
        state.beginReplyChunk(options.deliveryKey, 0); f.sends++;
        if (f.unknown) throw new Error("network response lost");
        state.confirmReplyChunk(options.deliveryKey, 0);
      },
      sendFile: async () => { throw new Error("Unexpected attachment"); },
    } });
  const dispatcher = (store = f.store, overrides: Partial<ResultDispatcherOptions> = {}) => new ResultDispatcher({ controller, store, runner, state, canDispatch: () => true,
    isReplyPending: () => f.pendingReply, now: () => f.now, ...overrides });
  const restart = () => { f.store = new FileResultOutbox(outboxPath, () => state.getLoginFingerprint()); return dispatcher(); };
  return Object.assign(f, { id, dispatcher, restart, controller });
}
test("claim response loss recovers through GET and never makes a second claim or send", async t => {
  const f = harness(t); f.loss = "claim";
  await assert.rejects(f.dispatcher().deliverOnce(["chat"]), /claim response lost/);
  assert.equal(f.store.references()[0].status, "claiming");
  assert.equal(f.sends, 0);
  assert.deepEqual(await f.restart().deliverOnce(["chat"]), { accepted: 1, uncertain: 0, skipped: 0 });
  assert.equal(f.claims, 1); assert.equal(f.sends, 1); assert.equal(f.store.references().length, 0);
});
test("accepted receipt response loss never replays a send after restart", async t => {
  const f = harness(t); f.loss = "receipt";
  await assert.rejects(f.dispatcher().deliverOnce(["chat"]), /receipt response lost/);
  assert.equal(f.store.references()[0].status, "receipt");
  await f.restart().deliverOnce(["chat"]);
  assert.equal(f.sends, 1); assert.equal(f.receipts, 1); assert.equal(f.store.references().length, 0);
});
test("defer response loss recognizes exact lastDeferredAttemptId rather than marking unknown", async t => {
  const f = harness(t); f.loss = "defer"; f.allowRunner = false;
  await assert.rejects(f.dispatcher().deliverOnce(["chat"]), /defer response lost/);
  assert.equal(f.store.references()[0].status, "defer");
  await f.restart().deliverOnce(["chat"]);
  assert.equal(f.sends, 0); assert.equal(f.store.references().length, 0);
  assert.equal(f.records.get(f.id)?.status, "waiting_for_user");
});
test("unknown transport send writes uncertain receipt and is never automatically replayed", async t => {
  const f = harness(t); f.unknown = true;
  assert.deepEqual(await f.dispatcher().deliverOnce(["chat"]), { accepted: 0, uncertain: 1, skipped: 0 });
  await f.restart().deliverOnce(["chat"]);
  assert.equal(f.sends, 1); assert.equal(f.records.get(f.id)?.status, "uncertain");
});
test("durable subordinate acceptance recovers a crash before receipt intent was written", async t => {
  const f = harness(t), update = f.store.update.bind(f.store);
  f.store.update = (id, patch) => { if (patch.status === "receipt") throw new Error("intent persistence unavailable"); update(id, patch); };
  await assert.rejects(f.dispatcher().deliverOnce(["chat"]), /intent persistence unavailable/);
  assert.equal(f.sends, 1); assert.equal(f.records.get(f.id)?.status, "claimed");
  await f.restart().deliverOnce(["chat"]);
  assert.equal(f.sends, 1); assert.equal(f.records.get(f.id)?.status, "accepted");
});
test("dispatch cooldown persists across restart and prevents repeated ticks from draining backlog", async t => {
  const f = harness(t), first = f.records.get(f.id)!;
  f.records.set(randomUUID(), { ...first, id: randomUUID(), key: randomUUID(), createdAt: first.createdAt - 1 });
  // Keep map keys aligned with IDs for the synthetic Controller.
  for (const [key, value] of f.records) if (key !== value.id) { f.records.delete(key); f.records.set(value.id, value); }
  await f.dispatcher().deliverOnce(["chat"]);
  assert.equal(f.sends, 1);
  await f.restart().deliverOnce(["chat"]);
  assert.equal(f.sends, 1);
  f.now += 60_000;
  await f.dispatcher().deliverOnce(["chat"]);
  assert.equal(f.sends, 2);
});
test("pending ordinary reply keeps active results queued without claiming", async t => {
  const f = harness(t); f.pendingReply = true;
  await f.dispatcher().deliverOnce(["chat"]);
  assert.equal(f.claims, 0); assert.equal(f.sends, 0);
});
test("API outbox is private, bounded references only, and isolated by account", async t => {
  const f = harness(t);
  f.loss = "claim";
  await assert.rejects(f.dispatcher().deliverOnce(["chat"]));
  assert.equal(statSync(f.outboxPath).mode & 0o777, 0o600);
  const other = new FileResultOutbox(f.outboxPath, () => "different-account");
  assert.equal(other.references().length, 0);
});
test("a chat with no usable context marks ready results waiting without claiming or sending", async t => {
  const f = harness(t), dispatcher = f.dispatcher(f.store, { canDispatch: () => false, deferReason: () => "window_expired" });
  await dispatcher.deliverOnce(["chat"]);
  assert.equal(f.records.get(f.id)?.status, "waiting_for_user");
  assert.equal(f.records.get(f.id)?.deferReason, "window_expired");
  assert.equal(f.claims, 0); assert.equal(f.sends, 0); assert.equal(f.blocked, 1);
  await dispatcher.deliverOnce(["chat"]);
  assert.equal(f.blocked, 1, "repeated ticks do not repeatedly mark the same blocked chat");
});
test("one blocked chat never prevents an independent authorized chat from delivering", async t => {
  const f = harness(t), original = f.records.get(f.id)!, id = randomUUID();
  f.records.set(id, { ...original, id, key: id, chatId: "other", artifact: { ...original.artifact, id: randomUUID(), chatId: "other" } });
  const dispatcher = f.dispatcher(f.store, { canDispatch: chatId => chatId === "other" });
  await dispatcher.deliverOnce(["chat", "other"]);
  assert.equal(f.records.get(f.id)?.status, "waiting_for_user");
  assert.equal(f.records.get(id)?.status, "accepted");
  assert.equal(f.sends, 1);
});
test("genuine inbound resume intent survives restart and waits until the ordinary reply finishes", async t => {
  const f = harness(t);
  f.records.set(f.id, { ...f.records.get(f.id)!, status: "waiting_for_user" });
  const dispatcher = f.dispatcher();
  dispatcher.noteInbound("chat", "genuine-inbound-generation");
  f.pendingReply = true;
  await f.restart().deliverOnce(["chat"]);
  assert.equal(f.records.get(f.id)?.status, "waiting_for_user");
  assert.equal(f.store.pendingResumes().length, 1);
  f.pendingReply = false;
  await f.dispatcher().deliverOnce(["chat"]);
  assert.equal(f.records.get(f.id)?.status, "accepted");
  assert.equal(f.store.pendingResumes().length, 0);
  assert.equal(f.sends, 1);
});
