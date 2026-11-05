import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GatewaySettings } from "../../src/settings/service.js";
import { GatewayModelCatalog } from "../../src/settings/models.js";
import { CodexReplyEngine } from "../../src/leader/codex.js";
import { WorkspaceStore } from "../../src/leader/workspace.js";
import { directToolController } from "../leader/direct-tool-fixture.js";
import type { ThreadEvent } from "@openai/codex-sdk";
import { startSettingsServer } from "../../src/settings/server.js";
import { buildLeaderPrompt } from "../../src/leader/prompt.js";
import { historyFixture } from "../leader/history-fixture.js";

async function fixture(t: TestContext, codexPath?: string) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "gateway-settings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const skillsRoot = path.join(root, "deployed-skills");
  fs.mkdirSync(path.join(skillsRoot, "test-skill"), { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, "test-skill", "SKILL.md"), "---\nname: test-skill\ndescription: fixture\n---\nOriginal skill");
  const store = new WorkspaceStore(path.join(root, "chats"));
  const workspace = await store.forChat("account", "chat");
  const catalog = { snapshot: async () => ({ status: "ready", source: "fixture-provider", freshness: "upstream-cache-possible",
    fetchedAt: "2026-10-23T00:00:00Z", cliVersion: "codex-cli fixture", provider: { id: "fixture" }, models: [
      { id: "new-model", displayName: "New model", hidden: false, supportedReasoningEfforts: [{ reasoningEffort: "high" }] },
    ] }), refresh: async () => catalog.snapshot() };
  let engine: CodexReplyEngine | undefined;
  const settings = new GatewaySettings({ root: path.join(root, "settings"), model: "original-model", skillsRoot,
    chatIds: () => ["chat"], workspace: chat => chat === "chat" ? store.findChat("account", chat) : Promise.resolve(undefined),
    withChat: (chat, operation) => engine ? engine.withSettingsChat("account", chat, operation) : operation(),
    catalog: catalog as unknown as GatewayModelCatalog, codexPath });
  return { root, settings, store, workspace, skillsRoot, setEngine: (value: CodexReplyEngine) => { engine = value; } };
}

test("resources edit the actual chat files with isolation, reload and CAS", async t => {
  const f = await fixture(t);
  const listed = await f.settings.list("chat");
  const memory = listed.resources.find(item => item.path === "聊天/preference.md")!;
  const saved = await f.settings.write(memory.id, { chatId: "chat", content: "先给结论", expectedRevision: memory.revision });
  assert.equal(f.workspace.readMemory()["preference.md"].content, "先给结论");
  assert.equal((await f.settings.read(memory.id, "chat")).revision, saved.revision);
  await assert.rejects(f.settings.write(memory.id, { chatId: "chat", content: "stale", expectedRevision: memory.revision }), { status: 409 });
  await assert.rejects(f.settings.read(memory.id, "another-chat"), { status: 403 });
  await assert.rejects(f.settings.read("gateway.Li4vYXV0aC5qc29u"), { status: 400 });
});

