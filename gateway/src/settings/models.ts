import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { resolveCodexExecutable } from "../leader/executable.js";

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_REFRESH_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_MODELS = 500;
export const MODEL_CATALOG_TTL_MS = 5 * 60_000;
const ENV_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "TZ", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"] as const;

export interface CatalogModel {
  id: string;
  displayName: string;
  description?: string;
  supportedReasoningEfforts: { reasoningEffort: string; description?: string }[];
  defaultReasoningEffort?: string;
  hidden: boolean;
  isDefault?: boolean;
  contextWindow?: number;
  maxContextWindow?: number;
  metadataSource?: "provider" | "codex-cache";
}

export interface ModelCatalogSnapshot {
  status: "ready" | "stale" | "unavailable";
  source: "provider-models+codex-metadata";
  freshness: "upstream-cache-possible";
  provider: { id: string; baseUrl?: string };
  models: CatalogModel[];
  fetchedAt?: string;
  cliVersion?: string;
  error?: "missing-api-key" | "refresh-failed" | "cache-unavailable" | "cache-expired";
}

export interface ModelCatalogOptions {
  stateRoot: string;
  apiKey?: string;
  baseUrl?: string;
  codexPath?: string;
  timeoutMs?: number;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid catalog object");
  return value as Record<string, unknown>;
}

function text(value: unknown, maxLength = 500): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Whitelist catalog metadata: raw model records also contain extensive prompt instructions. */
export function parseModelCatalog(raw: string): CatalogModel[] {
  const payload = object(JSON.parse(raw));
  const models = payload.models ?? payload.data;
  if (!Array.isArray(models) || models.length > MAX_MODELS) throw new Error("Invalid model list");
  const ids = new Set<string>();
  return models.map(value => {
    const model = object(value);
    const id = text(model.slug ?? model.id, 200);
    if (!id || ids.has(id)) throw new Error("Invalid model identifier");
    ids.add(id);
    const rawEfforts = model.supported_reasoning_levels ?? model.supportedReasoningEfforts;
    if (rawEfforts !== undefined && !Array.isArray(rawEfforts)) throw new Error("Invalid reasoning efforts");
    const supportedReasoningEfforts = (rawEfforts ?? []).map((value: unknown) => {
      const effort = object(value);
      const reasoningEffort = text(effort.effort ?? effort.reasoningEffort, 40);
      if (!reasoningEffort) throw new Error("Invalid reasoning effort");
      return { reasoningEffort, description: text(effort.description) };
    });
    return { id, displayName: text(model.display_name ?? model.displayName) ?? id,
      description: text(model.description, 2_000), supportedReasoningEfforts,
      defaultReasoningEffort: text(model.default_reasoning_level ?? model.defaultReasoningEffort, 40),
      hidden: model.hidden === true || model.visibility !== undefined && model.visibility !== "list",
      isDefault: typeof model.is_default === "boolean" ? model.is_default : typeof model.isDefault === "boolean" ? model.isDefault : undefined,
      contextWindow: positiveNumber(model.context_window ?? model.contextWindow),
      maxContextWindow: positiveNumber(model.max_context_window ?? model.maxContextWindow),
      metadataSource: model.metadataSource === "codex-cache" ? "codex-cache" : "provider" };
  });
}


function execute(executable: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { env, cwd, timeout, maxBuffer: MAX_OUTPUT_BYTES, killSignal: "SIGKILL", encoding: "utf8" },
      (error, stdout) => error ? reject(new Error("Catalog command failed")) : resolve(stdout));
  });
}

function remaining(deadline: number): number {
  const timeout = deadline - Date.now();
  if (timeout <= 0) throw new Error("Catalog deadline exceeded");
  return timeout;
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid catalog directory");
  await chmod(directory, 0o700);
}

async function rejectSymlinkDirectories(directory: string, root: string): Promise<void> {
  for (const current of [path.resolve(root, "settings"), path.resolve(root, "settings", "models"), directory]) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid catalog directory");
  }
}

/** Uses the Gateway's explicit API credentials; never inherits desktop login or host config. */
export class GatewayModelCatalog {
  private readonly directory: string;
  private readonly provider: ModelCatalogSnapshot["provider"];
  private readonly timeoutMs: number;
  private readonly endpoint: string;
  private pending?: Promise<ModelCatalogSnapshot>;
  private lastRefreshFailed = false;

  constructor(private readonly options: ModelCatalogOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > MAX_TIMEOUT_MS) throw new Error("Invalid catalog timeout");
    const endpoint = options.baseUrl ? new URL(options.baseUrl) : undefined;
    if (endpoint && (!["https:", "http:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)) {
      throw new Error("Invalid model provider URL");
    }
    this.provider = { id: options.baseUrl ? "leader_openai" : "openai", baseUrl: endpoint?.origin };
    this.endpoint = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "") + "/models";
    const identity = createHash("sha256").update(JSON.stringify(["provider-v1", options.baseUrl ?? "openai", options.apiKey ?? "", options.codexPath ?? "sdk"])).digest("hex");
    this.directory = path.resolve(options.stateRoot, "settings", "models", identity);
  }

