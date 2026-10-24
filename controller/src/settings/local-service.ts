import { AsyncLocalStorage } from "node:async_hooks";
import type { LeaderModel, ModelMessage, ModelTool } from "../leader/model/contracts.js";
import { HttpLeaderModel, type HttpLeaderModelOptions } from "../leader/model/client.js";
import { LOCAL_PROMPTS, LOCAL_TOOLS, LOCAL_TOOL_VALIDATORS } from "./local-registry.js";
import { LocalSettingsStorage, revision } from "./local-storage.js";
import { LocalModelCatalogs } from "./local-catalog.js";
import { assertEditedArguments, parseCompatibleTool } from "./local-tools.js";
import { LocalSettingsDataSchema, LocalSettingsError, MAX_RESOURCE_BYTES, RESOURCE_EFFECT, type LocalSettingsData,
  type LocalModelChoice, type LocalModelScopeId, type LocalResourceDocument, type ModelProvider } from "./local-contracts.js";

export { LocalSettingsError } from "./local-contracts.js";
const RESOURCE_VERSION = "controller@1.0.0";
const REGISTRY_REVISION = revision([LOCAL_PROMPTS, LOCAL_TOOLS]);
interface Options {
  root?: string; leader?: ModelProvider; background?: ModelProvider & { codexPath?: string }; codexPath?: string;
  now?: () => number; fetchImpl?: typeof fetch;
}

export class LocalRuntimeSettings {
  constructor(private readonly data: LocalSettingsData) {}
  prompt(name: string): string {
    const base = LOCAL_PROMPTS.find(item => item.name === name);
    if (!base) throw new LocalSettingsError(404, "未知提示词", "RESOURCE_NOT_FOUND");
    return this.data.resources[`controller.prompt.${name}`] ?? this.transformPrompt(base.content);
  }
  transformPrompt(content: string): string {
    // Match only authored system prompt prefixes, never user messages or model output.
    const prompts = [...LOCAL_PROMPTS].sort((a, b) => b.content.length - a.content.length);
    for (const prompt of prompts) {
      const replacement = this.data.resources[`controller.prompt.${prompt.name}`];
      if (replacement !== undefined && content.startsWith(prompt.content)) return replacement + content.slice(prompt.content.length);
    }
    return content;
  }
  tool(base: ModelTool): ModelTool {
    const content = this.data.resources[`controller.tool.${base.function.name}`];
    return content === undefined ? structuredClone(base) : parseCompatibleTool(base, content);
  }
  hasEditedConstraints(base: ModelTool): boolean {
    return JSON.stringify(base.function.parameters) !== JSON.stringify(this.tool(base).function.parameters);
  }
  assertArguments(base: ModelTool, argumentsValue: unknown): void {
    const edited = this.tool(base).function.parameters;
    if (JSON.stringify(base.function.parameters) === JSON.stringify(edited)) return;
    const validator = Object.hasOwn(LOCAL_TOOL_VALIDATORS, base.function.name) ? LOCAL_TOOL_VALIDATORS[base.function.name] : undefined;
    const normalized = validator ? validator.safeParse(argumentsValue) : undefined;
    if (normalized && !normalized.success) throw new LocalSettingsError(400, "工具参数不符合原执行器规则", "INVALID_TOOL_ARGUMENTS");
    assertEditedArguments(base.function.parameters, edited, normalized?.data ?? argumentsValue);
  }
  model(scope: LocalModelScopeId, fallback: string): LocalModelChoice {
    return structuredClone(this.data.models[scope] ?? { model: fallback, reasoningEffort: null });
  }
}

