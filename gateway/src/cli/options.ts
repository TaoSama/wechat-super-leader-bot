import { parseArgs } from "node:util";
import { resolvePath } from "../runtime/state.js";
import { DEFAULT_MESSAGE_MAX_CHARS } from "../wechat/markdown.js";
import { DEFAULT_HEALTH_MAX_AGE_MS } from "../runtime/health.js";
import { MAX_POLL_TIMEOUT_MS } from "../runtime/budgets.js";

export type GatewayCliMode = "check" | "establish-baseline" | "poll-once" | "run" | "healthcheck";

export interface ParsedCliOptions {
  help: boolean;
  mode: GatewayCliMode;
  check: boolean;
  establishBaseline: boolean;
  pollOnce: boolean;
  run: boolean;
  healthcheck: boolean;
  controllerUrl: string;
  controllerToken: string;
  allowInsecureController: boolean;
  credentialsPath: string;
  statePath?: string;
  healthPath?: string;
  healthMaxAgeMs: number;
  baselineMaxBatches: number;
  wechatBaseUrl?: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  maxChars: number;
  notifications: boolean;
}

export function getHelpText(): string {
  return [
    "Usage: gateway [options]",
    "",
    "Standalone WeChat Gateway for Super Leader (forwards to Controller /v1/messages).",
    "",
    "Modes (mutually exclusive):",
    "  -c, --check                    Validate configuration and credentials readonly (default)",
    "      --establish-baseline       Drain historical messages into baseline state without forwarding/replying",
    "      --poll-once                Execute a single active iLink poll -> Controller forward -> reply cycle",
    "  -r, --run                      Start continuous iLink polling loop (or env: GATEWAY_RUN_POLL=true)",
    "      --healthcheck              Check daemon health without loading credentials (exit 0 if healthy)",
    "",
    "Options:",
    "  -h, --help                     Show this help message",
    "  -u, --controller-url <url>     Controller base URL (env: CONTROLLER_URL, default: http://127.0.0.1:8790)",
    "      --allow-insecure-controller Allow plain HTTP for non-loopback Controller URLs (env: ALLOW_INSECURE_CONTROLLER=true)",
    "      --credentials-path <path>  Path to readonly WeChat credentials JSON (env: WECHAT_CREDENTIALS_PATH)",
    "      --state-path <path>        Path to gateway sync state JSON (env: WECHAT_STATE_PATH)",
    "      --health-path <path>       Path to gateway health JSON (env: GATEWAY_HEALTH_PATH)",
    "      --health-max-age-ms <ms>   Max age for successful poll in healthcheck (env: GATEWAY_HEALTH_MAX_AGE_MS, default: 120000)",
    "      --baseline-max-batches <n> Max batches to drain during baseline (env: GATEWAY_BASELINE_MAX_BATCHES, default: 20)",
    "      --wechat-base-url <url>    Override WeChat iLink base URL (env: WECHAT_ILINK_BASE_URL)",
    "      --poll-interval-ms <ms>    Interval between poll cycles in ms (env: GATEWAY_POLL_INTERVAL_MS, default: 1000)",
    "      --poll-timeout-ms <ms>     Timeout for iLink getupdates in ms (env: GATEWAY_POLL_TIMEOUT_MS, default: 35000)",
    "      --max-chars <count>        Max characters per WeChat message chunk (default: 4000)",
    "      --notifications            Deliver plan and goal state notifications (env: GATEWAY_NOTIFICATIONS=true, default: false)",
  ].join("\n");
}

