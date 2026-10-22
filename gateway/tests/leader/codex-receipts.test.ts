import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { CodexOptions, ThreadEvent } from "@openai/codex-sdk";
import { CodexReplyEngine, type CodexReplyEngineOptions } from "../../src/leader/codex.js";
import { CONTROL_TOKEN_ENV } from "../../src/leader/control-mcp.js";
import { WorkspaceStore } from "../../src/leader/workspace.js";

const request = { chatId: "chat", messageId: "message", text: "继续检查当前任务" };
const key = createHash("sha256").update(request.messageId).digest("hex");
const image = { id: "known-image", mime: "image/png" as const, size: 5, sha256: "a".repeat(64) };
const receipt = { text: "已接收，等待原会话完成。", commandId: "known-command", images: [image] };
const usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
  output_tokens: 0, reasoning_output_tokens: 0 };
type Failure = "failed" | "throw" | "empty" | "aborted";

function fixture(t: TestContext): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "codex-receipts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function invoke(sdk: CodexOptions): Promise<string> {
  const servers = sdk.config!.mcp_servers as Record<string, Record<string, string>>;
  const response = await fetch(servers.wechat_control.url, { method: "POST", headers: {
    Authorization: `Bearer ${sdk.env![CONTROL_TOKEN_ENV]}`, "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "control_current_request", arguments: {} } }) });
  assert.equal(response.status, 200);
  return response.text();
}

function factory(run: (sdk: CodexOptions, signal: AbortSignal) => AsyncIterable<ThreadEvent>):
  NonNullable<CodexReplyEngineOptions["sdkFactory"]> {
  return sdk => {
    const runner = { runStreamed: async (_input: string, turn: { signal: AbortSignal }) => ({ events: run(sdk, turn.signal) }) };
    return { startThread: () => runner, resumeThread: () => runner };
  };
}

async function* nativeFailure(failure: Failure, signal: AbortSignal): AsyncIterable<ThreadEvent> {
  if (failure === "throw") throw new Error("provider-secret raw stderr");
  if (failure === "failed") { yield { type: "turn.failed", error: { message: "provider failed" } }; return; }
  if (failure === "aborted" && !signal.aborted) {
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
  }
  yield { type: "turn.completed", usage };
}

for (const failure of ["failed", "throw", "empty", "aborted"] as const) {
  for (const consoleReply of [false, true]) {
    test(`confirmed Controller receipt survives native ${failure}, console=${consoleReply}, and restart`, async t => {
      const root = fixture(t);
      const original = { ...receipt, ...(consoleReply ? { text: "控制台：https://console.example/#login=delivery-only-token" } : {}) };
      let nativeCalls = 0, submits = 0, reads = 0;
      const options: CodexReplyEngineOptions = { root, model: "test", codexPath: process.execPath,
        timeoutMs: failure === "aborted" ? 100 : 10000, sdkFactory: factory(async function* (sdk, signal) {
          nativeCalls++;
          const modelResult = await invoke(sdk);
          assert.match(modelResult, /known-command/);
          assert.doesNotMatch(modelResult, /delivery-only-token/);
          yield* nativeFailure(failure, signal);
        }) };
      const controller = {
        forwardMessage: async () => { submits++; return original; },
        getMessageReply: async (chatId: string, messageId: string) => {
          reads++;
          assert.equal(chatId, request.chatId);
          assert.equal(messageId, request.messageId);
          return original;
        },
      };
      assert.deepEqual(await new CodexReplyEngine(options).reply("account", request, controller), original);
      const workspace = await new WorkspaceStore(root).forChat("account", "chat");
      const entry = workspace.getReplyJournal()[key];
      assert.equal(entry.stage, "completed");
      if (consoleReply) {
        assert.equal(entry.provenance, "controller-console");
        assert.doesNotMatch(JSON.stringify(entry), /delivery-only-token/);
      } else assert.deepEqual(entry.reply, original);
      const restarted = new CodexReplyEngine(options);
      assert.deepEqual(await restarted.getReply("account", "chat", request.messageId, controller), original);
      assert.deepEqual(await restarted.reply("account", request, controller), original);
      await restarted.ackReply("account", "chat", request.messageId, "accepted");
      assert.equal(workspace.getReplyJournal()[key].stage, "completed");
      assert.equal(workspace.getReplyJournal()[key].delivery, "accepted");
      assert.equal(reads, consoleReply ? 2 : 0);
      assert.equal(submits, 1);
      assert.equal(nativeCalls, 1);
    });
  }
}

test("native stream failure waits for a disconnected in-flight Controller receipt before persistence", async t => {
  const root = fixture(t);
  let submitted!: () => void;
  const invoked = new Promise<void>(resolve => { submitted = resolve; });
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  let tool: Promise<unknown> | undefined;
  let submits = 0;
  const options: CodexReplyEngineOptions = { root, model: "test", codexPath: process.execPath,
    sdkFactory: factory(async function* (sdk) {
      // The HTTP connection is expected to close, but the submitted obligation survives.
      tool = invoke(sdk).then(() => "completed", () => "disconnected");
      await invoked;
      setImmediate(finish);
      throw new Error("Native stream disconnected before the tool result");
    }) };
  t.after(async () => { await tool; });
  const reply = await new CodexReplyEngine(options).reply("account", request, { forwardMessage: async () => {
    submits++;
    submitted();
    await pending;
    return receipt;
  } });
  assert.deepEqual(reply, receipt);
  const workspace = await new WorkspaceStore(root).forChat("account", "chat");
  assert.equal(workspace.getReplyJournal()[key].stage, "completed");
  assert.equal(submits, 1);
});

test("a failing native close still drains and preserves the confirmed Controller result", async t => {
  const root = fixture(t);
  const engine = new CodexReplyEngine({ root, model: "test", codexPath: process.execPath,
    appServerFactory: async sdk => ({ threadId: "thread", turnId: "turn", steer: async () => undefined,
      events: (async function* () { await invoke(sdk); yield { type: "turn.failed" as const, error: { message: "failed" } }; })(),
      close: async () => { throw new Error("Native close failure"); },
    }) });
  assert.deepEqual(await engine.reply("account", request, { forwardMessage: async () => receipt }), receipt);
  const workspace = await new WorkspaceStore(root).forChat("account", "chat");
  assert.equal(workspace.getReplyJournal()[key].stage, "completed");
});

test("unconfirmed Controller failure remains uncertain and cannot trigger automatic resubmission", async t => {
  const root = fixture(t);
  let submits = 0, runs = 0;
  const options: CodexReplyEngineOptions = { root, model: "test", codexPath: process.execPath,
    sdkFactory: factory(async function* (sdk) {
      runs++;
      await invoke(sdk);
      yield { type: "turn.failed", error: { message: "failed" } };
    }) };
  const controller = { forwardMessage: async () => { submits++; throw new Error("Uncertain Controller response"); } };
  const reply = await new CodexReplyEngine(options).reply("account", request, controller);
  assert.match(reply.text, /执行结果待核实/);
  assert.equal(reply.commandId, undefined);
  assert.equal(reply.images, undefined);
  assert.deepEqual(await new CodexReplyEngine(options).reply("account", request, controller), reply);
  const workspace = await new WorkspaceStore(root).forChat("account", "chat");
  assert.equal(workspace.getReplyJournal()[key].stage, "started");
  assert.equal(submits, 1);
  assert.equal(runs, 1);
});

test("a failed steered native turn preserves the Controller message identity for console images", async t => {
  const root = fixture(t);
  const additional = { ...request, messageId: "supplement", text: "补充：查看控制台截图" };
  let started!: (sdk: CodexOptions) => void;
  const ready = new Promise<CodexOptions>(resolve => { started = resolve; });
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const original = { ...receipt, text: "https://console.example/#login=steered-delivery-only-token" };
  let submits = 0;
  const controller = { forwardMessage: async (input: typeof request) => {
    submits++;
    assert.equal(input.messageId, additional.messageId);
    return original;
  } };
  const engine = new CodexReplyEngine({ root, model: "test", codexPath: process.execPath,
    appServerFactory: async sdk => {
      started(sdk);
      return { threadId: "thread", turnId: "turn", steer: async () => undefined, close: async () => undefined,
        events: (async function* (): AsyncIterable<ThreadEvent> {
          await pending;
          yield { type: "turn.failed", error: { message: "failed after supplementation" } };
        })() };
    } });
  const reply = engine.reply("account", request, controller);
  const sdk = await ready;
  assert.equal(await engine.steer("account", additional, controller), true);
  await invoke(sdk);
  finish();
  const expected = { ...original, imageSourceMessageId: additional.messageId };
  assert.deepEqual(await reply, expected);
  const workspace = await new WorkspaceStore(root).forChat("account", "chat");
  const entry = workspace.getReplyJournal()[key];
  assert.equal(entry.stage, "completed");
  assert.equal(entry.provenance, "controller-console");
  assert.equal(entry.controllerMessageId, additional.messageId);
  assert.doesNotMatch(JSON.stringify(entry), /steered-delivery-only-token/);
  const restarted = new CodexReplyEngine({ root, model: "test", codexPath: process.execPath });
  assert.deepEqual(await restarted.getReply("account", "chat", request.messageId, {
    getMessageReply: async (_chatId, messageId) => {
      assert.equal(messageId, additional.messageId);
      return original;
    },
  }), expected);
  assert.equal(submits, 1);
});
