import { directToolController, syntheticTool } from "./direct-tool-fixture.js";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CodexOptions, ThreadEvent, ThreadOptions } from "@openai/codex-sdk";
import { CodexReplyEngine, type CodexReplyEngineOptions } from "../../src/leader/codex.js";
import { ReplyEngineConflictError, ReplyEngineUnavailableError } from "../../src/leader/contracts.js";
import { WorkspaceStore } from "../../src/leader/workspace.js";
import { CONTROL_TOKEN_ENV } from "../../src/leader/control-mcp.js";
import { StateManager } from "../../src/runtime/state.js";
import { ILinkClient } from "../../src/wechat/client.js";
import { ControllerClient } from "../../src/controller/client.js";
import { WeChatGateway } from "../../src/gateway.js";

const request = { chatId: "chat", messageId: "message", text: "记住：以后先说结论" };
const usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
  output_tokens: 0, reasoning_output_tokens: 0 };
const noController = directToolController();

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "codex-reply-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function fakeFactory(run: (input: string, settings: ThreadOptions, sdk: CodexOptions,
  resume: string | undefined, signal: AbortSignal) => AsyncIterable<ThreadEvent>): NonNullable<CodexReplyEngineOptions["sdkFactory"]> {
  return sdk => ({
    startThread: settings => ({ runStreamed: async (input, turn) => ({ events: run(input, settings, sdk, undefined, turn.signal) }) }),
    resumeThread: (id, settings) => ({ runStreamed: async (input, turn) => ({ events: run(input, settings, sdk, id, turn.signal) }) }),
  });
}

async function* complete(text: string): AsyncIterable<ThreadEvent> {
  yield { type: "item.completed", item: { type: "agent_message", id: "a", text } };
  yield { type: "turn.completed", usage };
}

test("native memory edits, early thread ID and restart resume persist in isolated chat home", async t => {
  const root = fixture(t);
  let first = true;
  const sdkFactory = fakeFactory(async function* (input, settings, sdk, resume) {
    assert.equal(settings.sandboxMode, undefined);
    assert.equal(settings.networkAccessEnabled, undefined);
    assert.equal(sdk.config?.default_permissions, "wechat_memory");
    const mcpServers = sdk.config?.mcp_servers as Record<string, Record<string, unknown>>;
    assert.deepEqual(mcpServers.wechat_control.enabled_tools, ["test_business", "report_progress"]);
    assert.deepEqual(mcpServers.wechat_control.tools, { test_business: { approval_mode: "approve" },
      report_progress: { approval_mode: "approve" } });
    const permissionProfile = sdk.configOverrides?.find(override => override.startsWith("permissions.wechat_memory="));
    assert.ok(permissionProfile);
    assert.ok(permissionProfile.includes(`${JSON.stringify(settings.workingDirectory)}="write"`));
    assert.ok(permissionProfile.includes(`${JSON.stringify(path.join(settings.workingDirectory!, ".codex"))}="deny"`));
    for (const metadata of [".replies.json", ".thread.json"]) {
      assert.ok(permissionProfile.includes(`${JSON.stringify(path.join(settings.workingDirectory!, metadata))}="deny"`));
    }
    assert.ok(permissionProfile.includes(`${JSON.stringify(path.join(settings.workingDirectory!, "AGENTS.md"))}="read"`));
    assert.match(permissionProfile, /":minimal"="read"/);
    assert.ok(permissionProfile.includes('"/etc/codex/skills"="read"'));
    assert.match(permissionProfile, /network=\{enabled=true\}/);
    assert.match(permissionProfile, /@openai\+codex@[^=]+="read"/);
    assert.doesNotMatch(permissionProfile, /extends|:root|sandbox_mode|sandbox_workspace_write|:workspace_roots/);
    assert.equal(settings.approvalPolicy, "never");
    assert.equal(settings.model, "test-model");
    assert.equal(sdk.env?.CODEX_HOME, path.join(settings.workingDirectory!, ".codex"));
    assert.match(input, /preference.md/);
    assert.equal(sdk.env?.CONTROLLER_TOKEN, undefined);
    assert.equal(sdk.env?.WECHAT_TOKEN, undefined);
    assert.equal(sdk.apiKey, "api-auth-only");
    assert.equal(sdk.config?.model_provider, "leader_openai");
    if (first) {
      assert.equal(resume, undefined);
      yield { type: "thread.started", thread_id: "thread-persisted" };
      // The next event cannot arrive before thread.started has reached durable storage.
      const workspace = await new WorkspaceStore(root).forChat("account", "chat");
      assert.equal(workspace.getThreadId(), "thread-persisted");
      fs.writeFileSync(path.join(settings.workingDirectory!, "preference.md"), "先说结论，简洁回复。\n");
      fs.writeFileSync(path.join(settings.workingDirectory!, "task.md"), "当前在修复重发问题，禁止部署。\n");
      first = false;
    } else {
      assert.equal(resume, "thread-persisted");
      assert.match(input, /先说结论，简洁回复/);
      assert.match(input, /禁止部署/);
    }
    yield* complete("记住了");
  });
  const options = { root, model: "test-model", sdkFactory, apiKey: "api-auth-only", baseUrl: "https://api.example.test/v1" };
  assert.deepEqual(await new CodexReplyEngine(options).reply("account", request, noController), { text: "记住了" });
  assert.deepEqual(await new CodexReplyEngine(options).reply("account", { ...request, messageId: "next", text: "继续" }, noController), { text: "记住了" });
  const other = await new WorkspaceStore(root).forChat("other-account", "chat");
  assert.equal(other.getThreadId(), undefined);
  assert.doesNotMatch(other.readMemory()["task.md"].content, /重发问题/);
});

