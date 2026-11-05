import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExecutionsSection } from "../../src/features/leader/components/ExecutionsSection";
import { GoalsSection } from "../../src/features/leader/components/GoalsSection";
import { PlanForm } from "../../src/features/leader/components/PlanForm";
import { GoalForm } from "../../src/features/leader/components/GoalForm";
import { parseAuthorizationReceipt, UNBOUND_LOGIN_MESSAGE } from "../../src/api/authorizations";
import { parseConsoleGoals } from "../../src/features/leader/goal-contract";
import { authorizableSessions, goalDraftFromGoal, removePlanStep } from "../../src/features/leader/authorization-forms";
import type { ScopedSession } from "../../src/types";
import { executionFixture, goalFixture, FIXTURE_NOW } from "../fixtures/status-fixtures";

const PLAN_ID = executionFixture().id;
const NEW_ID = "00000000-0000-4000-8000-0000000000ff";
const session = (nodeId: string, id: string, overrides: Partial<ScopedSession> = {}): ScopedSession => ({ id, nodeId, provider: "codex-app", title: `${nodeId}-${id}`,
  cwd: "/w", status: "idle", capabilities: ["read", "send"], observedAt: new Date(FIXTURE_NOW).toISOString(), loaded: true, ...overrides });
const sessions = [session("air", "same-session"), session("mini", "same-session"),
  session("air", "terminal:pane", { provider: "terminal/codex" }), session("wechat", "chat-1", { provider: "wechat-codex" })];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const bodies = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map(([url, init]) => ({ url, intent: (init as RequestInit).headers && ((init as RequestInit).headers as Record<string, string>)["X-Super-Leader-Intent"], body: JSON.parse(String((init as RequestInit).body)) }));
afterEach(() => vi.unstubAllGlobals());

