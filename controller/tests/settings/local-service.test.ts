import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { LocalSettingsService } from "../../src/settings/local-service.js";
import { assertEditedArguments, parseCompatibleTool } from "../../src/settings/local-tools.js";
import { SYSTEM_PROMPT, LEADER_TOOLS, LeaderDataSchema } from "../../src/leader/contracts.js";
import { DIRECT_TOOL_INSTRUCTIONS, DirectCallSchema } from "../../src/leader/direct-contracts.js";
import { LeaderOrchestrator } from "../../src/leader/orchestrator.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { ModelMessage, ModelTool } from "../../src/leader/model/contracts.js";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });
const leader = { model: "existing", baseUrl: "https://controller-model.example/v1", apiKey: "controller-private" };
const background = { model: "worker", baseUrl: "https://worker-model.example/v1", apiKey: "worker-private" };
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "controller-settings-test-")); roots.push(root);
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ data: [
    { id: "existing" }, { id: "new-future-model" },
    { id: "reasoner", supported_reasoning_efforts: ["low", "high"], default_reasoning_effort: "low", context_window: 123456 },
  ] }));
  const options = { root, leader, background, fetchImpl, codexPath: path.join(root, "no-cli") };
  return { root, options, fetchImpl, service: new LocalSettingsService(options) };
}
function save(service: LocalSettingsService, id: string, content: string) {
  return service.updateResource(id, content, service.readResource(id).revision);
}
const listed = (service: LocalSettingsService, name: string) => JSON.parse(service.readResource(`controller.tool.${name}`).content);

