import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { Codex, type CodexOptions, type ThreadEvent, type TurnOptions } from "@openai/codex-sdk";
import { CodexReplyEngine, type CodexReplyEngineOptions } from "../../src/leader/codex.js";
import { WorkspaceStore } from "../../src/leader/workspace.js";
import { CONTROL_TOKEN_ENV } from "../../src/leader/control-mcp.js";
import { createMessageTrace, runWithTrace } from "../../src/runtime/telemetry.js";
import { StateManager } from "../../src/runtime/state.js";
import { ControllerClient } from "../../src/controller/client.js";
import { ILinkClient } from "../../src/wechat/client.js";
import { WeChatGateway } from "../../src/gateway.js";

const request = { chatId: "chat", messageId: "first", text: "继续当前任务" };
const usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
  output_tokens: 0, reasoning_output_tokens: 0 };
const noController = { listTools: async () => ({ tools: [], instructions: "" }),
  callTool: async (): Promise<never> => { throw new Error("Unexpected controller call"); } };
const noRecovery = { getMessageReply: async (): Promise<never> => { throw new Error("Unexpected controller lookup"); } };
const key = (value: string) => createHash("sha256").update(value).digest("hex");
const TEST_TIMEOUT_MS = 20_000;
const NATIVE_ABORT_TIMEOUT_MS = 500;

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "codex-ready-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function factory(run: (sdk: CodexOptions, input: string, turn: TurnOptions) => AsyncIterable<ThreadEvent>)
  : NonNullable<CodexReplyEngineOptions["sdkFactory"]> {
  return sdk => {
    const runner = { runStreamed: async (input: string, turn: TurnOptions) => ({ events: run(sdk, input, turn) }) };
    return { startThread: () => runner, resumeThread: () => runner };
  };
}

async function* complete(text = "已完成的原文"): AsyncIterable<ThreadEvent> {
  yield { type: "item.completed", item: { type: "agent_message", id: "answer", text } };
  yield { type: "turn.completed", usage };
}

test("durable replies and receipts skip cleanup; same-thread resume waits only for process exit", { timeout: TEST_TIMEOUT_MS }, async t => {
  const root = fixture(t);
  const drain = gate();
  const exit = gate();
  let runs = 0;
  const options = { root, model: "synthetic", codexPath: process.execPath,
    sdkFactory: factory(async function* (_sdk, _input, turn) {
      const current = ++runs;
      yield* complete();
      if (current === 1) {
        await exit.promise;
        turn.onLifecycleEvent?.({ type: "child_exit", elapsedMs: 1, exitCode: 0, signal: null });
        await drain.promise;
      }
    }) };
  const engine = new CodexReplyEngine(options);
  try {
    assert.deepEqual(await engine.reply("account", request, noController), { text: "已完成的原文" });
    const workspace = await new WorkspaceStore(root).forChat("account", request.chatId);
    assert.equal(workspace.getReplyJournal()[key(request.messageId)].stage, "completed");
    let receiptFinished = false;
    let replayFinished = false;
    const receipt = engine.ackReply("account", request.chatId, request.messageId, "accepted")
      .then(() => { receiptFinished = true; });
    const replay = new CodexReplyEngine(options).reply("account", request, noController)
      .then(reply => { replayFinished = true; return reply; });
    const next = engine.reply("account", { ...request, messageId: "second" }, noController);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runs, 1);
    await receipt;
    assert.equal(receiptFinished, true);
    await replay;
    assert.equal(replayFinished, true);
    assert.deepEqual(await engine.getReply("account", request.chatId, request.messageId, noRecovery), { text: "已完成的原文" });
    exit.release();
    assert.deepEqual(await replay, { text: "已完成的原文" });
    assert.deepEqual(await next, { text: "已完成的原文" });
    await engine.ackReply("account", request.chatId, "second", "accepted");
    assert.equal(runs, 2, "resume can start after exit before prior stdio drain; replay never invokes the model");
    drain.release();
    await engine.drain();
    assert.equal(workspace.getReplyJournal()[key(request.messageId)].delivery, "accepted");
  } finally {
    exit.release();
    drain.release();
    await engine.drain();
    await engine.ackReply("account", request.chatId, request.messageId, "accepted");
  }
});

