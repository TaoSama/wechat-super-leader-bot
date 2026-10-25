import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelReasoningEffort } from "@openai/codex-sdk";
import { LEADER_SYSTEM_PROMPT } from "../leader/prompt.js";
import { HEADLESS_CODEX_CONFIG, HEADLESS_SKILLS_ROOT } from "../leader/headless-config.js";
import { DEFAULT_PROGRESS_TOOL, parseProgressTool } from "./progress-tool.js";
import { RuntimeResources, RuntimeResourceError, type ResourceMetadata } from "./resources.js";
import { GatewayModelCatalog } from "./models.js";
import { writePrivateJsonSync } from "../runtime/state.js";
import type { LeaderWorkspace, MemoryFile } from "../leader/workspace.js";

const EFFECT = "下一轮生效；正在执行的轮次保留启动时的设置";
const MEMORY_FILES = ["task.md", "memory.md", "preference.md", "AGENTS.md"] as const;
const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"]);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const ENVELOPE = `微信主会话的实际运行输入由下列资源按轮组合：
1. 可编辑的微信主会话 SP 静态主体。
2. 当前北京时间 current_time（运行时生成）。
3. Controller 业务指令 controller_instructions（独立资源）。
4. 本聊天 task.md / memory.md / preference.md 的 memory_snapshot。
5. 当前真实用户消息编号与原文 current_user_message。
6. Codex 从本聊天工作目录加载 AGENTS.md 和本轮冻结的 Skill。
这里的 SP 是 Gateway 注入的运行指令，不代表能够编辑 Codex 内建系统提示词。
动态时间、当前消息和记忆快照每轮生成，不保存为模板编辑内容。`;
type Selection = { model: string; reasoningEffort: ModelReasoningEffort | null };
interface Options {
  root: string; model: string; apiKey?: string; baseUrl?: string; codexPath?: string; skillsRoot?: string;
  chatIds: () => string[];
  workspace: (chatId: string) => Promise<LeaderWorkspace | undefined>;
  /** Must fail while this chat has a native writer, including cleanup. */
  withChat: <T>(chatId: string, operation: () => Promise<T>) => Promise<T>;
  catalog?: GatewayModelCatalog;
}
export type SettingResource = {
  id: string; kind: "prompt" | "memory" | "skill" | "tool"; title: string; scope: string; path: string;
  revision: string; version: string; editable: boolean; effect: string; reason?: string;
};
export type SettingDocument = SettingResource & { content: string; language: string };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RuntimeResourceError(400, "invalid_request", "Expected an object");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new RuntimeResourceError(400, "invalid_request", "Expected text");
  return value;
}
function safeRoot(root: string): void {
  let current = path.parse(root).root;
  for (const part of root.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new RuntimeResourceError(400, "unsafe_settings_root", "Settings root contains an unsafe directory");
  }
}

export class GatewaySettings {
  public readonly resources: RuntimeResources;
  public readonly catalog: GatewayModelCatalog;
  private readonly root: string;
  constructor(private readonly options: Options) {
    this.root = path.resolve(options.root);
    safeRoot(this.root);
    this.resources = new RuntimeResources({ root: path.join(this.root, "resources"),
      skillsRoot: options.skillsRoot ?? HEADLESS_SKILLS_ROOT,
      defaults: { main: LEADER_SYSTEM_PROMPT, progress_tool: JSON.stringify(DEFAULT_PROGRESS_TOOL, null, 2) } });
    this.catalog = options.catalog ?? new GatewayModelCatalog({ stateRoot: this.root, apiKey: options.apiKey,
      baseUrl: options.baseUrl, codexPath: options.codexPath });
  }

  private selection(): Selection {
    const file = path.join(this.root, "model.json");
    if (!fs.existsSync(file)) return { model: this.options.model, reasoningEffort: null };
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) throw new RuntimeResourceError(503, "invalid_model_settings", "Model settings require repair");
    const value = object(JSON.parse(fs.readFileSync(file, "utf8")));
    if (typeof value.model !== "string" || !value.model.trim() || value.reasoningEffort !== null && !EFFORTS.has(value.reasoningEffort as string)) {
      throw new RuntimeResourceError(503, "invalid_model_settings", "Model settings require repair");
    }
    return value as Selection;
  }
  modelScope() {
    const selected = this.selection();
    return { id: "wechat", label: "微信主助手", ...selected, revision: hash(JSON.stringify(selected)), editable: true,
      effect: EFFECT, provider: this.options.baseUrl ? "leader_openai · 自定义 Responses 接口" : "OpenAI API key" };
  }
  async models(refresh = false) {
    const catalog = await (refresh ? this.catalog.refresh() : this.catalog.snapshot());
    return { scope: "wechat", models: catalog.models.filter(model => !model.hidden).map(model => ({ id: model.id,
      label: model.displayName, reasoningEfforts: model.supportedReasoningEfforts.map(effort => effort.reasoningEffort).filter(effort => EFFORTS.has(effort)),
      defaultReasoningEffort: model.defaultReasoningEffort, contextWindow: model.contextWindow })),
      fetchedAt: catalog.fetchedAt ?? "", source: `${catalog.source}; ${catalog.freshness}; ${catalog.provider.id}`,
      version: catalog.cliVersion ?? "unknown", stale: catalog.status !== "ready" };
  }
  async updateModel(body: unknown) {
    const value = object(body);
    if (value.scope !== "wechat") throw new RuntimeResourceError(400, "invalid_scope", "Unknown model scope");
    const expected = string(value.expectedRevision);
    const model = string(value.model);
    const effort = value.reasoningEffort;
    if (effort !== null && (typeof effort !== "string" || !EFFORTS.has(effort))) throw new RuntimeResourceError(400, "invalid_effort", "Unsupported reasoning effort");
    const catalog = await this.models();
    if (catalog.stale) throw new RuntimeResourceError(503, "catalog_stale", "Refresh the provider model catalog before changing the model");
    const found = catalog.models.find(item => item.id === model);
    if (!found || effort !== null && !found.reasoningEfforts.includes(effort as string)) {
      throw new RuntimeResourceError(400, "unsupported_model", "Refresh the catalog and choose a supported model and effort");
    }
    if (this.modelScope().revision !== expected) throw new RuntimeResourceError(409, "revision_conflict", "Settings changed; reload before saving");
    writePrivateJsonSync(path.join(this.root, "model.json"), { model, reasoningEffort: effort });
    return this.modelScope();
  }
  async overview() {
    const chats = [];
    for (const chatId of this.options.chatIds()) {
      const workspace = await this.options.workspace(chatId);
      if (workspace) chats.push({ chatId, label: chatId, threadId: workspace.getThreadId() });
    }
    const catalog = await this.models();
    return { scopes: [this.modelScope()], chats, diagnostics: [
      { id: "gateway-connection", label: "微信 Gateway", value: "已连接", status: "ok" },
      { id: "gateway-version", label: "Gateway 版本", value: process.env.SOURCE_REVISION || "unknown", status: process.env.SOURCE_REVISION ? "ok" : "warning" },
      { id: "gateway-model-version", label: "Codex 目录版本", value: catalog.version, status: catalog.version === "unknown" ? "warning" : "ok" },
      { id: "gateway-model-catalog", label: "模型目录更新时间", value: catalog.fetchedAt || "尚未刷新（与微信助手使用相同认证）", status: catalog.stale ? "warning" : "ok" },
    ] };
  }
  private metadata(resource: ResourceMetadata): SettingResource {
    return { id: `gateway.${Buffer.from(resource.id).toString("base64url")}`, kind: resource.id === "prompt/progress_tool" ? "tool" : resource.kind,
      title: resource.id === "prompt/main" ? "微信主会话 SP · 静态主体" : resource.id === "prompt/progress_tool" ? "report_progress · 工具 Schema" : resource.title,
      scope: "wechat", path: resource.path, revision: resource.revision, version: resource.version, editable: resource.editable,
      effect: EFFECT, ...(resource.id === "prompt/main" ? { reason: "Gateway 每轮注入的指令主体；Codex 内建系统提示词不由此修改" } : {}),
      ...(!resource.editable ? { reason: "二进制文件仅展示版本与路径" } : {}) };
  }
  private envelope(): SettingDocument {
    const revision = hash(ENVELOPE);
    return { id: `gateway.${Buffer.from("effective/envelope").toString("base64url")}`, kind: "prompt", title: "主会话生效指令组成", scope: "wechat",
      path: "运行时/指令组成说明", revision, version: `sha256:${revision}`, editable: false,
      effect: "每轮按真实消息和当前时间生成", reason: "动态上下文由运行时生成，请编辑其对应的静态资源", content: ENVELOPE, language: "markdown" };
  }
  private nativeTools(): SettingDocument {
    const content = JSON.stringify({ source: "Codex CLI 内建工具与外部 MCP", features: HEADLESS_CODEX_CONFIG.features,
      externalMcp: HEADLESS_CODEX_CONFIG.mcp_servers,
      schemaOwnership: "Codex 内建 Schema 由所用 CLI 版本定义；外部 MCP Schema 由其服务器定义。此处展示实际启用配置，不伪造远程 Schema 或可编辑能力。可编辑的本地 report_progress 和 Controller 业务工具分别列于资源目录。" }, null, 2);
    const revision = hash(content);
    return { id: `gateway.${Buffer.from("effective/native-tools").toString("base64url")}`, kind: "tool", title: "原生工具与外部 MCP · 来源配置",
      scope: "wechat", path: "运行时/原生工具来源.json", revision, version: `sha256:${revision}`, editable: false,
      effect: "随 Codex CLI 或外部 MCP 服务版本变化", reason: "Schema 由对应原生实现定义；此处可查看实际启用配置", content, language: "json" };
  }
  private decode(id: string): string {
    if (!/^gateway\.[A-Za-z0-9_-]+$/.test(id)) throw new RuntimeResourceError(404, "resource_not_found", "Unknown resource");
    const result = Buffer.from(id.slice(8), "base64url").toString("utf8");
    if (`gateway.${Buffer.from(result).toString("base64url")}` !== id) throw new RuntimeResourceError(404, "resource_not_found", "Unknown resource");
    return result;
  }
  private async chat(chatId?: string): Promise<LeaderWorkspace> {
    if (!chatId || !this.options.chatIds().includes(chatId)) throw new RuntimeResourceError(403, "chat_required", "Choose an authorized WeChat chat");
    const workspace = await this.options.workspace(chatId);
    if (!workspace) throw new RuntimeResourceError(404, "chat_not_found", "This chat has no Codex workspace yet");
    return workspace;
  }
  private async memory(name: string, chatId?: string): Promise<SettingDocument> {
    if (!MEMORY_FILES.includes(name as typeof MEMORY_FILES[number])) throw new RuntimeResourceError(404, "resource_not_found", "Unknown memory file");
    const workspace = await this.chat(chatId);
    const file = workspace.readEditableFile(name as MemoryFile | "AGENTS.md");
    return { id: `gateway.${Buffer.from(`memory/${name}`).toString("base64url")}`, kind: name === "AGENTS.md" ? "prompt" : "memory",
      title: name, scope: "wechat", path: `聊天/${name}`, ...file, version: `sha256:${file.revision}`, editable: true,
      effect: name === "AGENTS.md" ? EFFECT : "保存到本聊天真实文件；下一轮读取", language: "markdown" };
  }
  async list(chatId?: string) {
    const resources = this.resources.list().map(resource => this.metadata(resource));
    resources.push(this.envelope());
    resources.push(this.nativeTools());
    if (chatId) for (const name of MEMORY_FILES) resources.push(await this.memory(name, chatId));
    return { resources };
  }
  async read(id: string, chatId?: string): Promise<SettingDocument> {
    const decoded = this.decode(id);
    if (decoded === "effective/envelope") return this.envelope();
    if (decoded === "effective/native-tools") return this.nativeTools();
    if (decoded.startsWith("memory/")) return this.memory(decoded.slice(7), chatId);
    const resource = this.resources.read(decoded);
    return { ...this.metadata(resource), content: resource.content, language: decoded === "prompt/progress_tool" ? "json" : path.extname(resource.path) === ".py" ? "python" : "markdown" };
  }
  async write(id: string, body: unknown): Promise<SettingDocument> {
    const value = object(body), decoded = this.decode(id);
    if (decoded.startsWith("effective/")) throw new RuntimeResourceError(403, "read_only_resource", "This resource is generated or owned by the native runtime");
    const content = string(value.content), expectedRevision = string(value.expectedRevision);
    if (decoded.startsWith("memory/")) {
      const chatId = string(value.chatId), name = decoded.slice(7);
      await this.memory(name, chatId);
      return this.options.withChat(chatId, async () => {
        const workspace = await this.chat(chatId);
        if (!workspace.writeEditableFile(name as MemoryFile | "AGENTS.md", content, expectedRevision)) throw new RuntimeResourceError(409, "revision_conflict", "File changed; reload before saving");
        return this.memory(name, chatId);
      });
    }
    if (decoded === "prompt/progress_tool") {
      try { parseProgressTool(content); }
      catch { throw new RuntimeResourceError(400, "invalid_tool_schema", "Progress schema must keep report_progress/text identity and supported constraints (minLength, maxLength, pattern, enum, description)"); }
    }
    this.resources.write(decoded, { content, expectedRevision });
    return this.read(id);
  }
  freeze() {
    const selected = this.selection();
    const systemPrompt = this.resources.read("prompt/main").content;
    const progressTool = parseProgressTool(this.resources.read("prompt/progress_tool").content);
    const home = path.join(path.dirname(this.root), "settings-snapshots", randomUUID());
    const skillsRoot = path.join(home, ".agents", "skills");
    let skillMetadata: ResourceMetadata[];
    try { skillMetadata = this.resources.snapshotSkills(skillsRoot); }
    catch (error) {
      try { fs.rmSync(home, { recursive: true, force: true }); }
      catch (cleanupError) {
        if (error instanceof Error) error.cause = cleanupError;
        else throw new AggregateError([error, cleanupError], "Failed to clean settings snapshot after freeze failure");
      }
      throw error;
    }
    const disabledSkills = skillMetadata.filter(resource => path.basename(resource.path) === "SKILL.md")
      .map(resource => ({ path: path.join(this.options.skillsRoot ?? HEADLESS_SKILLS_ROOT, resource.id.slice(6)), enabled: false }));
    return { ...selected, systemPrompt, progressTool, home, skillsRoot, disabledSkills,
      dispose: () => fs.rmSync(home, { recursive: true, force: true }) };
  }
}
