import { StateManager } from "./runtime/state.js";
import { ILinkClient } from "./wechat/client.js";
import { ControllerClient, ChatNotAllowedError } from "./controller/client.js";
import { PermanentImageDownloadError } from "./controller/image-client.js";
import { DEFAULT_MESSAGE_MAX_CHARS } from "./wechat/markdown.js";
import { HealthTracker, sanitizeErrorType } from "./runtime/health.js";
import { CHECKPOINT_MARGIN_MS, ENTRY_TYPING_BUDGET_MS, REPLY_TIMEOUT_MS, NOTIFICATION_REPLY_TIMEOUT_MS } from "./runtime/budgets.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { NOTIFICATION_CHAT_LIMIT, NOTIFICATION_TIMEOUT_MS, NOTIFICATION_RECEIPT_RETRIES, NOTIFICATION_LIMIT,
  parseNotification, sameNotification, type NotificationDeliverySummary } from "./controller/notification-contract.js";

const NOTIFICATION_RECEIPT_BUDGET_MS = NOTIFICATION_TIMEOUT_MS * (NOTIFICATION_RECEIPT_RETRIES + 1);
const NOTIFICATION_SEND_FAILED_EVENT = "notification_send_failed";
const STDERR_FD = 2;
const MIN_NOTIFICATION_INTERVAL_MS = 1;

async function waitForNotificationPoll(intervalMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, Math.max(MIN_NOTIFICATION_INTERVAL_MS, intervalMs));
    signal.addEventListener("abort", finish, { once: true });
  });
}

export class NotificationDiagnosticError extends Error {
  constructor() { super("Notification diagnostic write failed"); }
}

function reportNotificationSendFailure(notificationId: string, attemptId: string, errorType: string): void {
  try {
    const line = JSON.stringify({ event: NOTIFICATION_SEND_FAILED_EVENT, notificationId, attemptId, errorType }) + "\n";
    if (fs.writeSync(STDERR_FD, line) !== Buffer.byteLength(line)) throw new NotificationDiagnosticError();
  } catch {
    // The permanent receipt is already saved; a diagnostic failure must never reopen sending.
    throw new NotificationDiagnosticError();
  }
}

export interface PollCycleSummary {
  polledCount: number;
  processedCount: number;
  skippedCount: number;
  nextSyncBuf: string;
  interrupted?: boolean;
}

export interface BaselineSummary {
  batchesDrained: number;
  rawMessagesSkipped: number;
  finalSyncBuf: string;
  establishedAt: string;
}

export class WeChatGateway {
  public readonly stateManager: StateManager;
  public readonly ilink: ILinkClient;
  public readonly controller: ControllerClient;
  public readonly splitMaxChars: number;
  public readonly splitMultiPart: boolean;
  public readonly healthTracker?: HealthTracker;
  public readonly notifications: boolean;
  private stopped: boolean = false;
  private deliveringNotifications: boolean = false;
  private notificationChatCursor = 0;
  private readonly notificationAbort = new AbortController();

  constructor(options: {
    stateManager: StateManager;
    ilink: ILinkClient;
    controller: ControllerClient;
    splitMaxChars?: number;
    splitMultiPart?: boolean;
    healthTracker?: HealthTracker;
    notifications?: boolean;
  }) {
    this.stateManager = options.stateManager;
    this.ilink = options.ilink;
    this.controller = options.controller;
    this.splitMaxChars = options.splitMaxChars ?? DEFAULT_MESSAGE_MAX_CHARS;
    this.splitMultiPart = options.splitMultiPart ?? true;
    this.healthTracker = options.healthTracker;
    this.notifications = options.notifications ?? false;
  }

  public stop(): void {
    this.stopped = true;
    this.notificationAbort.abort(new Error("WeChat notification delivery stopped"));
  }

