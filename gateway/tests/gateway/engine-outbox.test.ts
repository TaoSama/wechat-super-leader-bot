import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { CodexOptions, ThreadEvent } from "@openai/codex-sdk";
import { CodexReplyEngine, type CodexReplyEngineOptions } from "../../src/leader/codex.js";
import { LeaderWorkspace, WorkspaceStore, type ReplyJournal } from "../../src/leader/workspace.js";
import { CONTROL_TOKEN_ENV } from "../../src/leader/control-mcp.js";
import { ReplyEngineBackpressureError, ReplyEngineUnavailableError, type GatewayReplyEngine } from "../../src/leader/contracts.js";
import { StateManager } from "../../src/runtime/state.js";
import { ControllerClient } from "../../src/controller/client.js";
import { ILinkClient } from "../../src/wechat/client.js";
import { WeChatGateway } from "../../src/gateway.js";

const ACCOUNT = "synthetic-account";
const CHAT = "synthetic-chat";
const MESSAGE = "synthetic-message";
const REQUEST = "请记住本轮结果，等待继续";
const CONTROLLER_DRAFT = "controller intermediate result";
const FINAL_TEXT = "SDK 最终原文：保留换行\n与标点。";
const usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
  output_tokens: 0, reasoning_output_tokens: 0 };

function fixture(t: TestContext, tool = false, sendBudget = 1) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "engine-outbox-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const credentials = path.join(root, "account.json"), statePath = path.join(root, "state.json");
  const leaderRoot = path.join(root, "leader");
  fs.writeFileSync(credentials, JSON.stringify({ accountId: ACCOUNT, token: "synthetic-token" }));
  const counts = { models: 0, controllerPosts: 0, controllerGets: 0 };
  const sends: string[] = [];
  let mailboxOpen = true;
  const sdkFactory: NonNullable<CodexReplyEngineOptions["sdkFactory"]> = sdk => {
    const runner = { runStreamed: async () => ({ events: run(sdk) }) };
    return { startThread: () => runner, resumeThread: () => runner };
  };
  async function* run(sdk: CodexOptions): AsyncIterable<ThreadEvent> {
    counts.models++;
    yield { type: "thread.started", thread_id: "synthetic-thread" };
    if (tool) {
      const servers = sdk.config!.mcp_servers as Record<string, Record<string, string>>;
      const response = await fetch(servers.wechat_control.url, { method: "POST", headers: {
        Authorization: `Bearer ${sdk.env![CONTROL_TOKEN_ENV]}`, "Content-Type": "application/json",
        Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1,
        method: "tools/call", params: { name: "control_current_request", arguments: {} } }) });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /controller intermediate result/);
    }
    yield { type: "item.completed", item: { type: "agent_message", id: "final", text: FINAL_TEXT } };
    yield { type: "turn.completed", usage };
  }
  const engine = () => new CodexReplyEngine({ root: leaderRoot, model: "synthetic-model", sdkFactory });
  const state = (budget = sendBudget) => new StateManager(credentials, statePath, { sendBudget: budget });
  const controller = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic-token",
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/chats/authorize") return Response.json({ allowed: true });
      if (init?.method === "GET") { counts.controllerGets++; return Response.json({ text: "WRONG Controller recovery text" }); }
      assert.equal(url.pathname, "/v1/messages");
      counts.controllerPosts++;
      assert.deepEqual(JSON.parse(String(init?.body)), { chatId: CHAT, messageId: MESSAGE, text: REQUEST });
      return Response.json({ text: CONTROLLER_DRAFT });
    } });
  const gateway = (current: StateManager, replyEngine: GatewayReplyEngine | undefined = engine(), splitMaxChars = 3) => {
    const ilink = new ILinkClient({ stateManager: current, configuredBaseUrl: "https://synthetic.invalid",
      fetchImpl: async (input, init) => {
        const route = new URL(String(input)).pathname;
        if (route.endsWith("getupdates")) return Response.json({ ret: 0, get_updates_buf: "cursor-after-message",
          msgs: mailboxOpen ? [{ message_type: 1, from_user_id: CHAT, client_id: MESSAGE,
            create_time_ms: Date.now() - 1000, context_token: "synthetic-context", item_list: [{ type: 1, text_item: { text: REQUEST } }] }] : [] });
        if (route.endsWith("getconfig")) return Response.json({ ret: 0, typing_ticket: "synthetic-ticket" });
        if (route.endsWith("sendtyping")) return Response.json({ ret: 0 });
        assert.ok(route.endsWith("sendmessage"));
        const body = JSON.parse(String(init?.body)) as { msg: { to_user_id: string; item_list: { text_item: { text: string } }[] } };
        assert.equal(body.msg.to_user_id, CHAT);
        sends.push(body.msg.item_list.map(item => item.text_item.text).join(""));
        return Response.json({ ret: 0 });
      } });
    return new WeChatGateway({ stateManager: current, controller, ilink, replyEngine, splitMaxChars });
  };
  const start = state();
  start.markBaselineEstablished();
  const key = start.computeDeliveryKey(CHAT, MESSAGE);
  const refresh = (current: StateManager) => {
    mailboxOpen = false;
    assert.equal(current.recordInboundContext("synthetic-budget-refresh", CHAT, Date.now(), true, "fresh-context"), true);
  };
  const workspace = () => new WorkspaceStore(leaderRoot).forChat(ACCOUNT, CHAT);
  const journal = async () => (await workspace()).getReplyJournal();
  return { start, state, gateway, engine, refresh, counts, sends, key, statePath, journal, workspace };
}

