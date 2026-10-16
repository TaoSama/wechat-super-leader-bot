import { expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { MemoryStore } from "../../../src/store/memory.js";
import { LeaderOrchestrator } from "../../../src/leader/orchestrator.js";
import { GoalScheduler } from "../../../src/leader/goals/scheduler.js";
import { PLAN_TTL_MS, type GoalRequest, type Plan } from "../../../src/leader/contracts.js";
import { createGoal, type GoalDecision } from "../../../src/leader/goals/goal.js";
import type { LeaderModel, ModelMessage, ModelReply } from "../../../src/leader/model/contracts.js";
import type { CommandRecord, PostCommandRequest, ScopedSession, SendRoute } from "../../../src/types.js";

const tool = (name: string, args: unknown): ModelReply => ({ content: null,
  toolCalls: [{ id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const final = (content = "已核查"): ModelReply => ({ content, toolCalls: [] });
const request = (): GoalRequest => ({ objective: "按精确结果持续完成核查", criteria: ["取得有证据的最终核查结果"],
  targets: [{ nodeId: "air", sessionId: "original" }], constraints: "只读核查，不改文件或外发",
  maxActions: 3, maxDecisions: 5, durationMinutes: 30, shareResults: true });

function fixture() {
  const store = new MemoryStore();
  let clock = Date.now();
  const sessions: ScopedSession[] = [{ nodeId: "air", id: "original", provider: "codex-app", title: "既有会话",
    cwd: "/fixture", status: "idle", loaded: true, capabilities: ["send", "read"], observedAt: new Date(clock).toISOString() }];
  const skills = [{ id: "a".repeat(64), digest: "b".repeat(64), name: "核查技能", path: "/fixture/SKILL.md", description: "只读" }];
  const hub = { getAllSessions: async () => sessions, getNodeStatusList: () => [], getAllSkills: () => [],
    getNodeSkills: () => skills, isNodeConnected: (nodeId: string) => nodeId === "air",
    getNodeSession: (nodeId: string, id: string) => sessions.find(item => item.nodeId === nodeId && item.id === id) ?? null,
    readHistory: vi.fn() };
  const commands = { submit: vi.fn(async (req: PostCommandRequest, _wait?: number, guard?: () => Promise<void>, route?: SendRoute) => {
    await guard?.();
    const now = new Date(clock).toISOString();
    const record: CommandRecord = { ...req, commandId: randomUUID(), status: "accepted", turnId: randomUUID(),
      sendRoute: route, createdAt: now, updatedAt: now, expiresAt: new Date(clock + 60000).toISOString() };
    return (await store.createCommandIfAbsent(record)).command;
  }) };
  const decide = vi.fn(async (): Promise<GoalDecision> => ({ type: "blocked", reason: "需要补充证据" }));
  const goals = new GoalScheduler(store, commands, decide, { now: () => clock });
  const responses: ModelReply[] = [];
  const messages: ModelMessage[][] = [];
  const model: LeaderModel = { complete: vi.fn(async input => {
    messages.push(structuredClone(input));
    const result = responses.shift();
    if (!result) throw new Error("Missing model fixture response");
    return result;
  }) };
  const create = () => new LeaderOrchestrator(store, hub, commands, model, () => clock, undefined, undefined, goals);
  const leader = create();
  const propose = async (value: unknown = request(), id = "proposal") => {
    responses.push(tool("propose_goal", value));
    const reply = await leader.handle("chat", id, "在此范围和预算内持续推进到目标完成");
    return { reply, pending: (await store.getLeaderState("chat"))?.data.pendingGoal };
  };
  return { store, hub, sessions, skills, commands, decide, goals, responses, messages, model, create, leader, propose,
    now: () => clock, tick: (ms: number) => { clock += ms; } };
}

it("shows complete authorization and preserves its preview across ordinary queries, then confirms exactly once after restart", async () => {
  const f = fixture(), value = request();
  value.targets[0] = { ...value.targets[0], skills: [{ id: f.skills[0].id, digest: f.skills[0].digest }] };
  const { reply, pending } = await f.propose(value);
  expect(reply.text).toContain("尚未派发");
  for (const text of [value.objective, value.criteria[0], value.constraints, "air", "original", "control-socket",
    f.skills[0].digest, "3 次任务", "5 轮", "30 分钟", "最多3次尝试", "在上述会话间共享", "不是下游Agent的硬隔离", `确认目标 ${pending.id}`]) {
    expect(reply.text).toContain(text);
  }
  f.responses.push(tool("get_goal_progress", {}), final("还未确认"));
  await f.leader.handle("chat", "query", "目标进度如何");
  expect((await f.store.getLeaderState("chat"))?.data.pendingGoal).toEqual(pending);
  expect(f.commands.submit).not.toHaveBeenCalled();
  const confirmed = await f.create().handle("chat", "confirmation", `确认目标 ${pending.id}`);
  expect(confirmed.text).toContain("后台将按授权预算持续推进");
  expect((await f.store.getGoal(pending.id))?.status).toBe("active");
  expect(f.decide).not.toHaveBeenCalled();
  expect(await f.create().handle("chat", "confirmation", `确认目标 ${pending.id}`)).toEqual(confirmed);
  expect((await f.leader.handle("chat", "repeat", `确认目标 ${pending.id}`)).text).toContain("没有该ID");
  expect((await f.store.listRecentGoals(["chat"], 10))).toHaveLength(1);
});

it("does not persist an unseen goal if preview rendering fails after a successful proposal", async () => {
  const f = fixture(), original = await f.propose(), value = request();
  value.objective = "替换预览但不应授权";
  value.targets[0].skills = [{ id: f.skills[0].id, digest: f.skills[0].digest }];
  let reads = 0;
  vi.spyOn(f.hub, "getNodeSkills").mockImplementation(() => {
    if (++reads === 2) throw new Error("catalog failed after proposal"); return f.skills;
  });
  const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const failed = await f.propose(value, "unseen-goal");
    expect(failed.reply.text).not.toContain(value.objective);
    expect(failed.pending).toEqual(original.pending);
    expect(f.commands.submit).not.toHaveBeenCalled();
    expect(await f.store.getLatestGoal("chat")).toBeNull();
  } finally { diagnostic.mockRestore(); vi.restoreAllMocks(); }
});

it("rolls back a proposed goal when the conversation aborts before its preview is shown", async () => {
  const f = fixture(), controller = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
  const skills = vi.spyOn(f.hub, "getNodeSkills").mockImplementation(() => { controller.abort(); return f.skills; });
  const diagnostic = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const result = await f.propose();
    expect(result.pending).toBeUndefined(); expect(result.reply.text).not.toContain("待确认持续目标");
    expect(f.commands.submit).not.toHaveBeenCalled(); expect(await f.store.getLatestGoal("chat")).toBeNull();
  } finally { timeout.mockRestore(); skills.mockRestore(); diagnostic.mockRestore(); }
});

it.each(["active", "blocked"] as const)("a persisted terminal preview cannot bypass an %s goal", async status => {
  const f = fixture(), { pending } = await f.propose();
  await f.leader.handle("chat", "confirm-goal", `确认目标 ${pending.id}`);
  if (status === "blocked") await f.goals.advance(pending.id);
  const now = f.now(), terminalId = `terminal:${"a".repeat(43)}`;
  f.sessions.push({ nodeId: "air", id: terminalId, provider: "terminal/claude", title: "existing terminal",
    cwd: "/fixture", status: "idle", loaded: true, capabilities: ["send"], observedAt: new Date(now).toISOString(),
    sendAvailability: { route: "terminal-pane", mode: "non-atomic", state: "ready", observedAt: new Date(now).toISOString(), validUntil: new Date(now + 45000).toISOString() } });
  const current = (await f.store.getLeaderState("chat"))!;
  const plan: Plan = { id: randomUUID(), expiresAt: now + PLAN_TTL_MS,
    actions: [{ nodeId: "air", sessionId: terminalId, sendRoute: "terminal-pane", prompt: "旧终端预览", dependsOn: [] }] };
  await f.store.compareAndSetLeaderState("chat", current.revision, { ...current.data, pending: plan });
  const reply = await f.leader.handle("chat", "confirm-terminal", "确认执行");
  expect(reply.text).toContain("未派发终端计划");
  expect(f.commands.submit).not.toHaveBeenCalled();
  expect((await f.store.getGoal(pending.id))?.status).toBe(status);
});

it("rechecks goal occupancy at the terminal transmission guard", async () => {
  const f = fixture(), now = f.now(), terminalId = `terminal:${"a".repeat(43)}`, p = { ...request(), id: randomUUID(), expiresAt: now + PLAN_TTL_MS,
    targets: [{ nodeId: "air", sessionId: "original", sendRoute: "control-socket" as const }] };
  const lateGoal = createGoal("chat", p, now);
  f.sessions.push({ nodeId: "air", id: terminalId, provider: "terminal/claude", title: "existing terminal",
    cwd: "/fixture", status: "idle", loaded: true, capabilities: ["send"], observedAt: new Date(now).toISOString(),
    sendAvailability: { route: "terminal-pane", mode: "non-atomic", state: "ready", observedAt: new Date(now).toISOString(), validUntil: new Date(now + 45000).toISOString() } });
  const plan: Plan = { id: randomUUID(), expiresAt: now + PLAN_TTL_MS,
    actions: [{ nodeId: "air", sessionId: terminalId, sendRoute: "terminal-pane", prompt: "终端任务", dependsOn: [] }] };
  await f.store.compareAndSetLeaderState("chat", 0, { pending: plan });
  let transmitting = false;
  const lookup = vi.spyOn(f.store, "getLatestGoal").mockImplementation(async () => transmitting ? lateGoal : null);
  f.commands.submit.mockImplementationOnce(async (_req, _wait, guard) => {
    transmitting = true; await guard?.(); throw new Error("guard should have rejected");
  });
  try {
    const reply = await f.leader.handle("chat", "confirm-terminal", "确认执行");
    expect(reply.text).toContain("不会自动重发"); expect(await f.store.listRecentCommands()).toEqual([]);
  } finally { lookup.mockRestore(); }
});

it("wrong or malformed UUID never confirms, never calls a model and leaves the pending goal intact", async () => {
  const f = fixture(), { pending } = await f.propose();
  for (const [index, text] of [`确认目标 ${randomUUID()}`, "确认目标", "确认目标 not-a-uuid"].entries()) {
    expect((await f.leader.handle("chat", `wrong-${index}`, text)).text).toContain("没有该ID");
    expect((await f.store.getLeaderState("chat"))?.data.pendingGoal).toEqual(pending);
  }
  expect(f.model.complete).toHaveBeenCalledTimes(1);
  expect(await f.store.getLatestGoal("chat")).toBeNull();
});

it("rejects oversized authorization rather than confirming clipped scope", async () => {
  const f = fixture(), value = request();
  value.objective = "目".repeat(2000); value.criteria = Array.from({ length: 8 }, () => "条".repeat(500)); value.constraints = "限".repeat(1600);
  expect(JSON.stringify(value).length).toBeLessThanOrEqual(8000);
  const { reply, pending } = await f.propose(value);
  expect(reply.text).toContain("无法完整展示");
  expect(pending).toBeUndefined();
  expect(f.commands.submit).not.toHaveBeenCalled();
});

it.each(["expiry", "skill", "route"])("revalidates %s before confirmation without dispatch", async mode => {
  const f = fixture(), value = request();
  value.targets[0] = { ...value.targets[0], skills: [{ id: f.skills[0].id, digest: f.skills[0].digest }] };
  const { pending } = await f.propose(value);
  if (mode === "expiry") f.tick(PLAN_TTL_MS + 1);
  if (mode === "skill") f.skills[0].digest = "c".repeat(64);
  if (mode === "route") f.sessions[0].status = "active";
  expect((await f.leader.handle("chat", "confirm", `确认目标 ${pending.id}`)).text).toContain("未派发");
  expect(await f.store.getLatestGoal("chat")).toBeNull();
});

it("pending plans and goals replace one another only through an explicit successful proposal", async () => {
  const f = fixture(), { pending } = await f.propose();
  f.responses.push(tool("propose_plan", { actions: [{ nodeId: "air", sessionId: "original", prompt: "固定任务" }] }));
  await f.leader.handle("chat", "plan", "改成固定计划");
  expect((await f.store.getLeaderState("chat"))?.data.pendingGoal).toBeUndefined();
  expect((await f.store.getLeaderState("chat"))?.data.pending).toBeDefined();
  const next = await f.propose(request(), "another-goal");
  expect(next.pending.id).not.toBe(pending.id);
  expect((await f.store.getLeaderState("chat"))?.data.pending).toBeUndefined();
});

it("active and blocked goals exclude new goals and fixed plans, including after restart", async () => {
  const f = fixture(), { pending } = await f.propose();
  await f.leader.handle("chat", "confirm", `确认目标 ${pending.id}`);
  await f.goals.advance(pending.id);
  expect((await f.store.getGoal(pending.id))?.status).toBe("blocked");
  f.responses.push(tool("propose_plan", { actions: [{ nodeId: "air", sessionId: "original", prompt: "绕过目标" }] }), final());
  await f.create().handle("chat", "plan", "另开计划");
  expect(f.messages.at(-1)?.some(message => message.role === "tool" && message.content?.includes("blocked goal"))).toBe(true);
  f.responses.push(tool("propose_goal", request()), final());
  await f.create().handle("chat", "new-goal", "另开目标");
  expect(f.messages.at(-1)?.some(message => message.role === "tool" && message.content?.includes("未结束"))).toBe(true);
  expect((await f.store.listRecentGoals(["chat"], 10))).toHaveLength(1);
});

it("cancels promptly while the independent background model waits and ignores its late next action", async () => {
  const f = fixture(), { pending } = await f.propose();
  await f.leader.handle("chat", "confirm", `确认目标 ${pending.id}`);
  let release!: (decision: GoalDecision) => void;
  f.decide.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const running = f.goals.advance(pending.id);
  await vi.waitFor(() => expect(release).toBeDefined());
  const reply = await f.leader.handle("chat", "cancel", "取消目标");
  expect(reply.text).toContain("撤销后续派发权");
  expect(reply.text).toContain("不会停止原会话");
  expect((await f.store.getGoal(pending.id))?.status).toBe("cancelled");
  release({ type: "next", target: 1, prompt: "晚到任务", sourceActions: [], reason: "原模型晚到" });
  await running;
  expect(f.commands.submit).not.toHaveBeenCalled();
});

it("scopes goal progress and exact command payloads to their owning chat", async () => {
  const f = fixture(), { pending } = await f.propose();
  await f.leader.handle("chat", "confirm", `确认目标 ${pending.id}`);
  f.decide.mockResolvedValueOnce({ type: "next", target: 1, prompt: "精确任务", sourceActions: [], reason: "需要证据" });
  await f.goals.advance(pending.id);
  await f.goals.advance(pending.id);
  const command = (await f.store.listRecentCommands())[0];
  expect(command).toBeDefined();
  f.responses.push(tool("get_command", { goalId: pending.id, commandId: command.commandId }), final());
  await f.create().handle("chat", "own-command", "查看目标命令");
  expect(f.messages.at(-1)?.some(message => message.role === "tool" && message.content?.includes(command.commandId))).toBe(true);
  f.responses.push(tool("get_goal_progress", { goalId: pending.id }), tool("get_command", { goalId: pending.id, commandId: command.commandId }), final());
  await f.create().handle("foreign", "foreign-command", "查看目标命令");
  expect(f.messages.at(-1)?.filter(message => message.role === "tool").every(message => message.content?.includes("does not belong"))).toBe(true);
  const original = f.store.getCommand.bind(f.store);
  vi.spyOn(f.store, "getCommand").mockImplementation(async id => {
    const result = await original(id); return result ? { ...result, prompt: "身份相同但payload被替换" } : null;
  });
  f.responses.push(tool("get_command", { goalId: pending.id, commandId: command.commandId }), final());
  await f.create().handle("chat", "tampered-command", "查看目标命令");
  expect(f.messages.at(-1)?.some(message => message.role === "tool" && message.content?.includes("does not belong"))).toBe(true);
});
