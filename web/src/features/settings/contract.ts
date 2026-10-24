export type ModelScopeId = "wechat" | "controller" | "background";
export interface ModelScope { id: ModelScopeId; label: string; model: string; reasoningEffort: string | null; revision: string; editable: boolean; effect: string; provider: string }
export interface SettingsChat { chatId: string; label: string; threadId?: string }
export interface Diagnostic { id: string; label: string; value: string; status: "ok" | "warning" | "error" }
export interface SettingsSnapshot { scopes: ModelScope[]; chats: SettingsChat[]; diagnostics: Diagnostic[] }
export interface CatalogModel { id: string; label: string; reasoningEfforts: string[]; defaultReasoningEffort?: string; contextWindow?: number }
export interface ModelCatalog { scope: string; models: CatalogModel[]; fetchedAt: string; source: string; version: string; stale: boolean }
export interface SettingsResource { id: string; kind: "prompt" | "memory" | "skill" | "tool"; title: string; scope: string; path: string; revision: string; version: string; editable: boolean; effect: string; reason?: string }
export interface ResourceDocument extends SettingsResource { content: string; language: string }

function object(raw: unknown): Record<string, unknown> { if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("设置接口响应格式无效"); return raw as Record<string, unknown>; }
function string(value: unknown): string { if (typeof value !== "string") throw new Error("设置接口响应字段无效"); return value; }
function boolean(value: unknown): boolean { if (typeof value !== "boolean") throw new Error("设置接口响应状态无效"); return value; }
function array<T>(value: unknown, parse: (item: unknown) => T): T[] { if (!Array.isArray(value)) throw new Error("设置接口响应列表无效"); return value.map(parse); }
export function parseScope(raw: unknown): ModelScope {
  const item = object(raw); const id = string(item.id);
  if (!["wechat", "controller", "background"].includes(id)) throw new Error("未知模型作用范围");
  return { id: id as ModelScopeId, label: string(item.label), model: string(item.model), reasoningEffort: item.reasoningEffort === null ? null : string(item.reasoningEffort), revision: string(item.revision), editable: boolean(item.editable), effect: string(item.effect), provider: string(item.provider) };
}
export function parseSettings(raw: unknown): SettingsSnapshot {
  const value = object(raw);
  return { scopes: array(value.scopes, parseScope), chats: array(value.chats, raw => { const item = object(raw); return { chatId: string(item.chatId), label: string(item.label), threadId: typeof item.threadId === "string" ? item.threadId : undefined }; }), diagnostics: parseDiagnostics(value.diagnostics) };
}
export function parseCatalog(raw: unknown): ModelCatalog {
  const item = object(raw);
  return { scope: string(item.scope), fetchedAt: string(item.fetchedAt), source: string(item.source), version: string(item.version), stale: boolean(item.stale), models: array(item.models, raw => { const model = object(raw); return { id: string(model.id), label: string(model.label), reasoningEfforts: array(model.reasoningEfforts, string), defaultReasoningEffort: typeof model.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : undefined, contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : undefined }; }) };
}
export function parseResource(raw: unknown): SettingsResource {
  const item = object(raw); const kind = string(item.kind);
  if (!["prompt", "memory", "skill", "tool"].includes(kind)) throw new Error("未知资源类型");
  return { id: string(item.id), kind: kind as SettingsResource["kind"], title: string(item.title), scope: string(item.scope), path: string(item.path), revision: string(item.revision), version: string(item.version), editable: boolean(item.editable), effect: string(item.effect), reason: typeof item.reason === "string" ? item.reason : undefined };
}
export function parseResources(raw: unknown): SettingsResource[] { return array(object(raw).resources, parseResource); }
export function parseDocument(raw: unknown): ResourceDocument { const item = object(raw); return { ...parseResource(item), content: string(item.content), language: string(item.language) }; }

export function parseDiagnostics(raw: unknown): Diagnostic[] {
  return array(raw, value => { const item = object(value); const status = string(item.status); if (!["ok", "warning", "error"].includes(status)) throw new Error("未知诊断状态"); return { id: string(item.id), label: string(item.label), value: string(item.value), status: status as Diagnostic["status"] }; });
}
export function parseResourceIndex(raw: unknown): { resources: SettingsResource[]; diagnostics: Diagnostic[] } { const value = object(raw); return { resources: parseResources(value), diagnostics: value.diagnostics === undefined ? [] : parseDiagnostics(value.diagnostics) }; }
