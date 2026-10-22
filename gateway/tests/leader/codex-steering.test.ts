import { test, type TestContext } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CodexOptions, ThreadEvent } from "@openai/codex-sdk";
import { CodexReplyEngine, type CodexReplyEngineOptions } from "../../src/leader/codex.js";
import { AppServerRejectedError } from "../../src/leader/app-server.js";
import { ReplyEngineConflictError } from "../../src/leader/contracts.js";
import { WorkspaceStore } from "../../src/leader/workspace.js";
import { directToolController, TEST_TOOL_NAME } from "./direct-tool-fixture.js";
import { CONTROL_TOKEN_ENV } from "../../src/leader/control-mcp.js";

const initial = { chatId: "chat", messageId: "first", text: "先分析问题" };
const additional = { chatId: "chat", messageId: "second", text: "补充：也给出修复方案" };
const controller = directToolController(async () => ({ result: {}, reply: { text: "首条控制结果" } }));
const usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
  output_tokens: 0, reasoning_output_tokens: 0 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "codex-steer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const started = deferred<CodexOptions>();
  const finish = deferred<void>();
  const ready = deferred<void>();
  const calls: Array<{ text: string; expected: string }> = [];
  let rejection: Error | undefined;
  let beforeSteerReceipt: (() => Promise<void>) | undefined;
  let runs = 0;
  const appServerFactory: NonNullable<CodexReplyEngineOptions["appServerFactory"]> = async options => {
    runs++;
    started.resolve(options);
    await ready.promise;
    return { threadId: "thread-active", turnId: "turn-active", close: async () => undefined,
      steer: async (text, expected) => {
        calls.push({ text, expected });
        await beforeSteerReceipt?.();
        if (rejection) throw rejection;
      },
      events: (async function* (): AsyncIterable<ThreadEvent> {
        yield { type: "turn.started" };
        await finish.promise;
        yield { type: "item.completed", item: { type: "agent_message", id: "final", text: "结合补充后的最终回答" } };
        yield { type: "turn.completed", usage };
      })() };
  };
  const engine = new CodexReplyEngine({ root, model: "test", codexPath: process.execPath, appServerFactory });
  t.after(() => engine.stop());
  return { root, engine, started, finish, ready, calls, get runs() { return runs; },
    reject(error: Error) { rejection = error; },
    beforeReceipt(action: () => Promise<void>) { beforeSteerReceipt = action; } };
}

async function callTool(options: CodexOptions, name: string, args: object = {}) {
  const config = options.config!.mcp_servers as Record<string, Record<string, string>>;
  const response = await fetch(config.wechat_control.url, { method: "POST", headers: {
    Authorization: `Bearer ${options.env![CONTROL_TOKEN_ENV]}`, "Content-Type": "application/json",
    Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1,
      method: "tools/call", params: { name, arguments: name === "report_progress" ? args : { arguments: {}, ...args } } }) });
  assert.equal(response.status, 200);
  const body = await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
  if (body.result.isError) return { isError: true, text: body.result.content[0].text };
  return JSON.parse(body.result.content[0].text) as Record<string, unknown>;
}

