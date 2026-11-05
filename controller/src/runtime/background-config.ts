import path from "node:path";
import { WORKER_EXECUTOR_KINDS, type WorkerExecutorKind } from "../background/worker/contracts.js";
import { CLAUDE_DEFAULT_MODEL_LABEL, isClaudeModel } from "../background/worker/claude-models.js";

export const BACKGROUND_EXECUTOR_KINDS = WORKER_EXECUTOR_KINDS;
export type BackgroundExecutorKind = WorkerExecutorKind;

export interface ClaudeBackgroundConfig {
  path: string;
  model?: string;
  /** Anthropic-compatible endpoint origin; unset means the official API. */
  baseUrl?: string;
  /** Exactly one credential: x-api-key, bearer token or Claude OAuth token. */
  apiKey?: string;
  authToken?: string;
  oauthToken?: string;
  /** Controller state the worker's Bash sandbox must not read, apart from its own workspace. */
  privateRoots: string[];
}

export interface BackgroundConfig {
  executorKind: BackgroundExecutorKind;
  /** Present only when executorKind is claude. */
  claude?: ClaudeBackgroundConfig;
  root: string;
  artifactRoot: string;
  codexPath: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  maxConcurrent: number;
}

const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
const MAX_TURN_TIMEOUT_MS = 60 * 60_000;

function loadExecutorKind(env: NodeJS.ProcessEnv): BackgroundExecutorKind {
  const raw = env.BACKGROUND_EXECUTOR?.trim() || "codex";
  if (!(BACKGROUND_EXECUTOR_KINDS as readonly string[]).includes(raw)) {
    throw new Error(`Invalid BACKGROUND_EXECUTOR; expected one of: ${BACKGROUND_EXECUTOR_KINDS.join(", ")}`);
  }
  return raw as BackgroundExecutorKind;
}

/**
 * The Anthropic SDK appends `/v1/messages` to its base URL, so an OpenAI-style
 * `/v1` suffix shared with the Codex provider is removed.
 */
function claudeBaseUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Invalid BACKGROUND_CLAUDE_BASE_URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Invalid BACKGROUND_CLAUDE_BASE_URL");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}`;
}

function loadClaudeConfig(env: NodeJS.ProcessEnv, privateRoots: string[], gateway: { baseUrl?: string; apiKey?: string }): ClaudeBackgroundConfig {
  const explicit = {
    apiKey: env.BACKGROUND_CLAUDE_API_KEY?.trim(),
    authToken: env.BACKGROUND_CLAUDE_AUTH_TOKEN?.trim(),
    oauthToken: env.BACKGROUND_CLAUDE_OAUTH_TOKEN?.trim(),
  };
  const set = Object.entries(explicit).filter(([, value]) => value);
  if (set.length > 1) {
    throw new Error("Set only one of BACKGROUND_CLAUDE_API_KEY, BACKGROUND_CLAUDE_AUTH_TOKEN or BACKGROUND_CLAUDE_OAUTH_TOKEN");
  }
  // Without a Claude-specific credential, reuse the background model gateway's key as an x-api-key.
  const credential = set.length ? Object.fromEntries(set) as Partial<typeof explicit>
    : gateway.apiKey ? { apiKey: gateway.apiKey } : undefined;
  if (!credential) {
    throw new Error("BACKGROUND_EXECUTOR=claude requires BACKGROUND_CLAUDE_API_KEY, BACKGROUND_CLAUDE_AUTH_TOKEN, " +
      "BACKGROUND_CLAUDE_OAUTH_TOKEN or a background model provider key");
  }
  // The gateway URL is inherited only with the gateway key, so a Claude-specific
  // credential is never sent to an endpoint it was not configured for.
  const rawBaseUrl = env.BACKGROUND_CLAUDE_BASE_URL?.trim() || (set.length ? "" : gateway.baseUrl);
  const model = env.BACKGROUND_CLAUDE_MODEL?.trim();
  if (model && !isClaudeModel(model)) {
    throw new Error("Invalid BACKGROUND_CLAUDE_MODEL; expected a Claude alias (sonnet, opus, haiku) or a claude-* model name");
  }
  return { path: env.BACKGROUND_CLAUDE_PATH?.trim() || "claude", ...(model ? { model } : {}),
    ...(rawBaseUrl ? { baseUrl: claudeBaseUrl(rawBaseUrl) } : {}), ...credential, privateRoots };
}

