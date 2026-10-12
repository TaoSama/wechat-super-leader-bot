import { parseArgs } from "node:util";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StateManager, resolvePath } from "./state.js";
import { ILinkClient } from "./ilink.js";
import { ControllerClient, validateControllerUrl } from "./controller_client.js";
import { WeChatGateway, NotificationDiagnosticError } from "./gateway.js";
import { DEFAULT_MESSAGE_MAX_CHARS } from "./markdown.js";
import { checkGatewayHealth, HealthTracker, resolveHealthPath, DEFAULT_HEALTH_MAX_AGE_MS, sanitizeErrorType } from "./health.js";
import { MAX_POLL_TIMEOUT_MS } from "./budgets.js";

export type GatewayCliMode = "check" | "establish-baseline" | "poll-once" | "run" | "healthcheck";
export const NOTIFICATION_DIAGNOSTIC_EXIT_CODE = 2;

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
  planNotifications: boolean;
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
    "      --plan-notifications       Deliver confirmed plan terminal notifications (env: GATEWAY_PLAN_NOTIFICATIONS=true, default: false)",
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
      "plan-notifications": { type: "boolean" },
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
    planNotifications: values["plan-notifications"] ?? env.GATEWAY_PLAN_NOTIFICATIONS === "true",
  };
}

export async function runCli(args: string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const opts = parseGatewayCli(args, env);
  if (opts.help) {
    process.stdout.write(getHelpText() + "\n");
    return 0;
  }

  const resolvedHealthPath = resolveHealthPath({
    healthPath: opts.healthPath,
    statePath: opts.statePath,
    credentialsPath: opts.credentialsPath,
  });

  // Independent healthcheck path: does NOT read WeChat credentials or account token
  if (opts.mode === "healthcheck") {
    const healthRes = checkGatewayHealth(resolvedHealthPath, opts.healthMaxAgeMs);
    process.stdout.write(JSON.stringify(healthRes, null, 2) + "\n");
    return healthRes.ok ? 0 : 1;
  }

  const validatedControllerUrl = validateControllerUrl(opts.controllerUrl, opts.allowInsecureController);
  const stateManager = new StateManager(opts.credentialsPath, opts.statePath);
  const ilink = new ILinkClient({
    stateManager,
    configuredBaseUrl: opts.wechatBaseUrl,
    pollTimeoutMs: opts.pollTimeoutMs,
  });

  if (opts.mode === "check") {
    const summary = {
      ok: Boolean(stateManager.account?.token && opts.controllerToken.trim()),
      mode: "check",
      controllerUrl: validatedControllerUrl,
      hasControllerToken: Boolean(opts.controllerToken.trim()),
      credentialsPath: stateManager.credentialsPath,
      statePath: stateManager.statePath,
      healthPath: resolvedHealthPath,
      hasWeChatAccount: Boolean(stateManager.account?.token),
      wechatBaseUrl: ilink.baseUrl,
      processedKeysCount: stateManager.processedMessageKeys.length,
      baselineEstablished: stateManager.baselineEstablished,
      baselineInProgress: stateManager.baselineInProgress,
      baselineEstablishedAt: stateManager.baselineEstablishedAt || null,
      planNotifications: opts.planNotifications,
    };
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return summary.ok ? 0 : 1;
  }

  const controller = new ControllerClient({
    controllerUrl: validatedControllerUrl,
    controllerToken: opts.controllerToken,
    allowInsecureController: opts.allowInsecureController,
  });

  const healthTracker = new HealthTracker(resolvedHealthPath);
  const gateway = new WeChatGateway({
    stateManager,
    ilink,
    controller,
    splitMaxChars: opts.maxChars,
    healthTracker,
    planNotifications: opts.planNotifications,
  });

  if (opts.mode === "establish-baseline") {
    const summary = await gateway.establishBaseline(opts.baselineMaxBatches);
    process.stdout.write(JSON.stringify({
      mode: "establish-baseline",
      ok: true,
      batchesDrained: summary.batchesDrained,
      rawMessagesSkipped: summary.rawMessagesSkipped,
      establishedAt: summary.establishedAt,
    }, null, 2) + "\n");
    return 0;
  }

  if (opts.mode === "poll-once") {
    const res = await gateway.pollOnce();
    const notifications = await gateway.deliverNotificationsOnce();
    process.stdout.write(JSON.stringify({
      mode: "poll-once",
      polledCount: res.polledCount,
      processedCount: res.processedCount,
      skippedCount: res.skippedCount,
      notifications,
    }) + "\n");
    return 0;
  }

  // Run loop mode
  healthTracker.startRun();
  const handleSignal = () => {
    gateway.stop();
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  try {
    await gateway.runLoop(opts.pollIntervalMs, (err) => {
    // Desensitized error logging: only log sanitized error classification to prevent leaking server body, tokens, or errmsg
    process.stderr.write(`[gateway] poll cycle error: ${sanitizeErrorType(err)}\n`);
    }, err => { process.stderr.write(`[gateway] notification cycle error: ${sanitizeErrorType(err)}\n`); });
  } catch (error) {
    if (error instanceof NotificationDiagnosticError) return NOTIFICATION_DIAGNOSTIC_EXIT_CODE;
    throw error;
  } finally {
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
    healthTracker.recordStop();
  }
  return 0;
}

const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === "ENOENT") return false;
    throw err;
  }
})();

if (isDirectRun) {
  runCli().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      if (err instanceof NotificationDiagnosticError) {
        process.exitCode = NOTIFICATION_DIAGNOSTIC_EXIT_CODE;
        return;
      }
      // Desensitized fatal error logging: only log sanitized error classification
      process.stderr.write(`[gateway] fatal: ${sanitizeErrorType(err)}\n`);
      process.exitCode = 1;
    }
  );
}
