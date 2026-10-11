import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionWorkspace } from "../src/components/SessionWorkspace";
import { useSessionHistory } from "../src/hooks/useSessionHistory";
import type { ScopedSession, SessionHistory } from "../src/types";
import { emptyExecutions } from "./status-fixtures";

const NOW = Date.parse("2026-10-12T12:00:00Z");
const SESSION_ID = "terminal:" + Buffer.alloc(32, 7).toString("base64url");
const CONTEXT = "cf7e282f-d6d2-4a98-a517-9fb753f2549b";
const NEXT_CONTEXT = "15c9ef38-59cc-410c-a0f0-6a54bcd7f41a";
const session: ScopedSession = { id: SESSION_ID, provider: "terminal/claude", nodeId: "fixture", title: "原 CLI",
  cwd: "/fixture", status: "active", loaded: false, capabilities: ["read"], historySource: "terminal-transcript",
  observedAt: new Date(NOW).toISOString() };
const nodes = [{ nodeId: "fixture", connected: true, sessionCount: 1, lastHeartbeat: session.observedAt, inferredOffline: false }];
const page = (ids = ["可见回答"], nextCursor: string | null = "older"): SessionHistory => ({ session,
  historyContext: CONTEXT, source: "terminal-transcript", nextCursor, fetchedAt: session.observedAt, truncated: false,
  items: ids.map(id => ({ id, text: id, turnId: "", kind: "assistant", type: "transcript_message" })) });
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const settle = () => act(async () => { await Promise.resolve(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
function deferred() { let resolve!: (value: Response) => void; const promise = new Promise<Response>(done => { resolve = done; }); return { resolve, promise }; }
function installFetch() {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => response(page()));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
function workspace(target = session) {
  return <SessionWorkspace data={{ nodes, sessions: [target], commands: [], executions: emptyExecutions() }}
    nodes={nodes} stale={false} onAuthFailure={vi.fn()} />;
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(NOW);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("terminal history lifecycle", () => {
  it.each([
    { historySource: undefined }, { provider: "terminal/unsupported" }, { id: `terminal:${"a".repeat(43)}` },
    { observedAt: new Date(NOW - 45001).toISOString() }, { observedAt: new Date(NOW + 1).toISOString() },
  ])("never requests history from missing, invalid or expired observation %#", async change => {
    const fetch = installFetch();
    const { result } = renderHook(() => useSessionHistory({ ...session, ...change }, true, vi.fn()));
    await advance(60000);
    expect(fetch).not.toHaveBeenCalled();
    expect(result.current.canRead).toBe(false);
  });

  it("reads working/blocked independently of send readiness and keeps the same context after marker revocation/recovery", async () => {
    const fetch = installFetch();
    const { result, rerender } = renderHook(({ target }) => useSessionHistory(target, true, vi.fn()), { initialProps: { target: session } });
    await settle();
    expect(result.current.history?.items[0].text).toBe("可见回答");
    rerender({ target: { ...session, historySource: undefined } });
    await advance(10000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.current.history?.historyContext).toBe(CONTEXT);
    expect(result.current.history?.items[0].text).toBe("可见回答");
    expect(result.current.pollingPaused).toBe(true);
    await act(async () => { expect(await result.current.refresh()).toBe(false); expect(await result.current.loadOlder()).toBe(false); });
    rerender({ target: { ...session, status: "blocked", observedAt: new Date(Date.now()).toISOString() } });
    await settle();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toContain(`historyContext=${CONTEXT}`);
    expect(result.current.contextExpired).toBe(false);
  });

  it("pauses precisely at observation expiry without a rerender, retains records, and resumes only on fresh observation", async () => {
    const fetch = installFetch();
    const { result, rerender } = renderHook(({ target }) => useSessionHistory(target, true, vi.fn()), { initialProps: { target: session } });
    await advance(45001);
    const reads = fetch.mock.calls.length;
    expect(result.current.pollingPaused).toBe(true);
    expect(result.current.canRead).toBe(false);
    expect(result.current.history?.items[0].text).toBe("可见回答");
    expect(result.current.readBlockReason).toContain("观测已过期");
    await advance(60000);
    expect(fetch).toHaveBeenCalledTimes(reads);
    rerender({ target: { ...session, observedAt: new Date(Date.now()).toISOString() } });
    await settle();
    expect(fetch).toHaveBeenCalledTimes(reads + 1);
    expect(fetch.mock.calls.at(-1)?.[0]).toContain(`historyContext=${CONTEXT}`);
  });

  it("cancels an in-flight read on marker revocation and ignores its late records", async () => {
    const fetch = installFetch();
    const pending = deferred();
    fetch.mockResolvedValueOnce(response(page())).mockReturnValueOnce(pending.promise);
    const { result, rerender } = renderHook(({ target }) => useSessionHistory(target, true, vi.fn()), { initialProps: { target: session } });
    await settle();
    act(() => { void result.current.refresh(); });
    const signal = fetch.mock.calls[1][1]?.signal;
    rerender({ target: { ...session, historySource: undefined } });
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve(response(page(["迟到内容"]))));
    expect(result.current.history?.items.map(item => item.text)).toEqual(["可见回答"]);
    expect(result.current.loading).toBe(false);
  });

  it("409 retains old records and blocks renewal events until an explicit latest-page reset", async () => {
    const fetch = installFetch();
    fetch.mockResolvedValueOnce(response(page())).mockResolvedValueOnce(response({ code: "history_context_expired" }, 409));
    const { result, rerender } = renderHook(({ target, connected }) => useSessionHistory(target, connected, vi.fn()),
      { initialProps: { target: session, connected: true } });
    await settle(); await advance(2000);
    expect(result.current.contextExpired).toBe(true);
    expect(result.current.history?.items[0].text).toBe("可见回答");
    rerender({ target: { ...session, historySource: undefined }, connected: false });
    rerender({ target: { ...session, observedAt: new Date(Date.now()).toISOString() }, connected: true });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await advance(10000);
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockResolvedValue(response({ ...page(["新上下文"]), historyContext: NEXT_CONTEXT }));
    await act(async () => { expect(await result.current.resetLatest()).toBe(true); });
    expect(fetch.mock.calls[2][0]).not.toContain("historyContext");
    expect(result.current.history?.items.map(item => item.text)).toEqual(["新上下文"]);
    expect(result.current.history?.historyContext).toBe(NEXT_CONTEXT);
  });

  it("rejects a response from another terminal provider while keeping the prior window", async () => {
    const fetch = installFetch();
    fetch.mockResolvedValueOnce(response(page())).mockResolvedValueOnce(response({ ...page(["错误来源"]),
      session: { ...session, provider: "terminal/codex" } }));
    const { result } = renderHook(() => useSessionHistory(session, true, vi.fn()));
    await settle(); await advance(2000);
    expect(result.current.history?.items.map(item => item.text)).toEqual(["可见回答"]);
    expect(result.current.error).toContain("来源或上下文不匹配");
  });

  it("does not merge another provider into an already pinned history context even after inventory changes", async () => {
    const fetch = installFetch();
    fetch.mockResolvedValueOnce(response(page())).mockResolvedValueOnce(response({ ...page(["错误来源"]),
      session: { ...session, provider: "terminal/codex" } }));
    const { result, rerender } = renderHook(({ target }) => useSessionHistory(target, true, vi.fn()), { initialProps: { target: session } });
    await settle();
    rerender({ target: { ...session, provider: "terminal/codex" } });
    await settle();
    expect(result.current.history?.items.map(item => item.text)).toEqual(["可见回答"]);
    expect(result.current.error).toContain("来源或上下文不匹配");
  });
});

describe("terminal transcript workspace", () => {
  it("labels Grok transcript chunks as text fragments, not complete turns or execution receipts", async () => {
    const fetch = installFetch();
    const target = { ...session, provider: "terminal/grok" };
    const record = page(["Grok 可见片段"], null);
    fetch.mockResolvedValue(response({ ...record, session: target,
      items: record.items.map(item => ({ ...item, type: "transcript_chunk", turnId: "", status: "" })) }));
    render(workspace(target));
    fireEvent.click(screen.getByTestId(`session-row-fixture-${SESSION_ID}`));
    await settle();
    expect(screen.getByText("助手 · 文本片段（非完整轮次）")).toBeInTheDocument();
    expect(screen.getByLabelText("会话历史")).toHaveTextContent("Grok 可见片段");
    expect(screen.queryByText("执行完成 (Completed)")).toBeNull();
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
  });

  it("reuses historical paging/refresh and never grants input from a history marker", async () => {
    const fetch = installFetch();
    fetch.mockResolvedValueOnce(response(page())).mockResolvedValueOnce(response(page(["更早回答", "可见回答"], null)))
      .mockResolvedValueOnce(response(page(["可见回答", "追加回答"])));
    render(workspace());
    fireEvent.click(screen.getByTestId(`session-row-fixture-${SESSION_ID}`));
    await settle();
    expect(screen.getByLabelText("会话历史")).toHaveTextContent("可见回答");
    expect(screen.getByText(/CLI 会话记录来自原 CLI/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送消息" })).toBeDisabled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "加载更早的消息" })));
    expect([...screen.getByLabelText("会话历史").querySelectorAll("[data-history-id]")].map(element => element.getAttribute("data-history-id")))
      .toEqual(["更早回答", "可见回答"]);
    expect(fetch.mock.calls[1][0]).toContain(`historyContext=${CONTEXT}`);
    expect(fetch.mock.calls[1][0]).toContain("cursor=older");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "刷新会话历史" })));
    expect(screen.getByLabelText("会话历史")).toHaveTextContent("追加回答");
    expect(fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("keeps loaded records visible when the marker is removed, with disabled refresh and older-page controls", async () => {
    const fetch = installFetch();
    const { rerender } = render(workspace());
    fireEvent.click(screen.getByTestId(`session-row-fixture-${SESSION_ID}`));
    await settle();
    rerender(workspace({ ...session, historySource: undefined }));
    await advance(10000);
    expect(screen.getByLabelText("会话历史")).toHaveTextContent("可见回答");
    expect(screen.queryByLabelText("终端观测说明")).toBeNull();
    expect(screen.getByText(/CLI 会话记录来源不可用/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "刷新会话历史" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "加载更早的消息" })).toBeDisabled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not make an unmarked terminal request history and preserves the original snapshot explanation", async () => {
    const fetch = installFetch();
    render(workspace({ ...session, historySource: undefined }));
    fireEvent.click(screen.getByTestId(`session-row-fixture-${SESSION_ID}`));
    await advance(60000);
    expect(screen.getByLabelText("终端观测说明")).toHaveTextContent("不是完整对话记录");
    expect(screen.queryByRole("button", { name: "刷新会话历史" })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
