import { directToolController } from "./direct-tool-fixture.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodexReplyEngine } from "../../src/leader/codex.js";
import { WorkspaceStore } from "../../src/leader/workspace.js";

test("native app-server carries headless tools into new and resumed chats without widening account permissions", async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "native-search-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = path.join(root, "codex.cjs");
  fs.writeFileSync(cli, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
fs.appendFileSync(path.join(process.env.HOME, "sdk-arguments.jsonl"), JSON.stringify({
  args: process.argv.slice(2), home: process.env.HOME, codexHome: process.env.CODEX_HOME,
}) + "\\n");
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  fs.appendFileSync(path.join(process.env.HOME, "native-requests.jsonl"), line + "\\n");
  if (request.method === "initialize") send({ id: request.id, result: {} });
  if (["thread/start", "thread/resume"].includes(request.method)) send({ id: request.id, result: { thread: { id: "native-search-thread" } } });
  if (request.method === "turn/start") {
    send({ id: request.id, result: { turn: { id: "search-turn" } } });
    send({ method: "item/completed", params: { threadId: "native-search-thread", turnId: "search-turn",
      item: { type: "agentMessage", id: "reply", text: "搜索已启用", phase: "final_answer" } } });
    send({ method: "turn/completed", params: { threadId: "native-search-thread", turn: { id: "search-turn", status: "completed" } } });
  }
});
`, { mode: 0o700 });
  const engine = new CodexReplyEngine({ root: path.join(root, "accounts"), model: "test-model",
    codexPath: cli, baseUrl: "https://provider.example.test/v1", apiKey: "synthetic-test-key" });
  const controller = directToolController();
  const request = { chatId: "chat", messageId: "first", text: "用原生网络搜索查一下最新资料" };
  assert.deepEqual(await engine.reply("account-one", request, controller), { text: "搜索已启用" });
  assert.deepEqual(await engine.reply("account-one", { ...request, messageId: "second" }, controller), { text: "搜索已启用" });
  assert.deepEqual(await engine.reply("account-two", request, controller), { text: "搜索已启用" });

  const store = new WorkspaceStore(path.join(root, "accounts"));
  const first = await store.forChat("account-one", "chat");
  const second = await store.forChat("account-two", "chat");
  assert.notEqual(first.workspacePath, second.workspacePath);
  for (const [workspace, expectedCalls] of [[first, 2], [second, 1]] as const) {
    const calls = fs.readFileSync(path.join(workspace.workspacePath, "sdk-arguments.jsonl"), "utf8")
      .trim().split("\n").map(line => JSON.parse(line) as { args: string[]; home: string; codexHome: string });
    assert.equal(calls.length, expectedCalls);
    for (const call of calls) {
      const config = (name: string): unknown => {
        const value = call.args.find(argument => argument.startsWith(`${name}=`))?.slice(name.length + 1);
        assert.ok(value, `Missing native configuration ${name}`);
        return JSON.parse(value.replace(/("[^"]+")=/g, "$1:"));
      };
      assert.ok(call.args.includes('web_search="live"'), "native app-server must receive explicit live search");
      assert.equal((config("model_providers") as Record<string, Record<string, unknown>>).leader_openai.supports_standalone_web_search, true,
        "Responses Lite needs the custom provider capability to expose native web.run");
      const features = config("features") as Record<string, unknown>;
      for (const feature of ["shell_tool", "unified_exec", "shell_snapshot", "skill_search", "view_image", "sleep_tool",
        "multi_agent", "multi_agent_v2", "goals"]) {
        assert.equal(features[feature], true, `${feature} must reach the native CLI`);
      }
      for (const feature of ["browser_use", "browser_use_external", "browser_use_full_cdp_access",
        "browser_annotation_api", "in_app_browser", "in_app_local_automation", "computer_use"]) {
        assert.equal(features[feature], false, `${feature} must remain unavailable on headless hosts`);
      }
      assert.equal((config("agents") as Record<string, unknown>).max_concurrent_threads_per_session, 2);
      assert.equal((config("skills") as Record<string, Record<string, unknown>>).bundled.enabled, false);
      const servers = config("mcp_servers") as Record<string, Record<string, unknown>>;
      assert.equal(servers.openaiDeveloperDocs.url, "https://developers.openai.com/mcp");
      assert.equal(servers.openaiDeveloperDocs.required, false);
      assert.ok(servers.wechat_control.url,
        "Adding Docs must not replace the authenticated Controller bridge");
      assert.equal(call.args.some(arg => /features\.(skills|collaboration_modes|js_repl|context_management)[=.]/.test(arg)), false);
      assert.ok(call.args.includes('default_permissions="wechat_memory"'));
      const permission = call.args.find(arg => arg.startsWith("permissions.wechat_memory="));
      assert.ok(permission);
      assert.ok(permission.includes(`${JSON.stringify(workspace.workspacePath)}="write"`));
      assert.ok(permission.includes(`${JSON.stringify(workspace.codexHome)}="deny"`));
      assert.ok(permission.includes('"/etc/codex/skills"="read"'));
      assert.doesNotMatch(permission, /:root|danger-full-access|extends/);
      assert.equal(call.args.includes("--sandbox"), false, "Search must not replace the isolated permission profile");
      assert.equal(call.home, workspace.workspacePath);
      assert.equal(call.codexHome, workspace.codexHome);
    }
    const requests = fs.readFileSync(path.join(workspace.workspacePath, "native-requests.jsonl"), "utf8")
      .trim().split("\n").map(line => JSON.parse(line) as { method: string; params?: Record<string, unknown> });
    const starts = requests.filter(request => ["thread/start", "thread/resume"].includes(request.method));
    assert.equal(starts[0].method, "thread/start");
    if (expectedCalls === 2) assert.equal(starts[1].method, "thread/resume");
    for (const start of starts) {
      assert.equal(start.params?.approvalPolicy, "never");
      assert.equal(start.params?.sandbox, undefined, "native named profile must not be replaced by a legacy sandbox");
    }
  }
});
