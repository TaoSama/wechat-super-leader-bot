import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryMessage } from "../../src/features/sessions/components/HistoryMessage";
import type { HistoryItem } from "../../src/types";

const COMMAND = "node --input-type=module <<'VERIFY'\n  console.log('中文原始命令', '/workspace/很长的路径');\nVERIFY";
const OUTPUT = "原始工具输出\n  保留缩进\n| 原始 | 文本 |\n<script>neverExecute()</script>";
const TIMESTAMP = "2026-10-19T04:06:00Z";
const tool: HistoryItem = { id: "tool-one", turnId: "turn-one", kind: "tool", type: "commandExecution", title: COMMAND, text: OUTPUT, status: "completed", timestamp: TIMESTAMP };
let mobile = true;
let clipboardDescriptor: PropertyDescriptor | undefined;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mobile = true;
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({ matches: mobile && query === "(max-width: 719px)", media: query,
    addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});
afterEach(() => {
  if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  else Reflect.deleteProperty(navigator, "clipboard");
  vi.unstubAllGlobals();
});

function openCommand() {
  const trigger = screen.getByRole("button", { name: "查看命令详情" });
  trigger.focus();
  fireEvent.click(trigger);
  return { trigger, dialog: screen.getByRole("dialog", { name: "命令详情" }) };
}

