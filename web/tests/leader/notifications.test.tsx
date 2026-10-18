import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationsSection } from "../../src/features/notifications/AutomationsSection";
import { DeliveriesSection } from "../../src/features/notifications/DeliveriesSection";
import { parseAutomations, type ConsoleAutomation } from "../../src/features/notifications/automation-contract";
import { parseDeliveries, type ConsoleDelivery } from "../../src/features/notifications/delivery-contract";
import { normalizeControlPlaneStatus } from "../../src/api/normalizers";
import { emptyExecutions, emptyGoals } from "../fixtures/status-fixtures";

const NOW = Date.now();
const schedule = (status: ConsoleAutomation["status"] = "active"): ConsoleAutomation => ({
  id: "schedule-1", chatId: "chat-1", title: "每天研究更新", kind: "session", status,
  timing: { type: "cron", expression: "0 9 * * *" }, timezone: "Asia/Shanghai", nextAt: NOW + 86_400_000,
});
const delivery = (id: string, status: ConsoleDelivery["status"]): ConsoleDelivery => ({
  id, kind: "completed", status, mode: "attachment", messages: ["已保存研究成果摘要"],
  artifact: { id: `artifact-${id}`, name: `${id}.md`, size: 20_000, expiresAt: NOW + 86_400_000 },
  createdAt: NOW, expiresAt: NOW + 3_600_000, retainedUntil: NOW + 86_400_000,
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("task notification console", () => {
  it("keeps task completion separate from waiting and uncertain delivery, loading full content only on request", async () => {
    const full = "# 完整研究\n" + "正文包含所有细节。".repeat(300);
    const fetchMock = vi.fn(async () => new Response(full, { headers: { "Content-Type": "text/markdown" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DeliveriesSection items={[delivery("waiting", "waiting_for_user"), delivery("unknown", "uncertain")]} />);
    expect(screen.getAllByText("执行完成")).toHaveLength(2);
    expect(screen.getByText("通知：等待微信续窗")).toBeInTheDocument();
    expect(screen.getByText("通知：投递结果待核验")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    const article = screen.getByText("waiting.md").closest("article")!;
    fireEvent.click(within(article).getByRole("button", { name: "查看完整成果" }));
    const content = await screen.findByLabelText("完整成果");
    expect(content.textContent).toBe(full);
    expect(fetchMock).toHaveBeenCalledWith("/v1/deliveries/waiting/full", expect.objectContaining({ method: "GET", credentials: "same-origin" }));
    fireEvent.click(within(article).getByRole("button", { name: "收起完整成果" }));
    expect(screen.queryByLabelText("完整成果")).not.toBeInTheDocument();
  });

  it("changes schedules using the scoped same-origin intent and confirms cancellation before sending", async () => {
    const fetchMock = vi.fn(async (_url, init: RequestInit) => {
      const { status } = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ schedule: schedule(status) }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AutomationsSection items={[schedule()]} />);
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    expect(await screen.findByText("已暂停")).toBeInTheDocument();
    expect(screen.getByText("后续执行已暂停")).toBeInTheDocument();
    expect(screen.queryByText(/下次执行/)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/v1/automations/schedule-1/status", expect.objectContaining({
      method: "POST", credentials: "same-origin", body: JSON.stringify({ chatId: "chat-1", status: "paused" }),
      headers: expect.objectContaining({ "X-Super-Leader-Intent": "automation-status" }),
    }));
    fireEvent.click(screen.getByRole("button", { name: "取消任务" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "确认取消" }));
    expect(await screen.findByText("已取消")).toBeInTheDocument();
    expect(screen.getByText("没有后续执行安排")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "恢复" })).not.toBeInTheDocument();
  });

  it("does not present a successful mutation when its receipt belongs to another chat", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ schedule: { ...schedule("paused"), chatId: "other" } }))));
    render(<AutomationsSection items={[schedule()]} />);
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("回执与当前操作不匹配");
    expect(screen.getByText("已启用")).toBeInTheDocument();
  });

  it("accepts and displays isolated background schedules without treating them as source session tasks", () => {
    const background = { ...schedule(), kind: "background" as const, title: "跨机日报汇总", activeRunId: "run-1" };
    const items = parseAutomations({ items: [background] });
    expect(items).toEqual([background]);
    render(<AutomationsSection items={items} />);
    expect(screen.getByText(/后台任务 · 定期执行/)).toBeInTheDocument();
    expect(screen.getByText(/每轮独立执行；会话默认保留 24 小时/)).toBeInTheDocument();
    expect(screen.getByText("本轮正在执行")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "暂停" })).toBeEnabled();
  });

  it("treats expired notification freshness independently of saved artifact retention", () => {
    const stale = { ...delivery("stale", "waiting_for_user"), expiresAt: NOW - 1 };
    render(<DeliveriesSection items={[stale]} />);
    expect(screen.getByText("通知：通知时效已过")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "查看完整成果" })).toBeEnabled();
  });

  it("keeps legacy status responses compatible and rejects unknown notification statuses", () => {
    const legacy = normalizeControlPlaneStatus({ nodes: [], sessions: [], commands: [], executions: emptyExecutions(), goals: emptyGoals() });
    expect(legacy.automations).toEqual([]);
    expect(legacy.deliveries).toEqual([]);
    expect(parseAutomations({ items: [schedule()] })).toEqual([schedule()]);
    expect(parseDeliveries([delivery("valid", "accepted")])[0].status).toBe("accepted");
    expect(() => parseAutomations({ items: [{ ...schedule(), status: "maybe" }] })).toThrow();
    expect(() => parseAutomations({ items: [{ ...schedule(), kind: "unrecognized" }] })).toThrow();
    expect(() => parseDeliveries({ items: [{ ...delivery("x", "ready"), status: "delivered" }] })).toThrow();
  });
});
