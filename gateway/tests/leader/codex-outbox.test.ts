import { directToolController } from "./direct-tool-fixture.js";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { ThreadEvent } from "@openai/codex-sdk";
import { CodexReplyEngine, type CodexReplyEngineOptions } from "../../src/leader/codex.js";
import { ReplyEngineBackpressureError, ReplyEngineUnavailableError } from "../../src/leader/contracts.js";
import { WorkspaceStore, MAX_REPLY_JOURNAL_BYTES, MAX_REPLY_ENTRY_BYTES,
  MAX_PINNED_REPLY_ENTRIES, MAX_CLOSED_REPLY_ENTRIES, type ReplyJournal } from "../../src/leader/workspace.js";

const ACCOUNT = "account";
const CHAT = "chat";
const INPUT_HASH = createHash("sha256").update("seeded user input").digest("hex");
const usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
  output_tokens: 0, reasoning_output_tokens: 0 };
const messageKey = (messageId: string): string => createHash("sha256").update(messageId).digest("hex");
const noController = {
  ...directToolController(),
  getMessageReply: async (): Promise<never> => { throw new Error("Unexpected Controller GET"); },
};

function fixture(t: TestContext) {
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "codex-outbox-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "workspaces");
  return { root, temporary, store: new WorkspaceStore(root) };
}

function fakeSdk() {
  let calls = 0;
  const sdkFactory: NonNullable<CodexReplyEngineOptions["sdkFactory"]> = () => {
    calls++;
    const text = `原文回复 ${calls}\n第二行保持不变。`;
    const runner = { runStreamed: async () => ({ events: (async function* (): AsyncIterable<ThreadEvent> {
      yield { type: "item.completed", item: { type: "agent_message", id: "answer", text } };
      yield { type: "turn.completed", usage };
    })() }) };
    return { startThread: () => runner, resumeThread: () => runner };
  };
  return { sdkFactory, calls: () => calls };
}

function options(root: string, sdkFactory: NonNullable<CodexReplyEngineOptions["sdkFactory"]>): CodexReplyEngineOptions {
  return { root, model: "synthetic-model", codexPath: process.execPath, sdkFactory };
}

function seeded(stage: "started" | "completed", delivery: ReplyJournal[string]["delivery"], text = "seeded reply"): ReplyJournal[string] {
  return { inputHash: INPUT_HASH, stage, ...(delivery ? { delivery } : {}), reply: { text } };
}

test("65 pending replies survive restart and getReply returns every original without SDK or Controller GET", async t => {
  const { root, store } = fixture(t);
  const sdk = fakeSdk();
  const engine = new CodexReplyEngine(options(root, sdk.sdkFactory));
  const originals = [];
  for (let index = 0; index < 65; index++) {
    originals.push(await engine.reply(ACCOUNT, { chatId: CHAT, messageId: `message-${index}`, text: `问题 ${index}` }, noController));
  }
  assert.equal(sdk.calls(), 65);
  const workspace = await store.findChat(ACCOUNT, CHAT);
  assert.equal(Object.keys(workspace!.getReplyJournal()).length, 65);
  const forbiddenSdk = fakeSdk();
  const restarted = new CodexReplyEngine(options(root, forbiddenSdk.sdkFactory));
  let gets = 0;
  const controller = { getMessageReply: async () => { gets++; return { text: "wrong source" }; } };
  for (let index = 0; index < originals.length; index++) {
    assert.deepEqual(await restarted.getReply(ACCOUNT, CHAT, `message-${index}`, controller), originals[index]);
  }
  assert.equal(forbiddenSdk.calls(), 0);
  assert.equal(gets, 0);
});