describe("Controller persistent runtime settings", () => {
  it("persists actual prompt text with CAS across service recreation and freezes an existing model conversation", async () => {
    const f = fixture(), seen: ModelMessage[][] = [];
    const delegate = { complete: vi.fn(async (messages: ModelMessage[]) => { seen.push(messages); return { content: "ok", toolCalls: [] }; }) };
    const model = f.service.wrapModel(delegate);
    const messages: ModelMessage[] = [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: "query" }];
    await model.complete(messages, []);
    const initial = f.service.readResource("controller.prompt.leader");
    const saved = f.service.updateResource(initial.id, "新的内部协调SP", initial.revision);
    expect(saved.revision).not.toBe(initial.revision);
    expect(() => f.service.updateResource(initial.id, "旧草稿", initial.revision)).toThrow(/新版本/);
    expect(new LocalSettingsService(f.options).readResource(initial.id).content).toBe("新的内部协调SP");
    await model.complete(messages, []);
    await model.complete([...messages], []);
    expect(seen.map(items => items[0].content)).toEqual([SYSTEM_PROMPT, SYSTEM_PROMPT, "新的内部协调SP"]);
    expect(messages[0].content).toBe(SYSTEM_PROMPT);
    expect(f.service.listResources().filter(item => item.kind === "prompt")).toHaveLength(12);
    expect(f.service.readResource("controller.prompt.background-worker")).toMatchObject({ editable: true, scope: "background", language: "markdown" });
    expect(() => f.service.readResource("../../secrets")).toThrow(/未知/);
  });

  it("fetches each scope with its own current provider identity, accepts new IDs and refuses unsupported effort", async () => {
    const f = fixture();
    const catalog = await f.service.models("controller");
    await f.service.models("background");
    expect(f.fetchImpl.mock.calls.map(([url, init]) => [String(url), (init?.headers as Record<string, string>).Authorization])).toEqual([
      ["https://controller-model.example/v1/models", "Bearer controller-private"],
      ["https://worker-model.example/v1/models", "Bearer worker-private"],
    ]);
    expect(f.fetchImpl.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(catalog.models.find(item => item.id === "new-future-model")?.reasoningEfforts).toEqual([]);
    const scope = (await f.service.snapshot()).scopes.find(item => item.id === "controller")!;
    const choice = await f.service.updateModel({ scope: "controller", model: "new-future-model", reasoningEffort: null, expectedRevision: scope.revision });
    expect(choice.model).toBe("new-future-model");
    await expect(f.service.updateModel({ scope: "controller", model: "new-future-model", reasoningEffort: "high", expectedRevision: choice.revision })).rejects.toThrow(/目录/);
    expect(f.service.resolveModel("background").model).toBe("worker");
    const next = await f.service.updateModel({ scope: "controller", model: "reasoner", reasoningEffort: "high", expectedRevision: choice.revision });
    expect(next.reasoningEffort).toBe("high");
    await expect(f.service.updateModel({ scope: "controller", model: "existing", reasoningEffort: null, expectedRevision: scope.revision })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("only supplements matching provider IDs with isolated bundled CLI metadata and caches its version", async () => {
    const f = fixture(), executable = path.join(f.root, "catalog-codex"), observed = path.join(f.root, "metadata-env.jsonl");
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    const metadata = JSON.stringify({ models: [{ slug: "existing", display_name: "Bundled existing", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], default_reasoning_level: "low", context_window: 400000, base_instructions: "must-not-expose" }, { slug: "only-in-bundle" }] });
    fs.writeFileSync(executable, `#!/bin/sh
printf '%s|%s|%s|%s\\n' "$*" "$HOME" "$CODEX_HOME" "\${TEST_METADATA_SECRET-}" >> ${quote(observed)}
if [ "$1" = '--version' ]; then printf '%s\\n' 'codex-cli 0.163.0'; else printf '%s\\n' ${quote(metadata)}; fi
`, { mode: 0o700 });
    const service = new LocalSettingsService({ ...f.options, codexPath: executable });
    process.env.TEST_METADATA_SECRET = "private";
    try {
      const catalog = await service.models("controller");
      expect(catalog.models.find(item => item.id === "existing")).toMatchObject({ reasoningEfforts: ["low", "high"], contextWindow: 400000, metadataSource: "cli-bundled" });
      expect(catalog.models.find(item => item.id === "new-future-model")?.reasoningEfforts).toEqual([]);
      expect(catalog.models.some(item => item.id === "only-in-bundle")).toBe(false);
      expect(JSON.stringify(catalog)).not.toContain("must-not-expose");
      expect(catalog.version).toContain("codex-cli 0.163.0");
      await service.models("background");
      const invocations = fs.readFileSync(observed, "utf8").trim().split("\n").map(line => {
        const [args, home, codexHome, leaked] = line.split("|"); return { args, home, codexHome, leaked };
      });
      expect(invocations).toHaveLength(2);
      expect(invocations[1].args).toBe("debug models --bundled");
      expect(invocations.every(item => !item.leaked && item.home === item.codexHome && !fs.existsSync(item.home))).toBe(true);
    } finally { delete process.env.TEST_METADATA_SECRET; }
  });

  it("uses saved model and effort in the actual Responses payload while the old round retains its frozen choice", async () => {
    const f = fixture();
    const payloads: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      payloads.push(JSON.parse(init?.body as string));
      return Response.json({ status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok" }] }] });
    });
    const model = f.service.wrapModel(f.service.wrapHttpModel({ ...leader, fetchImpl }));
    const messages: ModelMessage[] = [{ role: "user", content: "test" }];
    await model.complete(messages, []);
    const scope = (await f.service.snapshot()).scopes.find(item => item.id === "controller")!;
    await f.service.updateModel({ scope: "controller", model: "reasoner", reasoningEffort: "high", expectedRevision: scope.revision });
    await model.complete(messages, []);
    await model.complete([...messages], []);
    expect(payloads.map(item => [item.model, item.reasoning])).toEqual([["existing", undefined], ["existing", undefined], ["reasoner", { effort: "high" }]]);
    expect(() => f.service.wrapHttpModel({ ...leader, baseUrl: "http://unsafe.example/v1" })).toThrow(/Insecure/);
  });

  it("edits real exposed tool definitions and rejects widened structure, removed required fields, identity changes and bypassed call constraints", async () => {
    const f = fixture(), id = "controller.tool.remember";
    const tool = listed(f.service, "remember");
    tool.description = "仅保存短偏好";
    tool.parameters.properties.value.maxLength = 10;
    save(f.service, id, JSON.stringify(tool));
    expect(f.service.capture().tool(LEADER_TOOLS.find(item => item.function.name === "remember")!).function.description).toBe("仅保存短偏好");
    const base = LEADER_TOOLS.find(item => item.function.name === "remember")!;
    expect(() => f.service.capture().assertArguments(base, { key: "style", value: "x".repeat(11) })).toThrow(/收紧/);
    expect(() => f.service.capture().assertArguments(base, { key: "style", value: "短一点" })).not.toThrow();
    for (const mutate of [
      (candidate: any) => { candidate.name = "new_dispatch"; },
      (candidate: any) => { candidate.parameters.required.pop(); },
      (candidate: any) => { candidate.parameters.properties.value.maxLength = 501; },
      (candidate: any) => { candidate.parameters.properties.extra = { type: "string" }; },
      (candidate: any) => { candidate.parameters.properties.value.type = "number"; },
    ]) {
      const candidate = structuredClone(base.function); mutate(candidate);
      expect(() => save(f.service, id, JSON.stringify(candidate))).toThrow(/身份和结构/);
    }
    const delegate = { complete: vi.fn(async () => ({ content: null, toolCalls: [{ id: "call", type: "function" as const,
      function: { name: "remember", arguments: JSON.stringify({ key: "style", value: "x".repeat(11) }) } }] })) };
    await expect(f.service.wrapModel(delegate).complete([], [base])).rejects.toThrow(/收紧/);
  });

  it("applies object-property count narrowing instead of merely advertising it", () => {
    const base: ModelTool = { type: "function", function: { name: "test", description: "test", parameters: {
      type: "object", properties: { a: { type: "string" }, b: { type: "string" } }, minProperties: 0, maxProperties: 2,
    } } };
    const tool = structuredClone(base.function);
    tool.parameters.minProperties = 1; tool.parameters.maxProperties = 1;
    const edited = parseCompatibleTool(base, JSON.stringify(tool));
    expect(() => assertEditedArguments(base.function.parameters, edited.function.parameters, {})).toThrow(/收紧/);
    expect(() => assertEditedArguments(base.function.parameters, edited.function.parameters, { a: "one", b: "two" })).toThrow(/收紧/);
    expect(() => assertEditedArguments(base.function.parameters, edited.function.parameters, { a: "one" })).not.toThrow();
  });

  it("checks narrowed constraints after the original executor's trimming and default insertion", () => {
    const f = fixture();
    const sessions = listed(f.service, "list_sessions"); sessions.parameters.properties.offset.minimum = 1;
    save(f.service, "controller.tool.list_sessions", JSON.stringify(sessions));
    const sessionsBase = LEADER_TOOLS.find(item => item.function.name === "list_sessions")!;
    expect(() => f.service.capture().assertArguments(sessionsBase, {})).toThrow(/收紧/);
    expect(() => f.service.capture().assertArguments(sessionsBase, { offset: 1 })).not.toThrow();
    const memory = listed(f.service, "remember"); memory.parameters.properties.value.minLength = 3;
    save(f.service, "controller.tool.remember", JSON.stringify(memory));
    expect(() => f.service.capture().assertArguments(LEADER_TOOLS.find(item => item.function.name === "remember")!, { key: "style", value: "  x  " })).toThrow(/收紧/);
  });

  it("rejects storage/resource symlinks and never writes through them", () => {
    const f = fixture(), target = path.join(f.root, "outside.json");
    fs.writeFileSync(target, "private-data");
    fs.symlinkSync(target, path.join(f.root, "runtime-settings.json"));
    expect(() => f.service.readResource("controller.prompt.leader")).toThrow(/不合法/);
    expect(() => save(f.service, "controller.prompt.leader", "edited")).toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("private-data");
  });

  it("recovers a demonstrably dead lock owner while retaining a live owner's lock", () => {
    const f = fixture(), lock = path.join(f.root, ".write-lock");
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: Date.now() - process.uptime() * 1000, token: "live" }));
    expect(() => save(f.service, "controller.prompt.leader", "live must not be stolen")).toThrow(/另一个进程/);
    expect(JSON.parse(fs.readFileSync(lock, "utf8")).token).toBe("live");
    const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
    expect(child.status).toBe(0);
    expect(() => process.kill(child.pid, 0)).toThrow();
    fs.writeFileSync(lock, JSON.stringify({ pid: child.pid, startedAt: Date.now() - 10_000, token: "dead" }));
    expect(save(f.service, "controller.prompt.leader", "recovered").content).toBe("recovered");
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.readdirSync(f.root).some(file => file.endsWith(".tmp"))).toBe(false);
  });

  it("rejects invalid persisted settings and incompatible execution versions explicitly", () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, "runtime-settings.json"), JSON.stringify({ format: 1, resources: {}, models: { controller: { model: " ", reasoningEffort: null } } }));
    expect(() => f.service.capture()).toThrow(/格式无效/);
    expect(() => f.service.restoreTurn({ version: "previous-deployment", data: {} })).toThrow(/版本已变化/);
  });

  it("falls back to the base tool when a persisted schema is no longer compatible", () => {
    const f = fixture(), base = LEADER_TOOLS.find(item => item.function.name === "remember")!;
    fs.writeFileSync(path.join(f.root, "runtime-settings.json"), JSON.stringify({ format: 1, models: {}, resources: {
      ["controller.tool.remember"]: "{\"name\":\"remember\",\"description\":\"bad\",\"parameters\":{}}",
    }}));
    expect(f.service.capture().tool(base)).toEqual(base);
  });
});

