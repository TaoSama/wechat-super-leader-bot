import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useSessionMessages } from "../../src/features/sessions/useSessionMessages";
import type { ScopedSession } from "../../src/types";

const now = new Date().toISOString();
const session: ScopedSession = { id: "draft-session", nodeId: "local", provider: "codex-app", title: "草稿", cwd: "/fixture", status: "idle", loaded: true, capabilities: ["read", "send"], observedAt: now };
const command = { commandId: "sent-command", requestId: "request", nodeId: session.nodeId, sessionId: session.id, action: "send", status: "completed", createdAt: now, updatedAt: now, expiresAt: now };
afterEach(() => vi.unstubAllGlobals());

it("发送等待期间的新草稿不会被原请求回执清空", async () => {
  let resolve!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
  const { result } = renderHook(() => useSessionMessages(session, vi.fn()));
  act(() => result.current.setDraft("原消息"));
  let pending!: Promise<void>;
  act(() => { pending = result.current.submit(); });
  expect(result.current.sending).toBe(true);
  act(() => result.current.setDraft("下一条草稿"));
  await act(async () => { resolve(new Response(JSON.stringify(command))); await pending; });
  expect(result.current.draft).toBe("下一条草稿");
  expect(result.current.submission?.prompt).toBe("原消息");
  expect(result.current.submission?.command?.status).toBe("completed");
});

it.each(["原消息", ""])("发送后重新编辑为%j仍按新草稿保留", async draft => {
  let resolve!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(done => { resolve = done; })));
  const { result } = renderHook(() => useSessionMessages(session, vi.fn()));
  act(() => result.current.setDraft("原消息"));
  let pending!: Promise<void>;
  act(() => { pending = result.current.submit(); });
  act(() => result.current.setDraft("编辑下一条"));
  act(() => result.current.setDraft(draft));
  await act(async () => { resolve(new Response(JSON.stringify(command))); await pending; });
  expect(result.current.draft).toBe(draft);
});

it("核查不确定请求只更新原回执，不会丢弃下一条草稿", async () => {
  const fetchMock = vi.fn().mockRejectedValueOnce(new Error("network"))
    .mockResolvedValueOnce(new Response(JSON.stringify(command)));
  vi.stubGlobal("fetch", fetchMock);
  const { result } = renderHook(() => useSessionMessages(session, vi.fn()));
  act(() => result.current.setDraft("原消息"));
  await act(async () => result.current.submit());
  expect(result.current.submission?.uncertain).toBe(true);
  act(() => result.current.setDraft("下一条草稿"));
  await act(async () => result.current.submit(true));
  expect(result.current.draft).toBe("下一条草稿");
  expect(result.current.submission?.command?.status).toBe("completed");
  expect(fetchMock.mock.calls[1][0]).toContain("/messages/");
  expect(fetchMock.mock.calls[1][1].method).toBe("GET");
});
