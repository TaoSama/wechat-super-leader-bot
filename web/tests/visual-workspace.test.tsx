import { emptyGoals, emptyExecutions  } from "./status-fixtures";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../src/App";
import { resetAuthHelperForTesting } from "../src/auth";
import { CommandRecord, ControlPlaneStatusResponse, ScopedSession } from "../src/types";
import { CommandsSection } from "../src/components/CommandsSection";
import userEvent from "@testing-library/user-event";

const session: ScopedSession = { id: "session-one", nodeId: "local", provider: "codex-app", title: "整理项目的下一步", cwd: "/workspace/editorial-project", status: "idle", loaded: true, capabilities: ["read", "send"], model: "gpt-6.1-sol", modelProvider: "openai", reasoningEffort: "high", preview: "已经完成分析，接下来验证边界", observedAt: "2026-10-11T10:00:00Z" };
const second: ScopedSession = { ...session, id: "session-two", nodeId: "remote", title: "检查远程构建", model: "gpt-6-astra", preview: "构建等待确认", cwd: "/remote/build-project" };
const command = (status: CommandRecord["status"], index: number, target = session): CommandRecord => ({ commandId: `command-${index}`, requestId: `request-${index}`, nodeId: target.nodeId, sessionId: target.id, action: "send", prompt: `请求摘要 ${index}`, output: status === "completed" ? "完整输出只在详情中展开" : undefined, status, createdAt: `2026-10-11T10:${String(index).padStart(2, "0")}:00Z`, updatedAt: "2026-10-11T11:00:00Z", expiresAt: "2026-10-11T12:00:00Z" });
const data: ControlPlaneStatusResponse = { goals: emptyGoals(), executions: emptyExecutions(), leaderMode: "model", leaderModel: "leader-config-model", nodes: [session, second].map((value) => ({ nodeId: value.nodeId, connected: true, sessionCount: 1, lastHeartbeat: "2026-10-11T10:00:00Z" })), sessions: [session, second], commands: [command("uncertain", 1), command("failed", 2, second), command("accepted", 3), command("pending", 4), command("completed", 5)] };
const response = (value: unknown) => new Response(JSON.stringify(value));

beforeEach(() => {
  resetAuthHelperForTesting();
  window.history.replaceState(null, "", "/");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/auth/session") return response({ authenticated: true });
    if (url === "/health") return response({ status: "ok" });
    if (url === "/v1/status") return response(data);
    if (url.includes("/history")) return response({ session, historyContext: "cf7e282f-d6d2-4a98-a517-9fb753f2549b", source: "control-socket", items: [{ id: "message-one", turnId: "turn-one", type: "agentMessage", kind: "assistant", text: "可读的历史消息" }], fetchedAt: "2026-10-11T11:00:00Z", nextCursor: null, truncated: false });
    return new Response("{}", { status: 404 });
  }));
});
afterEach(() => { resetAuthHelperForTesting(); vi.unstubAllGlobals(); });

it("会话三行突出标题、最近消息和模型，技术字段在详情中", async () => {
  render(<App />);
  const row = await screen.findByTestId("session-row-local-session-one");
  expect(row.children).toHaveLength(3);
  expect(row).toHaveTextContent(session.title);
  expect(row).toHaveTextContent(session.preview!);
  expect(row).toHaveTextContent("gpt-6.1-sol");
  expect(row).toHaveTextContent("editorial-project");
  expect(row).not.toHaveTextContent("/workspace/");
  expect(row).not.toHaveTextContent("openai");
  fireEvent.click(row);
  await screen.findByText("可读的历史消息");
  const metadata = screen.getByText("会话详情").closest("details")!;
  expect(metadata).not.toHaveAttribute("open");
  expect(within(metadata).getByText(session.cwd)).not.toBeVisible();
  fireEvent.click(within(metadata).getByText("会话详情"));
  expect(within(metadata).getByText(session.cwd)).toBeVisible();
});

