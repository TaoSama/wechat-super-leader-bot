import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThreadEvent } from "@openai/codex-sdk";
import { CodexReplyEngine, type CodexReplyEngineOptions } from "../../src/leader/codex.js";
import { WorkspaceStore } from "../../src/leader/workspace.js";
import { checkGatewayHealth, HealthTracker } from "../../src/runtime/health.js";
import { createMessageTrace, runWithTrace } from "../../src/runtime/telemetry.js";
import { CHAT_AUTHORIZATION_TIMEOUT_MS, CHECKPOINT_MARGIN_MS, DEFAULT_CONTROLLER_MAX_RETRIES,
  DEFAULT_CONTROLLER_TIMEOUT_MS, MAX_CODEX_REQUEST_BUDGET_MS, MAX_CODEX_TURN_TIMEOUT_MS,
  MAX_PROCESSING_PHASE_MS, REPLY_TIMEOUT_MS } from "../../src/runtime/budgets.js";

const request = { chatId: "chat", messageId: "research", text: "深入研究十个方向" };
const controller = { listTools: async () => ({ tools: [], instructions: "" }),
  callTool: async (): Promise<never> => { throw new Error("Unexpected business execution"); } };
const usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
  output_tokens: 0, reasoning_output_tokens: 0 };
const oldDeadlineMs = 300_000;
const immediate = () => new Promise<void>(resolve => setImmediate(resolve));
const key = (value: string) => createHash("sha256").update(value).digest("hex");

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function fixture(t: TestContext, factory: NonNullable<CodexReplyEngineOptions["appServerFactory"]>) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "codex-budget-"));
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const engine = new CodexReplyEngine({ root, model: "synthetic", codexPath: process.execPath, appServerFactory: factory });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, engine };
}

test("research beyond five minutes accepts steer and publishes only after turn and items complete", async t => {
  const entered = gate(), draft = gate(), drafted = gate(), complete = gate(), completed = gate(), settle = gate();
  let signal!: AbortSignal;
  const steers: string[] = [];
  const command = { type: "command_execution" as const, id: "research-tool", command: "synthetic", aggregated_output: "" };
  const f = fixture(t, async (_options, _thread, _id, _input, abort) => {
    signal = abort;
    return { threadId: "research-thread", turnId: "research-turn", close: async () => undefined,
      steer: async (text, expected) => { assert.equal(expected, "research-turn"); steers.push(text); },
      events: (async function* (): AsyncIterable<ThreadEvent> {
        yield { type: "item.started", item: { ...command, status: "in_progress" } };
        entered.release();
        await draft.promise;
        yield { type: "item.completed", item: { type: "agent_message", id: "answer", text: "完整研究结果" } };
        drafted.release();
        await complete.promise;
        yield { type: "turn.completed", usage };
        completed.release();
        await settle.promise;
        yield { type: "item.completed", item: { ...command, status: "completed", exit_code: 0 } };
      })() };
  });
  let published = false;
  const reply = f.engine.reply("account", request, controller).then(result => { published = true; return result; });
  try {
    await entered.promise;
    t.mock.timers.tick(oldDeadlineMs + 1);
    assert.equal(signal.aborted, false);
    assert.equal(published, false);
    assert.equal(await f.engine.steer("account", { ...request, messageId: "supplement", text: "补充来源" }, controller), true);
    assert.equal(steers.length, 1);
    assert.match(steers[0], /补充来源/);
    draft.release();
    await drafted.promise;
    assert.equal(published, false, "native prose alone is not a completed reply");
    t.mock.timers.tick(oldDeadlineMs);
    complete.release();
    await completed.promise;
    assert.equal(published, false, "unfinished native obligations still hold delivery");
    settle.release();
    assert.deepEqual(await reply, { text: "完整研究结果" });
    await f.engine.drain();
    assert.equal(f.engine.hasActiveTurn("account", request.chatId), false);
    const workspace = await new WorkspaceStore(f.root).forChat("account", request.chatId);
    assert.equal(workspace.getReplyJournal()[key(request.messageId)].stage, "completed");
  } finally { draft.release(); complete.release(); settle.release(); await reply; await f.engine.stop(); }
});

