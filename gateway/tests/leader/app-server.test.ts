import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { AppServerRejectedError, readAppServerThreadHistory, startAppServerTurn } from "../../src/leader/app-server.js";
import { createMessageTrace, runWithTrace } from "../../src/runtime/telemetry.js";

type FixtureMode = "normal" | "reject" | "lost" | "lateAck" | "failed" | "interrupted" | "turn-fail" | "invalid" | "oversized" | "timeout" | "crash";
async function fixture(context: TestContext, mode: FixtureMode = "normal") {
  const root = await mkdtemp(path.join(os.tmpdir(), "wechat-app-server-"));
  const executable = path.join(root, "codex");
  const log = path.join(root, "protocol.jsonl");
  const source = `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
const mode = ${JSON.stringify(mode)};
const log = ${JSON.stringify(log)};
fs.appendFileSync(log, JSON.stringify({ pid: process.pid, args: process.argv.slice(2), env: process.env }) + '\\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const notify = (method, params) => send({ method, params: { threadId: 'thread-1', turnId: 'turn-1', ...params } });
function complete(status = 'completed') {
  notify('item/completed', { item: { id: 'progress', type: 'agentMessage', text: 'commentary must be hidden', phase: 'commentary' } });
  notify('item/started', { item: { id: 'cmd', type: 'commandExecution', command: 'true', status: 'inProgress' } });
  notify('item/completed', { item: { id: 'cmd', type: 'commandExecution', command: 'true', status: 'completed', aggregatedOutput: 'ok', exitCode: 0 } });
  notify('item/completed', { item: { id: 'mcp', type: 'mcpToolCall', server: 'wechat_control', tool: 'report_progress', status: 'completed', arguments: { text: '已检查' }, result: { content: [], structuredContent: { remaining: 2 } } } });
  notify('item/completed', { item: { id: 'patch', type: 'fileChange', status: 'completed', changes: [{ path: 'task.md', kind: { type: 'update', move_path: null } }] } });
  notify('item/completed', { item: { id: 'search', type: 'webSearch', action: { query: 'current docs' } } });
  notify('item/completed', { item: { id: 'reason', type: 'reasoning', summary: ['checked'], content: [] } });
  notify('item/started', { item: { id: 'compact', type: 'contextCompaction' } });
  notify('item/completed', { item: { id: 'compact', type: 'contextCompaction' } });
  notify('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 10, cachedInputTokens: 4, cacheWriteInputTokens: 1, outputTokens: 8, reasoningOutputTokens: 2 } } });
  notify('item/completed', { item: { id: 'answer', type: 'agentMessage', text: 'final answer', phase: 'final_answer' } });
  notify('turn/completed', { turn: { id: 'turn-1', status } });
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  fs.appendFileSync(log, JSON.stringify(message) + '\\n');
  if (message.method === 'initialize') {
    if (mode === 'timeout') return;
    if (mode === 'crash') { console.error('secret-do-not-expose'); process.exit(9); }
    send({ id: message.id, result: {} });
  }
  if (message.method === 'thread/start' || message.method === 'thread/resume') send({ id: message.id, result: { thread: { id: 'thread-1' } } });
  if (message.method === 'turn/start') {
    if (mode === 'turn-fail') return send({ id: message.id, error: { code: -32000, message: 'synthetic turn failure' } });
    send({ id: message.id, result: { turn: { id: 'turn-1' } } });
    if (mode === 'failed' || mode === 'interrupted') complete(mode);
    if (mode === 'invalid') process.stdout.write('not json\\n');
    if (mode === 'oversized') process.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));
  }
  if (message.method === 'turn/steer') {
    if (mode === 'reject') return send({ id: message.id, error: { code: -32602, message: 'secret-do-not-expose' } });
    if (mode === 'lost') { console.error('secret-do-not-expose'); process.exit(8); }
    if (mode === 'lateAck') { complete(); return setTimeout(() => send({ id: message.id, result: { turnId: 'turn-1' } }), 100); }
    send({ id: message.id, result: { turnId: 'turn-1' } });
    complete();
  }
});
setInterval(() => {}, 1000);
`;
  await writeFile(executable, source, { mode: 0o700 });
  context.after(() => rm(root, { recursive: true, force: true }));
  return { executable, log, async records() {
    return (await readFile(log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  } };
}

function assertExited(pid: number): void {
  assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
}

test("native protocol initializes, preserves permission profiles, steers the current turn and maps final events", async context => {
  const fake = await fixture(context);
  const abort = new AbortController();
  const telemetry: Array<Record<string, unknown>> = [];
  const trace = createMessageTrace("chat", "message", event => telemetry.push(event));
  const turn = await runWithTrace(trace, () => startAppServerTurn({ codexPathOverride: fake.executable, apiKey: "test-key", baseUrl: "https://api.test/v1",
    env: { HOME: "/chat", CODEX_HOME: "/chat/.codex", PATH: process.env.PATH ?? "", LEADER_TURN_MCP_TOKEN: "mcp-token",
      SHOULD_NOT_LEAK: "secret", OPENAI_API_KEY: "host-key" },
    config: { default_permissions: "wechat_memory", shell_environment_policy: { exclude: ["CODEX_API_KEY"] },
      mcp_servers: { wechat_control: { url: "http://127.0.0.1:1234", enabled_tools: ["report_progress"] } } },
    configOverrides: ['permissions.wechat_memory={filesystem={"/chat"="write"},network={enabled=true}}'] },
  { model: "test-model", workingDirectory: "/chat", sandboxMode: "workspace-write", approvalPolicy: "never",
    modelReasoningEffort: "high", webSearchMode: "live", threadSource: "wechat" }, undefined, "first", abort.signal));
  assert.equal(turn.threadId, "thread-1");
  assert.equal(turn.turnId, "turn-1");
  await turn.steer("follow up", turn.turnId);
  const events = [];
  for await (const event of turn.events) events.push(event);
  await turn.close();
  const records = await fake.records();
  const launch = records[0];
  assert.deepEqual(launch.args.slice(0, 3), ["app-server", "--listen", "stdio://"]);
  assert(launch.args.includes('default_permissions="wechat_memory"'));
  assert(launch.args.includes('mcp_servers={"wechat_control"={"url"="http://127.0.0.1:1234","enabled_tools"=["report_progress"]}}'));
  assert(launch.args.includes('permissions.wechat_memory={filesystem={"/chat"="write"},network={enabled=true}}'));
  assert.equal(launch.env.CODEX_API_KEY, "test-key");
  assert.equal(launch.env.LEADER_TURN_MCP_TOKEN, "mcp-token");
  assert.equal(launch.env.SHOULD_NOT_LEAK, undefined);
  assert.equal(launch.env.OPENAI_API_KEY, undefined);
  assert.equal(launch.env.OPENAI_BASE_URL, "https://api.test/v1");
  assert.deepEqual(records.slice(1).map(record => record.method), ["initialize", "initialized", "thread/start", "turn/start", "turn/steer"]);
  assert.equal(records[3].params.sandbox, undefined);
  assert.equal(records[3].params.model, "test-model");
  assert.equal(records[3].params.approvalPolicy, "never");
  assert.equal(records[5].params.expectedTurnId, "turn-1");
  assert.deepEqual(records[5].params.input, [{ type: "text", text: "follow up", text_elements: [] }]);
  assert.deepEqual(events.slice(0, 2), [{ type: "thread.started", thread_id: "thread-1" }, { type: "turn.started" }]);
  const answers = events.filter(event => "item" in event && event.item.type === "agent_message");
  assert.equal(answers.length, 1);
  assert.deepEqual(answers[0], { type: "item.completed", item: { id: "answer", type: "agent_message", text: "final answer" } });
  assert.deepEqual(events.at(-1), { type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4,
    cache_write_input_tokens: 1, output_tokens: 8, reasoning_output_tokens: 2 } });
  assert.deepEqual(telemetry.map(event => event.stage).filter(stage => typeof stage === "string" && stage.includes("context_compaction")),
    ["codex.context_compaction.started", "codex.context_compaction.completed"]);
  assert(events.some(event => "item" in event && event.item.type === "command_execution" && event.item.exit_code === 0));
  assert(events.some(event => "item" in event && event.item.type === "mcp_tool_call" && event.item.tool === "report_progress"));
  assert(events.some(event => "item" in event && event.item.type === "file_change" && event.item.changes[0].kind === "update"));
  assertExited(launch.pid);
  await turn.close();
});

test("history reads use read-only RPCs and return chronological pages", async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wechat-app-history-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "codex");
  await writeFile(executable, `#!${process.execPath}
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send({ id: message.id, result: {} });
  if (message.method === 'thread/read') send({ id: message.id, result: { thread: { id: message.params.threadId } } });
  if (message.method === 'thread/items/list') send({ id: message.id, result: { data: [
    { turnId: 'turn-1', turnStatus: 'completed', item: { id: 'new', type: 'agentMessage', text: 'new' } },
    { turnId: 'turn-1', turnStatus: 'completed', item: { id: 'old', type: 'userMessage', content: [{ type: 'text', text: 'old' }] } }
  ], nextCursor: 'next' } });
});
setInterval(() => {}, 1000);
`, { mode: 0o700 });
  const page = await readAppServerThreadHistory({ codexPathOverride: executable }, "thread-1", { limit: 2 }, new AbortController().signal);
  assert.deepEqual(page.items.map(item => (item.item as { id: string }).id), ["old", "new"]);
  assert.equal(page.nextCursor, "next");
});