it("历史超限提供显式分页入口，选择后标注来源且不发送消息", async () => {
  const baseFetch = vi.mocked(fetch).getMockImplementation()!;
  const calls: string[] = [];
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    calls.push(String(url));
    if (String(url).includes("/history") && !String(url).includes("source=control-socket")) {
      return new Response(JSON.stringify({ code: "history_too_large" }), { status: 413 });
    }
    return baseFetch(url, init);
  });
  render(<App />);
  fireEvent.click(await screen.findByTestId("session-row-local-session-one"));
  fireEvent.click(await screen.findByRole("button", { name: "使用分页历史接口" }));
  await screen.findByText("可读的历史消息");
  expect(screen.getByText(/原生分页历史 · 读取同一会话/)).toBeInTheDocument();
  expect(screen.queryByText("历史超出读取大小限制。")).toBeNull();
  expect(calls.some(url => url.includes("source=control-socket"))).toBe(true);
  expect(calls.some(url => url.includes("/messages"))).toBe(false);
});

it("已有旧页游标时最新页413停止近顶自动加载，保留手动旧页重试", async () => {
  const baseFetch = vi.mocked(fetch).getMockImplementation()!;
  const historyCalls: string[] = [];
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const path = String(url);
    if (!path.includes("/history")) return baseFetch(url, init);
    historyCalls.push(path);
    if (historyCalls.length === 2) {
      return new Response(JSON.stringify({ code: "history_too_large" }), { status: 413 });
    }
    const older = path.includes("cursor=older");
    return response({ session, historyContext: "cf7e282f-d6d2-4a98-a517-9fb753f2549b", source: "control-socket",
      items: [{ id: older ? "old-message" : "message-one", turnId: "turn-one", type: "agentMessage", kind: "assistant", text: older ? "手动加载的旧消息" : "可读的历史消息" }],
      fetchedAt: "2026-10-11T11:00:00Z", nextCursor: older ? null : "older", truncated: false });
  });
  render(<App />);
  fireEvent.click(await screen.findByTestId("session-row-local-session-one"));
  await screen.findByText("可读的历史消息");
  fireEvent.click(screen.getByRole("button", { name: "刷新会话历史" }));
  await screen.findByText("历史超出读取大小限制。");
  expect(historyCalls).toHaveLength(2);
  const history = screen.getByLabelText("会话历史");
  history.scrollTop = 20;
  await act(async () => { fireEvent.scroll(history); fireEvent.scroll(history); });
  expect(historyCalls).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "加载更早的消息" }));
  await screen.findByText("手动加载的旧消息");
  expect(historyCalls).toHaveLength(3);
  expect(historyCalls[2]).toContain("cursor=older");
  expect(historyCalls[2]).toContain("historyContext=cf7e282f-d6d2-4a98-a517-9fb753f2549b");
});

it("机器和模型搜索可以交叉筛选，并提供匹配为空的反馈", async () => {
  render(<App />);
  await screen.findByTestId("session-row-local-session-one");
  fireEvent.change(screen.getByLabelText("筛选机器"), { target: { value: "remote" } });
  expect(screen.queryByTestId("session-row-local-session-one")).toBeNull();
  expect(screen.getByTestId("session-row-remote-session-two")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("搜索会话"), { target: { value: "gpt-6.1-sol" } });
  expect(screen.getByText("未匹配到符合条件的宿主会话")).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("筛选机器"), { target: { value: "" } });
  expect(screen.getByTestId("session-row-local-session-one")).toBeInTheDocument();
  expect(screen.queryByTestId("session-row-remote-session-two")).toBeNull();
});