test("each native turn gets current Beijing time, including midnight after thread resume", async t => {
  const root = fixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-18T15:14:05Z") });
  const inputs: string[] = [];
  const resumed: Array<string | undefined> = [];
  const sdkFactory = fakeFactory(async function* (input, _settings, _sdk, resume) {
    inputs.push(input);
    resumed.push(resume);
    yield { type: "thread.started", thread_id: "beijing-time-thread" };
    yield* complete("当前时间已核对");
  });
  const options = { root, model: "test-model", sdkFactory };
  await new CodexReplyEngine(options).reply("account", request, noController);
  t.mock.timers.tick(2_755_000);
  await new CodexReplyEngine(options).reply("account", { ...request, messageId: "after-midnight" }, noController);
  assert.deepEqual(resumed, [undefined, "beijing-time-thread"]);
  assert.match(inputs[0], /<current_time time_zone="Asia\/Shanghai">2026-10-18 23:14:05 UTC\+08:00<\/current_time>/);
  assert.match(inputs[1], /<current_time time_zone="Asia\/Shanghai">2026-10-19 00:00:00 UTC\+08:00<\/current_time>/);
  assert.doesNotMatch(inputs[1], /2026-10-18 23:14:05/);
  for (const input of inputs) {
    assert.match(input, /不沿用历史消息或记忆中的“现在”/);
    assert.match(input, /来源没有时区时，标注时区未知，不猜测/);
    assert.match(input, /标题简短并独立成段，列表每项单独一行/);
    assert.match(input, /默认不反复输出“桌面观测过期”“已失联”等技术状态/);
    assert.match(input, /用户询问细节或能力时，如实解释当前限制/);
    assert.match(input, /不要伪造在线状态或声称尚未验证的执行已经完成/);
  }
});

test("completed message survives restart without rerunning; conflicting duplicate is refused", async t => {
  const root = fixture(t);
  let calls = 0;
  const sdkFactory = fakeFactory(async function* () { calls++; yield* complete("cached"); });
  const options = { root, model: "test-model", sdkFactory };
  await new CodexReplyEngine(options).reply("account", request, noController);
  assert.deepEqual(await new CodexReplyEngine(options).reply("account", request, noController), { text: "cached" });
  assert.equal(calls, 1);
  const workspace = await new WorkspaceStore(root).forChat("account", "chat");
  const originalJournal = workspace.getReplyJournal();
  await assert.rejects(new CodexReplyEngine(options).reply("account", { ...request, text: "other" }, noController),
    ReplyEngineConflictError);
  assert.equal(calls, 1);
  assert.deepEqual(workspace.getReplyJournal(), originalJournal);
});

