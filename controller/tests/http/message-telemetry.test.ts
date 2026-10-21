import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControllerServer } from "../../src/http/server.js";
import { MemoryStore } from "../../src/store/memory.js";
import { currentTrace } from "../../src/runtime/telemetry.js";
import type { LeaderModel } from "../../src/leader/model/contracts.js";
import type { ScopedSession } from "../../src/types.js";
import { markdownToWeChat } from "@super-leader/wechat-text";

describe("message HTTP latency trace", () => {
  let server: ControllerServer | undefined;
  let events: Record<string, unknown>[];
  beforeEach(() => {
    events = [];
    vi.spyOn(fs, "writeSync").mockImplementation((fd: number, message: string | ArrayBufferView) => {
      expect(fd).toBe(2);
      events.push(JSON.parse(String(message)));
      return Buffer.byteLength(String(message));
    });
  });
  afterEach(async () => {
    if (server) await server.stop();
    server = undefined;
    vi.restoreAllMocks();
  });

  async function start(store = new MemoryStore(), model?: LeaderModel) {
    server = new ControllerServer({ host: "127.0.0.1", port: 0, controllerToken: "private-controller-token",
      nodeTokens: {}, tokenToNode: new Map(), allowedChatIds: new Set(["private-chat"]),
      persistenceMode: "memory", commandTtlSeconds: 60 }, store, model);
    await server.start();
    const address = server.getHttpServer().address();
    if (!address || typeof address === "string") throw new Error("Missing test address");
    return (headers: Record<string, string> = {}, text = "private-prompt", signal?: AbortSignal) =>
      fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
        method: "POST", signal,
        headers: { authorization: "Bearer private-controller-token", "content-type": "application/json", ...headers },
        body: JSON.stringify({ chatId: "private-chat", messageId: "private-message", text }),
      });
  }

  it("records initial processing and replay in the same trace with fresh local attempts", async () => {
    const model: LeaderModel = { complete: vi.fn(async () => {
      expect(currentTrace()).toBeDefined();
      return { content: "private-answer", toolCalls: [] };
    }) };
    const post = await start(undefined, model);
    const parentAttemptId = randomUUID();
    expect((await post({ "x-latency-attempt": parentAttemptId, "x-latency-trace": "spoofed-trace" })).status).toBe(200);
    expect((await post({ "x-latency-attempt": parentAttemptId })).status).toBe(200);
    expect((await post({}, "conflicting-private-prompt")).status).toBe(409);
    const traceId = createHash("sha256").update(JSON.stringify(["private-chat", "private-message"])).digest("hex");
    expect(events.every(event => event.traceId === traceId)).toBe(true);
    expect(new Set(events.map(event => event.attemptId)).size).toBe(3);
    expect(events.filter(event => event.stage === "controller.replay")).toHaveLength(1);
    expect(events.filter(event => event.stage === "controller.leader.start")).toHaveLength(1);
    expect(events.filter(event => event.stage === "controller.persist.end")).toHaveLength(1);
    expect(events.filter(event => event.stage === "controller.response.finish")).toMatchObject([
      { httpStatus: 200, outcome: "ok", parentAttemptId },
      { httpStatus: 200, outcome: "ok", parentAttemptId },
      { httpStatus: 409, outcome: "error" },
    ]);
    expect(events.filter(event => event.parentAttemptId).every(event => event.attemptId !== parentAttemptId)).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/private-|spoofed-trace/);
  });

  it("checks auth before telemetry and ignores invalid parent headers", async () => {
    const post = await start();
    expect((await post({ authorization: "Bearer wrong" })).status).toBe(403);
    expect(events).toHaveLength(0);
    expect((await post({ "x-latency-attempt": "private-unsafe-header" })).status).toBe(200);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every(event => event.parentAttemptId === undefined)).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/private-/);
  });

  it("associates storage failure with a finished 503 without logging the exception", async () => {
    const store = new MemoryStore();
    const post = await start(store);
    vi.spyOn(store, "getMessage").mockRejectedValueOnce(new Error("private-database-error"));
    expect((await post()).status).toBe(503);
    expect(events.find(event => event.stage === "controller.dedupe.end")).toMatchObject({ outcome: "error" });
    expect(events.find(event => event.stage === "controller.message.end")).toMatchObject({ outcome: "error" });
    expect(events.find(event => event.stage === "controller.response.finish")).toMatchObject({ httpStatus: 503, outcome: "error" });
    expect(JSON.stringify(events)).not.toMatch(/private-/);
  });

  it("observes client disconnection while preserving processing semantics", async () => {
    let started!: () => void;
    let release!: () => void;
    const processing = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const model: LeaderModel = { complete: async () => {
      started(); await gate;
      return { content: "private-answer", toolCalls: [] };
    } };
    const post = await start(undefined, model);
    const abort = new AbortController();
    const pending = post({}, undefined, abort.signal).catch(error => error);
    try {
      await processing;
      abort.abort();
      await pending;
      await vi.waitFor(() => expect(events.find(event => event.stage === "controller.response.close"))
        .toMatchObject({ outcome: "disconnected" }));
    } finally { release(); }
    await vi.waitFor(() => expect(events.find(event => event.stage === "controller.message.end"))
      .toMatchObject({ outcome: "ok" }));
    expect(events.filter(event => event.stage === "controller.response.finish")).toHaveLength(0);
  });

  it("keeps successful replies available when the log sink throws", async () => {
    const post = await start();
    vi.spyOn(fs, "writeSync").mockImplementation(() => { throw new Error("broken logger"); });
    expect((await post()).status).toBe(200);
    expect((await post({ authorization: "Bearer wrong" })).status).toBe(403);
  });

  it("uses Project directories and selected observations for rule-mode WeChat lists", async () => {
    const post = await start();
    const now = Date.now();
    const sessions: ScopedSession[] = [
      { id: "old", nodeId: "demoair", provider: "codex-app", title: "旧会话原标题", cwd: "/work/app",
        status: "notLoaded", observedAt: new Date(now).toISOString(), capabilities: [],
        updatedAt: "2026-10-20T01:00:00Z", model: "control-model",
        desktopObservation: { source: "codex-desktop", availability: "available", status: "idle",
          observedAt: new Date(now).toISOString(), model: "desktop-model" } },
      { id: "other", nodeId: "mini", provider: "codex-app", title: "其他项目原标题", cwd: "/work/other",
        status: "unknown", observedAt: new Date(now).toISOString(), capabilities: [],
        updatedAt: "2026-10-21T02:00:00Z",
        desktopObservation: { source: "codex-desktop", availability: "available", status: "idle",
          observedAt: new Date(now - 120_000).toISOString(), model: "stale-model" } },
      { id: "new", nodeId: "demoair", provider: "codex-app", title: "最新会话原标题", cwd: "/work/app",
        status: "active", observedAt: new Date(now).toISOString(), capabilities: [],
        updatedAt: "2026-10-21T03:00:00Z", model: "native-model",
        desktopObservation: { source: "codex-desktop", availability: "available", status: "idle",
          observedAt: new Date(now).toISOString() } },
    ];
    const listing = vi.spyOn(server!.getNodeHub(), "getAllSessions").mockResolvedValue(sessions);
    const response = await post({}, "会话列表");
    expect(response.status).toBe(200);
    const body = markdownToWeChat((await response.json()).text, Number.MAX_SAFE_INTEGER);
    expect(body).toContain("app（demoair）");
    expect(body).toContain("other（mini）");
    expect(body.indexOf("app（demoair）")).toBeLessThan(body.indexOf("other（mini）"));
    expect(body.indexOf("最新会话原标题")).toBeLessThan(body.indexOf("旧会话原标题"));
    expect(body).toContain("[运行中] 最新会话原标题");
    expect(body).toContain("[空闲] 旧会话原标题\n模型：desktop-model");
    expect(body).toContain("[状态未知] 其他项目原标题\n模型：未知");
    expect(body).not.toContain("[demoair]");
    expect(body).not.toContain("stale-model");
    expect(listing).toHaveBeenCalledTimes(1);
    expect(sessions[0].status).toBe("notLoaded");
  });

  it("keeps rule-mode empty listings explicit about observed coverage", async () => {
    const post = await start();
    vi.spyOn(server!.getNodeHub(), "getAllSessions").mockResolvedValue([]);
    const response = await post({}, "会话列表");
    expect(response.status).toBe(200);
    expect((await response.json()).text).toBe("当前筛选范围的已观测快照未发现会话；仅覆盖在线节点已观测的会话。");
  });
});
