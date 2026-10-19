// Opt-in synthetic tool history. Uses only public HistoryItem fields.
export const TOOL_HISTORY_MODES = ["disabled", "showcase", "running", "completed", "failed"];

const HISTORY_LENGTH = 30;
const LONG_COMMAND = [
  "node --input-type=module <<'VERIFY_TOOL_HISTORY'",
  "const report = { checks: ['分页锚点', '手机阅读', '原始输出'], preserve: true };",
  ...Array.from({ length: 14 }, (_, index) => `console.log('第 ${index + 1} 项校验', report.checks.join(' / '), '${"/workspace/很长的项目目录".repeat(5)}');`),
  "VERIFY_TOOL_HISTORY",
].join("\n");

export function createToolHistoryFixture(sessionId) {
  let mode = "disabled";
  const observedAt = Date.now();
  const entry = (id, kind, type, text, extra = {}) => ({
    id: `fixture-tool-${id}`, turnId: "fixture-tool-turn", kind, type, text,
    timestamp: new Date(observedAt - (HISTORY_LENGTH - id) * 1000).toISOString(), ...extra,
  });
  const rows = [
    ...Array.from({ length: 16 }, (_, index) => entry(index, index % 2 ? "assistant" : "user", index % 2 ? "agentMessage" : "userMessage", `更早的分页消息 ${index + 1}：此记录用于验证加载更早消息与原阅读位置。`)),
    entry(16, "user", "userMessage", "请核查工具的原始命令、状态和输出。".repeat(35)),
    entry(17, "assistant", "agentMessage", "已经开始核查。\n\n| 检查项 | 结果 |\n| --- | --- |\n| 中文长消息 | 保留完整内容 |\n| 工具详情 | 按需展开 |\n\n```ts\nconst longPath = '/workspace/mobile/history/a-very-long-segment-without-spaces';\n```\n\n[校验说明](https://example.com/verification)"),
    entry(18, "tool", "commandExecution", "完整命令的输出：\n第一行结果\n第二行结果\n保留换行与缩进。", { title: LONG_COMMAND, status: "completed" }),
    entry(19, "tool", "commandExecution", "没有记录原生状态；输出里出现 Tests: 24 passed 也不能据此声称工具已成功。", { title: "pnpm --dir web test" }),
    entry(20, "tool", "commandExecution", "原生状态为 failed。\nError: synthetic verification failure", { title: "pnpm --dir web test --filter mobile", status: "failed" }),
    entry(21, "tool", "commandExecution", "这是未知状态的原始输出。", { title: "node inspect-history.mjs", status: "awaitingExternalReview" }),
    entry(22, "tool", "fileChange", "web/src/styles/history.css\n@@ -1 +1 @@\n-.tool { white-space: normal; }\n+.tool { min-width: 0; }", { title: "File changes", status: "completed" }),
    entry(23, "tool", "mcpToolCall", "公开的工具结果。\n```json\n{\"matched\":3,\"nextCursor\":null}\n```", { title: "documentation / search", status: "completed" }),
    entry(24, "tool", "dynamicToolCall", "动态工具返回的公开文本。", { title: "inspect_session_history", status: "completed" }),
    entry(25, "tool", "webSearch", "移动端工具详情 键盘关闭 可访问性", { title: "Web search", status: "completed" }),
    entry(26, "tool", "functionCallOutput", "| 原始工具输出 | 不应被误解成界面表格 |\n<script>neverExecute()</script>\n    indented output", { title: "Tool result" }),
    entry(27, "tool", "commandExecution", "此输出在公开历史投影时已裁剪；只能查看当前收到的内容。", { title: "node bounded-history-output.mjs", status: "completed", truncated: true }),
    entry(28, "tool", "commandExecution", "", { title: "node live-tool-progress.mjs", status: "inProgress" }),
    entry(29, "assistant", "agentMessage", "这些是合成验收数据。工具状态仅展示记录中的值；运行中工具可以通过 fixture 切换为完成或失败，消息 ID 保持不变。"),
  ];
  return {
    setMode(next) {
      if (!TOOL_HISTORY_MODES.includes(next)) throw new Error("Invalid synthetic tool history mode");
      const historyReset = (mode === "disabled") !== (next === "disabled");
      mode = next;
      return historyReset;
    },
    items(targetSessionId) {
      if (mode === "disabled" || targetSessionId !== sessionId) return null;
      return rows.map(row => row.id !== "fixture-tool-28" ? row : {
        ...row, status: mode === "running" ? "inProgress" : mode === "failed" ? "failed" : "completed",
        text: mode === "running" ? "正在读取第 1 / 3 段记录。" : mode === "failed" ? "Error: synthetic live tool failure" : "读取完成，三段记录均已返回。",
      });
    },
  };
}
