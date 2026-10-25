import { directToolController } from "./direct-tool-fixture.js";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CodexOptions, ThreadEvent } from "@openai/codex-sdk";
import { CodexReplyEngine, type CodexReplyEngineOptions } from "../../src/leader/codex.js";
import { CONTROL_TOKEN_ENV } from "../../src/leader/control-mcp.js";
import { NativeEventTrace } from "../../src/leader/native-events.js";
import { createMessageTrace, runWithTrace } from "../../src/runtime/telemetry.js";

const request = { chatId: "chat", messageId: "message", text: "user-body-secret" };
const usage = { input_tokens: 20, cached_input_tokens: 5, cache_write_input_tokens: 0,
  output_tokens: 4, reasoning_output_tokens: 2 };
const noController = directToolController();

function setup(t: TestContext, run: (sdk: CodexOptions) => AsyncIterable<ThreadEvent>) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "codex-telemetry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sdkFactory: CodexReplyEngineOptions["sdkFactory"] = sdk => ({
    startThread: () => ({ runStreamed: async () => ({ events: run(sdk) }) }),
    resumeThread: () => ({ runStreamed: async () => ({ events: run(sdk) }) }),
  });
  const engine = new CodexReplyEngine({ root, model: "test-model", sdkFactory });
  const events: Record<string, unknown>[] = [];
  const trace = createMessageTrace(request.chatId, request.messageId, event => events.push(event));
  return { engine, events, trace };
}

function stage(events: Record<string, unknown>[], name: string): Record<string, unknown> {
  const found = events.find(event => event.stage === name);
  assert.ok(found, `Missing telemetry stage: ${name}`);
  return found;
}

test("SDK lifecycle distinguishes turn completion, stream exhaustion, MCP close and journal persistence", async t => {
  let release!: () => void;
  const exit = new Promise<void>(resolve => { release = resolve; });
  let completed!: () => void;
  const turnCompleted = new Promise<void>(resolve => { completed = resolve; });
  const { engine, events, trace } = setup(t, async function* () {
    yield { type: "thread.started", thread_id: "native-thread" };
    yield { type: "turn.started" };
    yield { type: "item.started", item: { id: "tool-1", type: "command_execution",
      command: "command-secret", aggregated_output: "output-secret", status: "in_progress" } };
    yield { type: "item.completed", item: { id: "tool-1", type: "command_execution",
      command: "command-secret", aggregated_output: "output-secret", status: "completed", exit_code: 0 } };
    yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: "reply-secret" } };
    yield { type: "turn.completed", usage };
    completed();
    await exit;
  });
  const pending = runWithTrace(trace, () => engine.reply("account", request, noController));
  await turnCompleted;
  stage(events, "codex.turn.completed");
  assert.equal(events.some(event => event.stage === "codex.stream.drained"), false);
  stage(events, "codex.journal.outcome.save.end");
  assert.deepEqual(await pending, { text: "reply-secret" });
  assert.equal(stage(events, "codex.reply.ready").cleanupPending, true);
  await runWithTrace(trace, () => engine.ackReply("account", request.chatId, request.messageId, "accepted"));
  assert.equal(events.some(event => event.stage === "codex.stream.drained"), false,
    "durable delivery receipts must not wait for SDK cleanup");
  assert.equal(stage(events, "codex.journal.delivery.save.end").receiptStatus, "accepted");
  release();
  await engine.drain();
  const names = events.map(event => event.stage);
  assert.ok(names.indexOf("codex.turn.completed") < names.indexOf("codex.stream.drained"));
  assert.ok(names.indexOf("codex.stream.drained") < names.indexOf("codex.mcp.close.start"));
  assert.ok(names.indexOf("codex.journal.outcome.save.end") < names.indexOf("codex.stream.drained"));
  assert.ok(names.indexOf("codex.journal.delivery.save.end") < names.indexOf("codex.stream.drained"));
  assert.equal(stage(events, "codex.stream.begin").ttftAvailable, false);
  assert.equal(stage(events, "codex.stream.begin").nativeTurnIdAvailable, false);
  assert.equal(stage(events, "codex.stream.drained").cliExitTimeAvailable, false);
  assert.equal(stage(events, "codex.turn.completed").inputTokens, 20);
  assert.equal(stage(events, "codex.item.completed").startObserved, true);
  assert.equal(stage(events, "codex.item.completed").isTool, true);
  assert.equal(stage(events, "codex.thread.started").threadId, "native-thread");
  assert.equal(events.filter(event => event.stage === "codex.stream.first_agent_message").length, 1);
  assert.doesNotMatch(JSON.stringify(events), /user-body-secret|command-secret|output-secret|reply-secret/);
  await runWithTrace(trace, () => engine.ackReply("account", request.chatId, request.messageId, "accepted"));
  assert.equal(stage(events, "codex.journal.delivery.save.end").receiptStatus, "accepted");
});

