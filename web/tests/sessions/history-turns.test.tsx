import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { HistoryTurn } from "../../src/features/sessions/components/HistoryTurn";
import { historyTurns } from "../../src/features/sessions/history-turns";
import { applyHistoryTurnStatuses, mergeHistoryPage } from "../../src/features/sessions/history-page";
import type { HistoryItem } from "../../src/types";

const row = (id: string, kind: HistoryItem["kind"], turnStatus: HistoryItem["turnStatus"] = "completed", turnId = "turn"): HistoryItem => ({ id, kind, turnId, turnStatus, type: kind === "tool" ? "commandExecution" : "agentMessage", text: id, status: kind === "tool" ? "completed" : undefined });
const items = [row("问题", "user"), row("tool-a", "tool"), row("进度说明", "assistant"), row("tool-b", "tool"), row("最终回答", "assistant")];

it("完成轮次只有一个工具摘要，默认不挂载工具，问题与所有助手消息保留", async () => {
  const user = userEvent.setup();
  const { container } = render(<HistoryTurn turn={historyTurns(items, [])[0]} />);
  expect(screen.getByText("问题")).toBeVisible();
  expect(screen.getByText("进度说明")).toBeVisible();
  expect(screen.getByText("最终回答")).toBeVisible();
  const button = screen.getByRole("button", { name: "本轮已完成 · 2 项工具记录 展开" });
  expect(button).toHaveAttribute("aria-expanded", "false");
  expect(container.querySelectorAll(".tool-message")).toHaveLength(0);
  button.focus();
  await user.keyboard("{Enter}");
  expect(button).toHaveAttribute("aria-expanded", "true");
  expect(container.querySelectorAll(".tool-message")).toHaveLength(2);
  await user.keyboard(" ");
  expect(button).toHaveAttribute("aria-expanded", "false");
  expect(button).toHaveFocus();
});

describe("轮次完成证据", () => {
  it.each([undefined, "inProgress"] as const)("%s不折叠工具，即使所有工具已完成或后面出现助手回答", status => {
    const rows = items.map(item => ({ ...item, turnStatus: status }));
    const { container } = render(<HistoryTurn turn={historyTurns(rows, [])[0]} />);
    expect(container.querySelectorAll(".tool-message")).toHaveLength(2);
  });
  it("terminal轮次准确结束，旧工具状态仍在摘要显式标出，展开可核对", () => {
    const rows = items.map(item => item.id === "tool-b" ? { ...item, status: "waitingForApproval" } : item);
    expect(historyTurns(rows, [])[0].status).toBe("completed");
    const { container } = render(<HistoryTurn turn={historyTurns(rows, [])[0]} />);
    expect(container.querySelectorAll(".tool-message")).toHaveLength(0);
    expect(screen.getByText("1 项待审批")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /项工具记录/ }));
    expect(container.querySelectorAll(".tool-message")).toHaveLength(2);
  });
  it.each(["failed", "interrupted"] as const)("%s默认折叠且失败信息在摘要可读", status => {
    const rows = items.map(item => ({ ...item, turnStatus: status, ...(item.id === "tool-a" ? { status: "failed" } : {}) }));
    render(<HistoryTurn turn={historyTurns(rows, [])[0]} />);
    expect(screen.getByText("1 项失败")).toBeVisible();
    expect(screen.getByRole("button", { name: /项工具记录/ })).toHaveAttribute("aria-expanded", "false");
  });
  it("历史间隙与无turnId记录形成独立段，分页边界不会被推断为完成", () => {
    const grouped = historyTurns([...items, row("older-unknown", "tool", undefined, ""), row("second-unknown", "tool", undefined, "")], ["tool-b"]);
    expect(grouped.map(turn => turn.items.map(item => item.id))).toEqual([["问题", "tool-a", "进度说明"], ["tool-b", "最终回答"], ["older-unknown"], ["second-unknown"]]);
    expect(new Set(grouped.map(turn => turn.key)).size).toBe(4);
  });
  it("前插同轮次旧页保留组key，追加同轮工具也保留展开选择", () => {
    const initial = historyTurns(items.slice(1), [])[0];
    const expanded = historyTurns([...items, row("tool-c", "tool")], [])[0];
    expect(expanded.key).toBe(initial.key);
    const { rerender, container } = render(<HistoryTurn turn={initial} />);
    fireEvent.click(screen.getByRole("button", { name: /项工具记录/ }));
    rerender(<HistoryTurn turn={expanded} />);
    expect(container.querySelectorAll(".tool-message")).toHaveLength(3);
  });
});

