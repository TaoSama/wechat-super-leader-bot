import { expect, it, vi } from "vitest";
import { CommandService } from "../src/commands.js";
import { LeaderOrchestrator } from "../src/leader/orchestrator.js";
import { MemoryStore } from "../src/store/memory.js";
import { Skill, SkillCatalogSchema } from "../src/skills.js";
import { PostCommandRequestSchema } from "../src/types.js";
import type { ControllerCommandMessage, Session } from "../src/types.js";
import type { ModelMessage, ModelReply } from "../src/leader/model.js";

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

it("rejects duplicate catalog IDs, invalid digests, multiple refs, and skills on read", () => {
  expect(SkillCatalogSchema.safeParse([skill, skill]).success).toBe(false);
  expect(PostCommandRequestSchema.safeParse({ ...input, action: "read" }).success).toBe(false);
  expect(PostCommandRequestSchema.safeParse({ ...input, skills: [...refs, ...refs] }).success).toBe(false);
  expect(PostCommandRequestSchema.safeParse({ ...input, skills: [{ id: "path", digest: "bad" }] }).success).toBe(false);
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
  expect(preview.text).toContain(skill.digest);
  expect(g.hub.sendCommand).not.toHaveBeenCalled();
  expect(g.calls[1].find(message => message.role === "tool")?.content).toContain("UNTRUSTED");
  expect(g.calls[1].filter(message => message.role === "system")).toHaveLength(1);
  await g.leader().handle("chat", "c", "确认执行");
  expect(g.hub.sendCommand).toHaveBeenCalledTimes(1);
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
  expect(reply.text).toContain("计划依赖无效");
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
  expect(preview.text).toContain(skill.digest);
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
