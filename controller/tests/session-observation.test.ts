import { describe, expect, it, vi } from "vitest";
import { CommandService } from "../src/commands.js";
import { LeaderOrchestrator } from "../src/leader/orchestrator.js";
import { LEADER_TOOLS, SYSTEM_PROMPT } from "../src/leader/contracts.js";
import type { LeaderModel, ModelMessage, ModelReply } from "../src/leader/model.js";
import { MemoryStore } from "../src/store/memory.js";
import { DesktopObservationSchema, SessionSchema, type DesktopObservation, type ScopedSession } from "../src/types.js";
import { MAX_DESKTOP_OBSERVATION_AGE_MS, selectExecutionObservation } from "../src/session-observation.js";

const NOW = Date.parse("2026-10-11T12:00:00Z");
const iso = (offset = 0) => new Date(NOW + offset).toISOString();
const desktop = (overrides: Partial<DesktopObservation> = {}): DesktopObservation => ({
  status: "active", availability: "available", source: "codex-desktop", observedAt: iso(), ...overrides,
});
const session = (id: string, status = "notLoaded", observation?: DesktopObservation): ScopedSession => ({
  id, status, desktopObservation: observation, nodeId: "node", provider: "codex-app", title: id, cwd: "/fixture",
  capabilities: ["read"], loaded: false, observedAt: iso(-1000),
});

