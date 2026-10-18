import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateManager } from "../../src/runtime/state.js";
import { ResultDeliveryRunner, selectResultDeliveries, type ResultDeliveryOptions } from "../../src/results/delivery.js";
import type { MaterializedResultDelivery } from "../../src/results/contracts.js";
import { resultIdentity } from "../../src/results/outbox.js";

const now = 1_800_000_000_000;
const bytes = Buffer.from("完整研究成果");
function plan(overrides: Partial<MaterializedResultDelivery> = {}): MaterializedResultDelivery {
  const id = randomUUID(), artifactId = randomUUID();
  return { id, key: id, chatId: "chat", source: { type: "plan", id: "task" }, kind: "completed", status: "claimed", mode: "text", messages: ["甲", "乙", "丙"],
    artifact: { id: artifactId, chatId: "chat", name: "result.md", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
      expiresAt: now + 200_000, downloadUrl: `https://controller.test/v1/result-artifacts/${artifactId}/download?expires=${now + 200_000}&signature=${"a".repeat(64)}` },
    createdAt: now - 100_000, expiresAt: now + 100_000, retainedUntil: now + 200_000,
    attemptId: randomUUID(), attemptedAt: now - 1, attemptExpiresAt: now + 90_000, ...overrides };
}
function harness(t: { after(fn: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), "gateway-result-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const account = join(directory, "account.json"), stateFile = join(directory, "state.json");
  writeFileSync(account, JSON.stringify({ accountId: "synthetic-bot", token: "synthetic-token" }));
  const state = new StateManager(account, stateFile), sends: { key: string; value: string | Buffer }[] = [];
  const send = async (value: string | Buffer, key: string) => {
    const current = options.state as StateManager;
    const digest = createHash("sha256").update(value).digest("hex");
    const delivery = current.prepareReplyDelivery(key, digest, 1);
    if (delivery.acknowledgedChunks === 1) return;
    current.beginReplyChunk(key, 0);
    sends.push({ key, value });
    current.confirmReplyChunk(key, 0);
  };
  const options: ResultDeliveryOptions = { state, now: () => now, contextFingerprint: () => "synthetic-context", budget: () => ({ allowed: true, remaining: 10 }), isReplyPending: () => false,
    downloadArtifact: async () => bytes,
    transport: { sendText: async (_chat, value, options) => send(value, options.deliveryKey),
      sendFile: async (_chat, _artifact, value, options) => send(value, options.deliveryKey) } };
  return { state, account, stateFile, options, sends };
}
test("three text messages are preserved verbatim and never replayed after process restart", async t => {
  const f = harness(t), item = plan();
  assert.deepEqual(await new ResultDeliveryRunner(f.options).deliver(item), { status: "accepted", acknowledgedSteps: 3, totalSteps: 3 });
  assert.deepEqual(f.sends.map(send => send.value), item.messages);
  const reloaded = new StateManager(f.account, f.stateFile);
  f.options.state = reloaded;
  assert.equal((await new ResultDeliveryRunner({ ...f.options, state: reloaded }).deliver(item)).status, "accepted");
  assert.equal(f.sends.length, 3);
});
test("long results send one model summary then complete attachment bytes", async t => {
  const f = harness(t), item = plan({ mode: "attachment", messages: ["模型生成的结果摘要"] });
  assert.equal((await new ResultDeliveryRunner(f.options).deliver(item)).status, "accepted");
  assert.deepEqual(f.sends.map(send => send.value), [item.messages[0], bytes]);
  assert.equal(f.sends[0].key, `result:${item.id}:step:0`);
  assert.equal(f.sends[1].key, `result:${item.id}:step:1`);
});
test("unknown send persists inFlight and restart never retries it", async t => {
  const f = harness(t), item = plan();
  f.options.transport.sendText = async (_chat, value, options) => {
    f.state.prepareReplyDelivery(options.deliveryKey, createHash("sha256").update(value).digest("hex"), 1);
    f.state.beginReplyChunk(options.deliveryKey, 0);
    f.sends.push({ key: options.deliveryKey, value }); throw new Error("response lost");
  };
  assert.equal((await new ResultDeliveryRunner(f.options).deliver(item)).status, "uncertain");
  const reloaded = new StateManager(f.account, f.stateFile);
  const result = await new ResultDeliveryRunner({ ...f.options, state: reloaded }).deliver(item);
  assert.equal(result.reason, "previous_send_unknown");
  assert.equal(f.sends.length, 1);
});
test("definitely unsubmitted step resumes after preceding acknowledged text without duplication", async t => {
  const f = harness(t), item = plan();
  const original = f.options.transport.sendText;
  f.options.classifyError = () => "not_submitted";
  f.options.transport.sendText = async (chat, text, options) => {
    if (text === "乙") throw new Error("context unavailable before submit");
    return original(chat, text, options);
  };
  assert.deepEqual(await new ResultDeliveryRunner(f.options).deliver(item), {
    status: "deferred", reason: "not_submitted", acknowledgedSteps: 1, totalSteps: 3,
  });
  f.options.transport.sendText = original;
  const reloaded = new StateManager(f.account, f.stateFile);
  f.options.state = reloaded;
  assert.equal((await new ResultDeliveryRunner({ ...f.options, state: reloaded }).deliver(item)).status, "accepted");
  assert.deepEqual(f.sends.map(send => send.value), item.messages);
});
test("normal replies preempt notifications before claim-side sends", async t => {
  const f = harness(t);
  f.options.isReplyPending = () => true;
  assert.equal((await new ResultDeliveryRunner(f.options).deliver(plan())).reason, "reply_pending");
  assert.equal(f.sends.length, 0);
});
test("replies that arrive between result steps interrupt further steps safely", async t => {
  const f = harness(t);
  f.options.isReplyPending = () => f.sends.length > 0;
  const result = await new ResultDeliveryRunner(f.options).deliver(plan());
  assert.equal(result.reason, "reply_pending");
  assert.equal(result.acknowledgedSteps, 1);
  assert.equal(f.sends.length, 1);
});
test("progress never consumes reserved final three messages", async t => {
  const f = harness(t);
  f.options.budget = (_chat, kind) => ({ allowed: kind !== "progress", remaining: 3, reason: "budget_exhausted" });
  assert.equal((await new ResultDeliveryRunner(f.options).deliver(plan({ kind: "progress", messages: ["进度"] }))).reason, "budget_exhausted");
  assert.equal(f.sends.length, 0);
});
test("progress admission comes exclusively from the shared transport policy", async t => {
  const f = harness(t);
  f.options.budget = (_chat, kind) => ({ allowed: kind !== "progress" || f.sends.length < 3, remaining: 10, reason: "budget_exhausted" });
  for (let index = 0; index < 3; index++) {
    assert.equal((await new ResultDeliveryRunner(f.options).deliver(plan({ kind: "progress", messages: [`进度${index}`] }))).status, "accepted");
  }
  const reloaded = new StateManager(f.account, f.stateFile);
  assert.equal((await new ResultDeliveryRunner({ ...f.options, state: reloaded }).deliver(plan({ kind: "progress", messages: ["第四次"] }))).reason, "budget_exhausted");
  assert.equal(f.sends.length, 3);
});
test("window and quota denial defer without creating ambiguous sends", async t => {
  const f = harness(t);
  f.options.budget = () => ({ allowed: false, remaining: 0, reason: "window_closed" });
  assert.equal((await new ResultDeliveryRunner(f.options).deliver(plan())).reason, "window_closed");
  f.options.budget = () => ({ allowed: true, remaining: 2 });
  assert.equal((await new ResultDeliveryRunner(f.options).deliver(plan())).reason, "budget_exhausted");
  assert.equal(Object.keys(f.state.replyDeliveries).length, 0);
});
test("concurrent attempts for one immutable delivery share exactly one in-progress operation", async t => {
  const f = harness(t), item = plan(), runner = new ResultDeliveryRunner(f.options);
  const first = runner.deliver(item), second = runner.deliver(item);
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(f.sends.length, 3);
});
test("attachment preparation failures preserve an acknowledged summary for later continuation", async t => {
  const f = harness(t), item = plan({ mode: "attachment", messages: ["摘要"] });
  f.options.downloadArtifact = async () => { throw new Error("temporary offline"); };
  assert.equal((await new ResultDeliveryRunner(f.options).deliver(item)).reason, "artifact_unavailable");
  f.options.downloadArtifact = async () => bytes;
  assert.equal((await new ResultDeliveryRunner(f.options).deliver(item)).status, "accepted");
  assert.deepEqual(f.sends.map(send => send.value), ["摘要", bytes]);
});
test("immutable result identity changes when content changes", async t => {
  const f = harness(t), item = plan();
  await new ResultDeliveryRunner(f.options).deliver(item);
  assert.notEqual(resultIdentity(item), resultIdentity({ ...item, messages: ["篡改"] }));
  assert.equal(f.sends.length, 3);
});
test("per-pass selection chooses the newest terminal result per chat", () => {
  const items = [plan({ createdAt: now, kind: "progress" }), plan({ createdAt: now - 10 }), plan({ createdAt: now - 20 }), plan({ chatId: "other" })];
  assert.deepEqual(selectResultDeliveries(items).map(item => item.id), [items[1].id, items[3].id]);
});
test("a genuine context generation change interrupts the remaining result messages", async t => {
  const f = harness(t);
  f.options.contextFingerprint = () => f.sends.length ? "new-context" : "original-context";
  const outcome = await new ResultDeliveryRunner(f.options).deliver(plan());
  assert.equal(outcome.reason, "context_changed");
  assert.equal(outcome.acknowledgedSteps, 1);
  assert.equal(f.sends.length, 1);
});
test("business and claim deadlines prevent new sends", async t => {
  const f = harness(t);
  assert.equal((await new ResultDeliveryRunner(f.options).deliver(plan({ expiresAt: now }))).reason, "business_expired");
  assert.equal((await new ResultDeliveryRunner(f.options).deliver(plan({ attemptExpiresAt: now }))).reason, "attempt_expired");
  assert.equal(f.sends.length, 0);
});