/** A single persistent source for editable Controller runtime resources. */
export class LocalSettingsService {
  private readonly storage: LocalSettingsStorage;
  private readonly catalogs: LocalModelCatalogs;
  private readonly now: () => number;
  private readonly runtimeContext = new AsyncLocalStorage<LocalRuntimeSettings>();
  constructor(private readonly options: Options) {
    this.storage = new LocalSettingsStorage(options.root);
    this.now = options.now ?? Date.now;
    this.catalogs = new LocalModelCatalogs(options.fetchImpl ?? fetch, this.now, options.codexPath ?? options.background?.codexPath);
  }
  capture(): LocalRuntimeSettings { return new LocalRuntimeSettings(this.storage.read()); }
  withRuntime<T>(callback: () => T): T { return this.runtimeContext.run(this.capture(), callback); }
  turnSnapshot(): { version: string; data: LocalSettingsData } {
    return { version: REGISTRY_REVISION, data: this.storage.read() };
  }
  persistTurnSnapshot(reference: string, value: unknown): void { this.storage.writeTurnSnapshot(reference, value, this.now()); }
  readTurnSnapshot(reference: string): unknown | null { return this.storage.readTurnSnapshot(reference); }
  restoreTurn(value: unknown): LocalRuntimeSettings {
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== REGISTRY_REVISION || !("data" in value)) {
      throw new LocalSettingsError(409, "本轮工具运行版本已变化，请以新消息重新获取工具", "RUNTIME_VERSION_CONFLICT");
    }
    const parsed = LocalSettingsDataSchema.safeParse(value.data);
    if (!parsed.success) throw new LocalSettingsError(503, "本轮冻结设置不可读取", "RUNTIME_SNAPSHOT_INVALID");
    return new LocalRuntimeSettings(parsed.data);
  }
  private provider(scope: LocalModelScopeId): ModelProvider {
    const provider = scope === "controller" ? this.options.leader : this.options.background;
    if (!provider) throw new LocalSettingsError(503, "该运行环境尚未配置推理服务", "MODEL_SCOPE_UNAVAILABLE");
    return provider;
  }
  resolveModel(scope: LocalModelScopeId): LocalModelChoice { return this.capture().model(scope, this.provider(scope).model); }
  private modelScope(scope: LocalModelScopeId) {
    const provider = scope === "controller" ? this.options.leader : this.options.background;
    const choice = this.capture().model(scope, provider?.model ?? "未配置");
    return { id: scope, label: scope === "controller" ? "内部协调" : "后台任务", ...choice,
      revision: revision([scope, choice, provider?.baseUrl ?? null]), editable: !!provider, effect: RESOURCE_EFFECT,
      provider: provider ? new URL(provider.baseUrl).origin : "未配置" };
  }
  async snapshot() {
    return { scopes: [this.modelScope("controller"), this.modelScope("background")], diagnostics: [
      { id: "controller.settings", label: "Controller 运行设置", value: "本地持久化；保存以版本校验防止覆盖", status: "ok" as const },
      { id: "controller.version", label: "Controller 版本", value: process.env.BACKEND_REVISION ?? process.env.SOURCE_REVISION ?? RESOURCE_VERSION, status: "ok" as const },
    ] };
  }
  async models(scope: LocalModelScopeId, refresh = false) {
    this.assertScope(scope);
    return this.catalogs.get(scope, this.provider(scope), refresh);
  }
  private assertScope(scope: string): asserts scope is LocalModelScopeId {
    if (scope !== "controller" && scope !== "background") throw new LocalSettingsError(400, "未知模型作用范围", "INVALID_MODEL_SCOPE");
  }
  async updateModel(input: { scope: LocalModelScopeId; model: string; reasoningEffort: string | null; expectedRevision: string }) {
    this.assertScope(input.scope);
    if (typeof input.model !== "string" || !input.model.trim() || input.model.length > 200 ||
        !(input.reasoningEffort === null || typeof input.reasoningEffort === "string")) throw new LocalSettingsError(400, "模型设置无效", "INVALID_MODEL_SETTINGS");
    const catalog = await this.models(input.scope);
    if (catalog.stale) throw new LocalSettingsError(503, "模型目录已过期，请刷新后重试", "MODEL_CATALOG_STALE");
    const model = catalog.models.find(item => item.id === input.model);
    if (!model || input.reasoningEffort !== null && !model.reasoningEfforts.includes(input.reasoningEffort)) {
      throw new LocalSettingsError(400, "模型或推理强度不在当前服务提供的目录中", "UNSUPPORTED_MODEL_SETTINGS");
    }
    this.storage.update(data => {
      const current = data.models[input.scope] ?? { model: this.provider(input.scope).model, reasoningEffort: null };
      if (revision([input.scope, current, this.provider(input.scope).baseUrl]) !== input.expectedRevision) {
        throw new LocalSettingsError(409, "模型设置已有新版本，请重新载入后保存", "SETTINGS_REVISION_CONFLICT");
      }
      data.models[input.scope] = { model: input.model, reasoningEffort: input.reasoningEffort };
    });
    return this.modelScope(input.scope);
  }
  listResources() {
    return [...LOCAL_PROMPTS.map(item => this.readResource(`controller.prompt.${item.name}`)),
      ...LOCAL_TOOLS.map(item => this.readResource(`controller.tool.${item.function.name}`))]
      .map(({ content: _content, language: _language, ...item }) => item);
  }
  readResource(id: string): LocalResourceDocument {
    return this.document(id, this.storage.read());
  }
  private document(id: string, data: LocalSettingsData): LocalResourceDocument {
    const prompt = LOCAL_PROMPTS.find(item => id === `controller.prompt.${item.name}`);
    const tool = LOCAL_TOOLS.find(item => id === `controller.tool.${item.function.name}`);
    if (!prompt && !tool) throw new LocalSettingsError(404, "未知运行资源", "RESOURCE_NOT_FOUND");
    const content = data.resources[id] ?? (prompt ? prompt.content : JSON.stringify(tool!.function, null, 2));
    return { id, kind: prompt ? "prompt" : "tool", title: prompt?.title ?? tool!.function.name,
      scope: prompt?.scope ?? "controller", path: prompt?.path ?? `tools/${tool!.function.name}.schema.json`,
      revision: revision(content), version: `${RESOURCE_VERSION} · ${revision(prompt?.content ?? tool!.function).slice(0, 12)}`,
      editable: true, effect: RESOURCE_EFFECT, ...(tool ? { reason: "Schema 保留原身份和结构；可改说明、缩小枚举、收紧已有边界。执行器保留原参数及权限校验。" } : {}),
      content, language: prompt ? "markdown" : "json" };
  }
  updateResource(id: string, content: string, expectedRevision: string): LocalResourceDocument {
    if (typeof content !== "string" || !content.trim() || content.includes("\u0000") || Buffer.byteLength(content) > MAX_RESOURCE_BYTES) {
      throw new LocalSettingsError(400, "资源必须是非空 UTF-8 文本，且不超过256 KiB", "INVALID_RESOURCE_CONTENT");
    }
    this.readResource(id);
    const tool = LOCAL_TOOLS.find(item => id === `controller.tool.${item.function.name}`);
    if (tool) parseCompatibleTool(tool, content);
    this.storage.update(data => {
      if (this.document(id, data).revision !== expectedRevision) throw new LocalSettingsError(409, "资源已有新版本，草稿未保存", "SETTINGS_REVISION_CONFLICT");
      data.resources[id] = content;
    });
    return this.readResource(id);
  }
  /** Provider and credentials remain fixed; only model/effort are resolved per frozen completion. */
  wrapHttpModel(options: HttpLeaderModelOptions): LeaderModel {
    const defaultModel = new HttpLeaderModel(options);
    return { complete: (messages, tools, signal) => {
      const choice = (this.runtimeContext.getStore() ?? this.capture()).model("controller", options.model);
      const model = choice.model === options.model && choice.reasoningEffort === null ? defaultModel
        : new HttpLeaderModel({ ...options, model: choice.model, reasoningEffort: choice.reasoningEffort ?? undefined });
      return model.complete(messages, tools, signal);
    } };
  }
  wrapModel(delegate: LeaderModel): LeaderModel {
    const conversations = new WeakMap<ModelMessage[], LocalRuntimeSettings>();
    return { complete: async (messages, tools, signal) => {
      const view = this.runtimeContext.getStore() ?? conversations.get(messages) ?? this.capture();
      conversations.set(messages, view);
      const editedTools = tools.map(tool => view.tool(tool));
      const reply = await this.runtimeContext.run(view, () => delegate.complete(messages.map(message =>
        message.role === "system" && message.content ? { ...message, content: view.transformPrompt(message.content) } : message), editedTools, signal));
      for (const call of reply.toolCalls) {
        const base = tools.find(tool => tool.function.name === call.function.name);
        if (base && view.hasEditedConstraints(base)) {
          let args: unknown;
          try { args = JSON.parse(call.function.arguments); } catch { throw new LocalSettingsError(400, "工具参数不是有效JSON", "INVALID_TOOL_ARGUMENTS"); }
          view.assertArguments(base, args);
        }
      }
      return reply;
    } };
  }
}