describe("手机工具详情", () => {
  it("折叠时不挂载输出，打开后完整保留命令、输出和换行且不执行HTML", () => {
    const { container } = render(<HistoryMessage item={tool} />);
    expect(container.querySelector("pre")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/原始工具输出/)).toBeNull();
    const { dialog } = openCommand();
    expect([...dialog.querySelectorAll("pre, code")].some(element => element.textContent === COMMAND)).toBe(true);
    expect([...dialog.querySelectorAll("pre")].some(element => element.textContent === OUTPUT)).toBe(true);
    expect(dialog.querySelector("script")).toBeNull();
    expect(dialog.querySelector("table")).toBeNull();
  });

  it("关闭详情后卸载大块输出并恢复触发器焦点", async () => {
    const { container } = render(<HistoryMessage item={tool} />);
    const { trigger, dialog } = openCommand();
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭工具详情" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(container.querySelector("pre")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("Escape关闭详情并返回原触发器", async () => {
    render(<HistoryMessage item={tool} />);
    const { trigger, dialog } = openCommand();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it("键盘焦点限制在详情内，关闭后解除页面滚动锁", () => {
    const originalOverflow = document.body.style.overflow;
    render(<HistoryMessage item={tool} />);
    const { dialog } = openCommand();
    expect(within(dialog).getByRole("button", { name: "关闭工具详情" })).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    const first = within(dialog).getByRole("button", { name: "展开工具详情" });
    const last = within(dialog).getByRole("button", { name: "复制工具输出" });
    first.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(first).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "关闭工具详情" }));
    expect(document.body.style.overflow).toBe(originalOverflow);
  });

  it("扩大详情与收起不丢失原始输出", () => {
    render(<HistoryMessage item={tool} />);
    const { dialog } = openCommand();
    fireEvent.click(within(dialog).getByRole("button", { name: "展开工具详情" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "收起工具详情" }));
    expect([...dialog.querySelectorAll("pre")].some(element => element.textContent === OUTPUT)).toBe(true);
  });

  it.each([undefined, "awaitingExternalReview"])("原生状态为%s时不根据成功字样伪造完成", status => {
    const { container } = render(<HistoryMessage item={{ ...tool, status, text: "Tests: 24 passed. completed successfully" }} />);
    expect(screen.getByText("状态未知")).toBeInTheDocument();
    expect(container.querySelector("pre")).toBeNull();
    expect(screen.queryByText("已完成")).toBeNull();
    if (status) {
      const { dialog } = openCommand();
      expect(dialog).toHaveTextContent(status);
    }
  });

  it("同id原生运行状态更新为完成，已打开详情同步更新", () => {
    const { rerender } = render(<HistoryMessage item={{ ...tool, status: "inProgress", text: "第一段输出" }} />);
    expect(screen.getByText("运行中")).toBeInTheDocument();
    const { dialog } = openCommand();
    rerender(<HistoryMessage item={{ ...tool, status: "completed", text: "完整最终输出" }} />);
    expect(screen.getAllByText("已完成").some(element => element.closest("[data-history-id]"))).toBe(true);
    expect(dialog).toHaveTextContent("完整最终输出");
    expect(dialog).not.toHaveTextContent("第一段输出");
  });

  it("原生失败与已裁剪明确可见", () => {
    render(<HistoryMessage item={{ ...tool, status: "failed", truncated: true }} />);
    expect(screen.getByText("失败")).toBeVisible();
    const { dialog } = openCommand();
    expect(dialog).toHaveTextContent(/裁剪/);
  });

  it("未知工具类别保留公开调用标题，缺失状态和空输出不声称完成", () => {
    render(<HistoryMessage item={{ ...tool, type: "futureToolType", title: "公开的新工具调用", status: undefined, text: "" }} />);
    fireEvent.click(screen.getByRole("button", { name: "查看工具详情" }));
    const dialog = screen.getByRole("dialog", { name: "工具详情" });
    expect(dialog).toHaveTextContent("公开的新工具调用");
    expect(dialog).toHaveTextContent("状态未知");
    expect(dialog).toHaveTextContent("没有记录工具输出");
    expect(dialog).not.toHaveTextContent("已完成");
    expect(within(dialog).queryByRole("button", { name: "复制工具输出" })).toBeNull();
  });

  it("复制原始工具输出成功后确认，失败时显示可操作提示", async () => {
    writeText.mockRejectedValueOnce(new Error("Clipboard denied"));
    render(<HistoryMessage item={tool} />);
    const { dialog } = openCommand();
    fireEvent.click(within(dialog).getByRole("button", { name: "复制工具输出" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("复制失败，请选择文本后手动复制");
    expect(writeText).toHaveBeenLastCalledWith(OUTPUT);
    expect(within(dialog).queryByRole("button", { name: "已复制" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "复制工具输出" }));
    await within(dialog).findByRole("button", { name: "已复制" });
    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(writeText).toHaveBeenCalledTimes(2);
  });
});

describe("桌面工具与消息", () => {
  it("两个桌面工具展开后切手机不自动打开浮层，返回桌面收起并释放滚动锁", () => {
    mobile = false;
    const listeners = new Set<() => void>();
    const query = { get matches() { return mobile; }, media: "(max-width: 719px)",
      addEventListener: vi.fn((_event: string, listener: () => void) => listeners.add(listener)),
      removeEventListener: vi.fn((_event: string, listener: () => void) => listeners.delete(listener)) };
    const matchMedia = vi.fn(() => query);
    vi.stubGlobal("matchMedia", matchMedia);
    const originalBodyOverflow = document.body.style.overflow;
    const originalRootOverflow = document.documentElement.style.overflow;
    const { unmount } = render(<><HistoryMessage item={tool} /><HistoryMessage item={{ ...tool, id: "tool-two" }} /></>);
    const triggers = screen.getAllByRole("button", { name: "查看命令详情" });
    triggers.forEach(trigger => fireEvent.click(trigger));
    expect(screen.getAllByRole("region", { name: "命令详情" })).toHaveLength(2);
    expect(matchMedia).toHaveBeenCalledTimes(1);
    expect(query.addEventListener).toHaveBeenCalledTimes(1);
    act(() => { mobile = true; listeners.forEach(listener => listener()); });
    expect(screen.queryAllByRole("dialog")).toHaveLength(0);
    expect(screen.queryAllByRole("region", { name: "命令详情" })).toHaveLength(0);
    triggers.forEach(trigger => expect(trigger).toHaveAttribute("aria-expanded", "false"));
    fireEvent.click(triggers[0]);
    expect(screen.getAllByRole("dialog", { name: "命令详情" })).toHaveLength(1);
    act(() => { mobile = false; listeners.forEach(listener => listener()); });
    expect(screen.queryAllByRole("dialog")).toHaveLength(0);
    expect(screen.queryAllByRole("region", { name: "命令详情" })).toHaveLength(0);
    triggers.forEach(trigger => expect(trigger).toHaveAttribute("aria-expanded", "false"));
    expect(document.body.style.overflow).toBe(originalBodyOverflow);
    expect(document.documentElement.style.overflow).toBe(originalRootOverflow);
    expect(document.body.style.overflow).not.toBe("hidden");
    expect(document.documentElement.style.overflow).not.toBe("hidden");
    unmount();
    expect(query.removeEventListener).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  it("桌面详情在原消息位置按需展开，输出不预先解析为Markdown", async () => {
    mobile = false;
    const { container } = render(<HistoryMessage item={tool} />);
    const trigger = screen.getByRole("button", { name: "查看命令详情" });
    expect(container.querySelector("pre")).toBeNull();
    fireEvent.click(trigger);
    await waitFor(() => expect([...container.querySelectorAll("pre")].some(element => element.textContent === OUTPUT)).toBe(true));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(trigger);
    await waitFor(() => expect(container.querySelector("pre")).toBeNull());
  });

  it.each(["user", "assistant"] as const)("%s消息支持复制原始Markdown且提供真实时间", async kind => {
    const text = "**原始消息**\n\n- 第一项\n- 第二项";
    const { container } = render(<HistoryMessage item={{ id: `message-${kind}`, turnId: "turn", kind, type: kind === "user" ? "userMessage" : "agentMessage", text, timestamp: TIMESTAMP }} />);
    const time = container.querySelector("time");
    expect(time).toHaveAttribute("dateTime", TIMESTAMP);
    const timeButton = screen.getByRole("button", { name: /查看完整时间/ });
    expect(timeButton).toHaveAttribute("title", expect.stringContaining("2026-10-19"));
    fireEvent.click(timeButton);
    expect(screen.getByText(/2026-10-19.*UTC\+8/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "复制消息" }));
    await screen.findByRole("button", { name: "已复制" });
    expect(writeText).toHaveBeenCalledWith(text);
  });

  it("消息复制失败不显示成功，保留可选择的原文", async () => {
    writeText.mockRejectedValueOnce(new Error("Clipboard denied"));
    render(<HistoryMessage item={{ ...tool, kind: "assistant", type: "agentMessage", text: "必须保留的原文" }} />);
    fireEvent.click(screen.getByRole("button", { name: "复制消息" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("复制失败，请选择文本后手动复制");
    expect(screen.getByText("必须保留的原文")).toBeVisible();
    expect(screen.queryByRole("button", { name: "已复制" })).toBeNull();
  });

  it("后一次复制先失败时，较早请求迟到的成功不能覆盖失败提示", async () => {
    let finishFirst!: () => void;
    let rejectSecond!: (error: Error) => void;
    writeText.mockReturnValueOnce(new Promise<void>(resolve => { finishFirst = resolve; }))
      .mockReturnValueOnce(new Promise<void>((_resolve, reject) => { rejectSecond = reject; }));
    render(<HistoryMessage item={{ ...tool, kind: "assistant", type: "agentMessage", text: "并发复制的原文" }} />);
    const copy = screen.getByRole("button", { name: "复制消息" });
    fireEvent.click(copy);
    fireEvent.click(copy);
    expect(writeText).toHaveBeenCalledTimes(2);
    await act(async () => { rejectSecond(new Error("Latest clipboard request denied")); });
    expect(screen.getByRole("alert")).toHaveTextContent("复制失败，请选择文本后手动复制");
    await act(async () => { finishFirst(); });
    expect(screen.getByRole("alert")).toHaveTextContent("复制失败，请选择文本后手动复制");
    expect(screen.queryByRole("button", { name: "已复制" })).toBeNull();
    expect(copy).toHaveAttribute("aria-label", "复制消息");
  });

  it("浏览器不提供剪贴板API时仍明确提示手动复制", async () => {
    Reflect.deleteProperty(navigator, "clipboard");
    render(<HistoryMessage item={{ ...tool, kind: "user", type: "userMessage", text: "保留手动复制入口" }} />);
    fireEvent.click(screen.getByRole("button", { name: "复制消息" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("复制失败，请选择文本后手动复制");
    expect(writeText).not.toHaveBeenCalled();
  });
});