  /** One durable multipart delivery per claim; client IDs only correlate evidence. */
  public async deliverNotificationsOnce(): Promise<NotificationDeliverySummary> {
    const summary: NotificationDeliverySummary = { accepted: 0, uncertain: 0, skipped: 0 };
    if (!this.notifications || this.stopped || this.deliveringNotifications || !this.stateManager.isReadyForActivePolling()) return summary;
    const chatIds = Object.keys(this.stateManager.contextTokens).filter(chatId => chatId.trim() &&
      typeof this.stateManager.contextTokens[chatId] === "string" && this.stateManager.contextTokens[chatId].trim()).sort();
    if (!chatIds.length || !this.stateManager.account?.token) return summary;
    this.deliveringNotifications = true;
    try {
      const offset = this.notificationChatCursor % chatIds.length;
      const batch = [...chatIds.slice(offset), ...chatIds.slice(0, offset)].slice(0, NOTIFICATION_CHAT_LIMIT);
      this.notificationChatCursor = (offset + batch.length) % chatIds.length;
      const fingerprint = this.stateManager.getLoginFingerprint();
      const items = await this.controller.listNotifications(batch);
      if (!Array.isArray(items) || items.length > NOTIFICATION_LIMIT) throw new Error("Controller notification response schema invalid");
      for (const raw of items) {
        const item = parseNotification(raw);
        const context = this.stateManager.contextTokens[item.chatId];
        if (this.stopped || item.status !== "pending" || !batch.includes(item.chatId) || !context?.trim() ||
            item.expiresAt <= Date.now() || fingerprint !== this.stateManager.getLoginFingerprint()) { summary.skipped++; continue; }
        const attemptId = randomUUID();
        const claimed = parseNotification(await this.controller.claimNotification(item.id, attemptId));
        if (!sameNotification(item, claimed) || claimed.status !== "claimed" || claimed.attemptId !== attemptId) {
          throw new Error("Controller notification claim identity mismatch");
        }
        if (this.stopped || !this.stateManager.isReadyForActivePolling() || claimed.expiresAt <= Date.now() ||
            claimed.attemptExpiresAt! <= Date.now() || context !== this.stateManager.contextTokens[item.chatId] ||
            fingerprint !== this.stateManager.getLoginFingerprint()) {
          await this.controller.recordNotificationReceipt(item.id, attemptId, "uncertain");
          summary.skipped++;
          continue;
        }
        let status: "accepted" | "uncertain" = "accepted";
        let sendErrorType: string | undefined;
        try {
          const timeoutMs = Math.min(NOTIFICATION_REPLY_TIMEOUT_MS,
            claimed.attemptExpiresAt! - Date.now() - NOTIFICATION_RECEIPT_BUDGET_MS);
          if (timeoutMs <= 0) throw new Error("WeChat notification claim has insufficient delivery budget");
          await this.ilink.sendMarkdownReply(item.chatId, item.text, {
            deliveryKey: `notification:${item.id}`, maxCharsPerChunk: this.splitMaxChars,
            timeoutMs, signal: this.notificationAbort.signal,
            shouldContinue: () => !this.stopped && this.stateManager.isReadyForActivePolling() &&
              claimed.attemptExpiresAt! > Date.now() && item.expiresAt > Date.now() &&
              context === this.stateManager.contextTokens[item.chatId] && fingerprint === this.stateManager.getLoginFingerprint(),
          });
        } catch (error) {
          status = "uncertain"; // A send failure is evidence uncertainty, never a resend instruction.
          sendErrorType = sanitizeErrorType(error);
        }
        await this.controller.recordNotificationReceipt(item.id, attemptId, status);
        summary[status]++;
        if (sendErrorType !== undefined) reportNotificationSendFailure(item.id, attemptId, sendErrorType);
      }
      return summary;
    } finally {
      this.deliveringNotifications = false;
    }
  }

