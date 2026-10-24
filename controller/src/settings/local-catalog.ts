import type { LocalModelCatalog, LocalModelScopeId, ModelProvider } from "./local-contracts.js";
import { LocalSettingsError } from "./local-contracts.js";
import { revision } from "./local-storage.js";
import { cancelBodySafely, readBoundedStream } from "../leader/model/transport.js";
import { LocalCliMetadata } from "./local-cli-metadata.js";

const CATALOG_CACHE_MS = 5 * 60_000;
const CATALOG_TIMEOUT_MS = 10_000;
const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_MODELS = 2048;
const validText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export class LocalModelCatalogs {
  private readonly cached = new Map<string, LocalModelCatalog>();
  private readonly pending = new Map<string, Promise<LocalModelCatalog>>();
  private readonly metadata: LocalCliMetadata;
  constructor(private readonly fetchImpl: typeof fetch, private readonly now: () => number, codexPath?: string) {
    this.metadata = new LocalCliMetadata(codexPath);
  }
  async get(scope: LocalModelScopeId, provider: ModelProvider, refresh: boolean): Promise<LocalModelCatalog> {
    const key = revision([scope, provider.baseUrl, provider.apiKey]);
    const prior = this.cached.get(key);
    if (!refresh && prior && this.now() - Date.parse(prior.fetchedAt) < CATALOG_CACHE_MS) return structuredClone(prior);
    let pending = this.pending.get(key);
    if (!pending) {
      pending = this.load(scope, provider).then(catalog => { this.cached.set(key, catalog); return catalog; });
      this.pending.set(key, pending);
      void pending.then(() => this.pending.delete(key), () => this.pending.delete(key));
    }
    try { return structuredClone(await pending); }
    catch {
      if (prior && !refresh) return { ...structuredClone(prior), stale: true };
      throw new LocalSettingsError(503, "当前推理服务的模型目录读取失败；没有使用其他身份的目录替代", "MODEL_CATALOG_UNAVAILABLE");
    }
  }
  private async load(scope: LocalModelScopeId, provider: ModelProvider): Promise<LocalModelCatalog> {
    const [discovery, details] = await Promise.allSettled([
      this.providerCatalog(scope, provider), this.metadata.read(Date.now() + CATALOG_TIMEOUT_MS),
    ]);
    if (discovery.status === "rejected") throw discovery.reason;
    const catalog = discovery.value, metadata = details.status === "fulfilled" ? details.value : { models: [] };
    const byId = new Map(metadata.models.map(item => [item.id, item]));
    const models = catalog.models.map(model => {
      const cached = byId.get(model.id);
      if (!cached) return model;
      const useCached = !model.reasoningEfforts.length || !model.contextWindow || model.label === model.id;
      return { ...model, label: model.label === model.id ? cached.label : model.label,
        reasoningEfforts: model.reasoningEfforts.length ? model.reasoningEfforts : cached.reasoningEfforts,
        defaultReasoningEffort: model.defaultReasoningEffort ?? (model.reasoningEfforts.length ? undefined : cached.defaultReasoningEffort),
        contextWindow: model.contextWindow ?? cached.contextWindow,
        metadataSource: useCached ? "cli-bundled" as const : "provider" as const };
    });
    return { ...catalog, models, source: `${catalog.source}；能力元数据：provider / CLI bundled`,
      version: `${metadata.version ?? "CLI unknown"} · ${revision(models).slice(0, 16)}` };
  }
  private async providerCatalog(scope: LocalModelScopeId, provider: ModelProvider): Promise<LocalModelCatalog> {
    const endpoint = new URL(provider.baseUrl.replace(/\/+$/, "") + "/models");
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
        (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)))) {
      throw new Error("Unsafe model catalog endpoint");
    }
    const signal = AbortSignal.timeout(CATALOG_TIMEOUT_MS);
    const response = await this.fetchImpl(endpoint, { headers: { Authorization: `Bearer ${provider.apiKey}` }, redirect: "error", signal });
    if (!response.ok) { cancelBodySafely(response.body); throw new Error("Model catalog request failed"); }
    const raw: unknown = JSON.parse(await readBoundedStream(response.body, MAX_CATALOG_BYTES, signal));
    const values = record(raw) ? raw.data ?? raw.models : undefined;
    if (!Array.isArray(values) || values.length > MAX_MODELS) throw new Error("Invalid model catalog");
    const models: LocalModelCatalog["models"] = [];
    for (const item of values) {
      if (!record(item) || !validText(item.id ?? item.slug)) continue;
      if (item.hidden === true || item.visibility === "hidden" || item.visibility === "none") continue;
      const id = (item.id ?? item.slug) as string;
      const effortInput = item.supported_reasoning_efforts ?? item.supported_reasoning_levels ?? item.reasoning_efforts;
      const efforts = Array.isArray(effortInput) ? effortInput.flatMap(value => {
        const effort = record(value) ? value.reasoning_effort ?? value.effort : value;
        return typeof effort === "string" && /^[a-z_]{1,32}$/.test(effort) ? [effort] : [];
      }) : [];
      const contextWindow = item.context_window;
      const defaultEffort = item.default_reasoning_effort ?? item.default_reasoning_level;
      models.push({ id, label: validText(item.display_name) ? item.display_name : id, reasoningEfforts: [...new Set(efforts)], metadataSource: "provider",
        ...(typeof defaultEffort === "string" && efforts.includes(defaultEffort) ? { defaultReasoningEffort: defaultEffort } : {}),
        ...(typeof contextWindow === "number" && Number.isSafeInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}) });
    }
    if (!models.length) throw new Error("Empty model catalog");
    return { scope, models: [...new Map(models.map(item => [item.id, item])).values()],
      fetchedAt: new Date(this.now()).toISOString(), source: `${endpoint.origin}${endpoint.pathname}（当前推理身份）`,
      version: revision(models).slice(0, 16), stale: false };
  }
}
