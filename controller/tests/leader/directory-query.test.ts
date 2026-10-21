import { describe, expect, it, vi } from "vitest";
import { LeaderOrchestrator } from "../../src/leader/orchestrator.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { ScopedSession } from "../../src/types.js";

function fixture() {
  const now = Date.now();
  const sessions: ScopedSession[] = [
    { id: "idle", nodeId: "air", provider: "codex-app", title: "完整原标题", cwd: "/work/app", status: "idle",
      loaded: true, capabilities: ["read"], observedAt: new Date(now).toISOString() },
    { id: "busy", nodeId: "mini", provider: "codex-app", title: "运行任务", cwd: "/work/other", status: "active",
      loaded: true, capabilities: ["read"], observedAt: new Date(now).toISOString() },
  ];
  const store = new MemoryStore();
  const hub = {
    getAllSkills: () => [], getNodeSkills: () => [],
    getAllSessions: vi.fn(async () => sessions),
    getNodeStatusList: () => [],
    getNodeSession: (node: string, id: string) => sessions.find(s => s.nodeId === node && s.id === id) ?? null,
    isNodeConnected: () => true, readHistory: vi.fn(),
  };
  const model = { complete: vi.fn(async () => ({ content: "复杂请求仍由模型处理", toolCalls: [] })) };
  const commands = { submit: vi.fn() };
  const create = () => new LeaderOrchestrator(store, hub, commands, model, () => now);
  return { sessions, store, hub, model, commands, create };
}

describe("direct session directory", () => {
  it("reads the real observation tool without a model and persists history and a replayable receipt", async () => {
    const f = fixture();
    const result = await f.create().handle("chat", "list", "查看所有会话");
    expect(result.text).toContain("app（air）\n1. [闲] 完整原标题");
    expect(result.text).toContain("other（mini）\n2. [忙] 运行任务");
    expect(result.text).not.toContain("模型：");
    expect(f.model.complete).not.toHaveBeenCalled();
    expect(f.commands.submit).not.toHaveBeenCalled();
    const saved = await f.store.getLeaderState("chat");
    expect(saved?.data.history).toEqual([
      { role: "user", content: "查看所有会话", complete: true },
      { role: "assistant", content: result.text, complete: true },
    ]);
    f.sessions.splice(0);
    expect(await f.create().handle("chat", "list", "查看所有会话")).toEqual(result);
    expect(f.hub.getAllSessions).toHaveBeenCalledOnce();
    await expect(f.create().handle("chat", "list", "会话列表")).rejects.toThrow(/different text/);
  });

  it.each([["运行中会话列表", "运行任务", "完整原标题"], ["空闲会话列表", "完整原标题", "运行任务"]])(
    "preserves exact observed status filtering for %s", async (query, included, excluded) => {
      const f = fixture();
      const result = await f.create().handle("chat", "filtered", query);
      expect(result.text).toContain(included);
      expect(result.text).not.toContain(excluded);
      expect(f.model.complete).not.toHaveBeenCalled();
    });

  it("does not turn a mixed list-and-send or detailed read request into a directory", async () => {
    const f = fixture();
    for (const query of ["列出会话并给第2个发送继续", "查看所有会话的最新进度", "列出会话并核对模型来源"]) {
      expect((await f.create().handle("chat", query, query)).text).toBe("复杂请求仍由模型处理");
    }
    expect(f.model.complete).toHaveBeenCalledTimes(3);
    expect(f.hub.getAllSessions).not.toHaveBeenCalled();
    expect(f.commands.submit).not.toHaveBeenCalled();
  });

  it("keeps unavailable observations honest and does not call a model to fill gaps", async () => {
    const f = fixture();
    f.sessions.splice(0);
    expect((await f.create().handle("chat", "empty", "会话列表")).text).toContain("未发现会话");
    expect(f.model.complete).not.toHaveBeenCalled();
  });
});
