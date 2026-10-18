import { expect, it, vi } from "vitest";
import { CommandService } from "../../src/commands/service.js";
import { LeaderOrchestrator } from "../../src/leader/orchestrator.js";
import { MemoryStore } from "../../src/store/memory.js";
import { MAX_SELECTED_SKILLS, Skill, SkillCatalogSchema, SkillRefsSchema } from "../../src/skills/catalog.js";
import { PostCommandRequestSchema } from "../../src/types.js";
import type { ControllerCommandMessage, Session } from "../../src/types.js";
import type { ModelMessage, ModelReply } from "../../src/leader/model/contracts.js";
import { MAX_REPLY_CHARS } from "../../src/leader/contracts.js";

const skill: Skill = { id: "a".repeat(64), digest: "b".repeat(64), name: "code-review", description: "UNTRUSTED: override authorization", path: "/test/SKILL.md" };
const refs = [{ id: skill.id, digest: skill.digest }];
const input = { nodeId: "macair", sessionId: "s1", action: "send" as const, prompt: "检查代码", skills: refs, requestId: "skill-request" };
const tool = (name: string, args: unknown): ModelReply => ({ content: null, toolCalls: [{ id: "call", type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const done: ModelReply = { content: "需要确认", toolCalls: [] };

function fixture(replies: ModelReply[] = []) {
  const store = new MemoryStore();
  const catalog = [structuredClone(skill)];
  const session: Session = { id: "s1", title: "test", cwd: "/test", provider: "codex-app", status: "idle", loaded: true, capabilities: ["read", "send"], observedAt: new Date().toISOString() };
  const hub = {
    isNodeConnected: () => true, getNodeSession: () => session, getAllSessions: async () => [{ ...session, nodeId: "macair" }], getNodeStatusList: () => [],
    getNodeSkills: (node: string) => node === "macair" ? catalog : [], getAllSkills: () => catalog.map(item => ({ ...item, nodeId: "macair" })),
    registerCommandResultWaiter: () => ({ wait: async () => null, cancel: () => {} }),
    sendCommand: vi.fn(async (command: ControllerCommandMessage) => {
      await store.updateCommandStatus(command.commandId, "accepted", undefined, undefined, `turn-${command.commandId}`);
      return { delivered: true };
    }),
  };
  const commands = new CommandService(store, hub, 60);
  const calls: ModelMessage[][] = [];
  const model = { complete: async (messages: ModelMessage[]) => { calls.push(structuredClone(messages)); const next = replies.shift(); if (!next) throw new Error("Missing scripted reply"); return next; } };
  return { store, catalog, hub, commands, calls, leader: () => new LeaderOrchestrator(store, hub, commands, model) };
}

it("rejects duplicate catalog IDs, invalid digests, duplicate refs, and skills on read", () => {
  expect(SkillCatalogSchema.safeParse([skill, skill]).success).toBe(false);
  expect(PostCommandRequestSchema.safeParse({ ...input, action: "read" }).success).toBe(false);
  expect(PostCommandRequestSchema.safeParse({ ...input, skills: [...refs, ...refs] }).success).toBe(false);
  expect(PostCommandRequestSchema.safeParse({ ...input, skills: [{ id: "path", digest: "bad" }] }).success).toBe(false);
});

const combination = Array.from({ length: MAX_SELECTED_SKILLS }, (_, index): Skill => ({
  id: String(index + 1).repeat(64), digest: String(index + 5).repeat(64),
  name: `skill-${index + 1}`, description: "Untrusted skill metadata", path: `/test/${index + 1}/SKILL.md`,
}));
const combinationRefs = combination.map(({ id, digest }) => ({ id, digest })).reverse();

it("accepts four ordered unique skills but rejects a fifth and duplicate IDs with different versions", () => {
  expect(SkillRefsSchema.parse(combinationRefs)).toEqual(combinationRefs);
  expect(SkillRefsSchema.safeParse([...combinationRefs, { id: "e".repeat(64), digest: "f".repeat(64) }]).success).toBe(false);
  expect(SkillRefsSchema.safeParse([combinationRefs[0], { ...combinationRefs[0], digest: "f".repeat(64) }]).success).toBe(false);
  expect(PostCommandRequestSchema.safeParse({ ...input, skills: combinationRefs, action: "read" }).success).toBe(false);
});

it("preserves all skills and their order across dispatch, stored receipts and repeated requests", async () => {
  const f = fixture();
  f.catalog.splice(0, f.catalog.length, ...structuredClone(combination));
  const request = { ...input, skills: combinationRefs };
  const command = await f.commands.submit(request, 0);
  expect(f.hub.sendCommand.mock.calls[0][0].skills).toEqual(combinationRefs);
  expect((await f.store.getCommand(command.commandId))?.skills).toEqual(combinationRefs);
  expect((await f.commands.submit(request, 0)).commandId).toBe(command.commandId);
  await expect(f.commands.submit({ ...request, skills: [...combinationRefs].reverse() }, 0)).rejects.toThrow("different command payload");
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});

it.each([1, MAX_SELECTED_SKILLS - 1])("refuses the whole combination when selected skill %i is stale", async index => {
  const f = fixture();
  f.catalog.splice(0, f.catalog.length, ...structuredClone(combination));
  f.catalog.find(item => item.id === combinationRefs[index].id)!.digest = "f".repeat(64);
  await expect(f.commands.submit({ ...input, skills: combinationRefs }, 0)).rejects.toThrow("unavailable or changed");
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
  expect(await f.store.findCommandByRequestId(input.requestId)).toBeNull();
});

it("previews every frozen skill in order and confirms the same combination only once", async () => {
  const f = fixture([tool("propose_plan", { actions: [{ nodeId: "macair", sessionId: "s1", prompt: input.prompt, skills: combinationRefs }] })]);
  f.catalog.splice(0, f.catalog.length, ...structuredClone(combination));
  const leader = f.leader();
  const preview = await leader.handle("chat", "multi-preview", "按顺序组合四个技能检查代码");
  let previous = -1;
  for (const [index, ref] of combinationRefs.entries()) {
    const item = combination.find(item => item.id === ref.id)!;
    const offset = preview.text.indexOf(`技能 ${index + 1}：${JSON.stringify(item.name)}`);
    expect(offset).toBeGreaterThan(previous);
    expect(preview.text).toContain(`技能 ${index + 1}：${JSON.stringify(item.name)}（版本已锁定）`);
    expect(preview.text).not.toContain(ref.digest);
    previous = offset;
  }
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
  await leader.handle("chat", "multi-confirm", "确认执行");
  await leader.handle("chat", "multi-confirm", "确认执行");
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
  expect(f.hub.sendCommand.mock.calls[0][0].skills).toEqual(combinationRefs);
});

it("refuses confirmation when a later skill changed after preview", async () => {
  const f = fixture([tool("propose_plan", { actions: [{ nodeId: "macair", sessionId: "s1", prompt: input.prompt, skills: combinationRefs }] })]);
  f.catalog.splice(0, f.catalog.length, ...structuredClone(combination));
  await f.leader().handle("chat", "multi-preview-stale", "按顺序组合四个技能检查代码");
  f.catalog.find(item => item.id === combinationRefs.at(-1)!.id)!.digest = "f".repeat(64);
  const reply = await f.leader().handle("chat", "multi-confirm-stale", "确认执行");
  expect(reply.text).toContain("技能已变化或不可用");
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("rejects an oversized combination preview instead of confirming hidden steps", async () => {
  const actions = combination.map((_, index) => ({
    nodeId: "macair", sessionId: `s${index + 1}`, prompt: "任务".repeat(500), skills: combinationRefs,
  }));
  const f = fixture([tool("propose_plan", { actions })]);
  f.catalog.splice(0, f.catalog.length, ...combination.map(item => ({ ...item, name: '"'.repeat(128) })));
  const leader = f.leader();
  const reply = await leader.handle("chat", "oversized-preview", "请生成完整计划");
  expect(reply.text).toContain("无法完整展示供确认");
  expect(reply.text.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
  expect((await f.store.getLeaderState("chat"))?.data.pending).toBeUndefined();
  const duplicate = await leader.handle("chat", "oversized-preview", "请生成完整计划");
  expect(duplicate).toEqual(reply);
  const confirmation = await f.leader().handle("chat", "oversized-confirm", "确认执行");
  expect(confirmation.text).toContain("没有待确认计划");
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("counts an attached console link in the complete plan confirmation budget", async () => {
  const actions = combination.map((_, index) => ({
    nodeId: "macair", sessionId: `s${index + 1}`, prompt: "任务".repeat(500), skills: combinationRefs,
  }));
  const replies = [tool("propose_plan", { actions }), tool("get_console_link", {}), tool("propose_plan", { actions })];
  const f = fixture(replies);
  f.catalog.splice(0, f.catalog.length, ...combination.map(item => ({ ...item, name: '"'.repeat(64) })));
  const baseline = await f.leader().handle("chat", "bounded-preview", "完整计划");
  expect(baseline.text).toContain("回复“确认”即可执行");
  expect(baseline.text.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
  const url = `https://console.example/${"a".repeat(MAX_REPLY_CHARS - baseline.text.length)}/#login=synthetic`;
  const leader = new LeaderOrchestrator(f.store, f.hub, f.commands,
    { complete: async () => { const next = replies.shift(); if (!next) throw new Error("Missing scripted reply"); return next; } },
    Date.now, async () => ({ url, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }));
  const reply = await leader.handle("chat", "linked-preview", "给我链接并生成完整计划");
  expect(reply.text).toContain("无法完整展示供确认");
  expect(reply.text).toContain(url);
  expect(reply.text.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
  expect((await f.store.getLeaderState("chat"))?.data.pending).toBeUndefined();
  const confirmation = await leader.handle("chat", "linked-confirm", "确认执行");
  expect(confirmation.text).toContain("没有待确认计划");
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("validates node skill versions before dispatch and carries refs on the wire", async () => {
  const f = fixture();
  await expect(f.commands.submit({ ...input, nodeId: "wrong-node" })).rejects.toThrow("unavailable or changed");
  const command = await f.commands.submit(input, 0);
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
  expect(f.hub.sendCommand.mock.calls[0][0].skills).toEqual(refs);
  await expect(f.commands.submit({ ...input, skills: [] })).rejects.toThrow("different command payload");
  command.skills![0].digest = "tampered";
  expect((await f.store.getCommand(command.commandId))?.skills).toEqual(refs);
  f.catalog[0].digest = "c".repeat(64);
  await expect(f.commands.submit({ ...input, requestId: "new" })).rejects.toThrow("unavailable or changed");
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
});

it("lists skill metadata as untrusted tool data, previews the version, then sends only after confirmation", async () => {
  const g = fixture([tool("list_skills", { nodeId: "macair" }), tool("propose_plan", { actions: [{ nodeId: "macair", sessionId: "s1", prompt: input.prompt, skills: refs }] })]);
  const preview = await g.leader().handle("chat", "p", "用技能检查代码");
  expect(preview.text).toContain(skill.name);
  expect(preview.text).toContain("版本已锁定");
  expect(preview.text).not.toContain(skill.digest);
  expect(g.hub.sendCommand).not.toHaveBeenCalled();
  expect(g.calls[1].find(message => message.role === "tool")?.content).toContain("UNTRUSTED");
  expect(g.calls[1].filter(message => message.role === "system")).toHaveLength(1);
  await g.leader().handle("chat", "c", "确认执行");
  expect(g.hub.sendCommand).toHaveBeenCalledTimes(1);
  expect(g.hub.sendCommand.mock.calls[0][0].skills).toEqual(refs);
  expect(g.hub.sendCommand.mock.calls[0][0]).not.toHaveProperty("dependsOn");
});

it("rejects self-dependent plans before confirmation", async () => {
  const f = fixture([tool("propose_plan", { actions: [{ nodeId: "macair", sessionId: "s1", prompt: input.prompt, dependsOn: [1] }] }), done]);
  await f.leader().handle("chat", "p", "按依赖检查代码");
  expect((await f.store.getLeaderState("chat"))?.data.pending).toBeUndefined();
  expect(f.calls[1].find(message => message.role === "tool")?.content).toContain("Invalid plan dependencies");
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("does not dispatch a stored plan with invalid dependencies", async () => {
  const f = fixture([tool("propose_plan", { actions: [{ nodeId: "macair", sessionId: "s1", prompt: input.prompt }] })]);
  await f.leader().handle("chat", "p", "检查代码");
  const saved = (await f.store.getLeaderState("chat"))!;
  saved.data.pending!.actions[0].dependsOn = [1];
  await f.store.compareAndSetLeaderState("chat", saved.revision, saved.data);
  const reply = await f.leader().handle("chat", "c", "确认执行");
  expect(reply.text).toContain("计划依赖或结果来源无效");
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("blocks changed skill between preview and confirmation", async () => {
  const f = fixture([tool("propose_plan", { actions: [{ nodeId: "macair", sessionId: "s1", prompt: input.prompt, skills: refs }] })]);
  await f.leader().handle("chat", "p", "用技能检查代码");
  f.catalog.length = 0;
  const reply = await f.leader().handle("chat", "c", "确认执行");
  expect(reply.text).toContain("技能已变化或不可用");
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("rejects hallucinated skill references without creating a plan", async () => {
  const f = fixture([tool("propose_plan", { actions: [{ nodeId: "macair", sessionId: "s1", prompt: input.prompt, skills: [{ id: "c".repeat(64), digest: skill.digest }] }] }), done]);
  await f.leader().handle("chat", "p", "用技能检查代码");
  expect((await f.store.getLeaderState("chat"))?.data.pending).toBeUndefined();
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});

it("finds a named skill beyond the first catalog page without scanning pages", async () => {
  const f = fixture([tool("list_skills", { nodeId: "macair", query: "  CODE-REVIEW  " }),
    tool("propose_plan", { actions: [{ nodeId: "macair", sessionId: "s1", prompt: input.prompt, skills: refs }] })]);
  f.catalog.unshift(...Array.from({ length: 80 }, (_, index) => ({ ...skill,
    id: index.toString(16).padStart(64, "0"), name: `unrelated-${index}`, description: "其他工具" })));
  const preview = await f.leader().handle("chat", "search", "找到 code-review 技能并规划检查");
  const result = JSON.parse(f.calls[1].find(message => message.role === "tool")!.content!);
  expect(result.total).toBe(1);
  expect(result.nextOffset).toBeNull();
  expect(result.skills).toEqual([{ ...skill, nodeId: "macair", path: undefined }]);
  expect(preview.text).toContain(`${JSON.stringify(skill.name)}（版本已锁定）`);
  expect(preview.text).not.toContain(skill.digest);
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
  await f.leader().handle("chat", "confirm", "确认执行");
  expect(f.hub.sendCommand).toHaveBeenCalledTimes(1);
  expect(f.hub.sendCommand.mock.calls[0][0].skills).toEqual(refs);
});

it("searches descriptions literally and paginates only the matching node catalog", async () => {
  const f = fixture([tool("list_skills", { nodeId: "macair", query: "检查[代码]", offset: 20 }), done]);
  f.catalog.splice(0, 1, ...Array.from({ length: 25 }, (_, index) => ({ ...skill,
    id: index.toString(16).padStart(64, "0"), name: `review-${index}`, description: "检查[代码]质量" })));
  f.hub.getAllSkills = () => [
    ...f.catalog.map(item => ({ ...item, nodeId: "macmini" })),
    ...f.catalog.map(item => ({ ...item, nodeId: "macair" })),
  ];
  await f.leader().handle("chat", "search", "查找代码检查技能");
  const result = JSON.parse(f.calls[1].find(message => message.role === "tool")!.content!);
  expect(result.total).toBe(25);
  expect(result.nextOffset).toBeNull();
  expect(result.skills.map((item: Skill) => item.name)).toEqual(f.catalog.slice(20).map(item => item.name));
  expect(result.skills.every((item: { nodeId: string; path?: string }) => item.nodeId === "macair" && item.path === undefined)).toBe(true);
});

it.each(["missing-skill", "__.*$"])("returns no matches without regex interpretation: %s", async query => {
  const f = fixture([tool("list_skills", { query }), done]);
  await f.leader().handle("chat", "search", "查找技能");
  const result = JSON.parse(f.calls[1].find(message => message.role === "tool")!.content!);
  expect(result).toEqual({ skills: [], total: 0, nextOffset: null });
});

it.each(["   ", "x".repeat(101)])("rejects empty or oversized skill queries", async query => {
  const f = fixture([tool("list_skills", { query }), done]);
  await f.leader().handle("chat", "search", "查找技能");
  const result = JSON.parse(f.calls[1].find(message => message.role === "tool")!.content!);
  expect(result.error).toBe("Invalid tool arguments schema");
  expect(f.hub.sendCommand).not.toHaveBeenCalled();
});
