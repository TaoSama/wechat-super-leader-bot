import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ILinkClient } from "../../src/wechat/client.js";
import { StateManager } from "../../src/runtime/state.js";
import { ControllerClient } from "../../src/controller/client.js";
import { WeChatGateway } from "../../src/gateway.js";
import { HealthTracker, checkGatewayHealth } from "../../src/runtime/health.js";
import { CHECKPOINT_MARGIN_MS, DEFAULT_POLL_TIMEOUT_MS, MAX_POLL_TIMEOUT_MS,
  POLL_NETWORK_MARGIN_MS } from "../../src/runtime/budgets.js";

function state(): StateManager {
  return { account: { token: "synthetic-token", accountId: "fixture" }, syncBuf: "saved-cursor",
    consumeSendBudget: () => {} } as unknown as StateManager;
}

test("server long-poll hints update only the next HTTP timeout and include network margin", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let pendingSignal: AbortSignal | undefined;
  const client = new ILinkClient({ stateManager: state(), fetchImpl: async (_url, init) => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ ret: 0, longpolling_timeout_ms: 60000 }));
    pendingSignal = init?.signal ?? undefined;
    return new Promise<Response>(() => {});
  } });
  assert.equal(client.pollBudgetMs, DEFAULT_POLL_TIMEOUT_MS + POLL_NETWORK_MARGIN_MS);
  await client.pollBatch();
  assert.equal(client.pollBudgetMs, 60000 + POLL_NETWORK_MARGIN_MS);
  const pending = client.pollBatch();
  const rejected = assert.rejects(pending, { name: "AbortError" });
  t.mock.timers.tick(60000 + POLL_NETWORK_MARGIN_MS - 1);
  assert.equal(pendingSignal?.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(pendingSignal?.aborted, true);
});

test("invalid and unbounded server hints keep the last usable poll timeout", async () => {
  const hints: unknown[] = [60000, undefined, null, 0, -1, 1.5, "35000", {}, [],
    MAX_POLL_TIMEOUT_MS + 1, Number.MAX_SAFE_INTEGER, MAX_POLL_TIMEOUT_MS];
  const client = new ILinkClient({ stateManager: state(), pollTimeoutMs: 15000,
    fetchImpl: async () => new Response(JSON.stringify({ ret: 0, longpolling_timeout_ms: hints.shift() })) });
  while (hints.length > 1) {
    await client.pollBatch();
    assert.equal(client.pollBudgetMs, 60000 + POLL_NETWORK_MARGIN_MS);
  }
  await client.pollBatch();
  assert.equal(client.pollBudgetMs, MAX_POLL_TIMEOUT_MS + POLL_NETWORK_MARGIN_MS);
});

for (const codeField of ["ret", "errcode"] as const) {
  test(`expired-account ${codeField}=-14 never clears the cursor or retries`, async () => {
    const sm = state();
    let calls = 0;
    const client = new ILinkClient({ stateManager: sm, fetchImpl: async (_url, init) => {
      calls++;
      assert.equal(JSON.parse(String(init?.body)).get_updates_buf, "saved-cursor");
      return new Response(JSON.stringify({ [codeField]: -14, errmsg: "session timeout",
        longpolling_timeout_ms: MAX_POLL_TIMEOUT_MS }));
    } });
    await assert.rejects(client.pollBatch(), /WeChat getupdates failed/);
    assert.equal(calls, 1);
    assert.equal(sm.syncBuf, "saved-cursor");
    assert.equal(client.pollBudgetMs, DEFAULT_POLL_TIMEOUT_MS + POLL_NETWORK_MARGIN_MS);
  });
}

test("poll carries timestamps without treating malformed values as fresh context", async () => {
  const sm = state();
  sm.computeDeliveryKey = (_chat, id) => id;
  sm.isMessageProcessed = () => false;
  const values: unknown[] = [undefined, 1_800_000_000_000, "1800000000001", 0,
    -1, "", "NaN", "1.5", {}, Number.MAX_SAFE_INTEGER + 1];
  const client = new ILinkClient({ stateManager: sm, fetchImpl: async () => Response.json({
    ret: 0, msgs: values.map((value, index) => ({ message_type: 1, from_user_id: "chat",
      client_id: String(index), ...(value !== undefined ? { create_time_ms: value } : {}),
      context_token: "new-context", item_list: [{ type: 1, text_item: { text: "body" } }] })),
  }) });
  const { messages } = await client.pollBatch();
  assert.equal(messages[0].createdAtMs, undefined);
  assert.deepEqual(messages.slice(1, 4).map(message => message.createdAtMs), [1_800_000_000_000, 1_800_000_000_001, 0]);
  assert.ok(messages.slice(4).every(message => Number.isNaN(message.createdAtMs)));
  assert.ok(messages.every(message => message.contextToken === "new-context"));
  assert.equal(sm.contextTokens, undefined, "polling does not mutate context before authorization and durable dedup");
});

