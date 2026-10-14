import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeControlPlaneStatus } from "../../src/api/normalizers";
import { normalizeInputReceipt } from "../../src/features/sessions/input-receipt";
import { normalizeSendAvailability, sessionSendBlockReason } from "../../src/features/sessions/send-availability";
import { SessionWorkspace } from "../../src/features/sessions/components/SessionWorkspace";
import { CommandsSection } from "../../src/features/leader/components/CommandsSection";
import { parseConsoleExecutions } from "../../src/features/leader/execution-contract";
import type { CommandRecord, InputReceipt, ScopedSession } from "../../src/types";
import { emptyGoals, emptyExecutions  } from "../fixtures/status-fixtures";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
const sessionId = `terminal:${"a".repeat(43)}`;
const proof: InputReceipt = { kind: "terminal-input-written", sessionId,
  requestId: "e09a35c8-7290-41f0-8fc5-9701183d82a6", promptSHA256: "a".repeat(64), responseRevision: 0, observedRevision: 1 };
const ready = { route: "terminal-pane" as const, mode: "non-atomic" as const, state: "ready" as const, observedAt: iso(), validUntil: iso(45000) };
const session: ScopedSession = { id: sessionId, nodeId: "fixture", provider: "terminal/codex", title: "合成终端", cwd: "/fixture",
  status: "idle", loaded: false, capabilities: ["read"], observedAt: iso(), sendAvailability: ready };
const nodes = [{ nodeId: "fixture", connected: true, sessionCount: 1, lastHeartbeat: iso(), inferredOffline: false }];
const command: CommandRecord = { commandId: "terminal-cmd", requestId: "http-id", nodeId: "fixture", sessionId,
  action: "send", status: "input-written", sendRoute: "terminal-pane", inputReceipt: proof, output: "",
  createdAt: iso(), updatedAt: iso(), expiresAt: iso(60000) };
const normalizeCommands = (commands: unknown[]) => normalizeControlPlaneStatus({ nodes, sessions: [], commands, goals: emptyGoals(), executions: emptyExecutions() }).commands;
const response = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("terminal proof normalization and route isolation", () => {
  it("preserves strict input-written proof, not an exact native turn, even when PG omits empty output", () => {
    expect(normalizeCommands([command])[0]).toMatchObject(command);
    expect(normalizeCommands([{ ...command, output: undefined }])[0]).toMatchObject({ status: "input-written", inputReceipt: proof });
    expect(normalizeCommands([{ ...command, action: "read", status: "completed", sendRoute: undefined, inputReceipt: undefined, output: "bounded snapshot" }])[0].status).toBe("completed");
  });

  it.each([
    { socket: "/private/socket" }, { prompt: "private" }, { requestId: "http-id" }, { sessionId: "terminal:short" },
    { promptSHA256: "A".repeat(64) }, { responseRevision: -1 }, { observedRevision: 0, responseRevision: 1 },
    { observedRevision: Number.MAX_SAFE_INTEGER + 1 }, { observedRevision: 1.5 },
  ])("rejects malformed proof rather than silently displaying success %#", changes => {
    const invalid = { ...proof, ...changes };
    expect(normalizeInputReceipt(invalid)).toBeUndefined();
    expect(normalizeCommands([{ ...command, inputReceipt: invalid }])).toEqual([]);
  });

  it.each([
    { status: "accepted" }, { status: "completed" }, { status: "failed" }, { status: "uncertain" },
    { turnId: "fabricated-turn" }, { output: "fabricated-output" }, { error: "failed" }, { inputReceipt: undefined },
    { inputReceipt: { ...proof, sessionId: `terminal:${"b".repeat(43)}` } },
    { sendRoute: "desktop-owner" }, { sessionId: "native", sendRoute: "control-socket" }, { action: "read" },
  ])("rejects crossing input-written into native/read/completed or mismatched target %#", changes => {
    expect(normalizeCommands([{ ...command, ...changes }])).toEqual([]);
  });

  it("requires fresh strict non-atomic terminal qualification and never falls back or fabricates native loaded", () => {
    expect(sessionSendBlockReason(session, NOW)).toBeNull();
    expect(session.loaded).toBe(false);
    for (const availability of [undefined, { ...ready, mode: undefined }, { ...ready, mode: "atomic" },
      { ...ready, extra: true }, { ...ready, route: "desktop-owner", mode: undefined },
      { ...ready, state: "blocked", reason: "busy" }, { ...ready, observedAt: iso(1) }, { ...ready, validUntil: iso(45001) }]) {
      expect(sessionSendBlockReason({ ...session, sendAvailability: normalizeSendAvailability(availability) }, NOW)).not.toBeNull();
    }
    expect(sessionSendBlockReason(session, NOW + 45000)).not.toBeNull();
    expect(sessionSendBlockReason({ ...session, id: "native", provider: "codex-app", loaded: true, capabilities: ["send"] }, NOW)).not.toBeNull();
    expect(sessionSendBlockReason({ ...session, desktopObservation: { source: "codex-desktop", status: "active", availability: "available", observedAt: iso() } }, NOW)).toBeNull();
  });

  it("rejects terminal sessions and input-written in durable execution projections", () => {
    const step = { step: 1, nodeId: "fixture", sessionId, prompt: "fixture", promptTruncated: false, dependsOn: [], resultFrom: [], status: "waiting" };
    const projection = { observedAt: NOW, limit: 12, hasMore: false, items: [{ id: "execution", status: "active", createdAt: NOW, expiresAt: NOW + 1000, steps: [step] }] };
    expect(() => parseConsoleExecutions(projection)).toThrow("持久计划状态格式无效");
    projection.items[0].steps[0] = { ...step, sessionId: "native", status: "input-written" };
    expect(() => parseConsoleExecutions(projection)).toThrow("持久计划状态格式无效");
  });
});