describe("direct runtime consumer", () => {
  it("keeps each message's schema/SP across service restart and a long turn, with no snapshot in conversation history", async () => {
    const f = fixture(), store = new MemoryStore();
    let now = Date.now();
    const hub = { getAllSessions: vi.fn(async () => []), getNodeStatusList: () => [], getAllSkills: () => [], getNodeSkills: () => [],
      isNodeConnected: () => false, getNodeSession: () => null, readHistory: vi.fn() };
    const create = () => new LeaderOrchestrator(store, hub, { submit: vi.fn() }, { complete: vi.fn() }, () => now,
      undefined, undefined, undefined, undefined, undefined, { isAllowed: () => true, settings: new LocalSettingsService(f.options) }).direct;
    const request = { chatId: "chat", messageId: "old-message", text: "记住偏好" };
    const first = await create().list(request);
    expect(first.instructions).toBe(DIRECT_TOOL_INSTRUCTIONS);
    const tool = listed(f.service, "remember"); tool.parameters.properties.value.maxLength = 3;
    save(f.service, "controller.tool.remember", JSON.stringify(tool));
    save(f.service, "controller.prompt.direct", "新业务工具SP");
    now += 3 * 60_000;
    const afterRestart = await create().list(request);
    expect(afterRestart.instructions).toBe(DIRECT_TOOL_INSTRUCTIONS);
    expect(afterRestart.tools.find(item => item.name === "remember")!.inputSchema.properties.arguments)
      .toEqual(first.tools.find(item => item.name === "remember")!.inputSchema.properties.arguments);
    const call = (messageId: string, value: string) => DirectCallSchema.parse({ ...request, messageId, callId: randomUUID(), name: "remember",
      arguments: { key: "style", value }, authorization: { memoryOperations: ["remember"] } });
    await expect(create().call(call(request.messageId, "旧轮允许长偏好"))).resolves.toBeDefined();
    const newRequest = { ...request, messageId: "new-message" };
    expect((await create().list(newRequest)).instructions).toBe("新业务工具SP");
    await expect(create().call(call(newRequest.messageId, "新轮拒绝长偏好"))).rejects.toThrow(/configured tool schema/);
    const state = LeaderDataSchema.parse((await store.getLeaderState(request.chatId))?.data);
    expect(JSON.stringify(state.history)).not.toContain("runtime-settings");
    expect(JSON.stringify(state.history)).not.toContain("新业务工具SP");
    expect(await store.getMessage(request.chatId, request.messageId)).toBeNull();
    const settingsRecord = await store.getMessage(request.chatId, `direct_settings_${createHash("sha256").update(JSON.stringify([request.messageId])).digest("hex")}`);
    expect(settingsRecord?.replyText.length).toBeLessThan(256);
    expect(fs.readdirSync(path.join(f.root, "turn-snapshots")).length).toBe(2);
  });
});