  /**
   * Establishes baseline by draining pre-existing message batches until a raw empty page is observed.
   * Never forwards to Controller and never replies to WeChat.
   * Records context tokens, dedup keys, and commits syncBuf cursor.
   */
  public async establishBaseline(maxBatches: number = 20): Promise<BaselineSummary> {
    this.stateManager.beginBaseline();

    let batchesDrained = 0;
    let rawMessagesSkipped = 0;

    while (batchesDrained < maxBatches) {
      const batch = await this.ilink.pollBatch();
      batchesDrained++;
      rawMessagesSkipped += batch.rawMessageCount;

      // Record delivery keys for inbound text messages so they are never processed after baseline
      for (const msg of batch.messages) {
        if (msg.deliveryKey) {
          this.stateManager.recordProcessedMessageKey(msg.deliveryKey);
        }
      }

      // Commit syncBuf after each drained batch so progress is safely resumable upon interruption
      this.stateManager.commitCursor(batch.nextSyncBuf);

      // Crucial: Must check rawMessageCount from the server, not filtered batch.messages.length!
      // Non-text/event messages might result in messages.length === 0 while rawMessageCount > 0,
      // meaning more history pages may still follow.
      if (batch.rawMessageCount === 0) {
        this.stateManager.markBaselineEstablished();
        return {
          batchesDrained,
          rawMessagesSkipped,
          finalSyncBuf: batch.nextSyncBuf,
          establishedAt: this.stateManager.baselineEstablishedAt || new Date().toISOString(),
        };
      }
    }

    throw new Error(
      `Baseline drain exceeded bounded limit of ${maxBatches} batches without encountering an empty server page; baseline incomplete`
    );
  }

  /**
   * Executes a single poll -> forward -> reply -> checkpoint cycle.
   * Requires baseline to be established first.
   * Handles poison messages (CHAT_NOT_ALLOWED) by recording deliveryKey without replying,
   * allowing the cursor to safely advance past unallowed senders.
   */
  public async pollOnce(): Promise<PollCycleSummary> {
    if (!this.stateManager.isReadyForActivePolling()) {
      throw new Error(
        "Gateway cannot poll for active messages: baseline is not established. Run with --establish-baseline first."
      );
    }

    this.healthTracker?.recordPollStart(this.ilink.pollBudgetMs + CHECKPOINT_MARGIN_MS);
    try {
      const batch = await this.ilink.pollBatch();
      let processedCount = 0;
      let skippedCount = 0;
      let interrupted = false;

      for (const msg of batch.messages) {
        if (this.stopped) { interrupted = true; break; }
        this.healthTracker?.recordMessageStart(this.controller.authorizationBudgetMs + ENTRY_TYPING_BUDGET_MS +
          this.controller.requestBudgetMs + REPLY_TIMEOUT_MS + CHECKPOINT_MARGIN_MS);
        try {
          if (this.hasQuarantinedInboundReply(msg.deliveryKey)) {
            this.quarantineInboundReply(msg.deliveryKey);
            skippedCount++;
            continue;
          }
          await this.controller.assertChatAllowed(msg.chatId);
          await this.ilink.sendTyping(msg.chatId);
          const controllerReply = await this.controller.forwardMessage({
            chatId: msg.chatId,
            messageId: msg.messageId,
            text: msg.text,
          });

          const replyDeadline = Date.now() + REPLY_TIMEOUT_MS;
          if (controllerReply.images?.length) {
            await this.ilink.sendImageReply(msg.chatId, controllerReply.images, {
              deliveryKey: `image-reply:${msg.deliveryKey}`,
              timeoutMs: REPLY_TIMEOUT_MS,
              shouldContinue: () => !this.stopped,
              getImageBytes: (image, signal) => this.controller.downloadImage({
                chatId: msg.chatId, messageId: msg.messageId, image,
              }, signal),
            });
          }

          if (controllerReply.text.length > 0) {
            const timeoutMs = replyDeadline - Date.now();
            if (timeoutMs <= 0) throw new Error("WeChat reply timed out before completion");
            await this.ilink.sendMarkdownReply(msg.chatId, controllerReply.text, {
              deliveryKey: msg.deliveryKey,
              maxCharsPerChunk: this.splitMaxChars,
              splitMultiPart: this.splitMultiPart,
              timeoutMs,
            });
          }

          if (msg.deliveryKey) {
            this.stateManager.recordProcessedMessageKey(msg.deliveryKey);
          }
          processedCount++;
          this.healthTracker?.recordMessageProgress();
        } catch (err) {
          if (err instanceof PermanentImageDownloadError) {
            this.stateManager.recordReplyFailure(`image-reply:${msg.deliveryKey}`, err.reason);
          }
          if (this.hasQuarantinedInboundReply(msg.deliveryKey)) {
            this.quarantineInboundReply(msg.deliveryKey);
            skippedCount++;
            continue;
          }
          if (err instanceof ChatNotAllowedError) {
            // Poison batch protection: unauthorized chat is rejected by Controller allowlist.
            // Mark message processed so the cursor advances and subsequent messages are not starved.
            if (msg.deliveryKey) {
              this.stateManager.recordProcessedMessageKey(msg.deliveryKey);
            }
            skippedCount++;
            this.healthTracker?.recordMessageProgress();
            continue;
          }
          throw err;
        }
      }

      if (interrupted) this.healthTracker?.recordProcessingEnd();
      else {
        this.stateManager.commitCursor(batch.nextSyncBuf);
        this.healthTracker?.recordPollSuccess();
      }
      return {
        polledCount: batch.messages.length,
        processedCount,
        skippedCount,
        nextSyncBuf: this.stateManager.syncBuf,
        interrupted,
      };
    } catch (err) {
      this.healthTracker?.recordPollError(err);
      throw err;
    }
  }