test("app-server cleanup leaves receipts responsive while the next same-thread turn waits", { timeout: TEST_TIMEOUT_MS }, async t => {
  const root = fixture(t);
  const cleanup = gate();
  const closing = gate();
  let runs = 0;
  const engine = new CodexReplyEngine({ root, model: "synthetic", codexPath: process.execPath,
    appServerFactory: async () => {
      const current = ++runs;
      return { threadId: "shared-thread", turnId: `turn-${current}`, events: complete(),
        steer: async () => { throw new Error("No steer expected"); },
        close: async () => { if (current === 1) { closing.release(); await cleanup.promise; } } };
    } });
  try {
    const expected = await engine.reply("account", request, noController);
    await closing.promise;
    const next = engine.reply("account", { ...request, messageId: "second" }, noController);
    await engine.ackReply("account", request.chatId, request.messageId, "accepted");
    assert.deepEqual(await engine.getReply("account", request.chatId, request.messageId, noRecovery), expected);
    assert.equal(await engine.steer("account", { ...request, messageId: "third" }, noController), false);
    assert.equal(runs, 1, "resuming the same thread requires prior app-server close");
    cleanup.release();
    assert.deepEqual(await next, expected);
    await engine.drain();
    assert.equal(runs, 2);
    const workspace = await new WorkspaceStore(root).forChat("account", request.chatId);
    assert.equal(workspace.getReplyJournal()[key(request.messageId)].delivery, "accepted");
  } finally { cleanup.release(); await engine.stop(); }
});

test("cleanup failure cannot replace a durable reply or leak an unhandled rejection", { timeout: TEST_TIMEOUT_MS }, async t => {
  const root = fixture(t);
  const drain = gate();
  const events: Record<string, unknown>[] = [];
  const trace = createMessageTrace(request.chatId, request.messageId, event => events.push(event));
  const engine = new CodexReplyEngine({ root, model: "synthetic", codexPath: process.execPath,
    sdkFactory: factory(async function* () {
      yield* complete();
      await drain.promise;
      throw new Error("cleanup-secret-body");
    }) });
  try {
    const reply = await runWithTrace(trace, () => engine.reply("account", request, noController));
    assert.deepEqual(reply, { text: "已完成的原文" });
    drain.release();
    await engine.drain();
    await engine.ackReply("account", request.chatId, request.messageId, "accepted");
    assert.deepEqual(await engine.getReply("account", request.chatId, request.messageId, noRecovery), reply);
    assert.equal(events.find(event => event.stage === "codex.native.failed")?.replyAlreadyReady, true);
    assert.doesNotMatch(JSON.stringify(events), /cleanup-secret-body/);
  } finally {
    drain.release();
    await engine.ackReply("account", request.chatId, request.messageId, "accepted");
  }
});

test("uncertain or expired receipts block active replays before background cleanup ends", { timeout: TEST_TIMEOUT_MS }, async t => {
  for (const status of ["uncertain", "expired"] as const) {
    const root = fixture(t);
    const cleanup = gate();
    let runs = 0;
    const options = { root, model: "synthetic", codexPath: process.execPath,
      sdkFactory: factory(async function* () {
        runs++;
        yield* complete();
        await cleanup.promise;
      }) };
    const engine = new CodexReplyEngine(options);
    try {
      await engine.reply("account", request, noController);
      await engine.ackReply("account", request.chatId, request.messageId, status);
      await assert.rejects(new CodexReplyEngine(options).reply("account", request, noController), /unavailable/);
      await assert.rejects(engine.getReply("account", request.chatId, request.messageId, noRecovery), /unavailable/);
      assert.equal(runs, 1);
    } finally { cleanup.release(); await engine.stop(); }
  }
});