test("128 pinned replies apply backpressure before SDK execution and accepted receipt releases capacity", async t => {
  const { root, store } = fixture(t);
  const workspace = await store.forChat(ACCOUNT, CHAT);
  const journal = Object.fromEntries(Array.from({ length: MAX_PINNED_REPLY_ENTRIES }, (_, index) => [
    messageKey(`pending-${index}`), seeded("completed", "pending"),
  ]));
  workspace.setReplyJournal(journal);
  const sdk = fakeSdk();
  const engine = new CodexReplyEngine(options(root, sdk.sdkFactory));
  const request = { chatId: CHAT, messageId: "new-work", text: "开始下一项" };
  await assert.rejects(engine.reply(ACCOUNT, request, noController), ReplyEngineBackpressureError);
  assert.equal(sdk.calls(), 0);
  assert.deepEqual(workspace.getReplyJournal(), journal);
  await engine.ackReply(ACCOUNT, CHAT, "pending-0", "accepted");
  assert.deepEqual(await engine.reply(ACCOUNT, request, noController), { text: "原文回复 1\n第二行保持不变。" });
  assert.equal(sdk.calls(), 1);
  const persisted = workspace.getReplyJournal();
  assert.equal(persisted[messageKey("pending-0")].delivery, "accepted");
  assert.equal(persisted[messageKey("new-work")].delivery, "pending");
  assert.equal(Object.keys(persisted).length, MAX_PINNED_REPLY_ENTRIES + 1);
});

test("closing a 65th reply evicts only the oldest closed entry and preserves started and uncertain work", async t => {
  const { root, store } = fixture(t);
  const workspace = await store.forChat(ACCOUNT, CHAT);
  const journal: ReplyJournal = Object.fromEntries(Array.from({ length: MAX_CLOSED_REPLY_ENTRIES }, (_, index) => [
    messageKey(`closed-${index}`), seeded("completed", index % 2 ? "accepted" : "expired"),
  ]));
  journal[messageKey("started")] = seeded("started", "pending", "frozen unknown result");
  journal[messageKey("uncertain")] = seeded("completed", "uncertain", "uncertain original");
  journal[messageKey("closing-now")] = seeded("completed", "pending");
  workspace.setReplyJournal(journal);
  const sdk = fakeSdk();
  const engine = new CodexReplyEngine(options(root, sdk.sdkFactory));
  await engine.ackReply(ACCOUNT, CHAT, "closing-now", "accepted");
  const persisted = workspace.getReplyJournal();
  assert.equal(persisted[messageKey("closed-0")], undefined);
  for (const id of ["started", "uncertain"]) assert.deepEqual(persisted[messageKey(id)], journal[messageKey(id)]);
  assert.equal(Object.keys(persisted).length, MAX_CLOSED_REPLY_ENTRIES + 2);
  assert.equal(persisted[messageKey("closing-now")].delivery, "accepted");
  await engine.ackReply(ACCOUNT, CHAT, "closed-0", "expired");
  assert.deepEqual(workspace.getReplyJournal(), persisted, "repeated receipt for pruned expired work is a no-op");
  await engine.ackReply(ACCOUNT, CHAT, "uncertain", "accepted");
  assert.equal(workspace.getReplyJournal()[messageKey("uncertain")].delivery, "uncertain", "first terminal receipt wins");
  assert.equal(sdk.calls(), 0);
});

