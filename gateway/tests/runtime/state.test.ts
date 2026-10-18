import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { MAX_REPLY_DELIVERIES, StateManager } from "../../src/runtime/state.js";

test("failed processed checkpoint preserves reply progress in memory and on disk", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-rollback-test-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const credPath = path.join(tmpDir, "account.json");
  const statePath = path.join(tmpDir, "state.json");
  fs.writeFileSync(credPath, JSON.stringify({ token: "fake-token", accountId: "test-bot" }));
  const state = new StateManager(credPath, statePath);
  const key = state.computeDeliveryKey("test-chat", "test-message");
  state.recordReplyChunkProgress(key, 2);
  const failure = new Error("injected checkpoint failure");
  const save = t.mock.method(state, "saveState", () => { throw failure; });
  assert.throws(() => state.recordProcessedMessageKey(key), error => error === failure);
  assert.equal(state.isMessageProcessed(key), false);
  assert.equal(state.getReplySentChunks(key), 2);
  const reloaded = new StateManager(credPath, statePath);
  assert.equal(reloaded.isMessageProcessed(key), false);
  assert.equal(reloaded.getReplySentChunks(key), 2);
  save.mock.restore();
  state.recordProcessedMessageKey(key);
  assert.equal(state.isMessageProcessed(key), true);
  assert.equal(state.getReplySentChunks(key), 0);
  const completed = new StateManager(credPath, statePath);
  assert.equal(completed.isMessageProcessed(key), true);
  assert.equal(completed.getReplySentChunks(key), 0);
});

test("StateManager loads account readonly and writes atomic state with 0600 permissions", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-state-test-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const credPath = path.join(tmpDir, "account.json");
  const statePath = path.join(tmpDir, "state.json");

  fs.writeFileSync(credPath, JSON.stringify({ token: "tok123", accountId: "bot1", baseUrl: "https://custom.example" }));

  const sm = new StateManager(credPath, statePath);
  assert.equal(sm.account?.token, "tok123");
  assert.equal(sm.account?.accountId, "bot1");
  assert.equal(sm.account?.baseUrl, "https://custom.example");
  assert.equal(sm.syncBuf, "");

  // Verify atomic cursor commit and file mode 0600
  sm.commitCursor("buf-1");
  assert.equal(sm.syncBuf, "buf-1");
  assert.ok(fs.existsSync(statePath));
  const stat = fs.statSync(statePath);
  assert.equal(stat.mode & 0o777, 0o600);

  const rawState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(rawState.sync_buf, "buf-1");

  // Message delivery key and deduplication
  const key1 = sm.computeDeliveryKey("user1", "msg1");
  assert.equal(key1, JSON.stringify(["bot1", "user1", "msg1"]));
  assert.equal(sm.isMessageProcessed(key1), false);

  sm.recordProcessedMessageKey(key1);
  assert.equal(sm.isMessageProcessed(key1), true);

  // Reload state from disk
  const sm2 = new StateManager(credPath, statePath);
  assert.equal(sm2.syncBuf, "buf-1");
  assert.equal(sm2.isMessageProcessed(key1), true);

  // Changing login token invalidates old cursor and processed keys
  fs.writeFileSync(credPath, JSON.stringify({ token: "new-tok", accountId: "bot1" }));
  const sm3 = new StateManager(credPath, statePath);
  assert.equal(sm3.syncBuf, "");
  assert.equal(sm3.isMessageProcessed(key1), false);

});

