import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThreadEvent } from "@openai/codex-sdk";
import type { ControllerToolResult } from "../../src/controller/direct-tools.js";
import { CodexReplyEngine, type CodexReplyEngineOptions } from "../../src/leader/codex.js";
import { CONTROL_TOKEN_ENV, redactConsoleCredentials } from "../../src/leader/control-mcp.js";
import { WorkspaceStore } from "../../src/leader/workspace.js";
import { syntheticTool } from "./direct-tool-fixture.js";

const usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0,
  output_tokens: 0, reasoning_output_tokens: 0 };
const request = { chatId: "chat", messageId: "mixed", text: "查看项目状态，并处理我的其他请求" };
const image = { id: "query-image", mime: "image/png" as const, size: 5, sha256: "a".repeat(64) };

function fixture(t: TestContext) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "mixed-reply-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function factory(names: string[], text: string): NonNullable<CodexReplyEngineOptions["sdkFactory"]> {
  return sdk => {
    const runStreamed = async () => ({ events: (async function* (): AsyncIterable<ThreadEvent> {
      const server = (sdk.config!.mcp_servers as Record<string, Record<string, string>>).wechat_control;
      for (const [id, name] of names.entries()) {
        const response = await fetch(server.url, { method: "POST", headers: {
          Authorization: `Bearer ${sdk.env![CONTROL_TOKEN_ENV]}`, "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call",
          params: { name, arguments: { arguments: {} } } }) });
        assert.equal(response.status, 200);
        const content = await response.text();
        assert.doesNotMatch(content, /credential-only-token/);
      }
      yield { type: "item.completed", item: { type: "agent_message", id: "final", text } };
      yield { type: "turn.completed", usage };
    })() });
    return { startThread: () => ({ runStreamed }), resumeThread: () => ({ runStreamed }) };
  };
}

test("mixed query and execution replies retain both native analysis and exact business receipt", async t => {
  const root = fixture(t);
  const receipt = { text: "已向准确会话保存请求，尚未确认执行完成。", commandId: "command-exact", images: [image] };
  const controller = { listTools: async () => ({ tools: ["query", "execute"].map(syntheticTool), instructions: "" }),
    callTool: async ({ name }: { name: string }): Promise<ControllerToolResult> => name === "query"
      ? { result: { active: 3 } } : { result: { saved: true }, reply: receipt } };
  for (const includesReceipt of [false, true]) {
    const native = `当前有三个活跃项目。${includesReceipt ? `\n\n${receipt.text}` : ""}`;
    const engine = new CodexReplyEngine({ root, model: "synthetic", codexPath: process.execPath,
      sdkFactory: factory(["query", "execute"], native) });
    const actual = { ...request, messageId: `mixed-${includesReceipt}` };
    const reply = await engine.reply("account", actual, controller);
    assert.equal(reply.text, `当前有三个活跃项目。\n\n${receipt.text}`);
    assert.equal(reply.commandId, receipt.commandId);
    assert.deepEqual(reply.images, [image]);
    await engine.stop();
    assert.deepEqual(await new CodexReplyEngine({ root, model: "synthetic" }).getReply("account", request.chatId,
      actual.messageId, { getMessageReply: async () => { throw new Error("Normal mixed replies recover locally"); } }), reply);
  }
});

test("mixed console query and image receipts recover exactly without persisting credentials", async t => {
  const root = fixture(t);
  const consoleReply = { text: "控制台：https://console.example/#login=credential-only-token" };
  const image2 = { ...image, id: "execution-image" };
  const responses: Record<string, ControllerToolResult> = {
    query: { result: { active: 3 } },
    console: { result: {}, reply: { ...consoleReply, images: [image] } },
    execute: { result: { saved: true }, reply: { text: "已保存执行请求。", commandId: "command-exact", images: [image2] } },
  };
  const controller = { listTools: async () => ({ tools: Object.keys(responses).map(syntheticTool), instructions: "" }),
    callTool: async ({ name }: { name: string }) => responses[name] };
  const engine = new CodexReplyEngine({ root, model: "synthetic", codexPath: process.execPath,
    sdkFactory: factory(Object.keys(responses), `当前有三个活跃项目。\n\n${redactConsoleCredentials(consoleReply.text)}`) });
  const reply = await engine.reply("account", request, controller);
  assert.equal(reply.text, `当前有三个活跃项目。\n\n${consoleReply.text}\n\n已保存执行请求。`);
  assert.deepEqual(reply.images, [image, image2]);
  assert.equal(reply.commandId, "command-exact");
  await engine.stop();
  const workspace = await new WorkspaceStore(root).forChat("account", request.chatId);
  const persisted = readFileSync(join(workspace.workspacePath, ".replies.json"), "utf8");
  assert.doesNotMatch(persisted, /credential-only-token/);
  const entry = Object.values(workspace.getReplyJournal())[0];
  assert.equal(entry.consoleText, redactConsoleCredentials(consoleReply.text));
  assert.deepEqual(entry.reply?.images, [image, image2]);
  const restarted = new CodexReplyEngine({ root, model: "synthetic" });
  assert.deepEqual(await restarted.getReply("account", request.chatId, request.messageId,
    { getMessageReply: async () => consoleReply }), reply);
  await assert.rejects(restarted.getReply("account", request.chatId, request.messageId,
    { getMessageReply: async () => ({ text: "错误凭证段：https://different.example/#login=credential-only-token" }) }), /unavailable/);
});
