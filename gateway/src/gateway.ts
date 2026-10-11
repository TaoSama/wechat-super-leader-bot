import { StateManager } from "./state.js";
import { ILinkClient } from "./ilink.js";
import { ControllerClient, ChatNotAllowedError } from "./controller_client.js";
import { DEFAULT_MESSAGE_MAX_CHARS } from "./markdown.js";
import { HealthTracker } from "./health.js";
import { CHECKPOINT_MARGIN_MS, REPLY_TIMEOUT_MS, SEND_REQUEST_TIMEOUT_MS } from "./budgets.js";
import { randomUUID } from "node:crypto";
import { NOTIFICATION_CHAT_LIMIT, NOTIFICATION_TIMEOUT_MS, NOTIFICATION_RECEIPT_RETRIES, NOTIFICATION_LIMIT,
  parseNotification, sameNotification, type NotificationDeliverySummary } from "./notifications.js";

const NOTIFICATION_CYCLE_BUDGET_MS = NOTIFICATION_TIMEOUT_MS + NOTIFICATION_LIMIT *
  (NOTIFICATION_TIMEOUT_MS + SEND_REQUEST_TIMEOUT_MS + NOTIFICATION_TIMEOUT_MS * (NOTIFICATION_RECEIPT_RETRIES + 1)) + CHECKPOINT_MARGIN_MS;

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
  public readonly planNotifications: boolean;
  private stopped: boolean = false;
  private deliveringNotifications: boolean = false;
  private notificationChatCursor = 0;

  constructor(options: {
    stateManager: StateManager;
    ilink: ILinkClient;
    controller: ControllerClient;
    splitMaxChars?: number;
    splitMultiPart?: boolean;
    healthTracker?: HealthTracker;
    planNotifications?: boolean;
  }) {
    this.stateManager = options.stateManager;
    this.ilink = options.ilink;
    this.controller = options.controller;
    this.splitMaxChars = options.splitMaxChars ?? DEFAULT_MESSAGE_MAX_CHARS;
    this.splitMultiPart = options.splitMultiPart ?? true;
    this.healthTracker = options.healthTracker;
    this.planNotifications = options.planNotifications ?? false;
  }

  public stop(): void {
    this.stopped = true;
  }

  /** At most one send per claim. A deterministic client ID correlates evidence, not delivery idempotence. */
  public async deliverNotificationsOnce(): Promise<NotificationDeliverySummary> {
    const summary: NotificationDeliverySummary = { accepted: 0, uncertain: 0, skipped: 0 };
    if (!this.planNotifications || this.stopped || this.deliveringNotifications || !this.stateManager.isReadyForActivePolling()) return summary;
    const chatIds = Object.keys(this.stateManager.contextTokens).filter(chatId => chatId.trim() &&
      typeof this.stateManager.contextTokens[chatId] === "string" && this.stateManager.contextTokens[chatId].trim()).sort();
    if (!chatIds.length || !this.stateManager.account?.token) return summary;
    this.deliveringNotifications = true;
    let healthPhase: number | undefined;
    try {
      healthPhase = this.healthTracker?.recordMessageStart(NOTIFICATION_CYCLE_BUDGET_MS);
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
        try {
          await this.ilink.sendSingleText(item.chatId, item.text, `super-leader:notification:${item.id}`, undefined, { strictReceipt: true });
        } catch { status = "uncertain"; } // A send failure is evidence uncertainty, never a resend instruction.
        await this.controller.recordNotificationReceipt(item.id, attemptId, status);
        summary[status]++;
      }
      return summary;
    } finally {
      this.deliveringNotifications = false;
      if (healthPhase !== undefined) this.healthTracker?.recordProcessingEnd(healthPhase);
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
        this.healthTracker?.recordMessageStart(this.controller.requestBudgetMs + REPLY_TIMEOUT_MS + CHECKPOINT_MARGIN_MS);
        try {
          const controllerReply = await this.controller.forwardMessage({
            chatId: msg.chatId,
            messageId: msg.messageId,
            text: msg.text,
          });

          if (controllerReply.text && controllerReply.text.trim()) {
            await this.ilink.sendMarkdownReply(msg.chatId, controllerReply.text, {
              deliveryKey: msg.deliveryKey,
              maxCharsPerChunk: this.splitMaxChars,
              splitMultiPart: this.splitMultiPart,
            });
          }

          if (msg.deliveryKey) {
            this.stateManager.recordProcessedMessageKey(msg.deliveryKey);
          }
          processedCount++;
          this.healthTracker?.recordMessageProgress();
        } catch (err) {
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

  public async runLoop(pollIntervalMs: number = 1000, onError?: (err: Error) => void,
    onNotificationError?: (err: Error) => void): Promise<void> {
    if (!this.stateManager.isReadyForActivePolling()) {
      throw new Error(
        "Gateway cannot start poll loop: baseline is not established. Run with --establish-baseline first."
      );
    }

    while (!this.stopped) {
      try { await this.deliverNotificationsOnce(); }
      catch (err) {
        const error = err instanceof Error ? err : new Error("Notification delivery failed");
        if (onNotificationError) onNotificationError(error);
        else if (onError) onError(error);
        else process.stderr.write("[gateway] notification cycle error\n");
      }
      if (this.stopped) break;
      try {
        await this.pollOnce();
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (onError) {
          onError(error);
        } else {
          throw error;
        }
      }
      if (this.stopped) break;
      if (pollIntervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      }
    }
  }
}