test("StateManager fails closed on corrupted credentials or corrupted state file without leaking secrets", (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-corrupt-test-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const credPath = path.join(tmpDir, "account.json");
  const statePath = path.join(tmpDir, "state.json");

  // Corrupted credentials JSON: fails closed with desensitized error
  fs.writeFileSync(credPath, "{ invalid json with secret_token_xyz");
  assert.throws(
    () => new StateManager(credPath, statePath),
    (err: Error) => {
      assert.match(err.message, /Failed to load valid WeChat credentials from .* InvalidJsonSyntax/);
      assert.ok(!err.message.includes("secret_token_xyz"), "error must never leak token snippets");
      return true;
    }
  );

  // Credentials missing token: fails closed without crashing
  fs.writeFileSync(credPath, JSON.stringify({ accountId: "bot1" }));
  assert.throws(
    () => new StateManager(credPath, statePath),
    (err: Error) => {
      assert.match(err.message, /Failed to load valid WeChat credentials/);
      return true;
    }
  );

  // Valid credentials with secret token, but corrupted state JSON: must fail closed without leaking secret token or context tokens
  const sensitiveToken = "super-secret-wechat-bot-token-99999";
  fs.writeFileSync(credPath, JSON.stringify({ token: sensitiveToken, accountId: "bot1" }));
  fs.writeFileSync(statePath, "{ broken state json with sensitive_context_token_8888");
  assert.throws(
    () => new StateManager(credPath, statePath),
    (err: Error) => {
      assert.match(err.message, /Failed to load gateway state at .* InvalidJsonSyntax/);
      assert.ok(!err.message.includes(sensitiveToken), "error must never leak bot credentials");
      assert.ok(!err.message.includes("sensitive_context_token_8888"), "error must never leak state file contents");
      return true;
    }
  );

});

test("reply intent and acknowledgment roll back safely when durable checkpoints fail", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-delivery-state-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credentials = path.join(directory, "account.json");
  const statePath = path.join(directory, "state.json");
  fs.writeFileSync(credentials, JSON.stringify({ token: "synthetic", accountId: "fixture" }));
  const state = new StateManager(credentials, statePath);
  const digest = "a".repeat(64);
  state.prepareReplyDelivery("key", digest, 2);
  const failure = new Error("synthetic checkpoint failure");
  let mock = t.mock.method(state, "saveState", () => { throw failure; });
  assert.throws(() => state.beginReplyChunk("key", 0), error => error === failure);
  assert.equal(state.replyDeliveries.key.inFlight, false);
  mock.mock.restore();
  state.beginReplyChunk("key", 0);
  mock = t.mock.method(state, "saveState", () => { throw failure; });
  assert.throws(() => state.confirmReplyChunk("key", 0), error => error === failure);
  assert.equal(state.replyDeliveries.key.inFlight, true);
  assert.equal(state.getReplySentChunks("key"), 0);
  const disk = new StateManager(credentials, statePath);
  assert.equal(disk.replyDeliveries.key.inFlight, true);
  assert.throws(() => disk.prepareReplyDelivery("key", digest, 2), /uncertain/);
  mock.mock.restore();
});

test("login replacement clears durable reply delivery intents", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-delivery-account-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credentials = path.join(directory, "account.json");
  const statePath = path.join(directory, "state.json");
  fs.writeFileSync(credentials, JSON.stringify({ token: "synthetic-one", accountId: "fixture" }));
  const state = new StateManager(credentials, statePath);
  state.prepareReplyDelivery("key", "b".repeat(64), 1);
  state.beginReplyChunk("key", 0);
  fs.writeFileSync(credentials, JSON.stringify({ token: "synthetic-two", accountId: "fixture" }));
  const changed = new StateManager(credentials, statePath);
  assert.deepEqual(changed.replyDeliveries, {});
  assert.deepEqual(changed.sentReplyProgress, {});
});

test("reply state capacity only evicts completed deliveries and keeps uncertain intents", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-delivery-capacity-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credentials = path.join(directory, "account.json");
  const statePath = path.join(directory, "state.json");
  fs.writeFileSync(credentials, JSON.stringify({ token: "synthetic", accountId: "fixture" }));
  const state = new StateManager(credentials, statePath);
  for (let index = 0; index < MAX_REPLY_DELIVERIES; index++) {
    state.replyDeliveries[`pending-${index}`] = {
      digest: "c".repeat(64), totalChunks: 1, acknowledgedChunks: 0, inFlight: true,
    };
  }
  assert.throws(() => state.prepareReplyDelivery("new", "d".repeat(64), 1), /capacity exhausted/);
  state.replyDeliveries["pending-0"] = {
    digest: "c".repeat(64), totalChunks: 1, acknowledgedChunks: 1, inFlight: false,
  };
  state.sentReplyProgress["pending-0"] = 1;
  state.prepareReplyDelivery("new", "d".repeat(64), 1);
  assert.equal(Object.keys(state.replyDeliveries).length, MAX_REPLY_DELIVERIES);
  assert.equal(Object.hasOwn(state.replyDeliveries, "pending-0"), false);
  assert.equal(state.getReplySentChunks("pending-0"), 0);
  assert.equal(state.replyDeliveries["pending-1"].inFlight, true);
});