describe("read-only desktop observation", () => {
  it.each([
    ["notLoaded", desktop(), "active", "codex-desktop"],
    ["unknown", desktop({ status: "idle" }), "idle", "codex-desktop"],
    ["notLoaded", desktop({ observedAt: iso(-MAX_DESKTOP_OBSERVATION_AGE_MS) }), "active", "codex-desktop"],
    ["notLoaded", desktop({ availability: "unavailable" }), "notLoaded", "control-socket"],
    ["unknown", desktop({ observedAt: iso(-MAX_DESKTOP_OBSERVATION_AGE_MS - 1) }), "unknown", "control-socket"],
    ["notLoaded", desktop({ observedAt: iso(1) }), "notLoaded", "control-socket"],
    ["notLoaded", desktop({ observedAt: undefined }), "notLoaded", "control-socket"],
    ["notLoaded", desktop({ status: "unknown" }), "notLoaded", "control-socket"],
    ["unknown", undefined, "unknown", "control-socket"],
    ["notLoaded", undefined, "notLoaded", "control-socket"],
    ["active", desktop({ status: "idle" }), "active", "control-socket"],
    ["busy", desktop({ status: "idle" }), "busy", "control-socket"],
    ["running", desktop({ status: "idle" }), "running", "control-socket"],
    ["idle", desktop(), "idle", "control-socket"],
  ] as const)("selects %s from valid source without modifying control fields %#", (status, observation, expected, source) => {
    const raw = session("session", status, observation);
    const original = structuredClone(raw);
    expect(selectExecutionObservation(raw, NOW)).toEqual({ executionStatus: expected, statusSource: source });
    expect(raw).toEqual(original);
    expect(raw.capabilities).toEqual(["read"]);
    expect(raw.loaded).toBe(false);
  });

  it("preserves the desktop contract and rejects malformed fields", () => {
    const raw = session("session", "notLoaded", desktop());
    expect(SessionSchema.parse(raw)).toMatchObject({ status: "notLoaded", loaded: false,
      observedAt: raw.observedAt, capabilities: ["read"], desktopObservation: raw.desktopObservation });
    expect(DesktopObservationSchema.parse(desktop({ observedAt: undefined }))).toMatchObject({ status: "active", availability: "available" });
    for (const malformed of [desktop({ observedAt: "not-a-date" }),
      desktop({ observedAt: "2026-02-30T12:00:00Z" }), desktop({ observedAt: "2026-10-11T24:00:00Z" }), { ...desktop(), source: "other" },
      { ...desktop(), status: "running" }, { ...desktop(), availability: undefined }]) {
      expect(DesktopObservationSchema.safeParse(malformed).success).toBe(false);
    }
  });

  it("keeps desktop-idle targets read-only in the existing command path", async () => {
    const target = session("session", "notLoaded", desktop({ status: "idle" }));
    const sendCommand = vi.fn();
    const hub = { isNodeConnected: () => true, getNodeSession: () => target, getNodeSkills: () => [],
      registerCommandResultWaiter: () => ({ wait: async () => null, cancel: () => {} }), sendCommand };
    const service = new CommandService(new MemoryStore(), hub, 300);
    await expect(service.submit({ nodeId: "node", sessionId: "session", action: "send", prompt: "fixture", requestId: "request" }))
      .rejects.toThrow("does not support");
    expect(sendCommand).not.toHaveBeenCalled();
    expect(target).toMatchObject({ status: "notLoaded", loaded: false, capabilities: ["read"] });
  });

  it.each([
    { status: "notLoaded", loaded: false },
    { status: "unknown", loaded: true },
    { status: "idle", loaded: false },
  ])("does not use desktop idle to bypass raw send guards for $status/$loaded", async ({ status, loaded }) => {
    const target: ScopedSession = { ...session("session", status, desktop({ status: "idle" })), loaded, capabilities: ["read", "send"] };
    const sendCommand = vi.fn();
    const hub = { isNodeConnected: () => true, getNodeSession: () => target,
      getNodeSkills: () => [], registerCommandResultWaiter: () => ({ wait: async () => null, cancel: () => {} }), sendCommand };
    const service = new CommandService(new MemoryStore(), hub, 300);
    await expect(service.submit({ nodeId: "node", sessionId: "session", action: "send", prompt: "fixture", requestId: "request" }))
      .rejects.toThrow("not idle or not loaded");
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it.each(["notLoaded", "unknown"])("does not allow desktop idle to authorize a Leader plan for %s", async status => {
    const target: ScopedSession = { ...session("session", status, desktop({ status: "idle" })), capabilities: ["read", "send"] };
    const hub = { getAllSessions: async () => [target], getNodeStatusList: () => [], getAllSkills: () => [],
      getNodeSkills: () => [], getNodeSession: () => target, isNodeConnected: () => true };
    const store = new MemoryStore();
    const commands = { submit: vi.fn() };
    let calls = 0;
    let planResult: unknown;
    const model: LeaderModel = { complete: async messages => {
      if (++calls === 1) return { content: null, toolCalls: [{ id: "plan", type: "function", function: {
        name: "propose_plan", arguments: JSON.stringify({ actions: [{ nodeId: "node", sessionId: "session", prompt: "fixture" }] }),
      } }] };
      planResult = JSON.parse(messages.find(item => item.role === "tool")!.content!);
      return { content: "目标只读，没有派发。", toolCalls: [] };
    } };
    await new LeaderOrchestrator(store, hub, commands, model, () => NOW).handle("chat", "plan", "给会话生成执行计划");
    expect(planResult).toMatchObject({ error: expect.stringContaining("read-only") });
    expect((await store.getLeaderState("chat"))?.data.pending).toBeUndefined();
    expect(commands.submit).not.toHaveBeenCalled();
  });
});

class QueryModel implements LeaderModel {
  output?: { sessions: (ScopedSession & { executionStatus: string; statusSource: string })[]; total: number;
    snapshot: Record<string, unknown> };
  private calls = 0;
  constructor(private status?: string) {}
  async complete(messages: ModelMessage[]): Promise<ModelReply> {
    if (++this.calls === 1) return { content: null, toolCalls: [{ id: "query", type: "function", function: {
      name: "list_sessions", arguments: JSON.stringify(this.status ? { status: this.status } : {}),
    } }] };
    this.output = JSON.parse(messages.find(item => item.role === "tool")!.content!);
    return { content: "已查询观测状态。", toolCalls: [] };
  }
}

describe("Leader execution-status queries", () => {
  async function query(status?: string) {
    const sessions = [session("desktop-active", "notLoaded", desktop()),
      session("desktop-idle", "unknown", desktop({ status: "idle" })),
      session("unavailable", "notLoaded", desktop({ availability: "unavailable" })),
      session("stale", "unknown", desktop({ observedAt: iso(-45001) })),
      session("future", "notLoaded", desktop({ observedAt: iso(1) })),
      session("conflict", "active", desktop({ status: "idle" })),
      session("unobserved", "notLoaded")];
    const originals = structuredClone(sessions);
    const hub = { getAllSessions: async () => sessions, getNodeStatusList: () => [{ nodeId: "node", connected: true,
      lastHeartbeat: iso(), sessionCount: sessions.length }], getAllSkills: () => [], getNodeSkills: () => [],
      getNodeSession: () => null, isNodeConnected: () => true };
    const commands = { submit: vi.fn() };
    const model = new QueryModel(status);
    await new LeaderOrchestrator(new MemoryStore(), hub, commands, model, () => NOW).handle("chat", "query", "查看会话执行状态");
    expect(commands.submit).not.toHaveBeenCalled();
    expect(sessions).toEqual(originals);
    return model.output!;
  }

  it("filters active using desktop evidence while preserving original notLoaded and coverage", async () => {
    const output = await query("active");
    expect(output.sessions.map(item => item.id)).toEqual(["desktop-active", "conflict"]);
    expect(output.sessions[0]).toMatchObject({ status: "notLoaded", loaded: false, capabilities: ["read"],
      executionStatus: "active", statusSource: "codex-desktop", desktopObservation: desktop() });
    expect(output.sessions[1]).toMatchObject({ status: "active", executionStatus: "active", statusSource: "control-socket" });
    expect(output.snapshot).toMatchObject({ observedSessionCount: 7, statusCounts: { active: 2, idle: 1, notLoaded: 3, unknown: 1 },
      unknownStatusCount: 1, notLoadedCount: 7, completeTaskCoverage: false });
  });

  it("lists all double-source facts and only fresh desktop-idle in the idle query", async () => {
    const all = await query();
    expect(all.total).toBe(7);
    expect(all.sessions.find(item => item.id === "unobserved")).toMatchObject({ executionStatus: "notLoaded", statusSource: "control-socket" });
    const idle = await query("idle");
    expect(idle.sessions.map(item => item.id)).toEqual(["desktop-idle"]);
    expect(idle.sessions[0]).toMatchObject({ status: "unknown", executionStatus: "idle", loaded: false, capabilities: ["read"] });
  });
});

describe("Leader list-only and explicit-output tool guidance", () => {
  it("passes list-only instructions with lightweight query metadata without creating commands", async () => {
    const target = session("active-session", "notLoaded", desktop());
    const hub = { getAllSessions: async () => [target], getNodeStatusList: () => [{ nodeId: "node", connected: true,
      lastHeartbeat: iso(), sessionCount: 1 }], getAllSkills: () => [], getNodeSkills: () => [],
      getNodeSession: () => target, isNodeConnected: () => true };
    const store = new MemoryStore();
    const commands = { submit: vi.fn() };
    let prompt: string | null | undefined;
    let toolDescriptions: string[] = [];
    let result: Record<string, unknown> | undefined;
    let calls = 0;
    const model: LeaderModel = { complete: async (messages, tools) => {
      prompt = messages.find(item => item.role === "system")?.content;
      toolDescriptions = tools.map(item => item.function.description);
      if (++calls === 1) return { content: null, toolCalls: [{ id: "list", type: "function", function: {
        name: "list_sessions", arguments: '{"status":"active"}',
      } }] };
      result = JSON.parse(messages.find(item => item.role === "tool")!.content!);
      return { content: "已观测到一个执行中会话。", toolCalls: [] };
    } };
    await new LeaderOrchestrator(store, hub, commands, model, () => NOW).handle("chat", "list", "列出正在运行的任务");
    expect(prompt).toBe(SYSTEM_PROMPT);
    expect(prompt).toContain("不为列举任务额外调用 read_session");
    expect(prompt).toContain("只有用户明确询问具体会话的进度或最新输出时才调用 read_session");
    expect(toolDescriptions).toEqual(LEADER_TOOLS.map(item => item.function.description));
    expect(toolDescriptions.find(item => item.includes("双源观测"))).toContain("不为列举任务额外调用 read_session");
    expect(toolDescriptions.find(item => item.includes("最新输出"))).toContain("仅在用户明确询问具体会话的进度或最新输出时");
    expect(result).toMatchObject({ total: 1, sessions: [expect.objectContaining({ title: "active-session", cwd: "/fixture",
      executionStatus: "active", statusSource: "codex-desktop" })], snapshot: { statusCounts: { active: 1 } } });
    expect(commands.submit).not.toHaveBeenCalled();
    expect(await store.listRecentCommands(50)).toEqual([]);
  });

  it("retains read_session for an explicit known-session progress request without granting send", async () => {
    const target = session("active-session", "notLoaded", desktop());
    const hub = { getAllSessions: async () => [target], getNodeStatusList: () => [], getAllSkills: () => [],
      getNodeSkills: () => [], getNodeSession: () => target, isNodeConnected: () => true };
    const commands = { submit: vi.fn().mockResolvedValue({ commandId: "read-command", status: "completed", output: "最新输出" }) };
    let calls = 0;
    const model: LeaderModel = { complete: async () => ++calls === 1 ? { content: null, toolCalls: [{ id: "read", type: "function", function: {
      name: "read_session", arguments: JSON.stringify({ nodeId: "node", sessionId: "active-session" }),
    } }] } : { content: "已取得最新输出。", toolCalls: [] } };
    await new LeaderOrchestrator(new MemoryStore(), hub, commands, model, () => NOW).handle("chat", "progress", "读取 node 上 active-session 的最新输出，说明具体进度");
    expect(commands.submit).toHaveBeenCalledTimes(1);
    expect(commands.submit).toHaveBeenCalledWith(expect.objectContaining({ nodeId: "node", sessionId: "active-session", action: "read" }), 2000);
    expect(target.capabilities).toEqual(["read"]);
  });
});