describe("terminal composer and receipt behavior", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  function setup(target = session) {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/messages") || url.includes("/commands/")) return response(command);
      throw new Error(`Unexpected synthetic request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const rendered = render(<SessionWorkspace data={{ nodes, sessions: [target], commands: [], goals: emptyGoals(), executions: emptyExecutions() }} nodes={nodes} stale={false} onAuthFailure={vi.fn()} />);
    fireEvent.click(screen.getByTestId(`session-row-fixture-${sessionId}`));
    fireEvent.change(screen.getByLabelText("发送给当前会话"), { target: { value: "synthetic input" } });
    return { ...rendered, fetchMock };
  }

  it("shows non-atomic hazards, posts one explicit input, stops polling and never claims execution complete", async () => {
    const { fetchMock, unmount } = setup();
    expect(screen.getByText(/原终端输入 · 非原子：CLI 退出、同类进程替换或人工输入/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送消息" })).toBeEnabled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "发送消息" })));
    expect(screen.getByText("输入已写入 (Input Written)")).toBeInTheDocument();
    expect(screen.getByText("输入已写入，执行未确认；不是任务完成，勿自动重发")).toBeInTheDocument();
    expect(screen.getByText("发送通道：原终端输入（非原子）")).toBeInTheDocument();
    expect(screen.queryByText("执行完成 (Completed)")).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(fetchMock.mock.calls).toHaveLength(1);
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps disabled qualification read-only, rejects both button and Enter without any history or sends", async () => {
    const { fetchMock } = setup({ ...session, sendAvailability: { ...ready, state: "unavailable", reason: "unavailable" } });
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
    fireEvent.keyDown(screen.getByLabelText("发送给当前会话"), { key: "Enter" });
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText("发送给当前会话")).toHaveValue("synthetic input");
  });

  it("shows proof as an input receipt in a separate group, never in recent-completed or final-output groups", () => {
    render(<CommandsSection commands={[command]} selectedNodeId={null} sessions={[session]} />);
    const group = screen.getByRole("region", { name: "终端输入已写入" });
    expect(within(group).getByText("输入已写入 (Input Written)")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "最近完成" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("指令详情与回执"));
    expect(screen.getByText(proof.requestId)).toBeInTheDocument();
    expect(screen.getByText(proof.promptSHA256)).toBeInTheDocument();
    expect(screen.getByText("0 / 1")).toBeInTheDocument();
    expect(screen.queryByText(/关联 Turn/)).not.toBeInTheDocument();
    expect(screen.queryByText("最终回执 / 返回快照")).not.toBeInTheDocument();
  });
});
