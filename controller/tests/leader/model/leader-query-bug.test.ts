import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../../src/store/memory.js";
import { LeaderOrchestrator } from "../../../src/leader/orchestrator.js";
import { HttpLeaderModel, DEFAULT_MODEL_TIMEOUT_MS } from "../../../src/leader/model/client.js";
import { CLAIM_TTL_MS, TURN_TIMEOUT_MS } from "../../../src/leader/contracts.js";
import type { ScopedSession } from "../../../src/types.js";

const config = { baseUrl: "https://model.example/v1", apiKey: "private-secret-key", model: "test-model", retryDelayMs: 0 };
const response = (output: unknown[]) => new Response(JSON.stringify({ status: "completed", output }));
const tool = { type: "function_call", call_id: "active-query", name: "list_sessions", arguments: '{"status":"active"}', status: "completed" };
const answer = { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "当前有一个 active 会话：正在运行。" }] };

function fixture(fetchImpl: typeof fetch) {
  const store = new MemoryStore();
  const sessions: ScopedSession[] = ["active", "idle", "unknown"].map((status, index) => ({
    id: `session-${index}`, nodeId: "node", title: status, provider: "codex-app", cwd: "/workspace",
    status, capabilities: ["read"], observedAt: new Date().toISOString(),
  }));
  const hub = { getAllSessions: async () => sessions, getNodeStatusList: () => [], getAllSkills: () => [],
    getNodeSkills: () => [], getNodeSession: () => null, isNodeConnected: () => true };
  const commands = { submit: vi.fn() };
  return { store, commands, sessions, leader: new LeaderOrchestrator(store, hub, commands, new HttpLeaderModel({ ...config, fetchImpl })) };
}

