import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionWorkspace } from "../../src/features/sessions/components/SessionWorkspace";
import type { CommandRecord, HistoryItem, ScopedSession } from "../../src/types";
import { emptyExecutions, emptyGoals } from "../fixtures/status-fixtures";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const iso = new Date(NOW).toISOString();
const RUNNING_TURN = "turn-running";
const CONTEXT = "cf7e282f-d6d2-4a98-a517-9fb753f2549b";
const session: ScopedSession = { id: "original", nodeId: "air", provider: "codex-app", title: "运行中的原会话", cwd: "/fixture", status: "active", loaded: true, capabilities: ["read", "send"], observedAt: iso };
const terminal: ScopedSession = { ...session, id: "terminal:abc", provider: "terminal/codex", title: "终端会话" };
const nodes = [{ nodeId: "air", connected: true, sessionCount: 1, lastHeartbeat: iso, inferredOffline: false }];
const item = (turnId: string, turnStatus: HistoryItem["turnStatus"]): HistoryItem => ({ id: `${turnId}-item`, turnId, turnStatus, kind: "assistant", type: "agentMessage", text: "工作中" });
const receipt = (status: CommandRecord["status"], requestId: string): CommandRecord => ({ commandId: "interrupt-command", requestId, nodeId: "air", sessionId: "original",
  action: "interrupt", expectedTurnId: RUNNING_TURN, status, ...(status === "completed" ? { turnId: RUNNING_TURN, output: "interrupted" } : {}), createdAt: iso, updatedAt: iso, expiresAt: new Date(NOW + 60_000).toISOString() });

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function stubFetch(items: HistoryItem[], target: ScopedSession, interruptStatus: () => CommandRecord["status"]) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/interrupt")) return new Response(JSON.stringify(receipt(interruptStatus(), JSON.parse(String(init?.body)).requestId)), { status: 200 });
    return new Response(JSON.stringify({ session: target, historyContext: CONTEXT, source: "control-socket", fetchedAt: iso, items, nextCursor: null, truncated: false }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function open(target: ScopedSession) {
  render(<SessionWorkspace data={{ nodes, sessions: [target], commands: [], goals: emptyGoals(), executions: emptyExecutions() }} nodes={nodes} stale={false} onAuthFailure={vi.fn()} />);
  fireEvent.click(screen.getByTestId(`session-row-air-${target.id}`));
  await act(async () => {});
}

it("运行中的最新轮次显示停止按钮，确认后按精确轮次发送停止请求", async () => {
  const fetchMock = stubFetch([item("turn-old", "completed"), item(RUNNING_TURN, "inProgress")], session, () => "completed");
  await open(session);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "停止当前轮" })));
  expect(screen.getByText("仅停止该会话当前正在运行的这一轮；排队中的消息不受影响。")).toBeVisible();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "确认停止" })));
  const posts = fetchMock.mock.calls.filter(([url]) => url.endsWith("/interrupt"));
  expect(posts).toHaveLength(1);
  const [url, init] = posts[0];
  expect(url).toBe("/v1/sessions/air/original/interrupt");
  expect((init?.headers as Record<string, string>)["X-Super-Leader-Intent"]).toBe("session-interrupt");
  const body = JSON.parse(String(init?.body));
  expect(body.turnId).toBe(RUNNING_TURN);
  expect(body.requestId).toMatch(/^[A-Za-z0-9_-]+$/);
  expect(screen.getByText("已停止当前轮")).toBeVisible();
});

it("没有运行中轮次或终端会话时不显示停止按钮", async () => {
  stubFetch([item(RUNNING_TURN, "inProgress"), item("turn-new", "completed")], session, () => "completed");
  await open(session);
  expect(screen.queryByRole("button", { name: "停止当前轮" })).toBeNull();
});

it("终端会话不提供停止按钮", async () => {
  stubFetch([item(RUNNING_TURN, "inProgress")], terminal, () => "completed");
  await open(terminal);
  expect(screen.queryByRole("button", { name: "停止当前轮" })).toBeNull();
});

it("停止结果不确定时只用同一 requestId 核查，不自动发起新的停止", async () => {
  let status: CommandRecord["status"] = "uncertain";
  const fetchMock = stubFetch([item(RUNNING_TURN, "inProgress")], session, () => status);
  await open(session);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "停止当前轮" })));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "确认停止" })));
  expect(screen.getByText("停止结果不确定，请核查会话状态")).toBeVisible();
  expect(screen.getByRole("button", { name: "停止当前轮" })).toBeDisabled();
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(fetchMock.mock.calls.filter(([url]) => url.endsWith("/interrupt"))).toHaveLength(1);
  status = "completed";
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "核查停止结果" })));
  const posts = fetchMock.mock.calls.filter(([url]) => url.endsWith("/interrupt"));
  expect(posts).toHaveLength(2);
  expect(JSON.parse(String(posts[1][1]?.body))).toEqual(JSON.parse(String(posts[0][1]?.body)));
  expect(screen.getByText("已停止当前轮")).toBeVisible();
});
