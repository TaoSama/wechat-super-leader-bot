import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { StateManager } from "../../src/runtime/state.js";
import { deliverFileReply } from "../../src/wechat/file-delivery.js";
import { ILinkSendReceiptError } from "../../src/wechat/send-receipt.js";
import type { UploadedFileItem } from "../../src/wechat/file-upload.js";

const BYTES = Buffer.from("# 完整任务成果\n");
const METADATA = { fileName: "result.md", byteLength: BYTES.length,
  sha256: createHash("sha256").update(BYTES).digest("hex") };
const ITEM: UploadedFileItem = { type: 4, file_item: { media: {
  encrypt_query_param: "download", aes_key: "key", encrypt_type: 1 },
file_name: METADATA.fileName, len: String(BYTES.length) } };

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "gateway-file-delivery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const credentials = join(directory, "account.json"), statePath = join(directory, "state.json");
  writeFileSync(credentials, JSON.stringify({ accountId: "fixture", token: "synthetic-token" }));
  const state = new StateManager(credentials, statePath);
  state.setContextToken("chat", "synthetic-context");
  const calls: string[] = [], clientIds: string[] = [];
  let gate = Promise.resolve();
  const options: Parameters<typeof deliverFileReply>[0] = {
    chatId: "chat", bytes: BYTES, metadata: METADATA, deliveryKey: "file-delivery", state,
    upload: async () => { calls.push("upload"); return ITEM; },
    withChatSend: async (send, signal) => {
      const previous = gate; let release!: () => void;
      gate = new Promise(resolve => { release = resolve; });
      try { await previous; signal.throwIfAborted(); return await send(); } finally { release(); }
    },
    consumeBudget: () => { calls.push("budget"); },
    send: async (item, clientId) => {
      calls.push("send"); clientIds.push(clientId);
      assert.deepEqual(item, ITEM);
      const persisted = new StateManager(credentials, statePath);
      assert.equal(persisted.replyDeliveries[options.deliveryKey].inFlight, true, "intent is durable before sendmessage");
    },
  };
  return { options, state, calls, clientIds, restart: () => new StateManager(credentials, statePath) };
}

test("file final send consumes quota after upload and persists acknowledgement before returning", async t => {
  const f = fixture(t);
  assert.equal(await deliverFileReply(f.options), 1);
  assert.deepEqual(f.calls, ["upload", "budget", "send"]);
  assert.equal(f.restart().replyDeliveries["file-delivery"].acknowledgedChunks, 1);
  assert.equal(f.restart().replyDeliveries["file-delivery"].inFlight, false);
  await deliverFileReply({ ...f.options, state: f.restart() });
  assert.equal(f.calls.length, 3, "restart never reuploads an acknowledged file");
});

test("unknown final outcome survives restart and refuses every upload or send replay", async t => {
  const f = fixture(t);
  f.options.send = async () => { f.calls.push("send"); throw new Error("synthetic response loss"); };
  await assert.rejects(deliverFileReply(f.options), /response loss/);
  assert.equal(f.restart().replyDeliveries["file-delivery"].inFlight, true);
  await assert.rejects(deliverFileReply({ ...f.options, state: f.restart() }), /delivery uncertain/);
  assert.deepEqual(f.calls, ["upload", "budget", "send"]);
});

test("explicit rejection is retryable with the same message identity", async t => {
  const f = fixture(t);
  const send = f.options.send;
  f.options.send = async (item, clientId, signal) => {
    await send(item, clientId, signal);
    if (f.clientIds.length === 1) throw new ILinkSendReceiptError("RejectedRet");
  };
  await assert.rejects(deliverFileReply(f.options), /RejectedRet/);
  assert.equal(f.state.replyDeliveries["file-delivery"].inFlight, false);
  assert.equal(await deliverFileReply(f.options), 1);
  assert.deepEqual(f.clientIds, [f.clientIds[0], f.clientIds[0]]);
});

test("upload failure, local budget rejection and context changes never leave unknown delivery", async t => {
  for (const phase of ["upload", "budget", "context"]) {
    const f = fixture(t);
    if (phase === "upload") f.options.upload = async () => { throw new Error("upload unavailable"); };
    if (phase === "budget") f.options.consumeBudget = () => { throw new Error("budget exhausted"); };
    if (phase === "context") f.options.upload = async () => {
      f.state.setContextToken("chat", "new-context"); return ITEM;
    };
    await assert.rejects(deliverFileReply(f.options));
    assert.equal(f.state.replyDeliveries["file-delivery"].inFlight, false);
    assert.equal(f.calls.includes("send"), false);
    if (phase !== "budget") assert.equal(f.calls.includes("budget"), false);
  }
});

test("concurrent same-key file requests upload independently but submit only once under the shared chat lock", async t => {
  const f = fixture(t);
  assert.deepEqual(await Promise.all([deliverFileReply(f.options), deliverFileReply(f.options)]), [1, 1]);
  assert.equal(f.calls.filter(call => call === "upload").length, 2);
  assert.equal(f.calls.filter(call => call === "budget").length, 1);
  assert.equal(f.calls.filter(call => call === "send").length, 1);
});

test("file reply overall deadline bounds uploads and unknown sends that ignore cancellation", async t => {
  for (const phase of ["upload", "send"]) {
    const f = fixture(t);
    if (phase === "upload") f.options.upload = async () => new Promise(() => {});
    else f.options.send = async () => new Promise(() => {});
    await assert.rejects(deliverFileReply({ ...f.options, timeoutMs: 15 }), /file reply timed out/);
    assert.equal(f.state.replyDeliveries["file-delivery"].inFlight, phase === "send");
  }
});

test("changed metadata cannot reuse a committed delivery identity", async t => {
  const f = fixture(t);
  await deliverFileReply(f.options);
  await assert.rejects(deliverFileReply({ ...f.options, metadata: { ...METADATA, fileName: "changed.md" } }), /changed/);
  assert.equal(f.calls.filter(call => call === "send").length, 1);
});
