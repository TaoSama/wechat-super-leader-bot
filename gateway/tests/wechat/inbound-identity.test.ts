import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ILinkClient } from "../../src/wechat/client.js";
import { StateManager } from "../../src/runtime/state.js";

const ACCOUNT_ID = "identity-fixture";
const SERVER_ID = "18446744073709551615";
const INITIAL_CURSOR = "cursor-initial";
const NEXT_CURSOR = "cursor-next";
const FIXTURE_URL = "https://ilink.invalid/ilink/bot/getupdates";

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-inbound-identity-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const accountPath = path.join(directory, "account.json");
  const statePath = path.join(directory, "state.json");
  fs.writeFileSync(accountPath, JSON.stringify({ token: "synthetic-token", accountId: ACCOUNT_ID }));
  const loadState = () => new StateManager(accountPath, statePath);
  return { state: loadState(), statePath, loadState };
}

function textMessage(fields: Record<string, unknown> = {}) {
  return { message_type: 1, from_user_id: "chat-a", create_time_ms: 1_800_000_000_000,
    item_list: [{ type: 1, text_item: { text: "same command" } }], ...fields };
}

function client(state: StateManager, fetchImpl: typeof fetch) {
  return new ILinkClient({ stateManager: state, configuredBaseUrl: "https://ilink.invalid", fetchImpl });
}

for (const encoding of ["string", "integer"] as const) {
  test(`server ${encoding} ID deduplicates a moved replay after restart and stays isolated by chat`, async t => {
    const f = fixture(t);
    f.state.commitCursor(INITIAL_CURSOR);
    const wireMessage = (chatId: string) => {
      const serialized = JSON.stringify(textMessage({ message_id: SERVER_ID, from_user_id: chatId }));
      return encoding === "integer"
        ? serialized.replace(`"message_id":"${SERVER_ID}"`, `"message_id":${SERVER_ID}`)
        : serialized;
    };
    const cursors: string[] = [];
    const poll = (state: StateManager, messages: string[], nextCursor: string) => client(state, async (url, init) => {
      assert.equal(String(url), FIXTURE_URL);
      cursors.push(JSON.parse(String(init?.body)).get_updates_buf);
      return new Response(`{"ret":0,"get_updates_buf":${JSON.stringify(nextCursor)},"msgs":[${messages.join(",")}]}`);
    }).pollBatch();

    const original = await poll(f.state, [wireMessage("chat-a")], NEXT_CURSOR);
    assert.equal(original.messages.length, 1);
    assert.equal(original.messages[0].messageId, `server:${SERVER_ID}`);
    const originalKey = original.messages[0].deliveryKey!;
    assert.equal(originalKey, JSON.stringify([ACCOUNT_ID, "chat-a", `server:${SERVER_ID}`]));
    f.state.recordProcessedMessageKey(originalKey);
    f.state.commitCursor(original.nextSyncBuf);

    const reloaded = f.loadState();
    const replay = await poll(reloaded, ['{"message_type":2}', wireMessage("chat-b"), wireMessage("chat-a")], "cursor-last");
    assert.deepEqual(replay.messages.map(message => [message.chatId, message.messageId]), [["chat-b", `server:${SERVER_ID}`]]);
    assert.notEqual(replay.messages[0].deliveryKey, originalKey);
    reloaded.recordProcessedMessageKey(replay.messages[0].deliveryKey!);
    reloaded.commitCursor(replay.nextSyncBuf);

    assert.equal((await poll(f.loadState(), [wireMessage("chat-a"), wireMessage("chat-b")], "cursor-empty")).messages.length, 0);
    assert.deepEqual(cursors, [INITIAL_CURSOR, NEXT_CURSOR, "cursor-last"]);
  });
}

test("old processed-message checkpoints retain client identities when a server ID is now present", async t => {
  const f = fixture(t);
  const processedKeys = ["legacy-client", "0", "server:123"].map(id => JSON.stringify([ACCOUNT_ID, "chat-a", id]));
  const checkpoint = { sync_buf: INITIAL_CURSOR, context_tokens: { "chat-a": "synthetic-context" },
    processed_message_keys: processedKeys };
  fs.writeFileSync(f.statePath, JSON.stringify(checkpoint));
  const restored = f.loadState();
  const updates = { ret: 0, get_updates_buf: NEXT_CURSOR, msgs: [
    textMessage({ client_id: "legacy-client", message_id: SERVER_ID }),
    textMessage({ client_id: 0, message_id: "999" }),
    textMessage({ message_id: 123 }),
    textMessage({ client_id: "new-client", message_id: "456" }),
  ] };
  const incoming = await client(restored, async (url, init) => {
    assert.equal(String(url), FIXTURE_URL);
    assert.equal(JSON.parse(String(init?.body)).get_updates_buf, INITIAL_CURSOR);
    return Response.json(updates);
  }).pollBatch();

  assert.deepEqual(incoming.messages.map(message => message.messageId), ["new-client"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.statePath, "utf8")), checkpoint, "polling does not rewrite a legacy checkpoint");
  restored.commitCursor(incoming.nextSyncBuf);
  const reloaded = f.loadState();
  assert.deepEqual(reloaded.processedMessageKeys, processedKeys);
  assert.equal(reloaded.syncBuf, NEXT_CURSOR);
  assert.equal(reloaded.contextTokens["chat-a"], "synthetic-context");
});

test("messages without stable IDs preserve distinct commands and deduplicate only the same page position", async t => {
  const f = fixture(t);
  f.state.commitCursor(INITIAL_CURSOR);
  const updates = { ret: 0, get_updates_buf: NEXT_CURSOR, msgs: [textMessage(), textMessage()] };
  const poll = (state: StateManager) => client(state, async url => {
    assert.equal(String(url), FIXTURE_URL);
    return Response.json(updates);
  }).pollBatch();

  const original = await poll(f.state);
  assert.equal(original.messages.length, 2);
  assert.notEqual(original.messages[0].messageId, original.messages[1].messageId);
  assert.ok(original.messages.every(message => message.messageId.startsWith("det:")));
  assert.deepEqual((await poll(f.loadState())).messages, original.messages);
  f.state.recordProcessedMessageKey(original.messages[0].deliveryKey!);
  assert.deepEqual((await poll(f.state)).messages, [original.messages[1]]);

  f.state.commitCursor(original.nextSyncBuf);
  const anotherPage = await poll(f.loadState());
  assert.equal(anotherPage.messages.length, 2, "equal text alone cannot prove that another page is a redelivery");
  assert.ok(anotherPage.messages.every(message => !original.messages.some(previous => previous.messageId === message.messageId)));
});
