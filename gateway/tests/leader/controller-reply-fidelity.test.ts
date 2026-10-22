import { directToolController } from "./direct-tool-fixture.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexReplyEngine } from "../../src/leader/codex.js";
import { CONTROL_TOKEN_ENV } from "../../src/leader/control-mcp.js";

test("Controller session titles and checked acknowledgements survive native rewriting and restart", async t => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "controller-reply-fidelity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = { text: "🟢 [微信] 可靠通知交付 · 合并上线 | GPT-6.1-Sol\n已保存，等待原会话接收。", commandId: "command-exact" };
  let controllerCalls = 0, nativeCalls = 0;
  const engine = () => new CodexReplyEngine({ root, model: "test", sdkFactory: sdk => {
    const runStreamed = async () => ({ events: (async function* () {
      nativeCalls++;
      const servers = sdk.config!.mcp_servers as Record<string, Record<string, string>>;
      const response = await fetch(servers.wechat_control.url, { method: "POST", headers: {
        Authorization: `Bearer ${sdk.env![CONTROL_TOKEN_ENV]}`, "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "test_business", arguments: { arguments: {} } } }) });
      assert.equal(response.status, 200);
      await response.text();
      yield { type: "item.completed" as const, item: { type: "agent_message" as const,
        id: "rewritten", text: "可靠交付：已完成全部任务" } };
      yield { type: "turn.completed" as const, usage: { input_tokens: 0, cached_input_tokens: 0,
        cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 } };
    })() });
    return { startThread: () => ({ runStreamed }), resumeThread: () => ({ runStreamed }) };
  } });
  const request = { chatId: "chat", messageId: "message", text: "让原会话检查通知交付" };
  const controller = directToolController(async () => { controllerCalls++; return { result: { saved: true }, reply: original }; });
  assert.deepEqual(await engine().reply("account", request, controller), original);
  assert.deepEqual(await engine().reply("account", request, controller), original);
  assert.deepEqual(await engine().getReply("account", "chat", "message", {
    getMessageReply: async () => { throw new Error("A normal reply must recover locally"); },
  }), original);
  assert.equal(controllerCalls, 1);
  assert.equal(nativeCalls, 1);
});