test("unknown reply quarantine preserves evidence and fails closed if its checkpoint cannot persist", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-quarantine-state-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credentials = path.join(directory, "account.json"), statePath = path.join(directory, "state.json");
  fs.writeFileSync(credentials, JSON.stringify({ token: "synthetic", accountId: "fixture" }));
  const state = new StateManager(credentials, statePath);
  state.prepareReplyDelivery("key", "d".repeat(64), 2);
  state.beginReplyChunk("key", 0);
  const save = t.mock.method(state, "saveState", () => { throw new Error("synthetic persistence failure"); });
  assert.throws(() => state.recordProcessedMessageKey("key", { preserveReplyEvidence: true }), /persistence failure/);
  assert.equal(state.isMessageProcessed("key"), false);
  assert.equal(state.hasUncertainReply("key"), true);
  save.mock.restore();
  state.recordProcessedMessageKey("key", { preserveReplyEvidence: true });
  const reloaded = new StateManager(credentials, statePath);
  assert.equal(reloaded.isMessageProcessed("key"), true);
  assert.equal(reloaded.hasUncertainReply("key"), true);
});

test("permanent image failure persists, blocks replay and rolls back failed checkpoints", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-permanent-failure-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credentials = path.join(directory, "account.json"), statePath = path.join(directory, "state.json");
  fs.writeFileSync(credentials, JSON.stringify({ token: "synthetic", accountId: "fixture" }));
  const state = new StateManager(credentials, statePath);
  const key = "image-reply:key", digest = "e".repeat(64);
  state.prepareReplyDelivery(key, digest, 2);
  state.beginReplyChunk(key, 0);
  assert.throws(() => state.recordReplyFailure(key, "AttachmentExpired"), /Invalid/);
  state.confirmReplyChunk(key, 0);
  const failure = new Error("synthetic persistence failure");
  const save = t.mock.method(state, "saveState", () => { throw failure; });
  assert.throws(() => state.recordReplyFailure(key, "AttachmentExpired"), error => error === failure);
  assert.equal(state.hasPermanentReplyFailure(key), false);
  assert.equal(new StateManager(credentials, statePath).hasPermanentReplyFailure(key), false);
  save.mock.restore();
  state.recordReplyFailure(key, "AttachmentExpired");
  state.recordProcessedMessageKey("key", { preserveReplyEvidence: true });
  const reloaded = new StateManager(credentials, statePath);
  assert.equal(reloaded.hasPermanentReplyFailure(key), true);
  assert.equal(reloaded.replyDeliveries[key].acknowledgedChunks, 1);
  assert.equal(reloaded.replyDeliveries[key].failureReason, "AttachmentExpired");
  assert.throws(() => reloaded.prepareReplyDelivery(key, digest, 2), /permanently failed/);
  assert.throws(() => reloaded.beginReplyChunk(key, 1), /Invalid/);
  assert.throws(() => reloaded.recordReplyFailure(key, "AttachmentUnavailable"), /Invalid/);
});

test("corrupt permanent failure state fails closed", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-invalid-permanent-failure-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credentials = path.join(directory, "account.json"), statePath = path.join(directory, "state.json");
  fs.writeFileSync(credentials, JSON.stringify({ token: "synthetic", accountId: "fixture" }));
  const state = new StateManager(credentials, statePath);
  for (const invalid of [
    { failureReason: "Unrecognized" },
    { failureReason: "AttachmentExpired", inFlight: true },
    { failureReason: "AttachmentUnavailable", acknowledgedChunks: 1 },
  ]) {
    state.replyDeliveries.key = {
      digest: "f".repeat(64), totalChunks: 1, acknowledgedChunks: 0, inFlight: false,
      ...invalid,
    } as typeof state.replyDeliveries[string];
    state.saveState();
    assert.throws(() => new StateManager(credentials, statePath), /Failed to load gateway state/);
  }
});
