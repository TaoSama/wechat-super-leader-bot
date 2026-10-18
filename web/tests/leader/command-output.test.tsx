import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeControlPlaneStatus } from "../../src/api/normalizers";
import { CommandsSection } from "../../src/features/leader/components/CommandsSection";
import type { CommandRecord } from "../../src/types";
import { emptyExecutions, emptyGoals } from "../fixtures/status-fixtures";

const summary: CommandRecord = { commandId: "large-command", requestId: "request", nodeId: "air", sessionId: "original", action: "send", status: "completed", hasOutput: true, outputPreview: "结果摘要", outputTruncated: true, createdAt: "2026-10-18T10:00:00Z", updatedAt: "2026-10-18T10:00:00Z", expiresAt: "2026-10-18T10:10:00Z" };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
function view(commands = [summary]) { return <CommandsSection commands={commands} selectedNodeId={null} statusFilter="completed" onStatusFilterChange={vi.fn()} />; }
function expand(id = summary.commandId) { fireEvent.click(within(screen.getByTestId(`command-item-${id}`)).getByText("指令详情与回执")); }
afterEach(() => vi.unstubAllGlobals());

describe("command results from bounded status metadata", () => {
  it("keeps 50 large-result summaries bounded and reads only the expanded original command without truncating more than 8MiB", async () => {
    const full = `${"文".repeat(3_000_000)}\n\n完整结果末尾`;
    const commands = Array.from({ length: 50 }, (_, index) => ({ ...summary, commandId: `large-${index}`, outputPreview: "文".repeat(512) }));
    const normalized = normalizeControlPlaneStatus({ nodes: [], sessions: [], commands, goals: emptyGoals(), executions: emptyExecutions() }).commands;
    expect(JSON.stringify(normalized).length).toBeLessThan(100_000);
    expect(normalized.every(command => command.output === undefined && command.hasOutput && command.outputTruncated)).toBe(true);
    const fetchMock = vi.fn(async () => response({ ...commands[7], output: full }));
    vi.stubGlobal("fetch", fetchMock);
    render(view(normalized));
    expect(fetchMock).not.toHaveBeenCalled();
    expand("large-7");
    await waitFor(() => expect(screen.queryByText("正在加载完整结果…")).toBeNull());
    await waitFor(() => expect(screen.getByTestId("command-item-large-7").querySelector(".command-output pre")?.textContent?.length).toBe(full.length));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]).toMatchObject(["/v1/commands/large-7", { method: "GET", credentials: "same-origin" }]);
    expect(screen.getByTestId("command-item-large-7").querySelector(".command-output pre")?.textContent).toBe(full);
  });

  it("keeps failed loads explicit and retries only after a user action", async () => {
    const fetchMock = vi.fn(async () => response({}, 502));
    vi.stubGlobal("fetch", fetchMock);
    const page = render(view());
    expand();
    expect(await screen.findByRole("alert")).toHaveTextContent("完整结果加载失败");
    page.rerender(view([{ ...summary }]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(response({ ...summary, output: "完整结果" }));
    fireEvent.click(screen.getByRole("button", { name: "重试加载完整结果" }));
    expect(await screen.findByText("完整结果", { selector: "pre" })).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cancels a read and ignores a late result, while allowing an explicit reload", async () => {
    let complete!: (value: Response) => void;
    let signal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(resolve => { complete = resolve; });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(view());
    expand();
    await screen.findByRole("button", { name: "取消加载" });
    fireEvent.click(screen.getByRole("button", { name: "取消加载" }));
    expect(signal?.aborted).toBe(true);
    expect(screen.getByText("加载已取消，完整结果仍可按需读取。")).toBeVisible();
    await act(async () => complete(response({ ...summary, output: "迟到正文" })));
    expect(screen.queryByText("迟到正文")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "加载完整结果" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => complete(response({ ...summary, output: "重新读取的正文" })));
    expect(screen.getByText("重新读取的正文", { selector: "pre" })).toBeVisible();
  });

  it("does not accept a result for another session", async () => {
    const fetchMock = vi.fn(async () => response({ ...summary, sessionId: "other", output: "其它会话正文" }));
    vi.stubGlobal("fetch", fetchMock);
    render(view());
    expand();
    expect(await screen.findByRole("alert")).toHaveTextContent("完整结果加载失败");
    expect(screen.queryByText("其它会话正文")).toBeNull();
  });

  it("aborts in-flight reads when collapsed or unmounted", async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    }));
    const page = render(view());
    expand();
    await screen.findByRole("button", { name: "取消加载" });
    expand();
    await waitFor(() => expect(signals[0].aborted).toBe(true));
    expand();
    await waitFor(() => expect(signals).toHaveLength(2));
    page.unmount();
    expect(signals[1].aborted).toBe(true);
  });

  it("distinguishes an empty saved result from no result", async () => {
    const fetchMock = vi.fn(async () => response({ ...summary, output: "" }));
    vi.stubGlobal("fetch", fetchMock);
    render(view([{ ...summary, outputPreview: "", outputTruncated: false }]));
    expand();
    expect(await screen.findByText("结果为空。")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never treats an empty terminal-input receipt as execution output", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<CommandsSection commands={[{ ...summary, sessionId: "terminal:fixture", sendRoute: "terminal-pane", status: "input-written", outputPreview: "", outputTruncated: false }]} selectedNodeId={null} statusFilter="ALL" onStatusFilterChange={vi.fn()} />);
    expand();
    expect(screen.queryByText("最终回执 / 返回快照")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