function fakeDeadlines() {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Deadline reached", "TimeoutError")), ms);
    return controller.signal;
  });
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("active-task query regression", () => {
  it("allows two slow model steps beyond the old 24s deadline, without planning or dispatch", async () => {
    fakeDeadlines();
    const payloads: Record<string, unknown>[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      payloads.push(JSON.parse(init?.body as string));
      await new Promise(resolve => setTimeout(resolve, payloads.length === 1 ? 13000 : 25000));
      return response(payloads.length === 1 ? [tool] : [answer]);
    });
    const f = fixture(fetcher);
    const pending = f.leader.handle("private-chat", "private-message", "看看现在有什么 active 的任务");
    await vi.advanceTimersByTimeAsync(38001);
    const reply = await pending;
    expect(reply.text).toContain("当前有一个 active 会话");
    expect(reply.text).not.toContain("确认执行");
    expect(f.commands.submit).not.toHaveBeenCalled();
    const input = payloads[1].input as Record<string, unknown>[];
    const output = JSON.parse(input.find(item => item.type === "function_call_output")!.output as string);
    expect(output.sessions).toHaveLength(1);
    expect(output.sessions[0].status).toBe("active");
    expect(output.total).toBe(1);
    expect(output.snapshot).toMatchObject({ observedSessionCount: 3, observedNodeCount: 1,
      statusCounts: { active: 1, idle: 1, unknown: 1 }, unknownStatusCount: 1, completeTaskCoverage: false });
    expect((await f.store.getLeaderState("private-chat"))?.data.pending).toBeUndefined();
    expect(await f.leader.handle("private-chat", "private-message", "看看现在有什么 active 的任务")).toEqual(reply);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(CLAIM_TTL_MS).toBeGreaterThan(TURN_TIMEOUT_MS);
  });

  it("bounds a single default completion including all retries at 60s", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      if (fetcher.mock.calls.length === 1) {
        await new Promise(resolve => setTimeout(resolve, 45000));
        return new Response("temporary", { status: 503 });
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const pending = new HttpLeaderModel({ ...config, fetchImpl: fetcher }).complete([], []);
    const rejected = expect(pending).rejects.toThrow("timed out after 60000ms");
    await vi.advanceTimersByTimeAsync(DEFAULT_MODEL_TIMEOUT_MS - 1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("lets the 90s turn deadline interrupt a second completion before its separate 60s deadline", async () => {
    fakeDeadlines();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let requests = 0;
    const fetcher: typeof fetch = async (_url, init) => {
      requests++;
      if (requests === 1) { await new Promise(resolve => setTimeout(resolve, 45000)); return response([tool]); }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    };
    const f = fixture(fetcher);
    const pending = f.leader.handle("chat", "turn-deadline", "查询 active");
    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS);
    expect((await pending).text).toContain("查询处理超时");
    expect(warning).toHaveBeenCalledWith("Leader processing failed; no plan dispatched", expect.objectContaining({
      elapsedMs: 90000, modelSteps: 2, lastModelMs: 45000, category: "timeout",
    }));
    expect(f.commands.submit).not.toHaveBeenCalled();
  });

  it("keeps unknown and notLoaded coverage even when the active filter returns zero", async () => {
    let snapshot: Record<string, unknown> | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      if (fetcher.mock.calls.length === 1) return response([tool]);
      const input = JSON.parse(init?.body as string).input as Record<string, unknown>[];
      const output = JSON.parse(input.find(item => item.type === "function_call_output")!.output as string);
      expect(output.sessions).toEqual([]);
      snapshot = output.snapshot;
      return response([{ ...answer, content: [{ type: "output_text", text: "已观测快照未发现 active，其他会话状态未知或未加载。" }] }]);
    });
    const f = fixture(fetcher);
    f.sessions[0].status = "notLoaded";
    f.sessions[0].loaded = false;
    f.sessions[1].status = "unknown";
    expect((await f.leader.handle("chat", "coverage", "查询 active")).text).toContain("快照未发现");
    expect(snapshot).toMatchObject({ observedSessionCount: 3, statusCounts: { notLoaded: 1, unknown: 2 },
      unknownStatusCount: 2, notLoadedCount: 1, completeTaskCoverage: false });
    expect(f.commands.submit).not.toHaveBeenCalled();
  });

  it("ends at the complete-turn deadline and reports diagnostic step counts without identifiers", async () => {
    fakeDeadlines();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 19000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(init.signal?.reason);
        }, { once: true });
      });
      return response([tool]);
    });
    const f = fixture(fetcher);
    const pending = f.leader.handle("private-chat", "private-message", "看看 active 任务");
    await vi.advanceTimersByTimeAsync(TURN_TIMEOUT_MS + 1);
    const reply = await pending;
    expect(reply.text).toContain("查询处理超时");
    expect(reply.text).not.toContain("没有任务");
    expect(reply.text).toContain("未向会话发送新指令");
    expect(f.commands.submit).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith("Leader processing failed; no plan dispatched", expect.objectContaining({
      category: "timeout", elapsedMs: TURN_TIMEOUT_MS, modelSteps: 5, toolCalls: 4,
      lastModelMs: 14000, totalModelMs: TURN_TIMEOUT_MS,
    }));
    expect(JSON.stringify(warning.mock.calls)).not.toMatch(/private-chat|private-message|private-secret-key/);
  });

  it("safely retries only a transient model request, then continues the same query once", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("secret-provider-body", { status: 500 }))
      .mockResolvedValueOnce(response([tool]))
      .mockResolvedValueOnce(response([answer]));
    const f = fixture(fetcher);
    expect((await f.leader.handle("chat", "message", "查询 active 任务")).text).toContain("当前有一个");
    expect(fetcher.mock.calls[0][1]?.body).toBe(fetcher.mock.calls[1][1]?.body);
    expect(f.commands.submit).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith("Leader model temporary HTTP failure; retry scheduled", expect.objectContaining({ httpStatus: 500, attempt: 1 }));
    expect(JSON.stringify(warning.mock.calls)).not.toContain("secret-provider-body");
  });

  it("does not treat quota failure or malformed model output as an empty task list", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: {
      code: "insufficient_quota", message: "private-secret-key",
    } }), { status: 429, headers: { "content-type": "application/json" } }));
    const f = fixture(fetcher);
    expect((await f.leader.handle("chat", "quota", "查询 active 任务")).text).toContain("配置或额度异常");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const malformed = fixture(async () => response([]));
    const reply = await malformed.leader.handle("chat", "malformed", "查询 active 任务");
    expect(reply.text).toContain("不完整或无效");
    expect(reply.text).not.toContain("没有任务");
    expect(f.commands.submit).not.toHaveBeenCalled();
  });

  it("honors Retry-After and preserves upstream HTTP errors when retry cannot fit the budget", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("temporary", { status: 503, headers: { "retry-after": "0.5" } }))
      .mockResolvedValueOnce(response([answer]));
    const pending = new HttpLeaderModel({ ...config, fetchImpl: fetcher }).complete([], []);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).content).toContain("当前有一个");
    const overloaded = vi.fn<typeof fetch>(async () => new Response("temporary", {
      status: 503, headers: { "retry-after": "9999999999" },
    }));
    const failing = new HttpLeaderModel({ ...config, timeoutMs: 20, fetchImpl: overloaded }).complete([], []);
    await expect(failing).rejects.toMatchObject({ diagnostic: { category: "http", httpStatus: 503, attempts: 1 } });
    expect(overloaded).toHaveBeenCalledTimes(1);
  });

  it("reports HTTP502 Retry-After60s as temporarily unavailable without waiting or claiming a retry", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([tool]))
      .mockResolvedValueOnce(new Response("private-provider-error", { status: 502, headers: { "retry-after": "60" } }));
    const f = fixture(fetcher);
    const reply = await f.leader.handle("chat", "provider-overload", "查询 active");
    expect(reply.text).toContain("模型服务暂时不可用");
    expect(reply.text).not.toContain("安全重试后");
    expect(reply.text).not.toContain("超时");
    expect(warning).toHaveBeenCalledWith("Leader processing failed; no plan dispatched", expect.objectContaining({
      category: "http", httpStatus: 502, attempts: 1, modelSteps: 2, toolCalls: 1,
    }));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(f.commands.submit).not.toHaveBeenCalled();
  });

  it.each(["stalled until the completion deadline", "immediately errored"] as const)(
    "preserves HTTP502 when its JSON error body is %s without leaking or creating commands", async mode => {
      fakeDeadlines();
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const sensitiveText = "private-provider-error private-secret-key";
      const errorBody = new ReadableStream<Uint8Array>({ start(controller) {
        if (mode === "immediately errored") controller.error(new Error(sensitiveText));
        else controller.enqueue(new TextEncoder().encode(`{"error":{"message":"${sensitiveText}`));
      } });
      const fetcher = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(response([tool]))
        .mockResolvedValueOnce(new Response(errorBody, { status: 502,
          headers: { "content-type": "application/json", "retry-after": "60" } }));
      const f = fixture(fetcher);
      const pending = f.leader.handle("private-chat", "failed-json-body", "看看现在有什么 active 的任务");
      await vi.advanceTimersByTimeAsync(DEFAULT_MODEL_TIMEOUT_MS);
      const reply = await pending;
      expect(reply.text).toContain("模型服务暂时不可用");
      expect(reply.text).not.toContain("安全重试后");
      expect(reply.text).not.toContain("超时");
      expect(reply.text).not.toContain("本次模型处理未成功");
      expect(warning).toHaveBeenCalledWith("Leader processing failed; no plan dispatched", expect.objectContaining({
        category: "http", httpStatus: 502, attempts: 1, modelSteps: 2, toolCalls: 1,
      }));
      expect(JSON.stringify({ reply, warnings: warning.mock.calls })).not.toMatch(/private-provider-error|private-secret-key|private-chat|failed-json-body/);
      expect(warning.mock.calls.some(([message]) => message === "Leader model temporary HTTP failure; retry scheduled")).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(f.commands.submit).not.toHaveBeenCalled();
      expect(reply.commandId).toBeUndefined();
      expect((await f.store.getLeaderState("private-chat"))?.data.pending).toBeUndefined();
      expect(await f.store.listRecentCommands(50)).toEqual([]);
    },
  );
});
