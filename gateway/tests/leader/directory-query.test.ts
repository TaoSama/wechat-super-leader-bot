import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isConsoleLinkQuery, parseSessionDirectoryQuery } from "@super-leader/wechat-text";
import type { ThreadEvent } from "@openai/codex-sdk";
import { CodexReplyEngine, type CodexReplyEngineOptions } from "../../src/leader/codex.js";
import { WorkspaceStore } from "../../src/leader/workspace.js";
import { ReplyEngineConflictError } from "../../src/leader/contracts.js";
import { createMessageTrace, runWithTrace } from "../../src/runtime/telemetry.js";

const request = { chatId: "directory-chat", messageId: "directory-message", text: "列出当前会话" };
const usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
  output_tokens: 0, reasoning_output_tokens: 0 };

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "directory-query-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function neverNative(): NonNullable<CodexReplyEngineOptions["sdkFactory"]> {
  return () => { assert.fail("Pure directory query must not create the native SDK"); };
}

test("shared parser accepts only standalone directories and preserves requested status", () => {
  for (const text of ["查看所有会话", "会话列表", "列出当前会话", "看看现在所有的任务", "查一下当前都有哪些会话", "看一下我当前有哪些会话",
    "有哪些任务？", "当前会话列表", "请帮我看看所有会话", " 查看 所有 会话 ", "查看会话列表"]) {
    assert.deepEqual(parseSessionDirectoryQuery(text), {}, text);
  }
  for (const text of ["列出运行中的会话", "活跃会话列表", "有哪些正在运行的任务", "看看当前运行中的会话"]) {
    assert.deepEqual(parseSessionDirectoryQuery(text), { status: "active" }, text);
  }
  for (const text of ["空闲会话列表", "查看当前空闲的任务", "有哪些空闲会话"]) {
    assert.deepEqual(parseSessionDirectoryQuery(text), { status: "idle" }, text);
  }
  for (const text of ["", "会话", "列出会话并发送", "列出会话，然后给第三个发消息", "查看所有会话\n继续第三个",
    "会话列表\n", "会话列表\u2028", "查看会话。继续第三个", "查看所有会话的进度", "查看会话模型", "列出demoair会话",
    "查看项目A的任务", "记住以后查看所有会话", "‘查看所有会话’", "查看所有会话的标题", "取消任务列表",
    "把标题改成会话列表", "看看第三个任务", "运行会话", "列出会话；发消息", "列出会话并记住偏好"]) {
    assert.equal(parseSessionDirectoryQuery(text), undefined, text);
  }
});

test("directory forwards frozen original only after durable started record, without native execution", async t => {
  const root = fixture(t);
  const options = { root, model: "synthetic", sdkFactory: neverNative() };
  const response = { text: "项目（机器）\n1. [闲] 原始标题" };
  const events: Record<string, unknown>[] = [];
  let calls = 0;
  const controller = { forwardMessage: async (actual: typeof request) => {
    calls++;
    assert.deepEqual(actual, request);
    assert.ok(Object.isFrozen(actual));
    const workspace = await new WorkspaceStore(root).forChat("account", request.chatId);
    const entry = Object.values(workspace.getReplyJournal())[0];
    assert.equal(entry.stage, "started");
    assert.equal(entry.delivery, "pending");
    return response;
  } };
  assert.deepEqual(await runWithTrace(createMessageTrace(request.chatId, request.messageId, event => events.push(event)),
    () => new CodexReplyEngine(options).reply("account", request, controller)), response);
  assert.equal(calls, 1);
  assert.ok(events.some(event => event.stage === "codex.directory.controller.end" && event.outcome === "ok"));
  assert.ok(!events.some(event => event.stage === "codex.stream.begin"));
  const workspace = await new WorkspaceStore(root).forChat("account", request.chatId);
  assert.equal(Object.values(workspace.getReplyJournal())[0].stage, "completed");
  assert.equal(workspace.getThreadId(), undefined);
});

test("console parser accepts exact standalone requests and rejects compound or unrelated intent", () => {
  for (const text of ["给我控制端链接", "控制台链接", "打开控制台", "请给我控制台登录链接", "获取控制端入口。", " 控制台 登录 链接 "]) {
    assert.equal(isConsoleLinkQuery(text), true, text);
  }
  for (const text of ["", "控制台", "把控制台链接发给别人", "给我控制端链接并发送任务", "控制台链接\n执行任务",
    "‘控制台链接’", "请修改控制台链接", "查询控制台链接的过期时间", "给我控制台链接，然后修改任务", "控制台链接\n"]) {
    assert.equal(isConsoleLinkQuery(text), false, text);
  }
});

