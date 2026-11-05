import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ThreadEvent } from "@openai/codex-sdk";
import { CodexReplyEngine, type CodexReplyEngineOptions } from "../../src/leader/codex.js";
import type { DirectToolClient } from "../../src/controller/direct-tools.js";
import { LEADER_SYSTEM_PROMPT } from "../../src/leader/prompt.js";
import { WorkspaceStore } from "../../src/leader/workspace.js";
import { directToolController } from "./direct-tool-fixture.js";

const usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
  output_tokens: 0, reasoning_output_tokens: 0 };
const THREAD_ID = "static-layer-thread";

interface Turn { resume?: string; input: string; developerInstructions?: string }

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "codex-static-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const turns: Turn[] = [];
  const appServerFactory: NonNullable<CodexReplyEngineOptions["appServerFactory"]> =
    async (_options, _thread, resume, input, _signal, onStarted, _images, developerInstructions) => {
      turns.push({ resume, input, developerInstructions });
      await onStarted?.(THREAD_ID);
      return { threadId: THREAD_ID, turnId: `turn-${turns.length}`, close: async () => undefined, steer: async () => undefined,
        events: (async function* (): AsyncIterable<ThreadEvent> {
          yield { type: "turn.started" };
          yield { type: "item.completed", item: { type: "agent_message", id: "final", text: "完成" } };
          yield { type: "turn.completed", usage };
        })() };
    };
  return { root, turns, appServerFactory };
}

function withInstructions(instructions: string): DirectToolClient {
  const base = directToolController();
  return { ...base, listTools: async request => ({ ...await base.listTools(request), instructions }) };
}

test("a new thread gets static layers once as developer instructions and resumed turns omit them", async t => {
  const f = fixture(t);
  const engine = new CodexReplyEngine({ root: f.root, model: "test", codexPath: process.execPath, appServerFactory: f.appServerFactory });
  t.after(() => engine.stop());
  const controller = withInstructions("控制面规则 A");
  await engine.reply("account", { chatId: "chat", messageId: "m1", text: "第一条" }, controller);
  await engine.reply("account", { chatId: "chat", messageId: "m2", text: "第二条" }, controller);

  assert.equal(f.turns[0].resume, undefined);
  assert.ok(f.turns[0].developerInstructions?.startsWith(LEADER_SYSTEM_PROMPT));
  assert.match(f.turns[0].developerInstructions!, /<controller_instructions>控制面规则 A<\/controller_instructions>/);
  assert.equal(f.turns[1].resume, THREAD_ID);
  assert.equal(f.turns[1].developerInstructions, undefined);
  for (const turn of f.turns) {
    assert.ok(turn.input.startsWith("<current_time"));
    assert.doesNotMatch(turn.input, /<controller_instructions>|ALL_TOOLS/);
    assert.match(turn.input, /<current_user_message>[^\n]*<\/current_user_message>$/);
  }
});

test("a thread that predates the record keeps getting the static layers in every turn input", async t => {
  const f = fixture(t);
  const workspace = await new WorkspaceStore(f.root).forChat("account", "chat");
  workspace.setThreadId(THREAD_ID);
  assert.equal(workspace.getThreadState()?.staticLayers, undefined);
  const engine = new CodexReplyEngine({ root: f.root, model: "test", codexPath: process.execPath, appServerFactory: f.appServerFactory });
  t.after(() => engine.stop());
  const send = (messageId: string, instructions: string) =>
    engine.reply("account", { chatId: "chat", messageId, text: messageId }, withInstructions(instructions));
  await send("legacy", "规则 A");
  await send("same", "规则 A");
  await send("changed", "规则 B");

  assert.ok(f.turns.every(turn => turn.resume === THREAD_ID && turn.developerInstructions === undefined));
  // One input turn may not survive compaction, so the static layers ride along on every turn.
  assert.deepEqual(f.turns.map(turn => turn.input.startsWith(LEADER_SYSTEM_PROMPT)), [true, true, true]);
  assert.match(f.turns[1].input, /<controller_instructions>规则 A<\/controller_instructions>/);
  assert.match(f.turns[2].input, /<controller_instructions>规则 B<\/controller_instructions>/);
  assert.equal(workspace.getThreadState()?.staticLayers?.source, "input");
  // Usage bookkeeping and a repeated save of the same thread keep the record; a new thread drops it.
  const recorded = workspace.getThreadState()?.staticLayers;
  workspace.recordThreadUsage(10);
  workspace.setThreadId(THREAD_ID);
  assert.deepEqual(workspace.getThreadState()?.staticLayers, recorded);
  workspace.setThreadId("another-thread");
  assert.equal(workspace.getThreadState()?.staticLayers, undefined);
});

test("a thread started with developer instructions switches to turn input for good once the revision changes", async t => {
  const f = fixture(t);
  const engine = new CodexReplyEngine({ root: f.root, model: "test", codexPath: process.execPath, appServerFactory: f.appServerFactory });
  t.after(() => engine.stop());
  const send = (messageId: string, instructions: string) =>
    engine.reply("account", { chatId: "chat", messageId, text: messageId }, withInstructions(instructions));
  await send("start", "规则 A");
  await send("same", "规则 A");
  await send("changed", "规则 B");
  await send("after-change", "规则 B");
  await send("back", "规则 A");

  assert.match(f.turns[0].developerInstructions ?? "", /规则 A/);
  assert.ok(f.turns.slice(1).every(turn => turn.resume === THREAD_ID && turn.developerInstructions === undefined));
  assert.deepEqual(f.turns.map(turn => turn.input.startsWith(LEADER_SYSTEM_PROMPT)), [false, false, true, true, true]);
  assert.match(f.turns[3].input, /<controller_instructions>规则 B<\/controller_instructions>/);
  const workspace = await new WorkspaceStore(f.root).forChat("account", "chat");
  assert.equal(workspace.getThreadState()?.staticLayers?.source, "input");
});
