import { test } from "node:test";
import assert from "node:assert/strict";
import { projectHistoryItems } from "../../src/leader/history.js";

test("projects public Codex history while filtering private items and bounding text", () => {
  const items = projectHistoryItems([
    { turnId: "turn-1", turnStatus: "completed", item: { id: "private", type: "reasoning", summary: ["secret"], content: [] } },
    { turnId: "turn-1", turnStatus: "completed", item: { id: "user", type: "userMessage", content: [{ type: "text", text: "hello" }] } },
    { turnId: "turn-1", turnStatus: "completed", item: { id: "tool", type: "commandExecution", command: "pwd", status: "completed", aggregatedOutput: "ok" } },
    { turnId: "turn-1", turnStatus: "completed", item: { id: "answer", type: "agentMessage", text: "a".repeat(17_000) } },
  ]);
  assert.deepEqual(items.map(item => item.id), ["user", "tool", "answer"]);
  assert.equal(items[0].kind, "user");
  assert.equal(items[1].title, "pwd");
  assert.equal(items[1].turnStatus, "completed");
  assert.equal(items[2].text.length, 16_000);
  assert.equal(items[2].truncated, true);
  assert.equal(items.every(item => !JSON.stringify(item).includes("secret")), true);
});

test("projects native wrapper metadata and public tool content", () => {
  const items = projectHistoryItems([
    { turnId: "turn-2", turnStatus: "inProgress", startedAtMs: 1_000, completedAtMs: 3_250,
      item: { id: "tool", type: "commandExecution", command: "pwd", status: "completed", aggregatedOutput: "ok" } },
    { turnId: "turn-2", turnStatus: "inProgress", item: { id: "dynamic", type: "dynamicToolCall", tool: "report_progress",
      contentItems: [{ type: "inputText", text: "已检查" }] } },
  ]);
  assert.equal(items[0].turnId, "turn-2");
  assert.equal(items[0].turnStatus, "inProgress");
  assert.equal(items[0].timestamp, "1970-01-01T00:00:03.250Z");
  assert.equal(items[0].durationMs, 2_250);
  assert.equal(items[1].text, "已检查");
});
