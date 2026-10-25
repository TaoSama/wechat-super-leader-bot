import path from "node:path";

export interface BackgroundConfig {
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
  const model = env.BACKGROUND_MODEL_NAME?.trim() || leader?.model;
  const baseUrl = env.BACKGROUND_MODEL_BASE_URL?.trim() || leader?.baseUrl;
  const apiKey = env.BACKGROUND_MODEL_API_KEY?.trim() || leader?.apiKey;
  if (!model || !baseUrl || !apiKey) throw new Error("Background execution requires a model provider");
  const integer = (name: string, fallback: number, max: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > max) {
      throw new Error(`Invalid ${name}`);
    }
    return Number(raw);
  };
  return { root: resolvedRoot, artifactRoot: resolvedArtifacts, model, baseUrl, apiKey,
    codexPath: env.BACKGROUND_CODEX_PATH?.trim() || "codex",
    timeoutMs: integer("BACKGROUND_TURN_TIMEOUT_MS", DEFAULT_TURN_TIMEOUT_MS, MAX_TURN_TIMEOUT_MS),
    maxConcurrent: integer("BACKGROUND_MAX_CONCURRENT", 2, 8) };
}