test("conflicting message is replied without tools and later messages in the poll batch advance the cursor", async t => {
  const root = fixture(t);
  let modelCalls = 0;
  const engine = new CodexReplyEngine({ root: path.join(root, "workspaces"), model: "test-model",
    sdkFactory: fakeFactory(async function* () { modelCalls++; yield* complete("正常后续回复"); }) });
  await engine.reply("account", request, noController);
  const workspace = await new WorkspaceStore(path.join(root, "workspaces")).forChat("account", "chat");
  const originalJournal = workspace.getReplyJournal();
  const originalKey = Object.keys(originalJournal)[0];
  const credentials = path.join(root, "account.json");
  fs.writeFileSync(credentials, JSON.stringify({ token: "synthetic", accountId: "account" }));
  const state = new StateManager(credentials, path.join(root, "state.json"));
  state.markBaselineEstablished();
  const sent: string[] = [];
  const controller = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic",
    fetchImpl: async url => {
      if (String(url).endsWith("/v1/chats/authorize")) return new Response(JSON.stringify({ allowed: true }));
      assert.ok(String(url).endsWith("/v1/tools/list"), "conflict must not execute Controller tools");
      return new Response(JSON.stringify({ tools: [syntheticTool()], instructions: "Synthetic business tools", context: { history: [], memories: {} } }));
    } });
  const ilink = new ILinkClient({ stateManager: state, configuredBaseUrl: "https://ilink.example",
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("getupdates")) return new Response(JSON.stringify({ ret: 0,
        get_updates_buf: "past-conflict-and-followup", msgs: [
          { message_type: 1, from_user_id: "chat", client_id: request.messageId, context_token: "ctx", create_time_ms: Date.now(),
            item_list: [{ type: 1, text_item: { text: "different message content" } }] },
          { message_type: 1, from_user_id: "chat", client_id: "next-message", context_token: "ctx", create_time_ms: Date.now(),
            item_list: [{ type: 1, text_item: { text: "正常新消息" } }] },
        ] }));
      if (String(url).endsWith("getconfig")) return new Response(JSON.stringify({ ret: 0, typing_ticket: "ticket" }));
      if (String(url).endsWith("sendtyping")) return new Response(JSON.stringify({ ret: 0 }));
      if (String(url).endsWith("sendmessage")) {
        sent.push(JSON.parse(String(init?.body)).msg.item_list[0].text_item.text);
        return new Response(JSON.stringify({ ret: 0 }));
      }
      throw new Error("Unexpected synthetic WeChat route");
    } });
  const gateway = new WeChatGateway({ stateManager: state, ilink, controller, replyEngine: engine });
  const result = await gateway.pollOnce();
  assert.equal(result.processedCount, 2);
  assert.equal(state.syncBuf, "past-conflict-and-followup");
  assert.equal(sent.length, 2);
  assert.match(sent[0], /没有处理新内容/);
  assert.equal(sent[1], "正常后续回复");
  assert.equal(modelCalls, 2, "only the original and subsequent new message invoke Codex");
  assert.deepEqual(workspace.getReplyJournal()[originalKey], originalJournal[originalKey]);
  assert.equal((await gateway.pollOnce()).polledCount, 0);
  assert.equal(sent.length, 2);
});

test("failed turns retain early thread ID and started journal, sanitize stderr and refuse automatic replay", async t => {
  const root = fixture(t);
  let calls = 0;
  const sdkFactory = fakeFactory(async function* () {
    calls++;
    yield { type: "thread.started", thread_id: "recoverable-thread" };
    throw new Error("provider-secret-token raw stderr");
  });
  const options = { root, model: "test-model", sdkFactory };
  const failed = await new CodexReplyEngine(options).reply("account", request, noController);
  assert.doesNotMatch(failed.text, /provider-secret-token|stderr/);
  const retry = await new CodexReplyEngine(options).reply("account", request, noController);
  assert.deepEqual(retry, failed);
  assert.deepEqual(await new CodexReplyEngine(options).getReply("account", "chat", request.messageId,
    { getMessageReply: async () => { throw new Error("Unexpected Controller recovery"); } }), failed);
  assert.equal(calls, 1);
  const workspace = await new WorkspaceStore(root).forChat("account", "chat");
  assert.equal(workspace.getThreadId(), "recoverable-thread");
  assert.equal(Object.values(workspace.getReplyJournal())[0].stage, "started");
});

