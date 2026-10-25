import { ResultClient } from "../controller/result-client.js";
import { FileResultOutbox } from "../results/outbox.js";
import { StateManager } from "../runtime/state.js";
import { ILinkClient } from "../wechat/client.js";
import { ControllerClient, validateControllerUrl } from "../controller/client.js";
import { WeChatGateway, NotificationDiagnosticError } from "../gateway.js";
import { checkGatewayHealth, HealthTracker, resolveHealthPath, sanitizeErrorType } from "../runtime/health.js";
import { getHelpText, parseGatewayCli } from "./options.js";
import type { GatewayReplyEngine } from "../leader/contracts.js";
import * as path from "node:path";
import { GatewaySettings } from "../settings/service.js";
import { startSettingsServer } from "../settings/server.js";

export const NOTIFICATION_DIAGNOSTIC_EXIT_CODE = 2;
const MAX_CODEX_ACCOUNT_ID_BYTES = 4096;

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
  const accountId = stateManager.account?.accountId;
  const hasValidAccountId = typeof accountId === "string" && Boolean(accountId.trim()) &&
    Buffer.byteLength(accountId, "utf8") <= MAX_CODEX_ACCOUNT_ID_BYTES;
  const ilink = new ILinkClient({
    stateManager,
    configuredBaseUrl: opts.wechatBaseUrl,
    pollTimeoutMs: opts.pollTimeoutMs,
    maxFileBytes: opts.resultFileMaxBytes,
  });

  if (opts.mode === "check") {
    const summary = {
      ok: Boolean(stateManager.account?.token && opts.controllerToken.trim() &&
        (opts.leaderMode !== "codex" || hasValidAccountId && env.GATEWAY_LEADER_API_KEY?.trim())),
      mode: "check",
      controllerUrl: validatedControllerUrl,
      hasControllerToken: Boolean(opts.controllerToken.trim()),
      credentialsPath: stateManager.credentialsPath,
      statePath: stateManager.statePath,
      healthPath: resolvedHealthPath,
      hasWeChatAccount: Boolean(stateManager.account?.token),
      hasValidAccountId,
      wechatBaseUrl: ilink.baseUrl,
      processedKeysCount: stateManager.processedMessageKeys.length,
      baselineEstablished: stateManager.baselineEstablished,
      baselineInProgress: stateManager.baselineInProgress,
      baselineEstablishedAt: stateManager.baselineEstablishedAt || null,
      leaderMode: opts.leaderMode,
      leaderModel: opts.leaderModel,
      hasLeaderApiKey: Boolean(env.GATEWAY_LEADER_API_KEY?.trim()),
    };
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return summary.ok ? 0 : 1;
  }

  if (opts.leaderMode === "codex" && !hasValidAccountId) {
    throw new Error(`Invalid WeChat accountId for Codex reply engine; a non-empty account ID of at most ${MAX_CODEX_ACCOUNT_ID_BYTES} UTF-8 bytes is required`);
  }

  const controller = new ControllerClient({
    controllerUrl: validatedControllerUrl,
    controllerToken: opts.controllerToken,
    allowInsecureController: opts.allowInsecureController,
  });

  let replyEngine: GatewayReplyEngine | undefined;
  let settings: GatewaySettings | undefined;
  let settingsListener: Awaited<ReturnType<typeof startSettingsServer>> | undefined;
  if (opts.leaderMode === "codex" && opts.mode !== "establish-baseline") {
    if (!env.GATEWAY_LEADER_API_KEY?.trim()) throw new Error("Missing GATEWAY_LEADER_API_KEY for Codex reply engine");
    const { CodexReplyEngine } = await import("../leader/codex.js");
    let codexEngine!: InstanceType<typeof CodexReplyEngine>;
    if (env.GATEWAY_SETTINGS_HOST || env.GATEWAY_SETTINGS_PORT) {
      if (!env.GATEWAY_SETTINGS_HOST || !env.GATEWAY_SETTINGS_PORT || !/^\d+$/.test(env.GATEWAY_SETTINGS_PORT) ||
          Number(env.GATEWAY_SETTINGS_PORT) < 1 || Number(env.GATEWAY_SETTINGS_PORT) > 65535) throw new Error("Invalid Gateway settings listener configuration");
      settings = new GatewaySettings({ root: env.GATEWAY_SETTINGS_ROOT || path.join(path.dirname(stateManager.statePath), "settings"),
        model: opts.leaderModel, apiKey: env.GATEWAY_LEADER_API_KEY, baseUrl: env.GATEWAY_LEADER_BASE_URL || undefined,
        codexPath: env.GATEWAY_CODEX_PATH || undefined, chatIds: () => Object.keys(stateManager.contextTokens),
        workspace: chatId => codexEngine.settingsWorkspace(accountId!, chatId),
        withChat: (chatId, operation) => codexEngine.withSettingsChat(accountId!, chatId, operation) });
    }
    codexEngine = new CodexReplyEngine({ root: opts.leaderRoot, model: opts.leaderModel, settings,
      baseUrl: env.GATEWAY_LEADER_BASE_URL || undefined, apiKey: env.GATEWAY_LEADER_API_KEY,
      codexPath: env.GATEWAY_CODEX_PATH || undefined });
    replyEngine = codexEngine;
  }
  const healthTracker = new HealthTracker(resolvedHealthPath);
  const gateway = new WeChatGateway({
    stateManager,
    ilink,
    controller,
    splitMaxChars: opts.maxChars,
    healthTracker,
    replyEngine,
    resultClient: new ResultClient({ controllerUrl: validatedControllerUrl, controllerToken: opts.controllerToken,
      allowInsecureController: opts.allowInsecureController, artifactPublicOrigin: opts.resultPublicOrigin,
      maxFileBytes: opts.resultFileMaxBytes }),
    resultOutbox: new FileResultOutbox(`${stateManager.statePath}.results.json`, () => stateManager.getLoginFingerprint()),
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

  if (settings) settingsListener = await startSettingsServer({ settings, host: env.GATEWAY_SETTINGS_HOST!,
    port: Number(env.GATEWAY_SETTINGS_PORT), token: opts.controllerToken });

  if (opts.mode === "poll-once") {
    try {
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
    } finally {
      gateway.stop();
      try { await replyEngine?.stop?.(); } finally { await settingsListener?.close(); }
    }
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
    try { await replyEngine?.stop?.(); }
    finally { try { await settingsListener?.close(); } finally { healthTracker.recordStop(); } }
  }
  return 0;
}