test("resume and protocol steer refusals stay distinct from uncertain transport failure", async context => {
  for (const mode of ["reject", "lost"] as const) {
    const fake = await fixture(context, mode);
    const turn = await startAppServerTurn({ codexPathOverride: fake.executable }, {}, "saved-thread", "first", new AbortController().signal);
    await assert.rejects(turn.steer("follow up", "wrong-turn"), AppServerRejectedError);
    await assert.rejects(turn.steer("follow up", turn.turnId), error => {
      assert.equal(error instanceof AppServerRejectedError, mode === "reject");
      assert(!String(error).includes("secret-do-not-expose"));
      return true;
    });
    await turn.close();
    const records = await fake.records();
    assert.equal(records[3].method, "thread/resume");
    assert.equal(records[3].params.threadId, "saved-thread");
    assertExited(records[0].pid);
  }
});

test("persists the thread identity before a failed turn/start response", async context => {
  const fake = await fixture(context, "turn-fail");
  let saved: string | undefined;
  await assert.rejects(
    startAppServerTurn({ codexPathOverride: fake.executable }, {}, undefined, "first", new AbortController().signal,
      threadId => { saved = threadId; }),
    error => !String(error).includes("synthetic turn failure"),
  );
  assert.equal(saved, "thread-1");
  assertExited((await fake.records())[0].pid);
});

