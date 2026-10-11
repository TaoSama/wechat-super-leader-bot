import dotenv from "dotenv";

if (process.env.SUPER_LEADER_NO_DOTENV !== "1") {
  dotenv.config();
}

export interface Config {
  port: number;
  host: string;
  controllerToken: string;
  nodeTokens: Record<string, string>; // nodeId -> token (null-prototype)
  tokenToNode: Map<string, string>; // token -> nodeId
  allowedChatIds: Set<string>;
  persistenceMode: "postgres" | "memory";
  databaseUrl?: string;
  commandTtlSeconds: number;
  webDistDir?: string;
  leader?: { baseUrl: string; apiKey: string; model: string };
  consolePublicUrl?: string;
}

function parseStrictInt(value: string | undefined, name: string, min: number, max: number, defaultValue: number): number {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid ${name}: '${value}'. Must be a strictly positive integer between ${min} and ${max}`);
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${name}: '${value}'. Must be between ${min} and ${max}`);
  }
  return parsed;
}

export function validateConsolePublicUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (/[\\\u0000-\u0020\u007f]/.test(raw) || !/^https?:\/\/[^/?#]+\/?$/i.test(trimmed)) {
    throw new Error("Invalid CONSOLE_PUBLIC_URL: expected a canonical HTTP(S) origin");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid CONSOLE_PUBLIC_URL: Must be a valid absolute URL");
  }

  if (parsed.username || parsed.password) {
    throw new Error("CONSOLE_PUBLIC_URL must not contain credentials (userinfo)");
  }
  if (trimmed.includes("?") || parsed.search) {
    throw new Error("CONSOLE_PUBLIC_URL must not contain query parameters");
  }
  if (trimmed.includes("#") || parsed.hash) {
    throw new Error("CONSOLE_PUBLIC_URL must not contain URL fragments");
  }
  if (parsed.pathname !== "" && parsed.pathname !== "/") {
    throw new Error("CONSOLE_PUBLIC_URL must be an origin only without subpath");
  }

  const hostname = parsed.hostname.toLowerCase();
  const isLoopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname);
  if (parsed.protocol === "https:") {
    return parsed.origin;
  }
  if (parsed.protocol === "http:" && isLoopback) {
    return parsed.origin;
  }

  throw new Error("CONSOLE_PUBLIC_URL must use https: (http: is only permitted for loopback development)");
}

export function loadConfig(): Config {
  const port = parseStrictInt(process.env.PORT, "PORT", 1, 65535, 8790);

  const host = process.env.HOST || "127.0.0.1";

  const controllerToken = process.env.CONTROLLER_TOKEN;
  if (!controllerToken || controllerToken.trim().length === 0) {
    throw new Error("CONTROLLER_TOKEN environment variable is required and cannot be empty");
  }

  const rawNodeTokens = process.env.NODE_TOKENS || "{}";
  let parsedTokens: unknown;
  try {
    parsedTokens = JSON.parse(rawNodeTokens);
  } catch {
    throw new Error("NODE_TOKENS is not valid JSON (raw value redacted for security)");
  }

  if (typeof parsedTokens !== "object" || parsedTokens === null || Array.isArray(parsedTokens)) {
    throw new Error("NODE_TOKENS must be a strictly non-null JSON object mapping nodeId to token");
  }

  const nodeTokens: Record<string, string> = Object.create(null);
  const tokenToNode = new Map<string, string>();

  for (const [nodeId, token] of Object.entries(parsedTokens as Record<string, unknown>)) {
    if (!nodeId || nodeId.trim().length === 0) {
      throw new Error("NODE_TOKENS contains an empty or invalid nodeId");
    }
    if (typeof token !== "string" || token.trim().length === 0) {
      throw new Error(`NODE_TOKENS token for node '${nodeId}' must be a non-empty string`);
    }
    if (tokenToNode.has(token)) {
      throw new Error(
        `NODE_TOKENS contains duplicate token for nodes '${tokenToNode.get(token)}' and '${nodeId}' (mapping ambiguity)`
      );
    }
    nodeTokens[nodeId] = token;
    tokenToNode.set(token, nodeId);
  }

  const rawAllowedChatIds = process.env.ALLOWED_CHAT_IDS || "";
  const allowedChatIds = new Set<string>(
    rawAllowedChatIds
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0)
  );

  const persistenceModeRaw = process.env.PERSISTENCE_MODE || "postgres";
  if (persistenceModeRaw !== "postgres" && persistenceModeRaw !== "memory") {
    throw new Error("PERSISTENCE_MODE must be strictly either 'postgres' or 'memory'");
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (persistenceModeRaw === "postgres") {
    if (!databaseUrl || databaseUrl.trim().length === 0) {
      throw new Error(
        "DATABASE_URL is required when PERSISTENCE_MODE is postgres (fail closed). Set PERSISTENCE_MODE=memory explicitly for test/dev."
      );
    }
  }

  const commandTtlSeconds = parseStrictInt(process.env.COMMAND_TTL_SECONDS, "COMMAND_TTL_SECONDS", 5, 86400, 300);
  const leaderMode = process.env.LEADER_MODE || "rules";
  if (leaderMode !== "rules" && leaderMode !== "model") throw new Error("LEADER_MODE must be rules or model");
  let leader: Config["leader"];
  if (leaderMode === "model") {
    const baseUrl = process.env.LEADER_MODEL_BASE_URL;
    const apiKey = process.env.LEADER_MODEL_API_KEY;
    const model = process.env.LEADER_MODEL_NAME;
    if (!baseUrl?.trim() || !apiKey?.trim() || !model?.trim()) {
      throw new Error("Model mode requires LEADER_MODEL_BASE_URL, LEADER_MODEL_API_KEY and LEADER_MODEL_NAME");
    }
    leader = { baseUrl, apiKey, model };
  }

  const consolePublicUrl = validateConsolePublicUrl(process.env.CONSOLE_PUBLIC_URL);

  return {
    port,
    host,
    controllerToken,
    nodeTokens,
    tokenToNode,
    allowedChatIds,
    persistenceMode: persistenceModeRaw,
    databaseUrl,
    commandTtlSeconds,
    webDistDir: process.env.WEB_DIST_DIR,
    leader,
    consolePublicUrl,
  };
}
