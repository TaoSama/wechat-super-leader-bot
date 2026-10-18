import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiAuthError, ApiHistoryError, ApiHttpError } from "../../src/api/errors";
import { fetchSessionHistory, sendSessionMessage } from "../../src/api/sessions";

const CONTEXT = "cf7e282f-d6d2-4a98-a517-9fb753f2549b";
const OTHER_CONTEXT = "15c9ef38-59cc-410c-a0f0-6a54bcd7f41a";
const PAGE = { session: { id: "session", observedAt: "2026-10-11T10:00:00Z" }, historyContext: CONTEXT,
  source: "codex-desktop", items: [], nextCursor: "cursor", fetchedAt: "2026-10-11T10:00:00Z", truncated: false };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => vi.unstubAllGlobals());

describe("history API contract", () => {
  it("requests a fixed 20-item page and rejects oversized responses before publishing rows", async () => {
    const fetch = vi.fn().mockResolvedValue(response(PAGE));
    vi.stubGlobal("fetch", fetch);
    await fetchSessionHistory("node", "session");
    expect(new URL(fetch.mock.calls[0][0], "https://workspace.test").searchParams.get("limit")).toBe("20");
    const items = Array.from({ length: 21 }, (_, index) => ({ id: String(index), turnId: "turn", text: "row", kind: "assistant" }));
    fetch.mockResolvedValue(response({ ...PAGE, items }));
    await expect(fetchSessionHistory("node", "session")).rejects.toThrow("单页条数限制");
  });
  it("only selects the paginated source explicitly and rejects a different response source", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ ...PAGE, source: "control-socket" }));
    vi.stubGlobal("fetch", fetch);
    await fetchSessionHistory("node", "session", undefined, undefined, undefined, "control-socket");
    expect(fetch.mock.calls[0][0]).toContain("source=control-socket");
    fetch.mockResolvedValue(response(PAGE));
    await expect(fetchSessionHistory("node", "session", undefined, undefined, undefined, "control-socket")).rejects.toThrow("所选读取来源不匹配");
  });
  it("keeps initial reads context-free and includes context on latest/pagination requests", async () => {
    const fetch = vi.fn().mockResolvedValue(response(PAGE));
    vi.stubGlobal("fetch", fetch);
    expect(await fetchSessionHistory("node", "session")).toMatchObject({ historyContext: CONTEXT, source: "codex-desktop" });
    expect(fetch.mock.calls[0][0]).not.toContain("historyContext");
    fetch.mockResolvedValue(response(PAGE));
    await fetchSessionHistory("node", "session", undefined, undefined, CONTEXT);
    expect(fetch.mock.calls[1][0]).toContain(`historyContext=${CONTEXT}`);
    fetch.mockResolvedValue(response(PAGE));
    await fetchSessionHistory("node", "session", "opaque/+", undefined, CONTEXT);
    expect(fetch.mock.calls[2][0]).toContain("cursor=opaque%2F%2B");
    expect(fetch.mock.calls[2][0]).toContain(`historyContext=${CONTEXT}`);
  });

  it.each([
    { historyContext: undefined }, { historyContext: "" }, { historyContext: "bad" },
    { historyContext: OTHER_CONTEXT }, { source: undefined }, { source: "desktop-owner" },
    { session: { ...PAGE.session, id: "other" } }, { session: { ...PAGE.session, nodeId: "other" } },
  ])("rejects malformed or mismatched history response %#", async change => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ ...PAGE, ...change })));
    await expect(fetchSessionHistory("node", "session", undefined, undefined, CONTEXT)).rejects.toThrow("不匹配");
  });

  it("rejects invalid context and cursor-without-context before transport", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(fetchSessionHistory("node", "session", "cursor")).rejects.toThrow("参数无效");
    await expect(fetchSessionHistory("node", "session", undefined, undefined, "bad")).rejects.toThrow("参数无效");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [409, "history_context_expired", "请重新读取最新页"],
    [413, "history_too_large", "大小限制"],
    [502, "history_incomplete", "完整历史"],
  ])("exposes bounded static history error %s/%s", async (status, code, text) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ code, error: "PRIVATE IPC BODY" }, status as number)));
    const error = await fetchSessionHistory("node", "session").catch(reason => reason);
    expect(error).toBeInstanceOf(ApiHistoryError);
    expect(error).toMatchObject({ statusCode: status, code });
    expect(error.message).toContain(text);
    expect(error.message).not.toContain("PRIVATE");
  });

  it.each(["untrusted_private", "toString", "x".repeat(5000)])("does not reflect unknown error code %#", async code => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ code, error: "PRIVATE" }, 502)));
    await expect(fetchSessionHistory("node", "session")).rejects.toMatchObject({ code: undefined, message: "历史读取未成功 (HTTP 502)" });
  });

  it("handles malformed error JSON and preserves the general API error policy", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("not JSON", { status: 502 }))
      .mockResolvedValueOnce(response({ code: "history_context_expired", error: "PRIVATE" }, 409));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchSessionHistory("node", "session")).rejects.toMatchObject({ code: undefined });
    const error = await sendSessionMessage("node", "session", "fixture", "request").catch(reason => reason);
    expect(error).toBeInstanceOf(ApiHttpError);
    expect(error).not.toBeInstanceOf(ApiHistoryError);
    expect(error.message).toBe("请求未成功 (HTTP 409)");
  });

  it("preserves authentication failure behavior", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ code: "history_context_expired" }, 401)));
    await expect(fetchSessionHistory("node", "session")).rejects.toBeInstanceOf(ApiAuthError);
  });
});
