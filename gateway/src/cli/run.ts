import { StateManager } from "../runtime/state.js";
import { ILinkClient } from "../wechat/client.js";
import { ControllerClient, validateControllerUrl } from "../controller/client.js";
import { WeChatGateway, NotificationDiagnosticError } from "../gateway.js";
import { checkGatewayHealth, HealthTracker, resolveHealthPath, sanitizeErrorType } from "../runtime/health.js";
import { getHelpText, parseGatewayCli } from "./options.js";

export const NOTIFICATION_DIAGNOSTIC_EXIT_CODE = 2;

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
  const stateManager = new StateManager(opts.credentialsPath, opts.statePath, {
    contextWindowMs: opts.contextWindowMs, sendBudget: opts.sendBudget, outboxLimit: opts.outboxLimit,
  });
  const ilink = new ILinkClient({
    stateManager,
    configuredBaseUrl: opts.wechatBaseUrl,
    pollTimeoutMs: opts.pollTimeoutMs,
  });

  if (opts.mode === "check") {
    const summary = {
      ok: Boolean(stateManager.account?.token && opts.controllerToken.trim() &&
        (opts.leaderMode !== "codex" || env.GATEWAY_LEADER_API_KEY?.trim())),
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
      notifications: opts.notifications,
      leaderMode: opts.leaderMode,
      leaderModel: opts.leaderModel,
      hasLeaderApiKey: Boolean(env.GATEWAY_LEADER_API_KEY?.trim()),
    };
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return summary.ok ? 0 : 1;
  }

  const controller = new ControllerClient({
    controllerUrl: validatedControllerUrl,
    controllerToken: opts.controllerToken,
    allowInsecureController: opts.allowInsecureController,
  });

  let replyEngine;
  if (opts.leaderMode === "codex" && opts.mode !== "establish-baseline") {
    if (!env.GATEWAY_LEADER_API_KEY?.trim()) throw new Error("Missing GATEWAY_LEADER_API_KEY for Codex reply engine");
    const { CodexReplyEngine } = await import("../leader/codex.js");
    replyEngine = new CodexReplyEngine({ root: opts.leaderRoot, model: opts.leaderModel,
      baseUrl: env.GATEWAY_LEADER_BASE_URL || undefined, apiKey: env.GATEWAY_LEADER_API_KEY,
      codexPath: env.GATEWAY_CODEX_PATH || undefined });
  }
  const healthTracker = new HealthTracker(resolvedHealthPath);
  const gateway = new WeChatGateway({
    stateManager,
    ilink,
    controller,
    splitMaxChars: opts.maxChars,
    healthTracker,
    notifications: opts.notifications,
    replyEngine,
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
