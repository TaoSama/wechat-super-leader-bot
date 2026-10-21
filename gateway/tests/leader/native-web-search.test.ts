import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CodexReplyEngine } from "../../src/leader/codex.js";
import { WorkspaceStore } from "../../src/leader/workspace.js";

test("real pinned SDK carries headless tools into new and resumed chats without widening account permissions", async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "native-search-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cli = path.join(root, "codex.cjs");
  fs.writeFileSync(cli, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
fs.appendFileSync(path.join(process.env.HOME, "sdk-arguments.jsonl"), JSON.stringify({
  args: process.argv.slice(2), home: process.env.HOME, codexHome: process.env.CODEX_HOME,
}) + "\\n");
process.stdin.resume();
process.stdin.on("end", () => {
  for (const event of [
    { type: "thread.started", thread_id: "native-search-thread" },
    { type: "item.completed", item: { type: "agent_message", id: "reply", text: "搜索已启用" } },
    { type: "turn.completed", usage: {} },
  ]) process.stdout.write(JSON.stringify(event) + "\\n");
});
`, { mode: 0o700 });
  const engine = new CodexReplyEngine({ root: path.join(root, "accounts"), model: "test-model",
    codexPath: cli, baseUrl: "https://provider.example.test/v1", apiKey: "synthetic-test-key" });
  const controller = { forwardMessage: async () => { throw new Error("Search does not require Controller"); } };
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
      assert.ok(call.args.includes('web_search="live"'), "SDK must pass explicit live search to CLI");
      assert.ok(call.args.includes("model_providers.leader_openai.supports_standalone_web_search=true"),
        "Responses Lite needs the custom provider capability to expose native web.run");
      for (const feature of ["shell_tool", "unified_exec", "shell_snapshot", "skill_search", "view_image", "sleep_tool",
        "multi_agent", "multi_agent_v2", "goals"]) {
        assert.ok(call.args.includes(`features.${feature}=true`), `${feature} must reach the native CLI`);
      }
      for (const feature of ["browser_use", "browser_use_external", "browser_use_full_cdp_access",
        "browser_annotation_api", "in_app_browser", "in_app_local_automation", "computer_use"]) {
        assert.ok(call.args.includes(`features.${feature}=false`), `${feature} must remain unavailable on headless hosts`);
      }
      assert.ok(call.args.includes("agents.max_concurrent_threads_per_session=2"));
      assert.ok(call.args.includes("skills.bundled.enabled=false"));
      assert.ok(call.args.includes('mcp_servers.openaiDeveloperDocs.url="https://developers.openai.com/mcp"'));
      assert.ok(call.args.includes("mcp_servers.openaiDeveloperDocs.required=false"));
      assert.ok(call.args.some(arg => arg.startsWith("mcp_servers.wechat_control.url=")),
        "Adding Docs must not replace the authenticated Controller bridge");
      assert.equal(call.args.some(arg => /features\.(skills|collaboration_modes|js_repl|context_management)[=.]/.test(arg)), false);
      assert.ok(call.args.includes('default_permissions="wechat_memory"'));
      assert.ok(call.args.includes('approval_policy="never"'));
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
    assert.equal(calls[0].args.includes("resume"), false);
    if (expectedCalls === 2) assert.ok(calls[1].args.includes("resume"));
  }
});
