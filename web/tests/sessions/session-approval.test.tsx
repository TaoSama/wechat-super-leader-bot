import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionWorkspace } from "../../src/features/sessions/components/SessionWorkspace";
import { normalizeSession } from "../../src/api/normalizers";
import type { CommandRecord, PendingApproval, ScopedSession } from "../../src/types";
import { emptyExecutions, emptyGoals } from "../fixtures/status-fixtures";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const iso = new Date(NOW).toISOString();
const TURN = "turn-waiting";
const CONTEXT = "cf7e282f-d6d2-4a98-a517-9fb753f2549b";
const DESKTOP_ONLY = "该审批只能在桌面端处理：请在桌面端处理审批";
const commandApproval: PendingApproval = { requestId: "approval-1", kind: "commandExecution", turnId: TURN, command: "rm -rf <b>build</b>", cwd: "/fixture", reason: "清理产物", answerable: true };
const desktopApproval: PendingApproval = { requestId: "approval-2", kind: "permissions", grantRoot: "/fixture/secret", answerable: false };
const base: ScopedSession = { id: "original", nodeId: "air", provider: "codex-app", title: "等待审批的原会话", cwd: "/fixture", status: "active", loaded: true, capabilities: ["read", "send"], observedAt: iso };
const nodes = [{ nodeId: "air", connected: true, sessionCount: 1, lastHeartbeat: iso, inferredOffline: false }];
const receipt = (status: CommandRecord["status"], body: Record<string, string>, error?: string): CommandRecord => ({ commandId: "approve-command", requestId: body.requestId, nodeId: "air", sessionId: "original",
  action: "approve", expectedTurnId: body.turnId, approvalRequestId: body.approvalRequestId, approvalDecision: body.decision as "accept", status, ...(error ? { error } : {}),
  createdAt: iso, updatedAt: iso, expiresAt: new Date(NOW + 60_000).toISOString() });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function stubFetch(target: ScopedSession, status: CommandRecord["status"], error?: string) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/approval")) return new Response(JSON.stringify(receipt(status, JSON.parse(String(init?.body)), error)), { status: status === "pending" ? 202 : 200 });
    return new Response(JSON.stringify({ session: target, historyContext: CONTEXT, source: "control-socket", fetchedAt: iso, items: [], nextCursor: null, truncated: false }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function open(target: ScopedSession) {
  render(<SessionWorkspace data={{ nodes, sessions: [target], commands: [], goals: emptyGoals(), executions: emptyExecutions() }} nodes={nodes} stale={false} onAuthFailure={vi.fn()} />);
  fireEvent.click(screen.getByTestId(`session-row-air-${target.id}`));
  await act(async () => {});
}
const approvalPosts = (fetchMock: ReturnType<typeof stubFetch>) => fetchMock.mock.calls.filter(([url]) => url.endsWith("/approval"));

it("规范化时丢弃格式错误的审批条目，只保留字符串字段", () => {
  const session = normalizeSession({ ...base, pendingApprovals: [commandApproval, { requestId: "bad id", kind: "other", answerable: true }, { requestId: "x", kind: "unknown", answerable: true }, { ...desktopApproval, cwd: 42 }] });
  expect(session?.pendingApprovals).toEqual([commandApproval, desktopApproval]);
  expect(normalizeSession({ ...base, pendingApprovals: "bad" })?.pendingApprovals).toBeUndefined();
});

it("显示待处理审批详情，文本按纯文本渲染", async () => {
  const session = { ...base, pendingApprovals: [commandApproval, desktopApproval] };
  stubFetch(session, "completed");
  await open(session);
  const entry = within(screen.getByTestId("approval-approval-1"));
  expect(entry.getByText("命令执行")).toBeVisible();
  expect(entry.getByText("rm -rf <b>build</b>")).toBeVisible();
  expect(entry.getByText("目录：/fixture")).toBeVisible();
  expect(entry.getByText("原因：清理产物")).toBeVisible();
  expect(entry.getByText("请求 ID：approval-1")).toBeVisible();
  expect(document.querySelector(".session-approvals b")).toBeNull();
  const desktop = within(screen.getByTestId("approval-approval-2"));
  expect(desktop.getByText("权限申请")).toBeVisible();
  expect(desktop.getByText("授权范围：/fixture/secret")).toBeVisible();
});

it("点击批准只发送一次精确的审批答复", async () => {
  const session = { ...base, pendingApprovals: [commandApproval] };
  const fetchMock = stubFetch(session, "completed");
  await open(session);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "批准" })));
  const posts = approvalPosts(fetchMock);
  expect(posts).toHaveLength(1);
  const [url, init] = posts[0];
  expect(url).toBe("/v1/sessions/air/original/approval");
  expect(init?.credentials).toBe("same-origin");
  expect((init?.headers as Record<string, string>)["X-Super-Leader-Intent"]).toBe("session-approval");
  const body = JSON.parse(String(init?.body));
  expect(body).toEqual({ requestId: expect.stringMatching(/^[A-Za-z0-9_-]{1,128}$/), turnId: TURN, approvalRequestId: "approval-1", decision: "accept" });
  expect(screen.getByText("已批准，原会话已关闭该审批")).toBeVisible();
  expect(screen.getByRole("button", { name: "批准" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "拒绝" })).toBeDisabled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "批准" })));
  expect(approvalPosts(fetchMock)).toHaveLength(1);
});

it("审批失败时显示错误信息", async () => {
  const session = { ...base, pendingApprovals: [commandApproval] };
  stubFetch(session, "failed", DESKTOP_ONLY);
  await open(session);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "拒绝" })));
  expect(screen.getByRole("alert")).toHaveTextContent(DESKTOP_ONLY);
});

it("结果不确定时不自动重试，也不允许重复提交", async () => {
  const session = { ...base, pendingApprovals: [commandApproval] };
  const fetchMock = stubFetch(session, "pending");
  await open(session);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "批准" })));
  expect(screen.getByText("结果不确定，请勿重复提交，稍后刷新查看")).toBeVisible();
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(approvalPosts(fetchMock)).toHaveLength(1);
  expect(screen.getByRole("button", { name: "批准" })).toBeDisabled();
});

it("不可答复的审批不提供按钮，只提示在原客户端处理", async () => {
  const session = { ...base, pendingApprovals: [desktopApproval] };
  stubFetch(session, "completed");
  await open(session);
  expect(screen.getByText("需在原客户端处理")).toBeVisible();
  expect(screen.queryByRole("button", { name: "批准" })).toBeNull();
  expect(screen.queryByRole("button", { name: "拒绝" })).toBeNull();
});
