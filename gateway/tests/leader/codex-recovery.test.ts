import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ThreadEvent } from "@openai/codex-sdk";
import { CodexReplyEngine, type CodexReplyEngineOptions } from "../../src/leader/codex.js";
import { LeaderWorkspace, WorkspaceStore } from "../../src/leader/workspace.js";

const request = { chatId: "chat", messageId: "message", text: "继续当前工作" };
const usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
  output_tokens: 0, reasoning_output_tokens: 0 };
const noController = { listTools: async () => ({ tools: [], instructions: "" }),
  callTool: async (): Promise<never> => { throw new Error("Unexpected Controller mutation"); } };
const noRecovery = { getMessageReply: async () => { throw new Error("Unexpected Controller recovery"); } };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "codex-recovery-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function factory(run: (input: string) => AsyncIterable<ThreadEvent>): NonNullable<CodexReplyEngineOptions["sdkFactory"]> {
  const runner = { runStreamed: async (input: string) => ({ events: run(input) }) };
  return () => ({ startThread: () => runner, resumeThread: () => runner });
}

async function* complete(text: string): AsyncIterable<ThreadEvent> {
  yield { type: "item.completed", item: { type: "agent_message", id: "a", text } };
  yield { type: "turn.completed", usage };
}

test("failed final journal write never exposes an unrecoverable reply or reruns native work", async t => {
  const root = fixture(t);
  let runs = 0;
  const options = { root, model: "test", sdkFactory: factory(async function* () {
    runs++;
    yield* complete("这个结果尚未可靠保存");
  }) };
  let writes = 0;
  const original = LeaderWorkspace.prototype.setReplyJournal;
  const mocked = t.mock.method(LeaderWorkspace.prototype, "setReplyJournal", function(this: LeaderWorkspace,
    ...args: Parameters<LeaderWorkspace["setReplyJournal"]>) {
    if (++writes === 2) throw new Error("Synthetic final journal failure");
    return original.apply(this, args);
  });
  await assert.rejects(new CodexReplyEngine(options).reply("account", request, noController), /Synthetic final journal failure/);
  mocked.mock.restore();
  const restarted = new CodexReplyEngine(options);
  const recovered = await restarted.getReply("account", "chat", "message", noRecovery);
  assert.match(recovered.text, /没有自动重跑/);
  assert.doesNotMatch(recovered.text, /尚未可靠保存/);
  assert.deepEqual(await restarted.reply("account", request, noController), recovered);
  assert.equal(runs, 1);
  const workspace = await new WorkspaceStore(root).forChat("account", "chat");
  assert.equal(workspace.getReplyJournal()[hash("message")].stage, "started");
});

test("recovery waiting on an active failed final write reads the durable uncertain result", async t => {
  const root = fixture(t);
  let entered!: () => void;
  let release!: () => void;
  const active = new Promise<void>(resolve => { entered = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  let writes = 0;
  const original = LeaderWorkspace.prototype.setReplyJournal;
  t.mock.method(LeaderWorkspace.prototype, "setReplyJournal", function(this: LeaderWorkspace,
    ...args: Parameters<LeaderWorkspace["setReplyJournal"]>) {
    if (++writes === 2) throw new Error("Synthetic final journal failure");
    return original.apply(this, args);
  });
  const engine = new CodexReplyEngine({ root, model: "test", sdkFactory: factory(async function* () {
    entered();
    await proceed;
    yield* complete("未落盘结果");
  }) });
  const first = engine.reply("account", request, noController);
  const rejected = assert.rejects(first, /Synthetic final journal failure/);
  await active;
  const recovery = engine.getReply("account", "chat", "message", noRecovery);
  release();
  await rejected;
  assert.match((await recovery).text, /没有自动重跑/);
  await engine.stop();
});

test("reply, recovery and delivery receipt serialize together without blocking another chat", async t => {
  const root = fixture(t);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  let runs = 0;
  const engine = new CodexReplyEngine({ root, model: "test", sdkFactory: factory(async function* (input) {
    runs++;
    if (input.includes('"text":"继续当前工作"')) { enter(); await blocked; }
    yield* complete("最终原文");
  }) });
  const first = engine.reply("account", request, noController);
  await entered;
  let readFinished = false;
  let ackFinished = false;
  const recovery = engine.getReply("account", "chat", "message", noRecovery).then(reply => { readFinished = true; return reply; });
  const receipt = engine.ackReply("account", "chat", "message", "accepted").then(() => { ackFinished = true; });
  assert.deepEqual(await engine.reply("account", { ...request, chatId: "other", text: "独立聊天" }, noController), { text: "最终原文" });
  assert.equal(readFinished, false);
  assert.equal(ackFinished, false);
  release();
  assert.deepEqual(await first, { text: "最终原文" });
  assert.deepEqual(await recovery, { text: "最终原文" });
  await receipt;
  const workspace = await new WorkspaceStore(root).forChat("account", "chat");
  assert.equal(workspace.getReplyJournal()[hash("message")].delivery, "accepted");
  assert.deepEqual(await engine.getReply("account", "chat", "message", noRecovery), { text: "最终原文" });
  assert.equal(runs, 2);
});

test("legacy unknown started work recovers the same frozen explanation without native execution", async t => {
  const root = fixture(t);
  const workspace = await new WorkspaceStore(root).forChat("account", "chat");
  workspace.setReplyJournal({ [hash("message")]: { inputHash: hash(request.text), stage: "started" } });
  let factories = 0;
  const engine = new CodexReplyEngine({ root, model: "test", sdkFactory: () => {
    factories++;
    throw new Error("Unknown work must not restart");
  } });
  const recovered = await engine.getReply("account", "chat", "message", noRecovery);
  assert.match(recovered.text, /没有自动重跑/);
  assert.deepEqual(await engine.reply("account", request, noController), recovered);
  assert.equal(factories, 0);
});

test("two engine instances sharing a normalized root preserve overlapping replies and receipts", async t => {
  const root = fixture(t);
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let enter!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const seen: string[] = [];
  const sdkFactory = factory(async function* (input) {
    const text = input.includes('"text":"first"') ? "first" : "second";
    seen.push(text);
    if (text === "first") { enter(); await blocked; }
    yield* complete(text);
  });
  const firstEngine = new CodexReplyEngine({ root, model: "test", sdkFactory });
  const secondEngine = new CodexReplyEngine({ root: path.join(root, "nested", ".."), model: "test", sdkFactory });
  const first = firstEngine.reply("account", { ...request, text: "first" }, noController);
  await entered;
  const second = secondEngine.reply("account", { ...request, messageId: "second", text: "second" }, noController);
  const accepted = secondEngine.ackReply("account", "chat", "message", "accepted");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(seen, ["first"]);
  release();
  assert.deepEqual(await first, { text: "first" });
  assert.deepEqual(await second, { text: "second" });
  await accepted;
  const workspace = await new WorkspaceStore(root).forChat("account", "chat");
  const journal = workspace.getReplyJournal();
  assert.equal(Object.keys(journal).length, 2);
  assert.equal(journal[hash("message")].delivery, "accepted");
  assert.equal(journal[hash("second")].delivery, "pending");
  assert.deepEqual(await firstEngine.getReply("account", "chat", "second", noRecovery), { text: "second" });
  assert.deepEqual(seen, ["first", "second"]);
});