export function loadBackgroundConfig(env: NodeJS.ProcessEnv,
  leader?: { model: string; baseUrl: string; apiKey: string },
  controllerDataRoot?: string): BackgroundConfig | undefined {
  const configuredRoot = env.BACKGROUND_WORKER_ROOT?.trim();
  if (!configuredRoot) return undefined;
  const configuredArtifactRoot = env.BACKGROUND_ARTIFACT_ROOT?.trim();
  if (!configuredArtifactRoot && !controllerDataRoot) {
    throw new Error("Background execution requires an artifact root or CONTROLLER_DATA_ROOT");
  }
  const root = configuredRoot;
  const artifactRoot = configuredArtifactRoot || path.join(controllerDataRoot!, "background", "artifacts");
  if (![root, artifactRoot].every(value => path.isAbsolute(value) && path.resolve(value) !== path.parse(value).root)) {
    throw new Error("Background execution requires dedicated absolute worker and artifact roots");
  }
  const resolvedRoot = path.resolve(root), resolvedArtifacts = path.resolve(artifactRoot);
  if (controllerDataRoot) {
    const resolvedControllerDataRoot = path.resolve(controllerDataRoot);
    if (!resolvedRoot.startsWith(`${resolvedControllerDataRoot}${path.sep}`) ||
        !resolvedArtifacts.startsWith(`${resolvedControllerDataRoot}${path.sep}`)) {
      throw new Error("Background execution roots must be inside CONTROLLER_DATA_ROOT");
    }
  }
  if (resolvedRoot === resolvedArtifacts || resolvedRoot.startsWith(resolvedArtifacts + path.sep) || resolvedArtifacts.startsWith(resolvedRoot + path.sep)) {
    throw new Error("Background artifact storage must be separate from worker storage");
  }
  const executorKind = loadExecutorKind(env);
  const model = env.BACKGROUND_MODEL_NAME?.trim() || leader?.model;
  const baseUrl = env.BACKGROUND_MODEL_BASE_URL?.trim() || leader?.baseUrl;
  const apiKey = env.BACKGROUND_MODEL_API_KEY?.trim() || leader?.apiKey;
  // Claude reuses the background provider's Anthropic-compatible gateway unless its own endpoint is set.
  const claude = executorKind === "claude"
    ? loadClaudeConfig(env, [controllerDataRoot ? path.resolve(controllerDataRoot) : resolvedRoot], { baseUrl, apiKey }) : undefined;
  if (!claude && (!model || !baseUrl || !apiKey)) throw new Error("Background execution requires a model provider");
  const integer = (name: string, fallback: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > max) {
      throw new Error(`Invalid ${name}`);
    }
    return Number(raw);
  };
  return { executorKind, ...(claude ? { claude } : {}), root: resolvedRoot, artifactRoot: resolvedArtifacts,
    // The Codex provider is unused by Claude, which falls back to its CLI default model.
    ...(claude ? { model: claude.model ?? CLAUDE_DEFAULT_MODEL_LABEL, baseUrl: "", apiKey: "" } : { model: model!, baseUrl: baseUrl!, apiKey: apiKey! }),
    codexPath: env.BACKGROUND_CODEX_PATH?.trim() || "codex",
    timeoutMs: integer("BACKGROUND_TURN_TIMEOUT_MS", DEFAULT_TURN_TIMEOUT_MS, MAX_TURN_TIMEOUT_MS),
    maxConcurrent: integer("BACKGROUND_MAX_CONCURRENT", 2, 8) };
}
