import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileInboundInbox, InboxConflictError, INBOUND_INBOX_MAX_BYTES, INBOUND_INBOX_TEXT_MAX_BYTES } from "../../src/runtime/inbox.js";
import { OutboxBackpressureError } from "../../src/runtime/delivery-state.js";
import type { InboundWeChatMessage } from "../../src/types.js";

function fixture(t: TestContext, limit = 10) {
  const directory = fs.mkdtempSync(join(tmpdir(), "gateway-inbox-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "inbound.json"), account = { fingerprint: "account-one" };
  const reload = () => new FileInboundInbox(path, () => account.fingerprint, limit);
  return { directory, path, account, reload, inbox: reload() };
}

function inbound(key: string, patch: Partial<InboundWeChatMessage> = {}): InboundWeChatMessage {
  return { chatId: "chat-one", text: "先帮我查一下这件事", messageId: `message-${key}`, deliveryKey: key,
    contextToken: "synthetic-context", createdAtMs: 1_800_000_000_000, ...patch };
}

test("inbound messages recover exact text, metadata and poll insertion order across restarts", t => {
  const { inbox, reload, path } = fixture(t);
  const messages = [inbound("10"), inbound("2", { text: "补充：请保留\n原始换行与 emoji 🦊" }), inbound("1")];
  for (const item of messages) inbox.put(item);
  assert.deepEqual(reload().list(), messages);
  assert.equal(fs.statSync(path).mode & 0o777, 0o600);
  const restarted = reload();
  restarted.remove("2");
  restarted.put(inbound("2", { text: "新的入站内容" }));
  assert.deepEqual(reload().list().map(item => item.deliveryKey), ["10", "1", "2"]);
});

test("retained messages accept exact retries at capacity and reject changed content or metadata", t => {
  const { inbox, reload } = fixture(t, 1);
  const original = inbound("same-key");
  inbox.put(original);
  assert.doesNotThrow(() => inbox.put({ ...original }));
  for (const patch of [{ text: "篡改后的内容" }, { chatId: "other-chat" }, { messageId: "other-message" },
    { contextToken: "changed-context" }, { createdAtMs: original.createdAtMs! + 1 }, { contextToken: undefined }]) {
    assert.throws(() => inbox.put(inbound("same-key", patch)), InboxConflictError);
  }
  assert.throws(() => inbox.put(inbound("overflow")), OutboxBackpressureError);
  assert.deepEqual(reload().list(), [original]);
  inbox.remove("same-key");
  inbox.put(inbound("overflow"));
  assert.equal(reload().has("overflow"), true);
});

test("inbox callers cannot mutate persisted input through put or list object references", t => {
  const { inbox, reload } = fixture(t);
  const item = inbound("first"), expected = { ...item };
  inbox.put(item);
  item.text = "input mutated";
  inbox.list()[0].text = "output mutated";
  assert.deepEqual(inbox.list(), [expected]);
  assert.deepEqual(reload().list(), [expected]);
});

test("failed checkpoints keep memory and insertion order unchanged and clean up temporary files", t => {
  const { inbox, path, directory, reload } = fixture(t);
  inbox.put(inbound("first"));
  inbox.put(inbound("second"));
  const saved = fs.readFileSync(path), before = inbox.list();
  fs.unlinkSync(path);
  fs.mkdirSync(path);
  assert.throws(() => inbox.put(inbound("third")), /EISDIR|EPERM/);
  assert.deepEqual(inbox.list(), before);
  assert.throws(() => inbox.remove("first"), /EISDIR|EPERM/);
  assert.deepEqual(inbox.list(), before);
  assert.deepEqual(fs.readdirSync(directory), ["inbound.json"]);
  fs.rmdirSync(path);
  fs.writeFileSync(path, saved);
  assert.deepEqual(reload().list(), before);
  inbox.remove("first");
  assert.deepEqual(reload().list(), [inbound("second")]);
});

test("a changed account resets pending messages durably before allowing any access", t => {
  const { inbox, reload, path, account, directory } = fixture(t);
  inbox.put(inbound("old-account"));
  account.fingerprint = "account-two";
  assert.equal(inbox.has("old-account"), false);
  assert.deepEqual(reload().list(), []);
  assert.equal(JSON.parse(fs.readFileSync(path, "utf8")).fingerprint, "account-two");
  inbox.put(inbound("new-account"));
  account.fingerprint = "account-three";
  assert.deepEqual(reload().list(), []);
  account.fingerprint = "account-two";
  assert.deepEqual(reload().list(), []);
  assert.deepEqual(fs.readdirSync(directory), ["inbound.json"]);
});

test("failed account reset does not expose old messages or switch the in-memory account", t => {
  const { inbox, account, path } = fixture(t);
  inbox.put(inbound("old-account"));
  const original = fs.readFileSync(path);
  fs.unlinkSync(path);
  fs.mkdirSync(path);
  account.fingerprint = "account-two";
  assert.throws(() => inbox.list(), /EISDIR|EPERM/);
  assert.throws(() => inbox.has("old-account"), /EISDIR|EPERM/);
  fs.rmdirSync(path);
  fs.writeFileSync(path, original);
  assert.deepEqual(inbox.list(), []);
  inbox.put(inbound("new-account"));
  assert.deepEqual(inbox.list(), [inbound("new-account")]);
});

test("missing account identity prevents old account access until the same identity returns", t => {
  const { inbox, account, path } = fixture(t);
  inbox.put(inbound("retained"));
  const saved = fs.readFileSync(path, "utf8");
  account.fingerprint = "";
  assert.throws(() => inbox.list(), /Invalid inbound inbox string/);
  assert.equal(fs.readFileSync(path, "utf8"), saved);
  account.fingerprint = "account-one";
  assert.deepEqual(inbox.list(), [inbound("retained")]);
});

test("input validation rejects malformed messages without modifying durable state", t => {
  const { inbox, reload } = fixture(t);
  inbox.put(inbound("valid"));
  const invalid = [null, [], {}, inbound("bad", { text: "" }), inbound("bad", { chatId: " " }),
    inbound("bad", { deliveryKey: "" }), inbound("bad", { messageId: "m".repeat(4097) }),
    inbound("bad", { contextToken: "c".repeat(16 * 1024 + 1) }),
    inbound("bad", { text: "界".repeat(Math.ceil(INBOUND_INBOX_TEXT_MAX_BYTES / 3)) }),
    ...[NaN, Infinity, -1, 0.5, "123", null].map(createdAtMs => ({ ...inbound("bad"), createdAtMs })),
    { ...inbound("bad"), unknown: "field" }];
  for (const raw of invalid) assert.throws(() => inbox.put(raw as InboundWeChatMessage), /Invalid inbound inbox/);
  assert.deepEqual(reload().list(), [inbound("valid")]);
  assert.throws(() => inbox.has(""), /Invalid inbound inbox string/);
  assert.throws(() => inbox.remove(""), /Invalid inbound inbox string/);
});

test("disk corruption is never mistaken for an empty inbox, including another account's state", t => {
  const { path, reload, account } = fixture(t);
  const valid = { version: 1, fingerprint: "account-one", items: [inbound("first")] };
  for (const state of [null, [], {}, { ...valid, version: 2 }, { ...valid, unknown: true },
    { ...valid, fingerprint: "" }, { ...valid, items: {} }, { ...valid, items: [inbound("first"), inbound("first")] },
    { ...valid, items: [{ ...inbound("first"), text: 12 }] }]) {
    fs.writeFileSync(path, JSON.stringify(state));
    assert.throws(reload);
    account.fingerprint = "other-account";
    assert.throws(reload);
    account.fingerprint = "account-one";
  }
  fs.writeFileSync(path, "{not JSON");
  assert.throws(reload, SyntaxError);
});

test("disk size is checked before reading and only ENOENT means an empty inbox", t => {
  const { path, reload } = fixture(t);
  assert.deepEqual(reload().list(), []);
  fs.writeFileSync(path, "{}");
  fs.truncateSync(path, INBOUND_INBOX_MAX_BYTES + 1);
  assert.throws(reload, /exceeds byte budget/);
  fs.unlinkSync(path);
  fs.mkdirSync(path);
  assert.throws(reload, /exceeds byte budget/);
});

test("combined message body size causes backpressure before the durable file exceeds its budget", t => {
  const { path, reload, account } = fixture(t, 1000);
  const text = "x".repeat(INBOUND_INBOX_TEXT_MAX_BYTES);
  const accepted = Math.floor(INBOUND_INBOX_MAX_BYTES / INBOUND_INBOX_TEXT_MAX_BYTES) - 1;
  const items = Array.from({ length: accepted }, (_, index) => inbound(`body-${index}`, { text }));
  fs.writeFileSync(path, JSON.stringify({ version: 1, fingerprint: account.fingerprint, items }));
  const inbox = reload();
  assert.throws(() => inbox.put(inbound(`body-${accepted}`, { text })), OutboxBackpressureError);
  assert.ok(fs.statSync(path).size <= INBOUND_INBOX_MAX_BYTES);
  assert.equal(reload().list().length, accepted);
  assert.equal(inbox.has(`body-${accepted}`), false);
});

test("invalid capacities and reduced restart capacity reject overflow without rewriting messages", t => {
  const { path, inbox, account } = fixture(t);
  for (const limit of [0, -1, 1.5, NaN, Infinity, 10_001]) {
    assert.throws(() => new FileInboundInbox(path, () => account.fingerprint, limit), /Invalid inbound inbox capacity/);
  }
  inbox.put(inbound("first")); inbox.put(inbound("second"));
  const before = fs.readFileSync(path, "utf8");
  assert.throws(() => new FileInboundInbox(path, () => account.fingerprint, 1), OutboxBackpressureError);
  assert.equal(fs.readFileSync(path, "utf8"), before);
});
