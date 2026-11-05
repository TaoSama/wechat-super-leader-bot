import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { MEMORY_SNAPSHOT_BYTES, WorkspaceStore } from "../../src/leader/workspace.js";
import { agentInstructionsStatus } from "../../src/leader/agent-instructions.js";
import { OLDER_AGENT_INSTRUCTIONS, OLDEST_AGENT_INSTRUCTIONS, PREVIOUS_AGENT_INSTRUCTIONS } from "./agent-instructions-fixture.js";

function fixture(t: TestContext): { root: string; store: WorkspaceStore } {
  const temporary = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "leader-agent-instructions-test-"));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "workspaces");
  return { root, store: new WorkspaceStore(root) };
}
const REVISION_HEADER = /^<!-- default-revision: ([a-f0-9]{64}) -->\n/;
const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const headed = (body: string) => `<!-- default-revision: ${sha256(body)} -->\n${body}`;

test("default agent instructions hold only a per-chat placeholder, not the shared system rules", async t => {
  const { store } = fixture(t);
  const workspace = await store.forChat("account", "chat");
  const file = path.join(workspace.workspacePath, "AGENTS.md");
  const instructions = fs.readFileSync(file, "utf8");
  assert.match(instructions, /本聊天的补充规则/);
  assert.match(instructions, /只对这个微信聊天生效/);
  for (const shared of [/北京时间/, /task\.md/, /citation/, /\*\*强调\*\*/, /已失联/]) assert.doesNotMatch(instructions, shared);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("new agent instructions carry a default revision header that matches their body", async t => {
  const { store } = fixture(t);
  const workspace = await store.forChat("account", "chat");
  const content = fs.readFileSync(path.join(workspace.workspacePath, "AGENTS.md"), "utf8");
  const header = content.match(REVISION_HEADER);
  assert.ok(header);
  assert.equal(sha256(content.slice(header[0].length)), header[1]);
  assert.equal(agentInstructionsStatus(content), "current");
});

test("every unmodified earlier default upgrades once without replacing memory or thread state", async t => {
  const { root, store } = fixture(t);
  const workspace = await store.forChat("account", "chat");
  const instructionsFile = path.join(workspace.workspacePath, "AGENTS.md");
  const updated = fs.readFileSync(instructionsFile, "utf8");
  const previous = [OLDEST_AGENT_INSTRUCTIONS, OLDER_AGENT_INSTRUCTIONS, PREVIOUS_AGENT_INSTRUCTIONS,
    headed(OLDER_AGENT_INSTRUCTIONS), headed(PREVIOUS_AGENT_INSTRUCTIONS)];
  fs.writeFileSync(path.join(workspace.workspacePath, "task.md"), "保留当前任务");
  workspace.setThreadId("preserved-thread");
  for (const content of previous) {
    assert.equal(agentInstructionsStatus(content), "outdated-default");
    fs.writeFileSync(instructionsFile, content);
    const reloaded = await new WorkspaceStore(root).forChat("account", "chat");
    assert.equal(fs.readFileSync(instructionsFile, "utf8"), updated);
    assert.equal(reloaded.readMemory()["task.md"].content, "保留当前任务");
    assert.equal(reloaded.getThreadId(), "preserved-thread");
  }
  const inode = fs.statSync(instructionsFile).ino;
  await new WorkspaceStore(root).forChat("account", "chat");
  assert.equal(fs.readFileSync(instructionsFile, "utf8"), updated);
  assert.equal(fs.statSync(instructionsFile).ino, inode, "already upgraded instructions are not rewritten");
});

test("instructions edited from an older default stay in place and report stale", async t => {
  const { root, store } = fixture(t);
  const workspace = await store.forChat("account", "chat");
  const instructionsFile = path.join(workspace.workspacePath, "AGENTS.md");
  const current = fs.readFileSync(instructionsFile, "utf8");
  for (const body of [OLDEST_AGENT_INSTRUCTIONS, PREVIOUS_AGENT_INSTRUCTIONS]) {
    const edited = `${headed(body)}用户补充规则。\n`;
    fs.writeFileSync(instructionsFile, edited);
    await new WorkspaceStore(root).forChat("account", "chat");
    assert.equal(fs.readFileSync(instructionsFile, "utf8"), edited);
    assert.equal(agentInstructionsStatus(edited), "stale");
  }
  assert.equal(agentInstructionsStatus(`${current}用户补充规则。\n`), "custom");
});

test("custom agent instructions, including customized old templates and large files, are preserved", async t => {
  const { root, store } = fixture(t);
  const customVersions = [
    "# 自定义规则\n\n请使用我定义的输出格式。\n",
    OLDEST_AGENT_INSTRUCTIONS + "\n用户补充规则：保留这段内容。\n",
    PREVIOUS_AGENT_INSTRUCTIONS + "\n用户补充规则：保留这段内容。\n",
    "# 大型自定义规则\n" + "用户内容。".repeat(MEMORY_SNAPSHOT_BYTES),
  ];
  for (const [index, custom] of customVersions.entries()) {
    const chatId = `custom-${index}`;
    const workspace = await store.forChat("account", chatId);
    const instructionsFile = path.join(workspace.workspacePath, "AGENTS.md");
    fs.writeFileSync(instructionsFile, custom);
    const inode = fs.statSync(instructionsFile).ino;
    await new WorkspaceStore(root).forChat("account", chatId);
    assert.equal(fs.readFileSync(instructionsFile, "utf8"), custom);
    assert.equal(fs.statSync(instructionsFile).ino, inode);
  }
});
