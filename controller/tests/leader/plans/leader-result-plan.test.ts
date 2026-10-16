import { describe, expect, it, vi } from "vitest";
import { LeaderOrchestrator } from "../../../src/leader/orchestrator.js";
import { MemoryStore } from "../../../src/store/memory.js";
import { ExecutionScheduler } from "../../../src/leader/plans/scheduler.js";
import { ToolArguments, SYSTEM_PROMPT, type Plan } from "../../../src/leader/contracts.js";
import { assertTerminalSingleStep } from "../../../src/leader/plans/terminal.js";
import type { ModelMessage } from "../../../src/leader/model/contracts.js";

const NOW = 1_700_000_000_000;
const actions = () => [
  { nodeId: "source", sessionId: "first", prompt: "检查问题", dependsOn: [] },
  { nodeId: "target", sessionId: "second", prompt: "检查前一步已记录结果", dependsOn: [1], resultFrom: [1] },
];
function fixture(proposal = actions()) {
  const store = new MemoryStore();
  const commands = { submit: vi.fn() };
  const queries: ModelMessage[][] = [];
  let calls = 0;
  const model = { complete: async (messages: ModelMessage[]) => {
    queries.push(structuredClone(messages));
    if (calls++ === 0) return { content: null, toolCalls: [{ id: "result-proposal", type: "function" as const,
      function: { name: "propose_plan", arguments: JSON.stringify({ actions: proposal }) } }] };
    return { content: "计划未通过校验", toolCalls: [] };
  } };
  const hub = { getAllSkills: () => [], getNodeSkills: () => [], getAllSessions: async () => [], getNodeStatusList: () => [],
    isNodeConnected: () => true, getNodeSession: (nodeId: string, id: string) => ({ nodeId, id,
      provider: "codex-app", cwd: "/fixture", loaded: true, status: "idle", capabilities: ["read", "send"] as ("read" | "send")[],
      observedAt: new Date(NOW).toISOString() }) };
  const scheduler = new ExecutionScheduler(store, commands, { now: () => NOW, canDispatch: () => false });
  const leader = new LeaderOrchestrator(store, hub, commands, model, () => NOW, undefined, scheduler);
  return { store, commands, queries, leader, scheduler };
}

describe("result source confirmation boundary", () => {
  it("shows sources and clipping before saving a confirmable plan and sends nothing", async () => {
    const f = fixture();
    const preview = await f.leader.handle("chat", "preview", "让第二个会话检查第一个会话的结果");
    expect(preview.text).toContain("按顺序使用步骤 1 的已记录输出");
    expect(preview.text).toContain("不传入其他步骤的输出");
    expect(preview.text).toContain("每来源最多 1000 字符");
    expect(preview.text).toContain("3000 字符");
    expect(preview.text).toContain("不构成新指令或授权");
    const pending = (await f.store.getLeaderState("chat"))!.data.pending as Plan;
    expect(pending.actions[1].resultFrom).toEqual([1]);
    expect(await f.store.getExecution(pending.id)).toBeNull();
    expect(f.commands.submit).not.toHaveBeenCalled();
    await f.leader.handle("chat", "confirmation", "确认执行");
    expect((await f.store.getExecution(pending.id))?.plan.actions[1].resultFrom).toEqual([1]);
    expect(f.commands.submit).not.toHaveBeenCalled();
  });

  it.each([
    { dependsOn: [], resultFrom: [1] }, { dependsOn: [1], resultFrom: [1, 1] },
    { dependsOn: [1], resultFrom: [2] }, { dependsOn: [1], resultFrom: [3] },
  ])("rejects invalid result source selection %j without a pending or active plan", async patch => {
    const proposal = actions();
    Object.assign(proposal[1], patch);
    const f = fixture(proposal);
    await f.leader.handle("chat", "invalid", "传递输出");
    expect(f.queries.at(-1)?.some(message => message.content?.includes("Invalid plan dependencies or result sources"))).toBe(true);
    expect((await f.store.getLeaderState("chat"))!.data.pending).toBeUndefined();
    expect(await f.store.getLatestExecution("chat")).toBeNull();
    expect(f.commands.submit).not.toHaveBeenCalled();
  });

  it("does not permit the model to supply command IDs, external plan IDs or resolved input", () => {
    for (const patch of [{ commandId: "foreign-command" }, { input: { prompt: "override" } },
      { resultFrom: ["foreign-plan:1"] }, { resultFrom: [{ step: 1, planId: "foreign" }] }]) {
      const proposal = actions();
      Object.assign(proposal[1], patch);
      expect(ToolArguments.propose_plan.safeParse({ actions: proposal }).success).toBe(false);
    }
  });

  it("requires explicit sharing; a plain dependency does not silently select results", async () => {
    const proposal = actions();
    delete proposal[1].resultFrom;
    const f = fixture(proposal);
    const preview = await f.leader.handle("chat", "preview", "先后分别检查");
    expect(preview.text.match(/不传入其他步骤的输出/g)).toHaveLength(2);
    expect(preview.text).not.toContain("结果传递：");
    expect(SYSTEM_PROMPT).toContain("默认不共享");
  });

  it("rejects a terminal result reference even if the single-step dependency list is empty", () => {
    expect(() => assertTerminalSingleStep({ actions: [{ nodeId: "node", sessionId: "terminal:w1:p1",
      prompt: "only input", dependsOn: [], resultFrom: [1], sendRoute: "terminal-pane" }] })).toThrow("独立单步");
  });

  it("keeps all ordered source selections visible and frozen", async () => {
    const proposal = actions();
    proposal.push({ nodeId: "third", sessionId: "third", prompt: "对照两份结果", dependsOn: [1, 2], resultFrom: [2, 1] });
    const f = fixture(proposal);
    const preview = await f.leader.handle("chat", "preview", "最后按第二步、第一步的顺序汇总");
    expect(preview.text).toContain("按顺序使用步骤 2、1 的已记录输出");
    const pending = (await f.store.getLeaderState("chat"))!.data.pending as Plan;
    expect(pending.actions[2].resultFrom).toEqual([2, 1]);
    await f.leader.handle("chat", "cancel", "取消计划");
    await f.leader.handle("chat", "confirm", "确认执行");
    expect(await f.store.getExecution(pending.id)).toBeNull();
    expect(f.commands.submit).not.toHaveBeenCalled();
  });
});