test("an unfinished native item defers ready until the stream and MCP obligations drain", { timeout: TEST_TIMEOUT_MS }, async t => {
  const root = fixture(t);
  const drain = gate();
  const completed = gate();
  const engine = new CodexReplyEngine({ root, model: "synthetic", codexPath: process.execPath,
    sdkFactory: factory(async function* () {
      yield { type: "item.started", item: { type: "command_execution", id: "running",
        command: "synthetic", aggregated_output: "", status: "in_progress" } };
      yield* complete();
      completed.release();
      await drain.promise;
      yield { type: "item.completed", item: { type: "command_execution", id: "running",
        command: "synthetic", aggregated_output: "", status: "completed", exit_code: 0 } };
    }) });
  let delivered = false;
  const result = engine.reply("account", request, noController).then(reply => { delivered = true; return reply; });
  try {
    await completed.promise;
    assert.equal(delivered, false);
    const workspace = await new WorkspaceStore(root).forChat("account", request.chatId);
    assert.equal(workspace.getReplyJournal()[key(request.messageId)].stage, "started");
    drain.release();
    assert.deepEqual(await result, { text: "已完成的原文" });
  } finally { drain.release(); await result; }
});

test("a disconnected Controller submission must finish before any reply is published", { timeout: TEST_TIMEOUT_MS }, async t => {
  const root = fixture(t);
  const controllerEntered = gate();
  const controllerDone = gate();
  const completed = gate();
  let submission: Promise<PromiseSettledResult<Response>[]> | undefined;
  const engine = new CodexReplyEngine({ root, model: "synthetic", codexPath: process.execPath,
    sdkFactory: factory(async function* (sdk) {
      const server = (sdk.config!.mcp_servers as Record<string, Record<string, string>>).wechat_control;
      submission = Promise.allSettled([fetch(server.url, { method: "POST", headers: {
        Authorization: `Bearer ${sdk.env![CONTROL_TOKEN_ENV]}`, "Content-Type": "application/json",
        Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1,
        method: "tools/call", params: { name: "synthetic_query", arguments: { arguments: {} } } }) })]);
      await controllerEntered.promise;
      yield { type: "item.completed", item: { type: "agent_message", id: "answer", text: "已完成的原文" } };
      completed.release();
      yield { type: "turn.completed", usage };
    }) });
  let delivered = false;
  const result = engine.reply("account", request, { listTools: async () => ({ tools: [{
    name: "synthetic_query", description: "synthetic", inputSchema: { type: "object" as const },
    annotations: { readOnlyHint: true } }], instructions: "" }), callTool: async () => {
    controllerEntered.release();
    await controllerDone.promise;
    return { result: {}, reply: { text: "Controller 原文", commandId: "command-1" } };
  } }).then(reply => { delivered = true; return reply; });
  try {
    await completed.promise;
    assert.equal(delivered, false);
    controllerDone.release();
    assert.deepEqual(await result, { text: "Controller 原文", commandId: "command-1" });
  } finally {
    controllerDone.release();
    await result;
    if (submission) {
      const [settled] = await submission;
      if (settled.status === "fulfilled") assert.equal(settled.value.status, 200);
      else assert.ok(settled.reason instanceof Error, "MCP disconnect must settle as a transport error");
    }
  }
});

test("a durable ready result replaces the work deadline with the cleanup budget", { timeout: TEST_TIMEOUT_MS }, async t => {
  const root = fixture(t);
  const cleanup = gate();
  const cleanupEntered = gate();
  const workBudgetMs = 1000;
  const cleanupBudgetMs = 2000;
  let nativeSignal: AbortSignal | undefined;
  let abortedDuringCleanup = false;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const engine = new CodexReplyEngine({ root, model: "synthetic", codexPath: process.execPath,
    timeoutMs: workBudgetMs, cleanupTimeoutMs: cleanupBudgetMs,
    sdkFactory: factory(async function* (_sdk, _input, turn) {
      nativeSignal = turn.signal;
      yield* complete();
      cleanupEntered.release();
      await cleanup.promise;
      abortedDuringCleanup = turn.signal?.aborted ?? false;
    }) });
  try {
    await engine.reply("account", request, noController);
    await cleanupEntered.promise;
    t.mock.timers.tick(workBudgetMs + 1);
    assert.equal(nativeSignal?.aborted, false, "the completed work deadline must not abort valid cleanup");
    cleanup.release();
    await engine.drain();
    assert.equal(abortedDuringCleanup, false);
  } finally { cleanup.release(); await engine.stop(); }
});