test("natural event drain keeps a pending accepted steer alive until its late receipt arrives", async context => {
  const fake = await fixture(context, "lateAck");
  const turn = await startAppServerTurn({ codexPathOverride: fake.executable }, {}, undefined, "first", new AbortController().signal);
  context.after(() => turn.close());
  const steer = turn.steer("follow up", turn.turnId);
  const events = [];
  for await (const event of turn.events) events.push(event);
  assert.equal(events.at(-1)?.type, "turn.completed");
  await steer;
  const pid = (await fake.records())[0].pid;
  assert.equal(process.kill(pid, 0), true);
  await turn.close();
  assertExited(pid);
});

test("failed and interrupted completed notifications never become successful turns", async context => {
  for (const mode of ["failed", "interrupted"] as const) {
    const fake = await fixture(context, mode);
    const turn = await startAppServerTurn({ codexPathOverride: fake.executable }, {}, undefined, "first", new AbortController().signal);
    const events = [];
    for await (const event of turn.events) events.push(event);
    await turn.close();
    assert.equal(events.at(-1)?.type, "turn.failed");
    assertExited((await fake.records())[0].pid);
  }
});

test("abort and early consumer return terminate native processes", async context => {
  for (const abortTurn of [true, false]) {
    const fake = await fixture(context);
    const abort = new AbortController();
    const turn = await startAppServerTurn({ codexPathOverride: fake.executable }, {}, undefined, "first", abort.signal);
    if (abortTurn) {
      abort.abort();
      await assert.rejects(async () => { for await (const _event of turn.events) { /* drain to observe abort */ } }, /aborted/);
    } else { for await (const _event of turn.events) break; }
    await turn.close();
    assertExited((await fake.records())[0].pid);
  }
});

test("malformed, oversized and crashed streams reject with sanitized errors and clean up", async context => {
  for (const mode of ["invalid", "oversized", "crash"] as const) {
    const fake = await fixture(context, mode);
    await assert.rejects(async () => {
      const turn = await startAppServerTurn({ codexPathOverride: fake.executable }, {}, undefined, "first", new AbortController().signal);
      try { for await (const _event of turn.events) { /* drain */ } } finally { await turn.close(); }
    }, error => { assert(!String(error).includes("secret-do-not-expose")); return true; });
    assertExited((await fake.records())[0].pid);
  }
});

test("handshake request timeout cleans up without waiting indefinitely", async context => {
  const fake = await fixture(context, "timeout");
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = startAppServerTurn({ codexPathOverride: fake.executable }, {}, undefined, "first", new AbortController().signal);
  const rejection = assert.rejects(pending, /timed out/);
  context.mock.timers.tick(30_001);
  await rejection;
});
