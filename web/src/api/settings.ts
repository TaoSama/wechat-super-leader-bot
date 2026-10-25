import { ApiHttpError } from "./errors";
import { sessionRequest } from "./request";
import { parseCatalog, parseDocument, parseResourceIndex, parseScope, parseSettings, type ModelScope, type ModelScopeId, type ResourceDocument } from "../features/settings/contract";

async function request(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  try {
    return await sessionRequest(`/v1/settings${path}`, { method: body === undefined ? "GET" : "POST", headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json", "X-Super-Leader-Intent": "settings-update" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal }, false, "json", false);
  } catch (error) {
    if (error instanceof ApiHttpError) {
      const messages: Record<number, string> = { 400: "内容不符合要求，请检查模型、推理强度或文件格式。", 403: "当前资源不支持修改，或授权已失效。", 404: "资源已不存在，请刷新列表。", 409: "内容已被其他操作更新。草稿已保留，请重新读取并合并修改。", 503: "执行环境暂时不可用，请稍后重试。" };
      throw new ApiHttpError(error.statusCode, messages[error.statusCode] ?? error.message);
    }
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("请求超时，草稿已保留，请重试。");
    throw error;
  }
}
export async function loadSettings(signal?: AbortSignal) { return parseSettings(await request("", undefined, signal)); }
export async function loadModelCatalog(scope: ModelScopeId, signal?: AbortSignal) { const result = parseCatalog(await request(`/models?scope=${scope}`, undefined, signal)); if (result.scope !== scope) throw new Error("模型目录作用范围不匹配"); return result; }
export async function refreshModelCatalog(scope: ModelScopeId) { const result = parseCatalog(await request("/models/refresh", { scope })); if (result.scope !== scope) throw new Error("模型目录作用范围不匹配"); return result; }
export async function saveModelScope(current: ModelScope, model: string, reasoningEffort: string | null) { const result = parseScope(await request("/models", { scope: current.id, model, reasoningEffort, expectedRevision: current.revision })); if (result.id !== current.id || result.model !== model || result.reasoningEffort !== reasoningEffort) throw new Error("模型设置回执与提交不一致，请刷新核验"); return result; }
const chatQuery = (chatId?: string) => chatId ? `?chatId=${encodeURIComponent(chatId)}` : "";
export async function loadResources(chatId?: string, signal?: AbortSignal) { return parseResourceIndex(await request(`/resources${chatQuery(chatId)}`, undefined, signal)); }
export async function loadResource(id: string, chatId?: string, signal?: AbortSignal) { const result = parseDocument(await request(`/resources/${encodeURIComponent(id)}${chatQuery(chatId)}`, undefined, signal)); if (result.id !== id) throw new Error("资源回执身份不匹配"); return result; }
export async function saveResource(current: ResourceDocument, content: string, chatId?: string) { const result = parseDocument(await request(`/resources/${encodeURIComponent(current.id)}`, { ...(chatId ? { chatId } : {}), content, expectedRevision: current.revision })); if (result.id !== current.id || result.content !== content) throw new Error("资源保存回执与提交不一致，请刷新核验"); return result; }