export function parseGatewayCli(args: string[], env: NodeJS.ProcessEnv = process.env): ParsedCliOptions {
  const { values } = parseArgs({
    args,
    strict: true,
    allowPositionals: false,
    options: {
      help: { type: "boolean", short: "h", default: false },
      check: { type: "boolean", short: "c", default: false },
      "establish-baseline": { type: "boolean", default: false },
      "poll-once": { type: "boolean", default: false },
      run: { type: "boolean", short: "r", default: false },
      healthcheck: { type: "boolean", default: false },
      "controller-url": { type: "string", short: "u" },
      "allow-insecure-controller": { type: "boolean" },
      "credentials-path": { type: "string" },
      "state-path": { type: "string" },
      "health-path": { type: "string" },
      "health-max-age-ms": { type: "string" },
      "baseline-max-batches": { type: "string" },
      "wechat-base-url": { type: "string" },
      "poll-interval-ms": { type: "string" },
      "poll-timeout-ms": { type: "string" },
      "max-chars": { type: "string" },
      notifications: { type: "boolean" },
    },
  });

  const explicitModes: GatewayCliMode[] = [];
  if (values.check) explicitModes.push("check");
  if (values["establish-baseline"]) explicitModes.push("establish-baseline");
  if (values["poll-once"]) explicitModes.push("poll-once");
  if (values.run) explicitModes.push("run");
  if (values.healthcheck) explicitModes.push("healthcheck");

  if (explicitModes.length > 1) {
    throw new Error(`Cannot specify multiple mode flags simultaneously: ${explicitModes.join(", ")}`);
  }

  let mode: GatewayCliMode;
  if (explicitModes.length === 1) {
    mode = explicitModes[0];
  } else if (env.GATEWAY_RUN_POLL === "true" || env.GATEWAY_RUN_POLL === "1") {
    mode = "run";
  } else {
    mode = "check";
  }

  const controllerUrl = values["controller-url"] || env.CONTROLLER_URL || "http://127.0.0.1:8790";
  const controllerToken = env.CONTROLLER_TOKEN || "";
  const envAllowInsecure = env.ALLOW_INSECURE_CONTROLLER === "true" || env.ALLOW_INSECURE_CONTROLLER === "1";
  const allowInsecureController = values["allow-insecure-controller"] ?? envAllowInsecure;
  const credentialsPath = resolvePath(
    values["credentials-path"] || env.WECHAT_CREDENTIALS_PATH || "~/.super-leader/wechat-account.json"
  );
  const statePathRaw = values["state-path"] || env.WECHAT_STATE_PATH;
  const statePath = statePathRaw ? resolvePath(statePathRaw) : undefined;
  const healthPathRaw = values["health-path"] || env.GATEWAY_HEALTH_PATH;
  const healthPath = healthPathRaw ? resolvePath(healthPathRaw) : undefined;

  const healthMaxAgeMs = Number(
    values["health-max-age-ms"] ?? env.GATEWAY_HEALTH_MAX_AGE_MS ?? String(DEFAULT_HEALTH_MAX_AGE_MS)
  );
  if (!Number.isFinite(healthMaxAgeMs) || healthMaxAgeMs <= 0) {
    throw new Error("Invalid health-max-age-ms: must be a positive number");
  }

  const baselineMaxBatches = Number(
    values["baseline-max-batches"] ?? env.GATEWAY_BASELINE_MAX_BATCHES ?? "20"
  );
  if (!Number.isSafeInteger(baselineMaxBatches) || baselineMaxBatches <= 0) {
    throw new Error("Invalid baseline-max-batches: must be a positive integer");
  }

  const wechatBaseUrl = values["wechat-base-url"] || env.WECHAT_ILINK_BASE_URL;

  const pollIntervalMs = Number(values["poll-interval-ms"] ?? env.GATEWAY_POLL_INTERVAL_MS ?? "1000");
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new Error("Invalid poll-interval-ms: must be a non-negative number");
  }

  const pollTimeoutMs = Number(values["poll-timeout-ms"] ?? env.GATEWAY_POLL_TIMEOUT_MS ?? "35000");
  if (!Number.isSafeInteger(pollTimeoutMs) || pollTimeoutMs <= 0 || pollTimeoutMs > MAX_POLL_TIMEOUT_MS) {
    throw new Error(`Invalid poll-timeout-ms: must be a positive integer up to ${MAX_POLL_TIMEOUT_MS}`);
  }

  const maxChars = Number(values["max-chars"] ?? String(DEFAULT_MESSAGE_MAX_CHARS));
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    throw new Error("Invalid max-chars: must be a positive integer");
  }

  return {
    help: Boolean(values.help),
    mode,
    check: mode === "check",
    establishBaseline: mode === "establish-baseline",
    pollOnce: mode === "poll-once",
    run: mode === "run",
    healthcheck: mode === "healthcheck",
    controllerUrl,
    controllerToken,
    allowInsecureController,
    credentialsPath,
    statePath,
    healthPath,
    healthMaxAgeMs,
    baselineMaxBatches,
    wechatBaseUrl,
    pollIntervalMs,
    pollTimeoutMs,
    maxChars,
    notifications: values.notifications ?? env.GATEWAY_NOTIFICATIONS === "true",
  };
}