it("尾页的准确turn完成状态传播到已保留同轮旧行，metadata只更新精确turnId", () => {
  const current = [row("old-tool", "tool", "inProgress"), row("other", "tool", "inProgress", "other-turn")];
  const merged = mergeHistoryPage(current, [row("final", "assistant")], current.length);
  expect(merged[0].turnStatus).toBe("completed");
  expect(merged[1]).toBe(current[1]);
  const status = applyHistoryTurnStatuses(merged, { "other-turn": "interrupted", absent: "completed" });
  expect(status[1].turnStatus).toBe("interrupted");
  expect(status[0]).toBe(merged[0]);
  expect(applyHistoryTurnStatuses(status, { turn: "inProgress" })[0].turnStatus).toBe("inProgress");
  expect(applyHistoryTurnStatuses(status)).toBe(status);
});

it("展开后严格保留工具与助手进度交错顺序，收起只移除工具", () => {
  const { container } = render(<HistoryTurn turn={historyTurns(items, [])[0]} />);
  fireEvent.click(screen.getByRole("button", { name: /项工具记录/ }));
  expect([...container.querySelectorAll<HTMLElement>("[data-history-id]")].map(element => element.dataset.historyId)).toEqual(items.map(item => item.id));
  fireEvent.click(screen.getByRole("button", { name: /项工具记录/ }));
  expect([...container.querySelectorAll<HTMLElement>("[data-history-id]")].map(element => element.dataset.historyId)).toEqual(["问题", "进度说明", "最终回答"]);
});
it("最新准确inProgress观测覆盖同ID旧completed，不能用旧完成缓存折叠活跃turn", () => {
  const current = [row("old-tool", "tool")];
  const merged = mergeHistoryPage(current, [row("old-tool", "tool", "inProgress")], 0);
  expect(merged[0].turnStatus).toBe("inProgress");
});

it.each([['executing', '1 项状态未完结'], ['declined', '1 项已拒绝'], ['error', '1 项失败']])("摘要与工具详情共用%s状态语义", (status, label) => {
  const rows = [row("tool", "tool")].map(item => ({ ...item, status }));
  render(<HistoryTurn turn={historyTurns(rows, [])[0]} />);
  expect(screen.getByText(label)).toBeVisible();
});

it("新准确inProgress重开曾手动收起的完成轮次；缺turnStatus刷新保留可靠状态", () => {
  const turn = historyTurns(items, [])[0];
  const { rerender, container } = render(<HistoryTurn turn={turn} />);
  const toggle = screen.getByRole("button", { name: /项工具记录/ });
  fireEvent.click(toggle); fireEvent.click(toggle);
  expect(container.querySelectorAll(".tool-message")).toHaveLength(0);
  const active = historyTurns(items.map(item => ({ ...item, turnStatus: "inProgress" })), [])[0];
  rerender(<HistoryTurn turn={active} />);
  expect(container.querySelectorAll(".tool-message")).toHaveLength(2);
  const refreshed = mergeHistoryPage(items, items.map(({ turnStatus: _status, ...item }) => item), items.length);
  expect(refreshed.map(item => item.turnStatus)).toEqual(items.map(item => item.turnStatus));
});
