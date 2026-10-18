import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionWorkspace } from "../../src/features/sessions/components/SessionWorkspace";
import type { CommandRecord, ScopedSession } from "../../src/types";
import { emptyExecutions, emptyGoals } from "../fixtures/status-fixtures";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const iso = new Date(NOW).toISOString();
const session: ScopedSession = { id: "original", nodeId: "air", provider: "codex-app", title: "忙碌的原会话", cwd: "/fixture", status: "active", loaded: true, capabilities: ["read", "send"], observedAt: iso };
const nodes = [{ nodeId: "air", connected: true, sessionCount: 1, lastHeartbeat: iso, inferredOffline: false }];
const queued: CommandRecord = { commandId: "queued-command", requestId: "original-request", nodeId: "air", sessionId: "original", action: "send", status: "queued", sendRoute: "control-socket", createdAt: iso, updatedAt: iso, expiresAt: new Date(NOW + 60_000).toISOString() };

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("忙碌会话明确提示排队，取消仅针对原消息，取消后可编辑下一条", async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const value = url.endsWith("/messages") ? { ...queued, status: body.cancelCommandId ? "cancelled" : "queued" } : {
      session, historyContext: "cf7e282f-d6d2-4a98-a517-9fb753f2549b", source: "control-socket", fetchedAt: iso, items: [], nextCursor: null, truncated: false,
    };
    return new Response(JSON.stringify(value), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<SessionWorkspace data={{ nodes, sessions: [session], commands: [], goals: emptyGoals(), executions: emptyExecutions() }} nodes={nodes} stale={false} onAuthFailure={vi.fn()} />);
  fireEvent.click(screen.getByTestId("session-row-air-original"));
  await act(async () => {});
  expect(screen.getByText("会话忙碌，发送后排队")).toBeVisible();
  fireEvent.change(screen.getByLabelText("发送给当前会话"), { target: { value: "完成后继续" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送消息" })));
  expect(screen.getByText("消息已排队，会在会话可以继续时发送。")).toBeVisible();
  expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "取消排队" })));
  expect(screen.getByText("已取消", { selector: ".send-receipt > span" })).toBeVisible();
  const posts = fetchMock.mock.calls.filter(([url]) => url.endsWith("/messages"));
  expect(posts).toHaveLength(2);
  expect(JSON.parse(String(posts[1][1]?.body))).toEqual({ cancelCommandId: queued.commandId });
  fireEvent.change(screen.getByLabelText("发送给当前会话"), { target: { value: "新的消息" } });
  expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled();
});
