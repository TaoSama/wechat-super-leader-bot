import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ExecutionTimeline, formatExecutionDuration } from "../../src/features/sessions/execution-timeline";
import type { HistoryItem } from "../../src/types";

const time = (seconds: number) => new Date(seconds * 1000).toISOString();

function item(overrides: Partial<HistoryItem> & Pick<HistoryItem, "id" | "kind" | "type" | "text">): HistoryItem {
  return { turnId: "turn-1", ...overrides };
}

describe("执行时间线", () => {
  it("汇总轮次状态、阶段和耗时，并在折叠区保留工具调用与返回", () => {
    const items = [
      item({ id: "user", kind: "user", type: "userMessage", text: "检查状态", turnStatus: "completed", timestamp: time(1) }),
      item({ id: "tool", kind: "tool", type: "commandExecution", title: "npm test", text: "24 passed", status: "completed", durationMs: 2500, turnStatus: "completed", timestamp: time(4) }),
      item({ id: "assistant", kind: "assistant", type: "agentMessage", text: "已完成", turnStatus: "completed", timestamp: time(5) }),
    ];
    render(<ExecutionTimeline items={items} source="codex-desktop" now={6000} />);
    expect(screen.getByTestId("execution-timeline")).toHaveTextContent("远端会话历史");
    expect(screen.getByText("第 1 轮")).toBeVisible();
    expect(screen.getByText("已完成", { selector: ".execution-timeline-status" })).toBeVisible();
    expect(screen.getByText("当前阶段：已完成")).toBeVisible();
    expect(screen.getByText("耗时：4 秒")).toBeVisible();
    expect(screen.queryByText("24 passed")).toBeNull();
    const tools = screen.getByText("工具调用与返回 · 1 项");
    fireEvent.click(tools);
    expect(screen.getByText("npm test")).toBeVisible();
    expect(screen.queryByText("24 passed")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "查看命令详情" }));
    expect(screen.getByText("24 passed")).toBeVisible();
  });

  it("进行中的工具显示当前阶段，失败轮次显示可核对的失败原因", () => {
    const active = item({ id: "active-tool", kind: "tool", type: "commandExecution", title: "go test ./...", text: "running", status: "inProgress", turnStatus: "inProgress", timestamp: time(10) });
    render(<ExecutionTimeline items={[active]} source="control-socket" now={13_000} />);
    expect(screen.getByText("当前阶段：工具调用：命令（运行中）")).toBeVisible();
    expect(screen.getByText("耗时：3 秒")).toBeVisible();

    const failed = item({ id: "failed-tool", kind: "tool", type: "commandExecution", title: "deploy", text: "permission denied\nprivate details", status: "failed", turnStatus: "failed", timestamp: time(20) });
    const { rerender } = render(<ExecutionTimeline items={[failed]} source="control-socket" now={21_000} />);
    expect(screen.getByRole("alert")).toHaveTextContent("失败原因：命令失败");
    rerender(<ExecutionTimeline items={[item({ ...failed, text: "" })]} source="control-socket" now={21_000} />);
    expect(screen.getByRole("alert")).toHaveTextContent("失败原因：命令失败");
    expect(screen.getByRole("alert")).not.toHaveTextContent("permission denied");
  });

  it("对未知或不合理耗时明确显示未报告", () => {
    expect(formatExecutionDuration(undefined)).toBe("未报告");
    expect(formatExecutionDuration(-1)).toBe("未报告");
    expect(formatExecutionDuration(0)).toBe("<1 秒");
    expect(formatExecutionDuration(90_000)).toBe("1.5 分钟");
    const row = item({ id: "unknown", kind: "assistant", type: "agentMessage", text: "没有时间", turnStatus: "completed" });
    render(<ExecutionTimeline items={[row]} source="terminal-transcript" />);
    expect(within(screen.getByTestId("execution-timeline")).getByText("耗时：未报告")).toBeVisible();
  });
});