test("each native turn actually consumes saved model, effort, SP and immutable skill snapshot", async t => {
  const f = await fixture(t);
  const resources = (await f.settings.list()).resources;
  const prompt = resources.find(item => item.title.includes("静态主体"))!;
  const skill = resources.find(item => item.path.endsWith("SKILL.md"))!;
  await f.settings.write(prompt.id, { content: "Custom system instructions", expectedRevision: prompt.revision });
  await f.settings.write(skill.id, { content: "---\nname: test-skill\ndescription: fixture\n---\nChanged skill", expectedRevision: skill.revision });
  await f.settings.updateModel({ scope: "wechat", model: "new-model", reasoningEffort: "high", expectedRevision: f.settings.modelScope().revision });
  let observedHome = "";
  const engine = new CodexReplyEngine({ root: path.join(f.root, "chats"), model: "original-model", settings: f.settings,
    sdkFactory: sdk => ({ startThread: options => ({ runStreamed: async input => ({ events: (async function* (): AsyncIterable<ThreadEvent> {
      assert.equal(options.model, "new-model");
      assert.equal(options.modelReasoningEffort, "high");
      assert.match(String(input), /^Custom system instructions/);
      assert.match(String(input), /<current_user_message>/);
      observedHome = sdk.env!.HOME;
      const file = path.join(observedHome, ".agents", "skills", "test-skill", "SKILL.md");
      assert.match(fs.readFileSync(file, "utf8"), /Changed skill/);
      assert.match(fs.readFileSync(path.join(f.skillsRoot, "test-skill", "SKILL.md"), "utf8"), /Original skill/);
      const current = await f.settings.read(skill.id);
      await f.settings.write(skill.id, { content: "future skill", expectedRevision: current.revision });
      assert.match(fs.readFileSync(file, "utf8"), /Changed skill/);
      const memory = (await f.settings.list("chat")).resources.find(item => item.path === "聊天/preference.md")!;
      await assert.rejects(f.settings.write(memory.id, { chatId: "chat", content: "concurrent write", expectedRevision: memory.revision }), { status: 409 });
      yield { type: "item.completed", item: { type: "agent_message", id: "answer", text: "done" } };
      yield { type: "turn.completed", usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } };
    })() }) }), resumeThread: () => { throw new Error("Unexpected resume"); } }) });
  f.setEngine(engine);
  assert.deepEqual(await engine.reply("account", { chatId: "chat", messageId: "message", text: "do it" }, directToolController()), { text: "done" });
  await engine.stop();
  assert.equal(fs.existsSync(observedHome), false);
});

test("model settings reject unknown values and stale updates", async t => {
  const f = await fixture(t), revision = f.settings.modelScope().revision;
  await assert.rejects(f.settings.updateModel({ scope: "wechat", model: "unknown", reasoningEffort: null, expectedRevision: revision }), { status: 400 });
  await assert.rejects(f.settings.updateModel({ scope: "wechat", model: "new-model", reasoningEffort: "ultra", expectedRevision: revision }), { status: 400 });
  await f.settings.updateModel({ scope: "wechat", model: "new-model", reasoningEffort: null, expectedRevision: revision });
  await assert.rejects(f.settings.updateModel({ scope: "wechat", model: "new-model", reasoningEffort: "high", expectedRevision: revision }), { status: 409 });
});

test("management HTTP requires Bearer auth and returns real document revisions", async t => {
  const f = await fixture(t);
  const listener = await startSettingsServer({ settings: f.settings, host: "127.0.0.1", port: 0, token: "fixture-controller-token" });
  t.after(() => listener.close());
  const base = `http://127.0.0.1:${(listener.address as { port: number }).port}`;
  assert.equal((await fetch(`${base}/settings`)).status, 401);
  const headers = { Authorization: "Bearer fixture-controller-token", "Content-Type": "application/json" };
  const response = await fetch(`${base}/settings`, { headers });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { chats: { chatId: string }[] }).chats[0].chatId, "chat");
  assert.equal((await fetch(`${base}/settings/models/refresh`, { method: "POST", headers, body: '{"scope":"other"}' })).status, 400);
});