describe("console authorization forms", () => {
  it("offers only sendable non-terminal discovered sessions", () => {
    expect(authorizableSessions(sessions).map(item => [item.nodeId, item.id])).toEqual([["air", "same-session"], ["mini", "same-session"]]);
  });

  it("shows validation errors and never submits an invalid plan", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<PlanForm sessions={sessions} onDone={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "确认并创建计划" }));
    expect(screen.getByText("请为步骤 1 选择会话。")).toBeVisible();
    expect(screen.getByText("请填写步骤 1 的任务。")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "添加步骤" }));
    fireEvent.click(screen.getByRole("button", { name: "添加步骤" }));
    fireEvent.click(screen.getByRole("button", { name: "添加步骤" }));
    expect(screen.queryByRole("button", { name: "添加步骤" })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renumbers dependencies when a step is removed", () => {
    const step = (dependsOn: number[], resultFrom: number[] = []) => ({ nodeId: "air", sessionId: "s", prompt: "x", dependsOn, resultFrom });
    expect(removePlanStep({ steps: [step([]), step([1], [1]), step([1, 2], [2])] }, 0).steps.map(item => [item.dependsOn, item.resultFrom]))
      .toEqual([[[], []], [[1], [1]]]);
  });

  it("creates a plan with one idempotency key per unchanged submit and shows the server rejection verbatim", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ outcome: "rejected", message: "本聊天已有 3 个进行中的计划，已达上限，没有新增派发。" }, 422))
      .mockResolvedValueOnce(json({ outcome: "created", id: NEW_ID, message: "已创建", replayed: false }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const onDone = vi.fn();
    render(<PlanForm sessions={sessions} onDone={onDone} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("步骤 1 的会话"), { target: { value: JSON.stringify(["air", "same-session"]) } });
    fireEvent.change(screen.getByLabelText("任务"), { target: { value: "检查测试" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并创建计划" }));
    expect(await screen.findByText(/已达上限/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "确认并创建计划" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ id: NEW_ID })));
    const [first, second] = bodies(fetchMock);
    expect(first).toMatchObject({ url: "/v1/plans", intent: "plan-authorization",
      body: { steps: [{ nodeId: "air", sessionId: "same-session", prompt: "检查测试", dependsOn: [], resultFrom: [] }] } });
    expect(second.body.requestId).toBe(first.body.requestId);
  });

  it("prefills edit from the active plan and cancels it before recreating", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ outcome: "cancelled", id: PLAN_ID, message: "已取消", replayed: false }))
      .mockResolvedValueOnce(json({ outcome: "created", id: NEW_ID, message: "新计划已创建", replayed: false }, 201));
    vi.stubGlobal("fetch", fetchMock);
    render(<ExecutionsSection executions={{ observedAt: FIXTURE_NOW, limit: 12, hasMore: false, items: [executionFixture()] }}
      sessions={sessions} selectedNodeId={null} schedulerEnabled onOpenSession={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "修改（取消后重建）" }));
    const form = screen.getByRole("form", { name: "修改计划" });
    expect(within(form).getByText(/已授权的计划不能直接修改/)).toBeVisible();
    expect(within(form).getAllByLabelText("任务").map(input => (input as HTMLTextAreaElement).value)).toEqual(["先检查测试", "完成后检查文档"]);
    expect((within(form).getByLabelText("步骤 2 的会话") as HTMLSelectElement).value).toBe(JSON.stringify(["mini", "same-session"]));
    expect(within(form).getByRole("checkbox", { name: "依赖步骤 1" })).toBeChecked();
    fireEvent.click(within(form).getByRole("button", { name: "取消原计划并创建" }));
    expect(await screen.findByRole("status")).toHaveTextContent("新计划已创建");
    const [cancel, create] = bodies(fetchMock);
    expect(cancel).toMatchObject({ url: `/v1/plans/${PLAN_ID}/cancel`, intent: "plan-authorization" });
    expect(create).toMatchObject({ url: "/v1/plans", body: { steps: [{ prompt: "先检查测试" }, { sessionId: "same-session", dependsOn: [1] }] } });
  });

  it("explains when the recreate failed after the original plan was cancelled", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ outcome: "cancelled", id: PLAN_ID, message: "已取消", replayed: false }))
      .mockResolvedValueOnce(json({ outcome: "rejected", message: "Plan contains unavailable, busy or read-only targets" }, 422));
    vi.stubGlobal("fetch", fetchMock);
    render(<ExecutionsSection executions={{ observedAt: FIXTURE_NOW, limit: 12, hasMore: false, items: [executionFixture()] }}
      sessions={sessions} selectedNodeId={null} schedulerEnabled onOpenSession={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "修改（取消后重建）" }));
    fireEvent.click(screen.getByRole("button", { name: "取消原计划并创建" }));
    expect(await screen.findByText(/原计划已取消，但新计划未创建/)).toBeVisible();
    expect(screen.getByRole("button", { name: "确认并创建计划" })).toBeVisible();
  });

  it("prefills a goal edit, requires constraints to be retyped and validates budgets", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const goal = { ...goalFixture(), durationMinutes: 90 };
    render(<GoalsSection goals={{ observedAt: FIXTURE_NOW, limit: 12, hasMore: false, items: [goal] }} sessions={sessions}
      selectedNodeId={null} schedulerEnabled onOpenSession={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "修改（取消后重建）" }));
    const form = screen.getByRole("form", { name: "修改持续目标" });
    expect((within(form).getByLabelText("目标") as HTMLTextAreaElement).value).toBe("持续核查跨机会话");
    expect((within(form).getByLabelText("完成条件 1") as HTMLInputElement).value).toBe("所有测试通过");
    expect(within(form).getByRole("checkbox", { name: /air-same-session/ })).toBeChecked();
    expect(within(form).getByRole("checkbox", { name: /mini-same-session/ })).toBeChecked();
    expect((within(form).getByLabelText("约束（可选）") as HTMLTextAreaElement).value).toBe("");
    expect((within(form).getByLabelText("时长（分钟）") as HTMLInputElement).value).toBe("90");
    expect(within(form).getByText(/约束不在控制台展示/)).toBeVisible();
    fireEvent.change(within(form).getByLabelText("动作预算"), { target: { value: "13" } });
    fireEvent.click(within(form).getByRole("button", { name: "取消原目标并创建" }));
    expect(within(form).getByText("动作预算需为 1–12 的整数。")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces an unbound login without logging the user out", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ code: "console_chat_unbound", error: "unbound" }, 403)));
    render(<GoalForm sessions={sessions} initial={{ ...goalDraftFromGoal(goalFixture()), targets: [{ nodeId: "air", sessionId: "same-session" }] }}
      onDone={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "确认并创建目标" }));
    expect(await screen.findByText(UNBOUND_LOGIN_MESSAGE)).toBeVisible();
  });
});

describe("authorization API normalizers", () => {
  it("accepts only the expected receipt shape", () => {
    const receipt = { outcome: "created", id: NEW_ID, message: "ok", replayed: false };
    expect(parseAuthorizationReceipt(receipt, "created")).toEqual(receipt);
    expect(() => parseAuthorizationReceipt(receipt, "cancelled")).toThrow();
    expect(() => parseAuthorizationReceipt({ ...receipt, chatId: "secret" }, "created")).toThrow();
    expect(() => parseAuthorizationReceipt({ ...receipt, id: "not-a-uuid" }, "created")).toThrow();
    expect(() => parseAuthorizationReceipt({ ...receipt, outcome: "cancelled" }, "cancelled", PLAN_ID)).toThrow();
    expect(() => parseAuthorizationReceipt({ ...receipt, outcome: "rejected" }, "created")).toThrow();
  });

  it("reads the optional goal duration and rejects out-of-range values", () => {
    const goals = (item: object) => ({ observedAt: FIXTURE_NOW, limit: 12, hasMore: false, items: [{ ...goalFixture(), ...item }] });
    expect(parseConsoleGoals(goals({ durationMinutes: 60 })).items[0].durationMinutes).toBe(60);
    expect(parseConsoleGoals(goals({})).items[0].durationMinutes).toBeUndefined();
    expect(() => parseConsoleGoals(goals({ durationMinutes: 1441 }))).toThrow();
  });
});
