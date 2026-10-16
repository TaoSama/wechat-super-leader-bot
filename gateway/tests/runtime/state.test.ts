import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../../src/runtime/state.js";

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