  private hasQuarantinedInboundReply(deliveryKey: string): boolean {
    return Boolean(deliveryKey) && (this.stateManager.hasUncertainReply(deliveryKey) ||
      this.stateManager.hasUncertainReply(`image-reply:${deliveryKey}`) ||
      this.stateManager.hasPermanentReplyFailure(`image-reply:${deliveryKey}`));
  }

  private quarantineInboundReply(deliveryKey: string): void {
    // Isolate this inbound item while retaining its durable delivery failure evidence.
    this.stateManager.recordProcessedMessageKey(deliveryKey, { preserveReplyEvidence: true });
    this.healthTracker?.recordMessageProgress();
  }

  public async runLoop(pollIntervalMs: number = 1000, onError?: (err: Error) => void,
    onNotificationError?: (err: Error) => void): Promise<void> {
    if (!this.stateManager.isReadyForActivePolling()) {
      throw new Error(
        "Gateway cannot start poll loop: baseline is not established. Run with --establish-baseline first."
      );
    }

    let notificationFailure: Error | undefined;
    const deliver = async (): Promise<void> => {
      try { await this.deliverNotificationsOnce(); }
      catch (err) {
        const error = err instanceof Error ? err : new Error("Notification delivery failed");
        if (error instanceof NotificationDiagnosticError) { notificationFailure = error; this.stop(); return; }
        try {
          if (onNotificationError) onNotificationError(error);
          else if (onError) onError(error);
          else process.stderr.write("[gateway] notification cycle error\n");
        } catch (callbackError) {
          notificationFailure = callbackError instanceof Error ? callbackError : new Error("Notification error callback failed");
          this.stop();
        }
      }
    };
    const notificationTask = this.notifications ? (async () => {
      while (!this.stopped) {
        await deliver();
        if (!this.stopped) await waitForNotificationPoll(pollIntervalMs, this.notificationAbort.signal);
      }
    })() : Promise.resolve();
    try {
      while (!this.stopped) {
        try { await this.pollOnce(); }
        catch (err) {
          const error = err instanceof Error ? err : new Error("Gateway polling failed");
          if (onError) onError(error);
          else throw error;
        }
        if (this.stopped) break;
        if (pollIntervalMs > 0) await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      }
    } finally {
      this.stop();
      await notificationTask;
    }
    if (notificationFailure) throw notificationFailure;
  }
}