for (const failure of ["throw", "missing-completion", "no-events"] as const) {
  test(`SDK ${failure} emits honest timing coverage, cleans MCP and persists failed journal`, async t => {
    const { engine, events, trace } = setup(t, async function* () {
      if (failure === "no-events") return;
      yield { type: "thread.started", thread_id: "native-thread" };
      if (failure === "throw") throw new Error("stderr-secret https://secret.example/token");
      yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: "unverified-secret" } };
    });
    const result = await runWithTrace(trace, () => engine.reply("account", request, noController));
    assert.match(result.text, /待核实/);
    const finish = stage(events, failure === "throw" ? "codex.stream.interrupted" : "codex.stream.drained");
    assert.equal(finish.turnCompletedObserved, false);
    assert.equal(finish.streamDrainMs, undefined);
    assert.equal(finish.firstEventObserved, failure !== "no-events");
    stage(events, "codex.mcp.close.end");
    assert.equal(stage(events, "codex.journal.outcome.save.end").status, "failed");
    assert.doesNotMatch(JSON.stringify(events), /stderr-secret|secret.example|unverified-secret/);
  });
}

test("real MCP HTTP callbacks retain originating trace and time Controller call only once", async t => {
  const { engine, events, trace } = setup(t, async function* (sdk) {
    const server = (sdk.config!.mcp_servers as Record<string, Record<string, string>>).wechat_control;
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(server.url, { method: "POST", headers: {
        Authorization: `Bearer ${sdk.env![CONTROL_TOKEN_ENV]}`, "Content-Type": "application/json",
        Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1,
        method: "tools/call", params: { name: "test_business", arguments: { arguments: {} } } }) });
      assert.equal(response.status, 200);
      await response.text();
    }
    yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: "done" } };
    yield { type: "turn.completed", usage };
  });
  await runWithTrace(trace, () => engine.reply("account", request, directToolController(async () => ({ result: { checked: true },
    reply: { text: "controller-reply-secret", commandId: "command-1" } }))));
  assert.equal(events.filter(event => event.stage === "codex.mcp.controller.start").length, 1);
  assert.equal(events.filter(event => event.stage === "codex.mcp.controller.end").length, 1);
  assert.equal(stage(events, "codex.mcp.controller.end").traceId, trace.traceId);
  assert.equal(stage(events, "codex.mcp.invocation.reused").attemptId, trace.attemptId);
  assert.doesNotMatch(JSON.stringify(events), /controller-reply-secret|Bearer|127\.0\.0\.1/);
});

test("native item tracking is bounded, unmatched completions never invent duration, finally clears tracking", () => {
  const events: Record<string, unknown>[] = [];
  const trace = createMessageTrace("chat", "bounded", event => events.push(event));
  runWithTrace(trace, () => {
    const tracker = new NativeEventTrace();
    for (let index = 0; index < 200; index++) tracker.observe({ type: "item.started", item: {
      id: `item-${index}`, type: "web_search", query: "query-secret" } });
    tracker.observe({ type: "item.completed", item: { id: "unmatched", type: "web_search", query: "query-secret" } });
    tracker.finish(false);
    tracker.finish(false);
  });
  const unmatched = events.find(event => event.itemId === "unmatched")!;
  assert.equal(unmatched.durationMs, undefined);
  assert.equal(unmatched.startObserved, false);
  const finishes = events.filter(event => event.stage === "codex.stream.interrupted");
  assert.equal(finishes[0].pendingItems, 128);
  assert.equal(finishes[0].untrackedItemStarts, 72);
  assert.equal(finishes[1].pendingItems, 0);
  assert.doesNotMatch(JSON.stringify(events), /query-secret/);
});

test("consecutive same-chat requests expose lock wait on their own trace", async t => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const firstStarted = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  const { engine, events, trace } = setup(t, async function* () {
    calls++;
    if (calls === 1) { entered(); await blocked; }
    yield { type: "item.completed", item: { id: "answer", type: "agent_message", text: "ok" } };
    yield { type: "turn.completed", usage };
  });
  const secondEvents: Record<string, unknown>[] = [];
  const secondTrace = createMessageTrace("chat", "second", event => secondEvents.push(event));
  const first = runWithTrace(trace, () => engine.reply("account", request, noController));
  await firstStarted;
  const second = runWithTrace(secondTrace, () => engine.reply("account", { ...request, messageId: "second" }, noController));
  assert.equal(stage(secondEvents, "codex.chat_lock.wait.start").queued, true);
  assert.equal(secondEvents.some(event => event.stage === "codex.chat_lock.wait.end"), false);
  assert.equal(stage(events, "codex.chat_lock.wait.start").queued, false);
  release();
  await Promise.all([first, second]);
  assert.equal(stage(secondEvents, "codex.chat_lock.wait.end").traceId, secondTrace.traceId);
  assert.equal(stage(secondEvents, "codex.chat_lock.wait.end").outcome, "ok");
  assert.equal(calls, 2);
});