test("real console query skips native and reuses Controller receipt without journaling credentials or issuing again", async t => {
  const root = fixture(t);
  const options = { root, model: "synthetic", sdkFactory: neverNative() };
  const consoleRequest = { ...request, text: "给我控制端链接" };
  const response = { text: "控制台登录链接：https://console.example/#login=console-delivery-secret" };
  let issues = 0;
  let recoveries = 0;
  const controller = {
    forwardMessage: async (actual: typeof request) => {
      assert.deepEqual(actual, consoleRequest);
      assert.ok(Object.isFrozen(actual));
      issues++;
      return response;
    },
    getMessageReply: async (chatId: string, messageId: string) => {
      assert.equal(chatId, request.chatId);
      assert.equal(messageId, request.messageId);
      recoveries++;
      return response;
    },
  };
  assert.deepEqual(await new CodexReplyEngine(options).reply("account", consoleRequest, controller), response);
  const workspace = await new WorkspaceStore(root).forChat("account", request.chatId);
  assert.equal(workspace.getThreadId(), undefined);
  const journal = workspace.getReplyJournal();
  assert.equal(Object.values(journal)[0].provenance, "controller-console");
  assert.match(Object.values(journal)[0].reply!.text, /上次已生成一次性控制台链接/);
  assert.doesNotMatch(JSON.stringify(journal), /console-delivery-secret/);
  assert.deepEqual(await new CodexReplyEngine(options).reply("account", consoleRequest, controller), response);
  assert.deepEqual(await new CodexReplyEngine(options).getReply("account", request.chatId, request.messageId, controller), response);
  assert.equal(issues, 1);
  assert.equal(recoveries, 2);
});

test("directory journal survives restart, replays once and retains conflict and delivery protections", async t => {
  const root = fixture(t);
  const options = { root, model: "synthetic", sdkFactory: neverNative() };
  let calls = 0;
  const response = { text: "1. [闲] 原始标题" };
  const controller = { forwardMessage: async () => { calls++; return response; } };
  await new CodexReplyEngine(options).reply("account", request, controller);
  assert.deepEqual(await new CodexReplyEngine(options).reply("account", request, controller), response);
  assert.deepEqual(await new CodexReplyEngine(options).getReply("account", request.chatId, request.messageId,
    { getMessageReply: async () => { assert.fail("Completed directory must recover locally"); } }), response);
  assert.equal(calls, 1);
  await assert.rejects(new CodexReplyEngine(options).reply("account", { ...request, text: "查看空闲会话" }, controller),
    ReplyEngineConflictError);
  await new CodexReplyEngine(options).ackReply("account", request.chatId, request.messageId, "accepted");
  const workspace = await new WorkspaceStore(root).forChat("account", request.chatId);
  assert.equal(Object.values(workspace.getReplyJournal())[0].delivery, "accepted");
});

test("directory failures keep started journal and never fall back to native or retry Controller on replay", async t => {
  const root = fixture(t);
  const options = { root, model: "synthetic", sdkFactory: neverNative() };
  let calls = 0;
  const controller = { forwardMessage: async () => { calls++; throw new Error("synthetic-private-provider-error"); } };
  const failed = await new CodexReplyEngine(options).reply("account", request, controller);
  assert.doesNotMatch(failed.text, /synthetic-private-provider-error/);
  assert.deepEqual(await new CodexReplyEngine(options).reply("account", request, controller), failed);
  assert.equal(calls, 1);
  const workspace = await new WorkspaceStore(root).forChat("account", request.chatId);
  assert.equal(Object.values(workspace.getReplyJournal())[0].stage, "started");
});

test("unexpected directory console credential follows existing recovery provenance and never enters journal", async t => {
  const root = fixture(t);
  const options = { root, model: "synthetic", sdkFactory: neverNative() };
  const text = "https://console.example/#login=synthetic-delivery-secret";
  const controller = { forwardMessage: async () => ({ text }) };
  assert.deepEqual(await new CodexReplyEngine(options).reply("account", request, controller), { text });
  const workspace = await new WorkspaceStore(root).forChat("account", request.chatId);
  const journal = workspace.getReplyJournal();
  assert.equal(Object.values(journal)[0].provenance, "controller-console");
  assert.doesNotMatch(JSON.stringify(journal), /synthetic-delivery-secret/);
  assert.deepEqual(await new CodexReplyEngine(options).getReply("account", request.chatId, request.messageId,
    { getMessageReply: async () => ({ text: "recovered through Controller" }) }), { text: "recovered through Controller" });
});

test("compound and ordinary requests retain native tools with complete memory snapshot guidance", async t => {
  const root = fixture(t);
  let nativeCalls = 0;
  const sdkFactory: NonNullable<CodexReplyEngineOptions["sdkFactory"]> = () => ({
    startThread: () => ({ runStreamed: async (input: string) => ({ events: (async function* (): AsyncIterable<ThreadEvent> {
      nativeCalls++;
      assert.match(input, /完整快照满足读取要求/);
      assert.match(input, /文件没有变化时不必重写/);
      yield { type: "item.completed", item: { type: "agent_message", id: "a", text: "原生处理" } };
      yield { type: "turn.completed", usage };
    })() }) }),
    resumeThread: () => { assert.fail("Synthetic native request should start a thread"); },
  });
  const engine = new CodexReplyEngine({ root, model: "synthetic", sdkFactory });
  const controller = { forwardMessage: async () => { assert.fail("Native path controls whether to invoke Controller"); } };
  for (const [index, text] of ["列出会话并发送", "记住：先说结论", "查看项目A的会话进度", "比较会话的模型"].entries()) {
    assert.deepEqual(await engine.reply("account", { ...request, messageId: `native-${index}`, text }, controller), { text: "原生处理" });
  }
  assert.equal(nativeCalls, 4);
});
