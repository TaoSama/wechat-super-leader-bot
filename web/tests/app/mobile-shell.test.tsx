import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../../src/App";
import { resetAuthHelperForTesting } from "../../src/auth/bootstrap";
import { emptyExecutions, emptyGoals } from "../fixtures/status-fixtures";

const observedAt = new Date().toISOString();
const session = { id: "shell-session", nodeId: "local", provider: "codex-app", title: "继续原会话", cwd: "/workspace/project", status: "idle", loaded: true, model: "gpt-6.1-sol", capabilities: ["read", "send"], observedAt };
const data = { nodes: [{ nodeId: "local", connected: true, sessionCount: 1, lastHeartbeat: observedAt }], sessions: [session], commands: [], goals: emptyGoals(), executions: emptyExecutions() };
const response = (value: unknown) => new Response(JSON.stringify(value));
const automation = { id: "shell-schedule", chatId: "chat-shell", title: "每日项目进度", kind: "session", status: "active", timing: { type: "cron", expression: "0 9 * * *" }, timezone: "Asia/Shanghai", nextAt: Date.now() + 86_400_000 };

beforeEach(() => {
  resetAuthHelperForTesting();
  window.history.replaceState(null, "", "/");
  vi.stubGlobal("matchMedia", vi.fn((media: string) => ({ matches: media.includes("max-width"), media, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    if (input === "/auth/session") return response({ authenticated: true });
    if (input === "/health") return response({ status: "ok" });
    if (input === "/v1/status") return response({ ...data, automations: [automation] });
    if (input === "/v1/automations/shell-schedule/status") return response({ schedule: { ...automation, status: JSON.parse(String(init?.body)).status } });
    if (input.includes("/history")) return response({ session, historyContext: "cf7e282f-d6d2-4a98-a517-9fb753f2549b", source: "control-socket", items: [{ id: "hello", turnId: "one", type: "agentMessage", kind: "assistant", text: "会话消息" }], fetchedAt: observedAt, nextCursor: null, truncated: false });
    return new Response("{}", { status: 404 });
  }));
});
afterEach(() => { resetAuthHelperForTesting(); vi.unstubAllGlobals(); });

it("默认浅色，菜单支持明暗切换、Escape回焦点和外部点击关闭", async () => {
  const { container } = render(<App />);
  await screen.findByTestId("session-row-local-shell-session");
  const shell = container.querySelector(".app-shell")!;
  const options = screen.getByRole("button", { name: "工作台选项" });
  expect(shell).toHaveAttribute("data-theme", "light");
  expect(document.documentElement).toHaveAttribute("data-theme", "light");
  expect(options).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(options);
  expect(options).toHaveAttribute("aria-expanded", "true");
  const menu = screen.getByRole("dialog", { name: "工作台选项" });
  expect(menu).toHaveAttribute("aria-modal", "true");
  expect(document.body.style.overflow).toBe("hidden");
  fireEvent.keyDown(screen.getByRole("button", { name: "关闭工作台选项" }), { key: "ArrowUp" });
  expect(screen.getByRole("button", { name: "退出控制台登录" })).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: "切换明暗外观" }));
  expect(shell).toHaveAttribute("data-theme", "dark");
  fireEvent.keyDown(screen.getByRole("button", { name: "切换明暗外观" }), { key: "Escape" });
  expect(options).toHaveAttribute("aria-expanded", "false");
  expect(options).toHaveFocus();
  fireEvent.click(options);
  fireEvent.pointerDown(document.body);
  expect(options).toHaveAttribute("aria-expanded", "false");
});

it("会话详情进入沉浸态，返回与看板往返保留会话草稿", async () => {
  const { container } = render(<App />);
  const row = await screen.findByTestId("session-row-local-shell-session");
  const shell = container.querySelector(".app-shell")!;
  fireEvent.click(screen.getByRole("button", { name: "工作台选项" }));
  fireEvent.click(row);
  await screen.findByText("会话消息");
  expect(shell).toHaveClass("mobile-detail-open");
  expect(screen.getByRole("button", { name: "工作台选项" })).toHaveAttribute("aria-expanded", "false");
  fireEvent.change(screen.getByLabelText("发送给当前会话"), { target: { value: "保留这段草稿" } });
  fireEvent.click(screen.getByRole("button", { name: "返回会话列表" }));
  await waitFor(() => expect(shell).not.toHaveClass("mobile-detail-open"));
  fireEvent.click(screen.getByRole("button", { name: "工作看板" }));
  expect(shell).toHaveAttribute("data-view", "leader");
  fireEvent.click(screen.getByRole("button", { name: "定时任务" }));
  expect(shell).toHaveAttribute("data-view", "automations");
  expect(screen.getByText("每日项目进度")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "会话" }));
  fireEvent.click(row);
  await waitFor(() => expect(screen.getByLabelText("发送给当前会话")).toHaveValue("保留这段草稿"));
  expect(shell).toHaveAttribute("data-view", "sessions");
});

it("定时任务独立展示，切换导航保留操作回执，看板中成果先于指令动态", async () => {
  const { container } = render(<App />);
  await screen.findByTestId("session-row-local-shell-session");
  const nav = screen.getByRole("navigation", { name: "主导航" });
  expect(within(nav).getAllByRole("button").map(button => button.textContent)).toEqual(["会话", "工作看板", "定时任务"]);
  const schedules = within(nav).getByRole("button", { name: "定时任务" });
  fireEvent.click(schedules);
  expect(schedules).toHaveAttribute("aria-current", "page");
  expect(screen.getByText("每日项目进度")).toBeVisible();
  expect(screen.queryByRole("heading", { name: /成果交付/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "暂停" }));
  await screen.findByText("已暂停");
  fireEvent.click(within(nav).getByRole("button", { name: "工作看板" }));
  expect(screen.queryByRole("heading", { name: /定时任务/ })).toBeNull();
  expect(screen.getByRole("heading", { name: /成果交付/ })).toBeVisible();
  const deliveries = container.querySelector("#deliveries-heading")!.closest("section")!;
  const commands = container.querySelector(".leader-command-anchor")!;
  expect(deliveries.compareDocumentPosition(commands) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(commands).toBe(container.querySelector(".leader-grid")!.lastElementChild);
  fireEvent.click(schedules);
  expect(screen.getByText("已暂停")).toBeVisible();
  expect(screen.getByRole("button", { name: "恢复" })).toBeEnabled();
});