test("health accepts the maximum hinted poll plus network and checkpoint margins", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-18T00:00:00Z") });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-poll-budget-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const healthPath = path.join(directory, "health.json");
  const tracker = new HealthTracker(healthPath);
  tracker.startRun();
  const budget = MAX_POLL_TIMEOUT_MS + POLL_NETWORK_MARGIN_MS + CHECKPOINT_MARGIN_MS;
  tracker.recordPollStart(budget);
  t.mock.timers.tick(budget);
  assert.equal(checkGatewayHealth(healthPath, 1000).ok, true);
  t.mock.timers.tick(1);
  assert.equal(checkGatewayHealth(healthPath, 1000).reason, "ProcessingDeadlineExceeded");
});

for (const raw of ["", " \n\t "]) {
  test("empty HTTP 200 send body remains explicitly unknown", async () => {
    const sm = state();
    sm.contextTokens = { chat: "synthetic-context" };
    const client = new ILinkClient({ stateManager: sm, fetchImpl: async () => new Response(raw) });
    await assert.rejects(client.sendSingleText("chat", "body"), { reason: "EmptyResponse" });
  });
}

test("inbound identity preserves client IDs and distinguishes adjacent lossless uint64 server IDs", async () => {
  const sm = state();
  sm.computeDeliveryKey = (chat, id) => `${chat}:${id}`;
  sm.isMessageProcessed = () => false;
  const serverIds = ["18446744073709551614", "18446744073709551615"];
  const messages = serverIds.map(id => `{"message_type":1,"message_id":${id},"from_user_id":"chat",` +
    '"item_list":[{"type":1,"text_item":{"text":"body"}}]}');
  messages.push('{"message_type":1,"message_id":18446744073709551615,"client_id":"existing-client",' +
    '"from_user_id":"chat","item_list":[{"type":1,"text_item":{"text":"body"}}]}');
  const client = new ILinkClient({ stateManager: sm,
    fetchImpl: async () => new Response(`{"ret":0,"msgs":[${messages.join(",")}]}`) });
  const batch = await client.pollBatch();
  assert.deepEqual(batch.messages.map(message => message.messageId), [...serverIds.map(id => `server:${id}`), "existing-client"]);
  assert.equal(new Set(batch.messages.map(message => message.deliveryKey)).size, 3);
});

test("server-only inbound replay across cursor, index and restart never forwards or replenishes budget twice", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-server-id-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const accountPath = path.join(directory, "account.json"), statePath = path.join(directory, "state.json");
  fs.writeFileSync(accountPath, JSON.stringify({ token: "synthetic-token", accountId: "fixture" }));
  let pollCount = 0, forwardCount = 0, sends = 0;
  const cursors: string[] = [];
  const inbound = { message_type: 1, message_id: "18446744073709551615", from_user_id: "chat",
    create_time_ms: Date.now() - 1000, context_token: "synthetic-context",
    item_list: [{ type: 1, text_item: { text: "same original text" } }] };
  const fetchImpl: typeof fetch = async (url, init) => {
    if (String(url).endsWith("getupdates")) {
      cursors.push(JSON.parse(String(init?.body)).get_updates_buf);
      pollCount++;
      return Response.json({ ret: 0, get_updates_buf: `cursor-${pollCount}`,
        msgs: pollCount === 1 ? [inbound] : [{ message_type: 2 }, inbound] });
    }
    if (String(url).endsWith("getconfig")) return Response.json({ ret: 0, typing_ticket: "synthetic-ticket" });
    if (String(url).endsWith("sendtyping")) return Response.json({ ret: 0 });
    assert.ok(String(url).endsWith("sendmessage"));
    sends++;
    return Response.json({ ret: 0 });
  };
  const controller = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic",
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/v1/chats/authorize")) return Response.json({ allowed: true });
      assert.equal(init?.method, "POST");
      assert.ok(String(url).endsWith("/v1/messages"));
      assert.equal(JSON.parse(String(init?.body)).messageId, `server:${inbound.message_id}`);
      forwardCount++;
      return Response.json({ text: "reply" });
    } });
  const original = new StateManager(accountPath, statePath);
  original.markBaselineEstablished();
  original.commitCursor("cursor-initial");
  const makeGateway = (sm: StateManager) => new WeChatGateway({ stateManager: sm, controller,
    ilink: new ILinkClient({ stateManager: sm, fetchImpl }) });
  assert.equal((await makeGateway(original).pollOnce()).processedCount, 1);
  assert.equal(original.contextBudgets.chat.remaining, 9);
  original.consumeSendBudget("chat");
  const reloaded = new StateManager(accountPath, statePath);
  assert.equal((await makeGateway(reloaded).pollOnce()).polledCount, 0);
  assert.deepEqual(cursors, ["cursor-initial", "cursor-1"]);
  assert.equal(forwardCount, 1);
  assert.equal(sends, 1);
  assert.equal(reloaded.contextBudgets.chat.remaining, 8);
  assert.equal(reloaded.inboundWatermarks.chat.keys.length, 1);
  assert.equal(reloaded.syncBuf, "cursor-2");
});