  async snapshot(): Promise<ModelCatalogSnapshot> {
    if (!this.options.apiKey?.trim()) return this.empty("missing-api-key");
    try {
      await rejectSymlinkDirectories(this.directory, this.options.stateRoot);
      const file = path.join(this.directory, "catalog.json");
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_OUTPUT_BYTES) throw new Error("Invalid catalog cache");
      const cached = object(JSON.parse(await readFile(file, "utf8")));
      if (!text(cached.fetchedAt) || !Number.isFinite(Date.parse(cached.fetchedAt as string))) throw new Error("Invalid catalog cache metadata");
      const age = Date.now() - Date.parse(cached.fetchedAt as string);
      const expired = age < 0 || age >= MODEL_CATALOG_TTL_MS;
      const failed = cached.status === "stale" || this.lastRefreshFailed;
      return { ...this.empty(), status: expired || failed ? "stale" : "ready", models: parseModelCatalog(JSON.stringify(cached)),
        fetchedAt: cached.fetchedAt as string, cliVersion: text(cached.cliVersion, 200),
        ...(failed ? { error: "refresh-failed" as const } : expired ? { error: "cache-expired" as const } : {}) };
    } catch (error) {
      return this.empty((error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "cache-unavailable");
    }
  }

  refresh(): Promise<ModelCatalogSnapshot> {
    if (!this.pending) this.pending = this.load().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private empty(error?: ModelCatalogSnapshot["error"]): ModelCatalogSnapshot {
    return { status: "unavailable", source: "provider-models+codex-metadata", freshness: "upstream-cache-possible", provider: this.provider, models: [], ...(error ? { error } : {}) };
  }

  private async save(snapshot: ModelCatalogSnapshot): Promise<void> {
    const temporary = path.join(this.directory, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600, flag: "wx" });
      await rename(temporary, path.join(this.directory, "catalog.json"));
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async providerModels(deadline: number): Promise<CatalogModel[]> {
    const response = await fetch(this.endpoint, { headers: { authorization: `Bearer ${this.options.apiKey}`, accept: "application/json" },
      redirect: "error", signal: AbortSignal.timeout(remaining(deadline)) });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("Provider model discovery failed");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > MAX_OUTPUT_BYTES) throw new Error("Provider model catalog exceeds limit");
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    return parseModelCatalog(Buffer.concat(chunks).toString("utf8"));
  }

  private async cliMetadata(home: string, deadline: number): Promise<{ models: CatalogModel[]; cliVersion?: string }> {
    let cliVersion: string | undefined;
    try {
      const env: NodeJS.ProcessEnv = { HOME: home, CODEX_HOME: home, CODEX_API_KEY: this.options.apiKey };
      for (const name of ENV_ALLOWLIST) if (process.env[name] !== undefined) env[name] = process.env[name];
      const executable = resolveCodexExecutable(this.options.codexPath).executable;
      const version = (await execute(executable, ["--version"], env, home, remaining(deadline))).trim();
      if (!/^codex(?:-cli)? \d+\.\d+\.\d+(?:[^\r\n]*)$/.test(version) || version.length > 200) throw new Error("Invalid CLI version");
      cliVersion = version;
      const args = ["debug", "models", "-c", 'forced_login_method="api"'];
      if (this.options.baseUrl) args.push("-c", 'model_provider="leader_openai"', "-c",
        `model_providers.leader_openai={name="Leader OpenAI-compatible API",base_url=${JSON.stringify(this.options.baseUrl)},env_key="CODEX_API_KEY",wire_api="responses",supports_standalone_web_search=true}`);
      return { models: parseModelCatalog(await execute(executable, args, env, home, remaining(deadline))), cliVersion };
    } catch {
      // Provider discovery remains authoritative when optional CLI metadata is unavailable.
      return { models: [], cliVersion };
    }
  }

  private async load(): Promise<ModelCatalogSnapshot> {
    if (!this.options.apiKey?.trim()) return this.empty("missing-api-key");
    const deadline = Date.now() + Math.min(this.timeoutMs, MAX_REFRESH_TIMEOUT_MS);
    try {
      await privateDirectory(path.resolve(this.options.stateRoot, "settings"));
      await privateDirectory(path.resolve(this.options.stateRoot, "settings", "models"));
      await privateDirectory(this.directory);
      const home = path.join(this.directory, "home");
      await privateDirectory(home);
      const [discovery, details] = await Promise.allSettled([
        this.providerModels(deadline).then(models => ({ models, fetchedAt: new Date().toISOString() })),
        this.cliMetadata(home, deadline),
      ]);
      if (discovery.status === "rejected") throw new Error("Provider model discovery failed");
      const { models: available, fetchedAt } = discovery.value;
      const metadata = details.status === "fulfilled" ? details.value : { models: [] };
      const byId = new Map(metadata.models.map(model => [model.id, model]));
      const models = available.map(model => {
        const cached = byId.get(model.id);
        if (!cached) return model;
        return { ...model, displayName: model.displayName === model.id ? cached.displayName : model.displayName,
          description: model.description ?? cached.description,
          supportedReasoningEfforts: model.supportedReasoningEfforts.length ? model.supportedReasoningEfforts : cached.supportedReasoningEfforts,
          defaultReasoningEffort: model.defaultReasoningEffort ?? (model.supportedReasoningEfforts.length ? undefined : cached.defaultReasoningEffort),
          contextWindow: model.contextWindow ?? cached.contextWindow, maxContextWindow: model.maxContextWindow ?? cached.maxContextWindow,
          metadataSource: "codex-cache" as const };
      });
      const snapshot: ModelCatalogSnapshot = { ...this.empty(), status: "ready", models, cliVersion: metadata.cliVersion, fetchedAt };
      await this.save(snapshot);
      this.lastRefreshFailed = false;
      return snapshot;
    } catch {
      this.lastRefreshFailed = true;
      const cached = await this.snapshot();
      const failed: ModelCatalogSnapshot = { ...cached, status: cached.fetchedAt ? "stale" : "unavailable", error: "refresh-failed" };
      if (cached.fetchedAt) {
        try {
          await this.save(failed);
        } catch {
          return { ...failed, error: "cache-unavailable" };
        }
      }
      return failed;
    }
  }
}