test("cleanup has its own budget while accepted receipts never wait for abort", { timeout: TEST_TIMEOUT_MS }, async t => {
  const root = fixture(t);
  let aborted = false;
  const engine = new CodexReplyEngine({ root, model: "synthetic", codexPath: process.execPath, cleanupTimeoutMs: NATIVE_ABORT_TIMEOUT_MS,
    sdkFactory: factory(async function* (_sdk, _input, turn) {
      yield* complete();
      await new Promise<void>(resolve => {
        if (turn.signal?.aborted) resolve();
        else turn.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      aborted = true;
    }) });
  assert.deepEqual(await engine.reply("account", request, noController), { text: "已完成的原文" });
  await engine.ackReply("account", request.chatId, request.messageId, "accepted");
  assert.equal(aborted, false);
  await engine.drain();
  assert.equal(aborted, true);
  assert.deepEqual(await engine.getReply("account", request.chatId, request.messageId, noRecovery), { text: "已完成的原文" });
});

test("stop rejects admission and waits for tracked cleanup without terminating a normal CLI", { timeout: TEST_TIMEOUT_MS }, async t => {
  const root = fixture(t);
  const cleanup = gate();
  let aborted = false;
  const engine = new CodexReplyEngine({ root, model: "synthetic", codexPath: process.execPath,
    sdkFactory: factory(async function* (_sdk, _input, turn) {
      yield* complete();
      await cleanup.promise;
      aborted = turn.signal?.aborted ?? false;
    }) });
  await engine.reply("account", request, noController);
  const stop = engine.stop();
  let stopped = false;
  void stop.then(() => { stopped = true; });
  try {
    await assert.rejects(engine.reply("account", { ...request, messageId: "after-stop" }, noController), /unavailable/);
    await engine.ackReply("account", request.chatId, request.messageId, "accepted");
    assert.equal(stopped, false);
    cleanup.release();
    await stop;
    assert.equal(aborted, false);
    assert.equal(stopped, true);
    assert.equal(engine.stop(), stop, "repeated stop shares the same tracked drain");
  } finally { cleanup.release(); await stop; }
});

test("stop drains overdue cleanup after the native abort is acknowledged", { timeout: TEST_TIMEOUT_MS }, async t => {
  const root = fixture(t);
  let acknowledged = false;
  const engine = new CodexReplyEngine({ root, model: "synthetic", codexPath: process.execPath,
    cleanupTimeoutMs: NATIVE_ABORT_TIMEOUT_MS,
    sdkFactory: factory(async function* (_sdk, _input, turn) {
      yield* complete();
      await new Promise<void>(resolve => {
        if (turn.signal?.aborted) resolve();
        else turn.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      acknowledged = true;
    }) });
  const reply = await engine.reply("account", request, noController);
  await engine.stop();
  assert.equal(acknowledged, true);
  assert.deepEqual(await engine.getReply("account", request.chatId, request.messageId, noRecovery), reply);
});

for (const runner of ["sdk", "app-server"] as const) test(`Gateway sends and checkpoints before its synthetic ${runner} process exits`, { timeout: TEST_TIMEOUT_MS }, async t => {
  const root = fixture(t);
  const releasePath = path.join(root, "release");
  const cliPath = path.join(root, "codex.cjs");
  const nativeEvents = [
    { type: "thread.started", thread_id: "synthetic-thread" },
    { type: "item.completed", item: { type: "agent_message", id: "answer", text: "已完成的原文" } },
    { type: "turn.completed", usage },
  ];
  const recordPid = `fs.writeFileSync(${JSON.stringify(path.join(root, "pid"))}, String(process.pid));`;
  const waitForRelease = `setInterval(() => { if (fs.existsSync(${JSON.stringify(releasePath)})) process.exit(0); }, 10);`;
  fs.writeFileSync(cliPath, `#!${process.execPath}
const fs = require("node:fs");
${runner === "sdk" ? `process.stdin.resume();
process.stdin.on("end", () => {
  ${recordPid}
  for (const event of ${JSON.stringify(nativeEvents)}) process.stdout.write(JSON.stringify(event) + "\\n");
  ${waitForRelease}
});` : `process.on("SIGTERM", () => {});
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "initialize") send({id: message.id, result: {}});
  if (message.method === "thread/start" || message.method === "thread/resume") send({id: message.id, result: {thread: {id: "synthetic-thread"}}});
  if (message.method === "turn/start") {
    ${recordPid}
    send({id: message.id, result: {turn: {id: "synthetic-turn"}}});
    send({method: "item/completed", params: {threadId: "synthetic-thread", turnId: "synthetic-turn", item: {type: "agentMessage", id: "answer", phase: "final_answer", text: "已完成的原文"}}});
    send({method: "turn/completed", params: {threadId: "synthetic-thread", turnId: "synthetic-turn", turn: {id: "synthetic-turn", status: "completed"}}});
    ${waitForRelease}
  }
});`}
`, { mode: 0o700 });
  const credentials = path.join(root, "account.json");
  fs.writeFileSync(credentials, JSON.stringify({ token: "synthetic", accountId: "account" }));
  const state = new StateManager(credentials, path.join(root, "state.json"));
  state.markBaselineEstablished();
  const engine = new CodexReplyEngine({ root: path.join(root, "workspaces"), model: "synthetic",
    codexPath: cliPath, timeoutMs: TEST_TIMEOUT_MS,
    ...(runner === "sdk" ? { sdkFactory: (settings: CodexOptions) => new Codex(settings) } : {}) });
  const controller = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic",
    fetchImpl: async url => {
      if (String(url).endsWith("/v1/tools/list")) return new Response(JSON.stringify({ tools: [], instructions: "", context: { history: [], memories: {} } }));
      assert.ok(String(url).endsWith("/v1/chats/authorize"));
      return new Response(JSON.stringify({ allowed: true }));
    } });
  let sent = 0;
  const ilink = new ILinkClient({ stateManager: state, configuredBaseUrl: "https://ilink.example",
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("getupdates")) return new Response(JSON.stringify({ ret: 0,
        get_updates_buf: "after-ready", msgs: [{ message_type: 1, from_user_id: request.chatId,
          client_id: request.messageId, context_token: "synthetic", create_time_ms: Date.now(),
          item_list: [{ type: 1, text_item: { text: request.text } }] }] }));
      if (String(url).endsWith("getconfig")) return new Response(JSON.stringify({ ret: 0, typing_ticket: "synthetic" }));
      if (String(url).endsWith("sendtyping")) return new Response(JSON.stringify({ ret: 0 }));
      assert.ok(String(url).endsWith("sendmessage"));
      sent++;
      assert.equal(JSON.parse(String(init?.body)).msg.item_list[0].text_item.text, "已完成的原文");
      const workspace = await new WorkspaceStore(path.join(root, "workspaces")).forChat("account", request.chatId);
      assert.equal(workspace.getReplyJournal()[key(request.messageId)].stage, "completed");
      const pid = Number(fs.readFileSync(path.join(root, "pid"), "utf8"));
      process.kill(pid, 0); // The CLI must still be alive when WeChat accepts the reply.
      return new Response(JSON.stringify({ ret: 0 }));
    } });
  const gateway = new WeChatGateway({ stateManager: state, ilink, controller, replyEngine: engine });
  try {
    assert.equal((await gateway.pollOnce()).processedCount, 1);
    assert.equal(sent, 1);
    assert.equal(state.syncBuf, "after-ready");
    assert.deepEqual(state.outbox, {});
    const pid = Number(fs.readFileSync(path.join(root, "pid"), "utf8"));
    process.kill(pid, 0); // pollOnce, receipt and checkpoint finish while CLI cleanup is pending.
    fs.writeFileSync(releasePath, "release");
    await engine.drain();
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    const workspace = await new WorkspaceStore(path.join(root, "workspaces")).forChat("account", request.chatId);
    assert.equal(workspace.getReplyJournal()[key(request.messageId)].delivery, "accepted");
  } finally {
    fs.writeFileSync(releasePath, "release");
    await engine.stop();
    await engine.ackReply("account", request.chatId, request.messageId, "accepted");
  }
});