test("new message waits for starting native turn and steers once with exact persisted turn identity", async t => {
  const f = fixture(t);
  const reply = f.engine.reply("account", initial, controller);
  await f.started.promise;
  let settled = false;
  const steer = f.engine.steer("account", additional, controller).then(result => { settled = true; return result; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(settled, false, "a query still starting must not become a second queued turn");
  f.ready.resolve();
  assert.equal(await steer, true);
  assert.equal(await f.engine.steer("account", additional, controller), true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].expected, "turn-active");
  assert.match(f.calls[0].text, /补充：也给出修复方案/);
  await assert.rejects(f.engine.steer("account", { ...additional, text: "conflicting body" }, controller), ReplyEngineConflictError);
  const workspace = await new WorkspaceStore(f.root).forChat("account", initial.chatId);
  const supplement = Object.values(workspace.getReplyJournal()).find(entry => entry.steering);
  assert.deepEqual(supplement?.steering, { rootMessageId: initial.messageId, threadId: "thread-active",
    turnId: "turn-active", status: "accepted" });
  assert.equal(supplement?.delivery, "accepted");
  f.finish.resolve();
  assert.deepEqual(await reply, { text: "结合补充后的最终回答" });
  assert.equal(f.runs, 1);
  assert.equal(Object.keys(workspace.getReplyJournal()).length, 2, "root outcome must preserve the appended journal record");
  const restarted = new CodexReplyEngine({ root: f.root, model: "test", codexPath: process.execPath });
  assert.equal(await restarted.steer("account", additional, controller), true, "restart must not resubmit accepted supplementation");
  assert.equal(await restarted.steer("account", { ...additional, messageId: "after-completion" }, controller), false);
});

test("accepting a supplement prunes closed history before crossing the durable journal limit", async t => {
  const f = fixture(t);
  const workspace = await new WorkspaceStore(f.root).forChat("account", initial.chatId);
  const journal = Object.fromEntries(Array.from({ length: 64 }, (_, index) => [
    createHash("sha256").update(`history-${index}`).digest("hex"),
    { inputHash: "a".repeat(64), stage: "completed" as const, delivery: "accepted" as const, reply: { text: "历史回复" } },
  ]));
  workspace.setReplyJournal(journal);
  const reply = f.engine.reply("account", initial, controller);
  await f.started.promise;
  f.ready.resolve();
  assert.equal(await f.engine.steer("account", additional, controller), true);
  assert.equal(Object.values(workspace.getReplyJournal()).filter(entry => entry.delivery === "accepted").length, 64);
  f.finish.resolve();
  assert.equal((await reply).text, "结合补充后的最终回答");
});

test("steered original authority reaches Controller and model final incorporates all messages", async t => {
  const f = fixture(t);
  const forwarded: string[] = [];
  const boundController = directToolController(async request => {
    forwarded.push(request.text); return { result: { text: `Controller:${request.text}` } };
  });
  const reply = f.engine.reply("account", initial, boundController);
  const options = await f.started.promise;
  f.ready.resolve();
  await callTool(options, TEST_TOOL_NAME);
  assert.equal(await f.engine.steer("account", additional, boundController), true);
  await callTool(options, TEST_TOOL_NAME, { requestMessageId: additional.messageId });
  assert.deepEqual(forwarded, [initial.text, additional.text]);
  f.finish.resolve();
  assert.equal((await reply).text, "结合补充后的最终回答", "an earlier Controller response must not overwrite the steered model answer");
});

for (const consoleReceipt of [false, true]) test(`a ${consoleReceipt ? "console" : "business"} receipt keeps later steered explanation without another tool`, async t => {
  const f = fixture(t);
  const receipt = { text: consoleReceipt ? "控制台：https://console.test/#login=private-steer-token" : "已保存任务，尚未确认执行完成。",
    commandId: "command-original", images: [{ id: "original-image", mime: "image/png" as const,
      size: 5, sha256: "b".repeat(64) }] };
  let calls = 0;
  const boundController = directToolController(async () => { calls++; return { result: {}, reply: receipt }; });
  const pendingReply = f.engine.reply("account", initial, boundController);
  const options = await f.started.promise;
  f.ready.resolve();
  await callTool(options, TEST_TOOL_NAME);
  assert.equal(await f.engine.steer("account", { ...additional, text: "补充：解释一下刚才的结果，无需再操作。" }, boundController), true);
  f.finish.resolve();
  const expected = { ...receipt, text: `结合补充后的最终回答\n\n${receipt.text}` };
  assert.deepEqual(await pendingReply, expected);
  assert.equal(calls, 1, "ordinary supplementation needs no additional business invocation");
  const workspace = await new WorkspaceStore(f.root).forChat("account", initial.chatId);
  assert.doesNotMatch(JSON.stringify(workspace.getReplyJournal()), /private-steer-token/);
  const restarted = new CodexReplyEngine({ root: f.root, model: "test", codexPath: process.execPath });
  assert.deepEqual(await restarted.getReply("account", initial.chatId, initial.messageId, {
    getMessageReply: async (chatId, messageId) => {
      assert.equal(consoleReceipt, true, "normal mixed replies recover from the Gateway journal");
      assert.equal(chatId, initial.chatId);
      assert.equal(messageId, initial.messageId, "the receipt keeps its original source across steering");
      return receipt;
    },
  }), expected);
});

test("Controller calls arriving before native steer acknowledgement wait for exact added authority", async t => {
  const f = fixture(t);
  const forwarded: string[] = [];
  const boundController = directToolController(async request => {
    forwarded.push(request.text); return { result: { text: `Controller:${request.text}` } };
  });
  const reply = f.engine.reply("account", initial, boundController);
  const options = await f.started.promise;
  f.ready.resolve();
  let earlyTool!: Promise<Record<string, unknown>>;
  f.beforeReceipt(async () => {
    earlyTool = callTool(options, TEST_TOOL_NAME, { requestMessageId: additional.messageId });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(forwarded, [], "unacknowledged supplementation must hold Controller selection");
  });
  assert.equal(await f.engine.steer("account", additional, boundController), true);
  await earlyTool;
  assert.equal(forwarded.length, 1, "pending messages must reach one Controller decision together");
  assert.ok(forwarded[0].includes(initial.text));
  assert.ok(forwarded[0].includes(additional.text));
  f.finish.resolve();
  await reply;
});

test("unknown steer acknowledgement cannot release a queued Controller call with stale original authority", async t => {
  const f = fixture(t);
  const forwarded: string[] = [];
  const boundController = directToolController(async request => {
    forwarded.push(request.text); return { result: { text: "Unexpected old dispatch" } };
  });
  const reply = f.engine.reply("account", initial, boundController);
  const options = await f.started.promise;
  f.ready.resolve();
  let earlyTool!: Promise<Record<string, unknown>>;
  f.beforeReceipt(async () => {
    earlyTool = callTool(options, TEST_TOOL_NAME, { requestMessageId: additional.messageId });
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  f.reject(new Error("acknowledgement lost"));
  assert.equal(await f.engine.steer("account", { ...additional, text: "取消之前的操作" }, boundController), true);
  assert.equal((await earlyTool).isError, true);
  assert.deepEqual(forwarded, []);
  f.finish.resolve();
  assert.match((await reply).text, /结果待核实/);
});

test("query progress remains a shared three-call allowance after successful steer", async t => {
  const f = fixture(t);
  const updates: string[] = [];
  const reply = f.engine.reply("account", initial, controller, { progress: async text => {
    updates.push(text); return { sent: true };
  } });
  const options = await f.started.promise;
  f.ready.resolve();
  assert.equal((await callTool(options, "report_progress", { text: "已核对问题来源" })).remaining, 2);
  assert.equal(await f.engine.steer("account", additional, controller), true);
  for (const [text, remaining] of [["已定位修改点", 1], ["正在验证修复", 0], ["超出本轮额度", 0]] as const) {
    assert.equal((await callTool(options, "report_progress", { text })).remaining, remaining);
  }
  assert.equal(updates.length, 3);
  f.finish.resolve();
  await reply;
});

test("console link produced by a steered message recovers by its original Controller message identity", async t => {
  const f = fixture(t);
  const consoleReply = { text: "https://console.test/#login=only-on-delivery" };
  const boundController = directToolController(async request => ({ result: {}, reply: request.messageId === additional.messageId
    ? consoleReply : { text: "已读取第一条" } }));
  const reply = f.engine.reply("account", initial, boundController);
  const options = await f.started.promise;
  f.ready.resolve();
  assert.equal(await f.engine.steer("account", additional, boundController), true);
  await callTool(options, TEST_TOOL_NAME, { requestMessageId: additional.messageId });
  f.finish.resolve();
  const expected = { text: `结合补充后的最终回答\n\n${consoleReply.text}` };
  assert.deepEqual(await reply, expected);
  const workspace = await new WorkspaceStore(f.root).forChat("account", initial.chatId);
  assert.doesNotMatch(JSON.stringify(workspace.getReplyJournal()), /only-on-delivery/);
  const frozen = await f.engine.getReply("account", initial.chatId, initial.messageId, {
    getMessageReply: async (chatId, messageId) => {
      assert.equal(chatId, initial.chatId);
      assert.equal(messageId, additional.messageId);
      return consoleReply;
    },
  });
  assert.deepEqual(frozen, expected);
});

test("steered screenshots keep the original attachment message identity through restart", async t => {
  const f = fixture(t);
  const images = [{ id: "image-steer", mime: "image/png" as const, size: 5, sha256: "a".repeat(64) }];
  const boundController = directToolController(async request => ({ result: {}, reply: request.messageId === additional.messageId
    ? { text: "截图完成", images } : { text: "已分析" } }));
  const reply = f.engine.reply("account", initial, boundController);
  const options = await f.started.promise;
  f.ready.resolve();
  assert.equal(await f.engine.steer("account", additional, boundController), true);
  await callTool(options, TEST_TOOL_NAME, { requestMessageId: additional.messageId });
  f.finish.resolve();
  const expected = { text: "结合补充后的最终回答\n\n截图完成", images, imageSourceMessageId: additional.messageId };
  assert.deepEqual(await reply, expected);
  const restarted = new CodexReplyEngine({ root: f.root, model: "test", codexPath: process.execPath });
  assert.deepEqual(await restarted.getReply("account", initial.chatId, initial.messageId, {
    getMessageReply: async () => { throw new Error("Engine images must recover from its own journal"); },
  }), expected);
});

for (const uncertain of [false, true]) test(`steer ${uncertain ? "unknown receipt" : "explicit rejection"} never silently resubmits`, async t => {
  const f = fixture(t);
  f.reject(uncertain ? new Error("transport disconnected") : new AppServerRejectedError(-32602));
  const reply = f.engine.reply("account", initial, controller);
  await f.started.promise;
  f.ready.resolve();
  assert.equal(await f.engine.steer("account", additional, controller), uncertain);
  const workspace = await new WorkspaceStore(f.root).forChat("account", initial.chatId);
  const supplementation = Object.values(workspace.getReplyJournal()).find(entry => entry.steering);
  assert.equal(supplementation?.steering?.status, uncertain ? "uncertain" : undefined);
  f.finish.resolve();
  const final = await reply;
  if (uncertain) {
    assert.match(final.text, /结果待核实/);
    assert.equal(await f.engine.steer("account", additional, controller), true);
    assert.equal(f.calls.length, 1);
  } else assert.equal(final.text, "结合补充后的最终回答");
});