for (const remainsFull of [false, true]) {
  test(`engine journal backpressure drains an old reply and ${remainsFull ? "retains cursor after one retry" : "retries new inbound once"}`, async t => {
    const f = fixture(t, false, 4);
    f.start.commitCursor("cursor-before-backpressure");
    f.start.recordInboundContext("old-window", CHAT, Date.now() - 2000, true, "old-context");
    for (let count = 0; count < 4; count++) f.start.consumeSendBudget(CHAT);
    const oldKey = f.start.computeDeliveryKey(CHAT, "old-0");
    for (let index = 0; index < 128; index++) {
      const chatId = index === 0 ? CHAT : `unfunded-chat-${index}`;
      f.start.putOutbox({ kind: "reply", source: "engine", chatId, messageId: `old-${index}`,
        deliveryKey: f.start.computeDeliveryKey(chatId, `old-${index}`), splitMaxChars: 100,
        splitMultiPart: true, status: "pending" });
    }
    assert.equal(f.start.policy.outboxLimit, 1000, "Gateway capacity must exceed the full engine journal");
    const operations: string[] = [];
    let replyCalls = 0;
    let released = false;
    const engine: GatewayReplyEngine = { requestBudgetMs: 1000,
      reply: async (_account, input) => {
        replyCalls++;
        operations.push(`reply-${replyCalls}`);
        assert.ok(replyCalls <= 2, "one poll must not loop indefinitely while the engine remains full");
        assert.equal(input.messageId, MESSAGE);
        if (replyCalls === 1) {
          assert.equal(Object.keys(f.start.outbox).length, 128);
          throw new ReplyEngineBackpressureError();
        }
        assert.equal(released, true, "old receipt must release engine capacity before retrying the new request");
        if (remainsFull) throw new ReplyEngineBackpressureError();
        return { text: "new reply" };
      },
      getReply: async (_account, chat, messageId) => {
        operations.push(`get-${messageId}`);
        assert.equal(chat, CHAT);
        assert.equal(messageId, "old-0");
        return { text: "old reply" };
      },
      ackReply: async (_account, _chat, messageId, status) => {
        operations.push(`ack-${messageId}`);
        assert.equal(status, "accepted");
        if (messageId === "old-0") released = true;
      },
    };
    const gateway = f.gateway(f.start, engine, 100);
    if (remainsFull) {
      await assert.rejects(gateway.pollOnce(), ReplyEngineBackpressureError);
      assert.equal(f.start.syncBuf, "cursor-before-backpressure");
      assert.equal(f.start.isMessageProcessed(f.key), false);
      assert.deepEqual(f.sends, ["old reply"]);
      assert.deepEqual(operations, ["reply-1", "get-old-0", "ack-old-0", "reply-2"]);
    } else {
      const result = await gateway.pollOnce();
      assert.equal(result.processedCount, 1);
      assert.equal(f.start.syncBuf, "cursor-after-message");
      assert.equal(f.start.isMessageProcessed(f.key), true);
      assert.deepEqual(f.sends, ["old reply", "new reply"]);
      assert.deepEqual(operations, ["reply-1", "get-old-0", "ack-old-0", "reply-2", `ack-${MESSAGE}`]);
    }
    assert.equal(replyCalls, 2);
    assert.equal(f.start.outbox[oldKey], undefined);
    assert.equal(Object.keys(f.start.outbox).length, 127);
    assert.deepEqual(f.counts, { models: 0, controllerPosts: 0, controllerGets: 0 });
  });
}

for (const tool of [false, true]) {
  test(`${tool ? "tool-backed" : "pure chat"} engine outbox resumes SDK final text after budget exhaustion and process restart`, async t => {
    const f = fixture(t, tool);
    await f.gateway(f.start).pollOnce();
    assert.equal(f.counts.models, 1);
    assert.deepEqual(f.sends, [FINAL_TEXT.slice(0, 3)]);
    assert.equal(f.start.outbox[f.key].source, "engine");
    assert.equal(f.start.outbox[f.key].status, "pending");
    assert.equal(f.start.replyDeliveries[f.key].acknowledgedChunks, 1);
    assert.equal(Object.values(await f.journal())[0].delivery, "pending");
    assert.equal(fs.readFileSync(f.statePath, "utf8").includes(FINAL_TEXT), false);
    const restarted = f.state(100);
    f.refresh(restarted);
    await f.gateway(restarted, f.engine(), 1).flushRepliesOnce();
    assert.equal(f.sends.join(""), FINAL_TEXT, "restart must preserve SDK final text, not Controller draft or changed chunk size");
    assert.equal(restarted.outbox[f.key], undefined);
    assert.equal(Object.values(await f.journal())[0].delivery, "accepted");
    assert.deepEqual(f.counts, { models: 1, controllerPosts: tool ? 1 : 0, controllerGets: 0 });
    await f.gateway(f.state(100)).pollOnce();
    assert.equal(f.sends.join(""), FINAL_TEXT);
    assert.equal(f.counts.models, 1);
  });
}