it("紧凑机器与状态筛选保留原生选择语义、Tab焦点和选中后的控件身份", async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByTestId("session-row-local-session-one");
  const machine = screen.getByRole("combobox", { name: "筛选机器" });
  expect(machine.tagName).toBe("SELECT");
  expect(machine).toHaveClass("filter-select");
  screen.getByRole("textbox", { name: "搜索会话" }).focus();
  await user.tab();
  expect(machine).toHaveFocus();
  await user.selectOptions(machine, "remote");
  expect(machine).toHaveValue("remote");
  expect(machine).toHaveFocus();
  expect(screen.getByRole("combobox", { name: "筛选机器" })).toBe(machine);
  expect(screen.queryByTestId("session-row-local-session-one")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Super Leader" }));
  const status = screen.getByRole("combobox", { name: "按指令状态过滤" });
  expect(status.tagName).toBe("SELECT");
  expect(status).toHaveClass("filter-select");
  await user.selectOptions(status, "uncertain");
  expect(status).toHaveFocus();
  expect(status).toHaveValue("uncertain");
  expect(screen.getByRole("combobox", { name: "按指令状态过滤" })).toBe(status);
  expect(screen.getByTestId("command-item-command-1")).toBeInTheDocument();
  expect(screen.queryByTestId("command-item-command-3")).toBeNull();
});

it("Leader按注意事项、进行中、完成分组且筛选不混淆执行状态", async () => {
  render(<App />);
  await screen.findByTestId("session-row-local-session-one");
  fireEvent.click(screen.getByRole("button", { name: "Super Leader" }));
  expect(screen.getByRole("button", { name: "Super Leader" })).toHaveAttribute("aria-current", "page");
  expect(screen.getByRole("region", { name: "需要处理" })).toHaveTextContent("不确定，需核验，勿自动重发");
  expect(within(screen.getByRole("region", { name: "执行中" })).getByTestId("command-status-command-3")).toHaveTextContent("已受理");
  expect(within(screen.getByRole("region", { name: "最近完成" })).getByTestId("command-status-command-5")).toHaveTextContent("执行完成");
  expect(screen.getByRole("region", { name: "Leader 运行模式" })).toHaveTextContent("leader-config-model");
  fireEvent.change(screen.getByLabelText("按指令状态过滤"), { target: { value: "uncertain" } });
  expect(screen.getByTestId("command-item-command-1")).toBeInTheDocument();
  expect(screen.queryByTestId("command-item-command-3")).toBeNull();
  expect(screen.queryByRole("region", { name: "最近完成" })).toBeNull();
});

it("Leader完整回执默认折叠，节点筛选和回到原会话保留草稿", async () => {
  render(<App />);
  fireEvent.click(await screen.findByTestId("session-row-local-session-one"));
  await screen.findByText("可读的历史消息");
  fireEvent.change(screen.getByLabelText("发送给当前会话"), { target: { value: "继续这段草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "Super Leader" }));
  const completed = screen.getByTestId("command-item-command-5");
  const output = within(completed).getByText("完整输出只在详情中展开");
  expect(output).not.toBeVisible();
  fireEvent.click(within(completed).getByText("指令详情与回执"));
  expect(output).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "按节点 remote 筛选会话与指令" }));
  expect(screen.queryByTestId("command-item-command-1")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "取消筛选节点 remote" }));
  fireEvent.click(within(screen.getByTestId("command-item-command-1")).getByRole("button", { name: session.title }));
  expect(screen.getByRole("button", { name: "会话" })).toHaveAttribute("aria-current", "page");
  await waitFor(() => expect(screen.getByLabelText("发送给当前会话")).toHaveValue("继续这段草稿"));
});

it("流水仅展示最近50条，较早记录不会混入当前分类", () => {
  const commands = Array.from({ length: 55 }, (_, index) => ({ ...command("completed", index), createdAt: new Date(Date.UTC(2026, 9, 11, 10, index)).toISOString() }));
  const { container } = render(<CommandsSection commands={commands} selectedNodeId={null} sessions={[session]} />);
  expect(container.querySelectorAll(".command-row")).toHaveLength(50);
  expect(screen.queryByTestId("command-item-command-4")).toBeNull();
  expect(screen.getByTestId("command-item-command-54")).toBeInTheDocument();
});