test("leader history is authenticated, bounded, and supports an authorized chat before its first turn", async t => {
  const f = await fixture(t);
  const listener = await startSettingsServer({ settings: f.settings, host: "127.0.0.1", port: 0, token: "fixture-controller-token" });
  t.after(() => listener.close());
  const base = `http://127.0.0.1:${(listener.address as { port: number }).port}`;
  const headers = { Authorization: "Bearer fixture-controller-token" };
  const response = await fetch(`${base}/settings/leader-history?chatId=chat&limit=20`, { headers });
  assert.equal(response.status, 200);
  const payload = await response.json() as Record<string, unknown>;
  assert.equal(payload.threadId, "");
  assert.deepEqual(payload.items, []);
  assert.equal(payload.nextCursor, null);
  assert.equal(payload.truncated, false);
  assert.equal(typeof payload.fetchedAt, "string");
  assert.equal((await fetch(`${base}/settings/leader-history?chatId=chat&unknown=x`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/settings/leader-history?chatId=chat&cursor=opaque`, { headers })).status, 400);
});

test("history HTTP reads only the current native task, extracts original text and preserves pagination, tools and compact events", async t => {
  const original = '真实用户原文\n<current_user_message>{"text":"保留字面标签"}</current_user_message>😀';
  const prompt = buildLeaderPrompt({ "task.md": { content: "private memory", truncated: false },
    "memory.md": { content: "", truncated: false }, "preference.md": { content: "", truncated: false } },
  { chatId: "chat", messageId: "message", text: original }, "private controller ".repeat(2_000), "private system ".repeat(2_000));
  const fake = await historyFixture(t, { itemsPages: {
    "": { data: [
      { turnId: "turn-new", item: { id: "answer", type: "agentMessage", text: "a".repeat(17_000) } },
      { turnId: "turn-new", item: { id: "user", type: "userMessage", content: [{ type: "text", text: prompt }] } },
    ], nextCursor: "older-native-page" },
    "older-native-page": { data: [
      { turnId: "turn-old", item: { id: "compact", type: "contextCompaction", summary: "private compact summary" } },
      { turnId: "turn-old", item: { id: "tool", type: "commandExecution", command: "echo test", aggregatedOutput: "native output", status: "completed" } },
    ], nextCursor: null },
  }, turnPages: { "": { data: [{ id: "turn-new", status: "completed" }, { id: "turn-old", status: "interrupted" }], nextCursor: null } } });
  const f = await fixture(t, fake.executable);
  const threadFile = path.join(f.workspace.workspacePath, ".thread.json");
  const originalState = JSON.stringify({ threadId: "persisted-native-task", lastInputTokens: 250_000, rotateBeforeNext: true });
  fs.writeFileSync(threadFile, originalState, { mode: 0o600 });
  const listener = await startSettingsServer({ settings: f.settings, host: "127.0.0.1", port: 0, token: "fixture-controller-token" });
  t.after(() => listener.close());
  const base = `http://127.0.0.1:${(listener.address as { port: number }).port}/settings/leader-history`;
  const headers = { Authorization: "Bearer fixture-controller-token" };
  const response = await fetch(`${base}?chatId=chat&limit=2`, { headers });
  assert.equal(response.status, 200);
  const latest = await response.json() as { threadId: string; items: Array<{ id: string; text: string; type: string; turnStatus?: string }>;
    nextCursor: string | null; truncated: boolean; turnStatuses?: Record<string, string> };
  assert.equal(latest.threadId, "persisted-native-task");
  assert.deepEqual(latest.items.map(item => item.id), ["user", "answer"]);
  assert.equal(latest.items[0].text, original);
  assert.equal(latest.items[1].text.length, 16_000);
  assert.equal(latest.truncated, true);
  assert.equal(latest.turnStatuses?.["turn-new"], "completed");
  const olderResponse = await fetch(`${base}?chatId=chat&limit=2&cursor=${latest.nextCursor}&historyContext=00000000-0000-4000-8000-000000000001`, { headers });
  assert.equal(olderResponse.status, 200);
  const older = await olderResponse.json() as typeof latest;
  assert.deepEqual(older.items.map(item => item.type), ["commandExecution", "contextCompaction"]);
  assert.equal(older.items[0].text, "native output");
  assert.equal(older.items[1].text, "Context compacted");
  assert(older.items.every(item => item.turnStatus === "interrupted"));
  assert.equal(older.nextCursor, null);
  assert.equal(older.truncated, false);
  assert.equal(fs.readFileSync(threadFile, "utf8"), originalState);
  const records = await fake.records();
  assert(records.filter(record => record.method).every(record =>
    ["initialize", "initialized", "thread/read", "thread/items/list", "thread/turns/list"].includes(record.method!)));
  assert(records.filter(record => record.method?.startsWith("thread/")).every(record => record.params?.threadId === "persisted-native-task"));
});