test("pending engine reply fails safely when engine is disabled, without Controller fallback or new sends", async t => {
  const f = fixture(t);
  await f.gateway(f.start).pollOnce();
  const restarted = f.state(100);
  f.refresh(restarted);
  // Passing undefined would activate the fixture default engine; construct the disabled Gateway explicitly.
  const enabled = f.gateway(restarted);
  const disabled = new WeChatGateway({ stateManager: restarted, controller: enabled.controller, ilink: enabled.ilink });
  await assert.rejects(disabled.flushRepliesOnce(), ReplyEngineUnavailableError);
  assert.equal(restarted.outbox[f.key].source, "engine");
  assert.equal(restarted.outbox[f.key].status, "pending");
  assert.deepEqual(f.sends, [FINAL_TEXT.slice(0, 3)]);
  assert.deepEqual(f.counts, { models: 1, controllerPosts: 0, controllerGets: 0 });
});

for (const fault of ["ack-save", "outbox-remove"] as const) {
  test(`${fault} failure after final receipt is recovered without repeating model or WeChat send`, async t => {
    const f = fixture(t, true, 100);
    let injected = false;
    if (fault === "ack-save") {
      const save = LeaderWorkspace.prototype.setReplyJournal;
      t.mock.method(LeaderWorkspace.prototype, "setReplyJournal", function (this: LeaderWorkspace, journal: ReplyJournal) {
        if (!injected && Object.values(journal).some(entry => entry.delivery === "accepted")) {
          injected = true;
          throw new Error("synthetic ack persistence failure");
        }
        save.call(this, journal);
      });
    } else {
      const remove = f.start.removeOutbox.bind(f.start);
      t.mock.method(f.start, "removeOutbox", (key: string) => {
        if (!injected && key === f.key) { injected = true; throw new Error("synthetic outbox cleanup failure"); }
        remove(key);
      });
    }
    await assert.rejects(f.gateway(f.start, f.engine(), 100).pollOnce(), /synthetic (ack persistence|outbox cleanup) failure/);
    assert.equal(injected, true);
    assert.deepEqual(f.sends, [FINAL_TEXT]);
    assert.equal(f.start.outbox[f.key].status, "receipt");
    assert.equal(f.start.outbox[f.key].receiptStatus, "accepted");
    const text = f.start.replyDeliveries[f.key];
    assert.equal(text.acknowledgedChunks, text.totalChunks);
    assert.equal(text.inFlight, false);
    const restarted = f.state(100);
    await f.gateway(restarted).pollOnce();
    assert.equal(restarted.outbox[f.key], undefined);
    assert.equal(Object.values(await f.journal())[0].delivery, "accepted");
    assert.deepEqual(f.sends, [FINAL_TEXT]);
    assert.deepEqual(f.counts, { models: 1, controllerPosts: 1, controllerGets: 0 });
  });
}

test("accepted empty reply receipt survives journal pruning and restart without retrieval or sends", async t => {
  const f = fixture(t, false, 100);
  const workspace = await f.workspace();
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  workspace.setReplyJournal({ [hash(MESSAGE)]: { inputHash: hash(REQUEST), stage: "completed",
    delivery: "pending", reply: { text: "" } } });
  t.mock.method(f.start, "removeOutbox", () => { throw new Error("synthetic empty receipt cleanup failure"); });
  await assert.rejects(f.gateway(f.start).pollOnce(), /empty receipt cleanup failure/);
  assert.equal(f.start.outbox[f.key].status, "receipt");
  assert.equal(f.start.outbox[f.key].receiptStatus, "accepted");
  assert.equal(f.start.replyDeliveries[f.key], undefined, "empty reply has no text chunk receipt");
  assert.equal(Object.values(await f.journal())[0].delivery, "accepted");
  workspace.setReplyJournal({}); // Closed accepted entries may be pruned before Gateway reference cleanup.
  const restarted = f.state(100);
  const engine = f.engine();
  t.mock.method(engine, "getReply", async () => { assert.fail("accepted receipt must not retrieve a pruned response"); });
  await f.gateway(restarted, engine).pollOnce();
  assert.equal(restarted.outbox[f.key], undefined);
  assert.equal(restarted.syncBuf, "cursor-after-message");
  assert.deepEqual(f.sends, []);
  assert.deepEqual(f.counts, { models: 0, controllerPosts: 0, controllerGets: 0 });
});