test("Controller tool preserves attachments, command ID and original credential links outside generated prose", async t => {
  const root = fixture(t);
  const image = { id: "image-1", mime: "image/png" as const, size: 5, sha256: "a".repeat(64) };
  let calls = 0;
  const originalText = "控制台：https://console.example/#login=delivery-only-token";
  const sdkFactory = fakeFactory(async function* (input, _settings, sdk) {
    assert.doesNotMatch(input, /delivery-only-token/);
    const servers = sdk.config!.mcp_servers as Record<string, Record<string, string>>;
    const url = servers.wechat_control.url;
    const response = await fetch(url, { method: "POST", headers: {
      Authorization: `Bearer ${sdk.env![CONTROL_TOKEN_ENV]}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "test_business", arguments: { arguments: {} } },
    }) });
    assert.equal(response.status, 200);
    const modelContent = await response.text();
    assert.doesNotMatch(modelContent, /delivery-only-token/);
    assert.match(modelContent, /REDACTED/);
    yield* complete("已查询，结果见图");
  });
  const engine = new CodexReplyEngine({ root, model: "test-model", sdkFactory });
  const reply = await engine.reply("account", request, directToolController(async input => {
    calls++;
    assert.equal(input.chatId, request.chatId);
    assert.equal(input.messageId, request.messageId);
    assert.equal(input.text, request.text);
    assert.equal(input.name, "test_business");
    assert.deepEqual(input.arguments, {});
    return { result: { delivered: true }, reply: { text: originalText, commandId: "cmd-1", images: [image] } };
  }));
  assert.deepEqual(reply, { text: originalText, commandId: "cmd-1", images: [image] });
  assert.equal(calls, 1);
  const workspace = await new WorkspaceStore(root).forChat("account", "chat");
  assert.doesNotMatch(JSON.stringify(workspace.getReplyJournal()), /delivery-only-token/);
  await engine.drain();
  await assert.rejects(engine.reply("account", request, noController), ReplyEngineUnavailableError);
  let lookups = 0;
  const replay = await engine.getReply("account", "chat", request.messageId, { getMessageReply: async (chatId, messageId) => {
    lookups++;
    assert.equal(chatId, request.chatId);
    assert.equal(messageId, request.messageId);
    return reply;
  } });
  assert.deepEqual(replay, reply);
  assert.equal(lookups, 1);
  assert.equal(calls, 1);
  assert.equal(Object.values(workspace.getReplyJournal())[0].provenance, "controller-console");
});

for (const useControl of [false, true]) {
  test(`model credentials are redacted and never change recovery source (Controller called: ${useControl})`, async t => {
    const root = fixture(t);
    const secretRequest = { ...request, text: "检查这个链接 https://console.example/#login=user-supplied-secret" };
    let runs = 0;
    let controlCalls = 0;
    const sdkFactory = fakeFactory(async function* (input, _settings, sdk) {
      runs++;
      assert.doesNotMatch(input, /user-supplied-secret|remembered-secret/);
      assert.match(input, /REDACTED/);
      if (useControl) {
        const servers = sdk.config!.mcp_servers as Record<string, Record<string, string>>;
        const response = await fetch(servers.wechat_control.url, { method: "POST", headers: {
          Authorization: `Bearer ${sdk.env![CONTROL_TOKEN_ENV]}`, "Content-Type": "application/json",
          Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1,
          method: "tools/call", params: { name: "test_business", arguments: { arguments: {} } } }) });
        assert.equal(response.status, 200);
        await response.text();
      }
      yield* complete("不要公开：https://console.example/#login=model-generated-secret");
    });
    const options = { root, model: "test-model", sdkFactory };
    const workspace = await new WorkspaceStore(root).forChat("account", "chat");
    fs.writeFileSync(path.join(workspace.workspacePath, "memory.md"), "旧链接 #login=remembered-secret\n");
    const controller = directToolController(async input => {
      controlCalls++;
      assert.deepEqual({ chatId: input.chatId, messageId: input.messageId, text: input.text }, secretRequest,
        "Controller remains bound to the immutable original request");
      return { result: { checked: true }, reply: { text: "普通查询结果", commandId: "ordinary-command" } };
    });
    const reply = await new CodexReplyEngine(options).reply("account", secretRequest, controller);
    assert.equal(reply.text, useControl ? "普通查询结果" : "不要公开：https://console.example/#login=[REDACTED]");
    assert.equal(controlCalls, useControl ? 1 : 0);
    const journal = workspace.getReplyJournal();
    assert.equal(Object.values(journal)[0].provenance, undefined);
    assert.deepEqual(Object.values(journal)[0].reply, reply);
    assert.doesNotMatch(JSON.stringify(journal), /model-generated-secret|user-supplied-secret/);
    let gets = 0;
    const recovery = { getMessageReply: async () => { gets++; return { text: "wrong source" }; } };
    const restarted = new CodexReplyEngine(options);
    assert.deepEqual(await restarted.getReply("account", "chat", request.messageId, recovery), reply);
    assert.deepEqual(await restarted.reply("account", secretRequest, noController), reply);
    assert.equal(gets, 0);
    assert.equal(runs, 1);
  });
}

test("disconnected Controller call keeps lock and started journal until submission settles", async t => {
  const root = fixture(t);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let submitted!: () => void;
  const entered = new Promise<void>(resolve => { submitted = resolve; });
  let terminal!: () => void;
  const nativeTerminated = new Promise<void>(resolve => { terminal = resolve; });
  const sdkFactory = fakeFactory(async function* (_input, _settings, sdk) {
    const servers = sdk.config!.mcp_servers as Record<string, Record<string, string>>;
    const pending = fetch(servers.wechat_control.url, { method: "POST", headers: {
      Authorization: `Bearer ${sdk.env![CONTROL_TOKEN_ENV]}`, "Content-Type": "application/json",
      Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1,
      method: "tools/call", params: { name: "test_business", arguments: { arguments: {} } } }),
    }).then(() => "response", () => "disconnected");
    await entered;
    yield { type: "item.completed", item: { type: "agent_message", id: "early", text: "模型过早声称完成" } };
    terminal();
    yield { type: "turn.completed", usage };
    void pending;
  });
  const engine = new CodexReplyEngine({ root, model: "test-model", sdkFactory });
  let resolved = false;
  const reply = engine.reply("account", request, directToolController(async () => {
    submitted(); await blocked; throw new Error("uncertain-controller-secret");
  })).then(value => { resolved = true; return value; });
  await nativeTerminated;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolved, false);
  const workspace = await new WorkspaceStore(root).forChat("account", "chat");
  assert.equal(Object.values(workspace.getReplyJournal())[0].stage, "started");
  release();
  const result = await reply;
  assert.doesNotMatch(result.text, /过早声称完成|uncertain-controller-secret/);
  assert.match(result.text, /待核实/);
  assert.equal(Object.values(workspace.getReplyJournal())[0].stage, "started");
});

test("same chat waits for turn termination while another chat proceeds independently", async t => {
  const root = fixture(t);
  let unblock!: () => void;
  const blocked = new Promise<void>(resolve => { unblock = resolve; });
  let firstStarted!: () => void;
  const started = new Promise<void>(resolve => { firstStarted = resolve; });
  const seen: string[] = [];
  const sdkFactory = fakeFactory(async function* (input) {
    if (input.includes('"text":"first"')) {
      seen.push("first"); firstStarted(); await blocked;
    } else if (input.includes('"text":"second"')) seen.push("second");
    else seen.push("independent");
    yield* complete("ok");
  });
  const engine = new CodexReplyEngine({ root, model: "test-model", sdkFactory });
  const first = engine.reply("account", { ...request, text: "first" }, noController);
  await started;
  const second = engine.reply("account", { ...request, messageId: "m2", text: "second" }, noController);
  await engine.reply("account", { ...request, chatId: "other", text: "independent" }, noController);
  assert.deepEqual(seen, ["first", "independent"]);
  unblock();
  await Promise.all([first, second]);
  assert.deepEqual(seen, ["first", "independent", "second"]);
});

test("timeout aborts the native turn and keeps uncertain journal; budget is bounded", async t => {
  const root = fixture(t);
  let terminated = false;
  const sdkFactory = fakeFactory(async function* (_input, _settings, _sdk, _resume, signal) {
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    terminated = true;
  });
  const engine = new CodexReplyEngine({ root, model: "test-model", sdkFactory, timeoutMs: 10 });
  assert.equal(engine.requestBudgetMs, 315010);
  const reply = await engine.reply("account", request, noController);
  assert.equal(terminated, true);
  assert.match(reply.text, /未正常完成|没有正常完成/);
  assert.throws(() => new CodexReplyEngine({ root, model: "x", timeoutMs: 315001 }), /budget/);
});
