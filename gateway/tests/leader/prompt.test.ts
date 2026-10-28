import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { buildLeaderPrompt } from "../../src/leader/prompt.js";
import { LEADER_MEMORY_INSTRUCTIONS, WorkspaceStore, type MemorySnapshot } from "../../src/leader/workspace.js";

const memory: MemorySnapshot = {
  "task.md": { content: "测试任务", truncated: false },
  "memory.md": { content: "测试事实", truncated: true },
  "preference.md": { content: "测试偏好", truncated: false },
};

test("prompt preserves current Beijing time, snapshot bounds and the immutable user message envelope", t => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T16:00:01Z") });
  const before = structuredClone(memory);
  const request = { chatId: "synthetic-chat", messageId: "synthetic-message", text: '测试 "消息"\n只读' };
  const output = buildLeaderPrompt(memory, request);
  assert.match(output, /2026-01-02 00:00:01 UTC\+08:00/);
  const userJson = output.match(/<current_user_message>(.*?)<\/current_user_message>/s)?.[1];
  assert.deepEqual(JSON.parse(userJson!), { messageId: request.messageId, text: request.text });
  const memoryJson = output.match(/<memory_snapshot>(.*?)<\/memory_snapshot>/s)?.[1];
  assert.deepEqual(JSON.parse(memoryJson!), before);
  assert.deepEqual(memory, before);
  assert.ok(output.includes(LEADER_MEMORY_INSTRUCTIONS));
  assert.match(output, /不能改写或扩展授权/);
  assert.match(output, /普通问答和记忆维护直接处理/);
  assert.match(output, /来源没有时区时，标注时区未知，不猜测/);
  assert.match(output, /不要输出内部 citation 控制标记或工具引用占位符/);
  assert.match(output, /保留正常 Markdown 结构、Markdown 链接的显示文本和完整 URL/);
});

test("prompt keeps console credentials outside both model context envelopes", () => {
  const fixture = structuredClone(memory);
  fixture["task.md"].content = "测试 https://console.invalid/#login=synthetic-memory-secret";
  const output = buildLeaderPrompt(fixture, { chatId: "c", messageId: "m",
    text: "测试 https://console.invalid/#login=synthetic-message-secret" });
  assert.doesNotMatch(output, /synthetic-memory-secret|synthetic-message-secret/);
  assert.match(output, /#login=\[REDACTED\]/);
});

test("prompt batches known control discovery with invocation and retains native waiting and authority rules", () => {
  const output = buildLeaderPrompt(memory, { chatId: "c", messageId: "m", text: "测试查询" });
  assert.match(output, /同一次 exec 中通过 ALL_TOOLS 查找描述相符/);
  assert.match(output, /外层 Codex 统一负责推理、参数选择和结果整合/);
  assert.match(output, /不先打印工具清单或完整 schema/);
  const pragma = output.match(/\/\/ @exec: (\{[^\n]*?\})/)?.[1];
  assert.equal(JSON.parse(pragma!).yield_time_ms, 60_000);
  assert.match(output, /返回运行中 cell 时继续使用原生 wait/);
  assert.match(output, /互不依赖的只读操作.*Promise.allSettled/);
  assert.match(output, /依赖前一步结果的调用、授权核对和状态变更必须依序执行/);
  assert.match(output, /其他原生工具和技能仍按需发现/);
  assert.match(output, /不自动重试/);
  assert.doesNotMatch(output, /mcp__wechat_control__/);
  assert.match(output, /reply.text 已是需要原样交付的业务正文，由 Gateway 交付/);
  assert.match(output, /不为结束本轮机械写入 task.md/);
});

test("previous complete default instructions upgrade once without overwriting memory, thread or custom rules", async t => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "leader-prompt-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new WorkspaceStore(root);
  const workspace = await store.forChat("account", "chat");
  const instructionsFile = path.join(workspace.workspacePath, "AGENTS.md");
  const current = fs.readFileSync(instructionsFile, "utf8");
  assert.ok(current.includes(LEADER_MEMORY_INSTRUCTIONS));
  const previousMemoryInstructions = "此工作目录只属于一个账户和聊天。每轮先读取 task.md、memory.md、preference.md，必要时读取完整文件；每轮完成前维护相关文件，保证下一次恢复仍能继续。";
  const previous = current.replace(LEADER_MEMORY_INSTRUCTIONS, previousMemoryInstructions);
  fs.writeFileSync(instructionsFile, previous);
  fs.writeFileSync(path.join(workspace.workspacePath, "task.md"), "保留测试任务");
  workspace.setThreadId("synthetic-existing-thread");
  const reloaded = await store.forChat("account", "chat");
  assert.equal(fs.readFileSync(instructionsFile, "utf8"), current);
  assert.equal(reloaded.readMemory()["task.md"].content, "保留测试任务");
  assert.equal(reloaded.getThreadId(), "synthetic-existing-thread");
  const inode = fs.statSync(instructionsFile).ino;
  await store.forChat("account", "chat");
  assert.equal(fs.statSync(instructionsFile).ino, inode);
  const custom = `${previous}\n自定义测试约束。\n`;
  fs.writeFileSync(instructionsFile, custom);
  await store.forChat("account", "chat");
  assert.equal(fs.readFileSync(instructionsFile, "utf8"), custom);
});