test("the thirty minute wall clock cancels unfinished prose, preserves failure and releases the next message", async t => {
  const entered = gate();
  let runs = 0, closes = 0;
  let signal!: AbortSignal;
  const events: Record<string, unknown>[] = [];
  const f = fixture(t, async (_options, _thread, _id, _input, abort) => {
    signal = abort;
    const current = ++runs;
    return { threadId: "research-thread", turnId: `turn-${current}`, close: async () => { closes++; },
      steer: async () => undefined,
      events: (async function* (): AsyncIterable<ThreadEvent> {
        yield { type: "item.completed", item: { type: "agent_message", id: "answer", text: "尚未完成的原生长文" } };
        if (current > 1) { yield { type: "turn.completed", usage }; return; }
        entered.release();
        await new Promise<void>(resolve => abort.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("Synthetic native cancellation");
      })() };
  });
  const trace = createMessageTrace(request.chatId, request.messageId, event => events.push(event));
  const reply = runWithTrace(trace, () => f.engine.reply("account", request, controller));
  await entered.promise;
  t.mock.timers.tick(MAX_CODEX_TURN_TIMEOUT_MS - 1);
  assert.equal(signal.aborted, false);
  // MockTimers invokes callbacks in the tick caller's context, unlike a real timer.
  runWithTrace(trace, () => t.mock.timers.tick(1));
  const failure = await reply;
  await f.engine.drain();
  assert.equal(signal.aborted, true);
  assert.match(failure.text, /没有正常完成/);
  assert.doesNotMatch(failure.text, /原生长文/);
  assert.equal(events.find(event => event.stage === "codex.work.budget_exceeded")?.budgetMs, MAX_CODEX_TURN_TIMEOUT_MS);
  assert.equal(events.find(event => event.stage === "codex.native.incomplete")?.turnCompletedObserved, false);
  const workspace = await new WorkspaceStore(f.root).forChat("account", request.chatId);
  assert.equal(workspace.getReplyJournal()[key(request.messageId)].stage, "failed");
  assert.deepEqual(await f.engine.reply("account", request, controller), failure);
  assert.equal(runs, 1, "recovery must not rerun the research or its business tools");
  assert.deepEqual(await f.engine.reply("account", { ...request, messageId: "next" }, controller), { text: "尚未完成的原生长文" });
  await f.engine.drain();
  assert.equal(runs, 2);
  assert.equal(closes, 2);
  assert.equal(f.engine.hasActiveTurn("account", request.chatId), false);
  await f.engine.stop();
});

test("explicit shutdown after five minutes retains its independent cleanup deadline", async t => {
  const entered = gate();
  let signal!: AbortSignal;
  const f = fixture(t, async (_options, _thread, _id, _input, abort) => {
    signal = abort;
    return { threadId: "research-thread", turnId: "research-turn", close: async () => undefined,
      steer: async () => undefined,
      events: (async function* (): AsyncIterable<ThreadEvent> {
        entered.release();
        await new Promise<void>(resolve => abort.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("Synthetic shutdown");
      })() };
  });
  const reply = f.engine.reply("account", request, controller);
  await entered.promise;
  t.mock.timers.tick(oldDeadlineMs + 1);
  const stopped = f.engine.stop();
  await assert.rejects(f.engine.reply("account", { ...request, messageId: "after-stop" }, controller), /unavailable/);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(40_000);
  await immediate();
  await stopped;
  assert.equal(signal.aborted, true);
  assert.match((await reply).text, /没有正常完成/);
  assert.equal(f.engine.hasActiveTurn("account", request.chatId), false);
});

test("health processing covers bounded research, Controller drain, authorization and delivery", t => {
  const f = fixture(t, async () => { throw new Error("No native turn expected"); });
  const drainMs = DEFAULT_CONTROLLER_TIMEOUT_MS * (DEFAULT_CONTROLLER_MAX_RETRIES + 1);
  assert.equal(f.engine.requestBudgetMs, MAX_CODEX_TURN_TIMEOUT_MS + drainMs);
  assert.equal(f.engine.requestBudgetMs, MAX_CODEX_REQUEST_BUDGET_MS);
  const phaseMs = CHAT_AUTHORIZATION_TIMEOUT_MS + f.engine.requestBudgetMs + REPLY_TIMEOUT_MS + CHECKPOINT_MARGIN_MS;
  assert.equal(phaseMs, MAX_PROCESSING_PHASE_MS);
  const healthPath = path.join(f.root, "health.json");
  const tracker = new HealthTracker(healthPath);
  tracker.startRun();
  tracker.recordMessageStart(phaseMs);
  t.mock.timers.tick(MAX_CODEX_TURN_TIMEOUT_MS + drainMs);
  assert.equal(checkGatewayHealth(healthPath, 0).ok, true, "completed work can still settle and deliver");
  t.mock.timers.tick(phaseMs - MAX_CODEX_REQUEST_BUDGET_MS);
  assert.equal(checkGatewayHealth(healthPath, 0).ok, true);
  t.mock.timers.tick(1);
  assert.equal(checkGatewayHealth(healthPath, 0).reason, "ProcessingDeadlineExceeded");
});