test("worst-case byte reservation near 16 MiB evicts closed replies and keeps every pinned reply", async t => {
  const { root, store } = fixture(t);
  const workspace = await store.forChat(ACCOUNT, CHAT);
  const reply = { text: "\u0000".repeat(16000), commandId: "x" + "\u0000".repeat(4095) };
  const journal: ReplyJournal = Object.fromEntries(Array.from({ length: MAX_PINNED_REPLY_ENTRIES - 1 }, (_, index) => [
    messageKey(`pinned-${index}`), { ...seeded(index % 2 ? "started" : "completed", index % 2 ? "pending" : "uncertain"), reply },
  ]));
  const closedIds: string[] = [];
  for (let index = 0; index < MAX_CLOSED_REPLY_ENTRIES; index++) {
    const id = `closed-${index}`;
    journal[messageKey(id)] = { ...seeded("completed", "accepted"), reply };
    if (Buffer.byteLength(JSON.stringify(journal) + "\n") > MAX_REPLY_JOURNAL_BYTES) {
      delete journal[messageKey(id)];
      break;
    }
    closedIds.push(id);
  }
  const sizeBefore = Buffer.byteLength(JSON.stringify(journal) + "\n");
  assert.ok(closedIds.length > 0);
  assert.ok(sizeBefore + MAX_REPLY_ENTRY_BYTES + 128 > MAX_REPLY_JOURNAL_BYTES, "next response needs byte reservation");
  workspace.setReplyJournal(journal);
  const sdk = fakeSdk();
  const engine = new CodexReplyEngine(options(root, sdk.sdkFactory));
  await engine.reply(ACCOUNT, { chatId: CHAT, messageId: "reserved-new", text: "执行新任务" }, noController);
  const persisted = workspace.getReplyJournal();
  const removed = Object.keys(journal).filter(key => !persisted[key]);
  assert.ok(removed.length > 0);
  assert.ok(removed.every(key => closedIds.some(id => messageKey(id) === key)));
  for (const [key, entry] of Object.entries(journal)) {
    if (entry.delivery !== "accepted") assert.deepEqual(persisted[key], entry);
  }
  assert.equal(persisted[messageKey("reserved-new")].stage, "completed");
  assert.ok(Buffer.byteLength(JSON.stringify(persisted) + "\n") <= MAX_REPLY_JOURNAL_BYTES);
  assert.equal(sdk.calls(), 1);
});

test("missing, uncertain and expired replies never GET or create a workspace; accepted replies remain readable", async t => {
  const { root, temporary, store } = fixture(t);
  const sdk = fakeSdk();
  const engine = new CodexReplyEngine(options(root, sdk.sdkFactory));
  let gets = 0;
  const controller = { getMessageReply: async () => { gets++; return { text: "controller original", commandId: "cmd" }; } };
  await assert.rejects(engine.getReply(ACCOUNT, CHAT, "missing", controller), ReplyEngineUnavailableError);
  assert.deepEqual(fs.readdirSync(temporary), []);
  const workspace = await store.forChat(ACCOUNT, CHAT);
  workspace.setReplyJournal({
    [messageKey("uncertain")]: { ...seeded("completed", "uncertain"), provenance: "controller-console" },
    [messageKey("expired")]: { ...seeded("completed", "expired"), provenance: "controller-console" },
    [messageKey("accepted")]: seeded("completed", "accepted", "accepted original"),
    [messageKey("console-accepted")]: { ...seeded("completed", "accepted"), provenance: "controller-console" },
  });
  for (const id of ["missing", "uncertain", "expired"]) {
    await assert.rejects(engine.getReply(ACCOUNT, CHAT, id, controller), ReplyEngineUnavailableError);
  }
  assert.deepEqual(await engine.getReply(ACCOUNT, CHAT, "accepted", controller), { text: "accepted original" });
  assert.equal(gets, 0);
  assert.deepEqual(await engine.getReply(ACCOUNT, CHAT, "console-accepted", controller), { text: "controller original", commandId: "cmd" });
  assert.equal(gets, 1);
  assert.equal(sdk.calls(), 0);
});

test("all missing terminal receipts are idempotent no-ops without workspace or journal creation", async t => {
  const { root, temporary, store } = fixture(t);
  const sdk = fakeSdk();
  const engine = new CodexReplyEngine(options(root, sdk.sdkFactory));
  for (const status of ["accepted", "uncertain", "expired"] as const) {
    for (let repeat = 0; repeat < 2; repeat++) await engine.ackReply(ACCOUNT, CHAT, "missing", status);
  }
  assert.deepEqual(fs.readdirSync(temporary), []);
  const workspace = await store.forChat(ACCOUNT, CHAT);
  for (const status of ["accepted", "uncertain", "expired"] as const) {
    for (let repeat = 0; repeat < 2; repeat++) await engine.ackReply(ACCOUNT, CHAT, "missing", status);
  }
  assert.equal(fs.existsSync(path.join(workspace.workspacePath, ".replies.json")), false);
  assert.equal(sdk.calls(), 0);
});
