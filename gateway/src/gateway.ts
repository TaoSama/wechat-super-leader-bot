import { StateManager } from "./runtime/state.js";
import { ILinkClient } from "./wechat/client.js";
import { ControllerClient, ChatNotAllowedError } from "./controller/client.js";
import { PermanentImageDownloadError } from "./controller/image-client.js";
import { PermanentReplyUnavailableError } from "./controller/reply-client.js";
import { DEFAULT_MESSAGE_MAX_CHARS } from "./wechat/markdown.js";
import { HealthTracker } from "./runtime/health.js";
import { CHECKPOINT_MARGIN_MS, ENTRY_TYPING_BUDGET_MS, REPLY_TIMEOUT_MS } from "./runtime/budgets.js";
import { type NotificationDeliverySummary } from "./controller/notification-contract.js";
import { NotificationOutbox, NotificationDiagnosticError } from "./runtime/notification-outbox.js";
import { ResultClient } from "./controller/result-client.js";
import { FileResultOutbox } from "./results/outbox.js";
import { ResultDeliveryRunner } from "./results/delivery.js";
import { ResultDispatcher } from "./results/dispatcher.js";
import { RenewalNotifier, renewalDeliveryKey } from "./results/renewal.js";
import { RESULT_TEXT_CHARS } from "./results/contracts.js";
import { getDeferReason, LocalSendDeferredError } from "./runtime/context-policy.js";
import type { ControllerMessageResponse, DeliveryOutboxItem } from "./types.js";
import { OutboxBackpressureError } from "./runtime/delivery-state.js";
import { CONFLICT_REPLY, ReplyEngineBackpressureError, ReplyEngineConflictError, ReplyEngineUnavailableError, type GatewayReplyEngine } from "./leader/contracts.js";
export type { GatewayReplyEngine } from "./leader/contracts.js";
export { NotificationDiagnosticError } from "./runtime/notification-outbox.js";

const MIN_NOTIFICATION_INTERVAL_MS = 1;
const NOTIFICATION_INTEREST_CACHE_MS = 30_000;

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
  private readonly replyEngine?: GatewayReplyEngine;
  private stopped: boolean = false;
  private readonly notificationOutbox?: NotificationOutbox;
  private readonly resultDispatcher?: ResultDispatcher;
  private readonly renewalNotifier?: RenewalNotifier;
  private readonly resultClient?: ResultClient;
  private notificationInterest?: { fetchedAt: number; chatIds: string[]; interested: string[] };
  private readonly activeInboundChats = new Set<string>();
  private flushingReplies = false;
  private readonly activeReplyDeliveries = new Set<string>();
  private replyOutboxCursor = 0;
  private readonly notificationAbort = new AbortController();

  constructor(options: {
    stateManager: StateManager;
    ilink: ILinkClient;
    controller: ControllerClient;
    splitMaxChars?: number;
    splitMultiPart?: boolean;
    healthTracker?: HealthTracker;
    notifications?: boolean;
    replyEngine?: GatewayReplyEngine;
    resultClient?: ResultClient;
    resultOutbox?: FileResultOutbox;
  }) {
    this.replyEngine = options.replyEngine;
    this.stateManager = options.stateManager;
    this.ilink = options.ilink;
    this.controller = options.controller;
    this.splitMaxChars = options.splitMaxChars ?? DEFAULT_MESSAGE_MAX_CHARS;
    this.splitMultiPart = options.splitMultiPart ?? true;
    this.healthTracker = options.healthTracker;
    this.notifications = options.notifications ?? false;
    if (options.resultClient && options.resultOutbox) {
      this.resultClient = options.resultClient;
      const active = () => !this.stopped && this.stateManager.isReadyForActivePolling();
      const isReplyPending = (chatId: string) => this.isReplyPending(chatId);
      const canDispatch = (chatId: string, kind: "final" | "progress") => Boolean(this.stateManager.contextTokens[chatId]) && this.stateManager.canSendToChat(chatId, kind);
      const deferReason = (chatId: string, kind: "final" | "progress") => getDeferReason(this.stateManager.contextBudgets[chatId], this.stateManager.policy, kind) ?? "context_changed";
      const runner = new ResultDeliveryRunner({ state: this.stateManager,
        transport: {
          sendText: (chatId, text, sendOptions) => this.ilink.sendMarkdownReply(chatId, text, { ...sendOptions, maxCharsPerChunk: RESULT_TEXT_CHARS, splitMultiPart: false, verbatim: true }),
          sendFile: (chatId, artifact, bytes, sendOptions) => this.ilink.sendFileReply(chatId, bytes,
            { fileName: artifact.name, byteLength: artifact.size, sha256: artifact.sha256 }, sendOptions),
        },
        downloadArtifact: (artifact, signal) => options.resultClient!.downloadArtifact(artifact, signal),
        budget: (chatId, kind) => ({ allowed: canDispatch(chatId, kind), remaining: this.stateManager.remainingSendBudget(chatId), reason: deferReason(chatId, kind) }),
        contextFingerprint: chatId => JSON.stringify([this.stateManager.contextTokens[chatId], this.stateManager.contextBudgets[chatId]?.lastInboundKey]),
        isReplyPending,
      });
      this.resultDispatcher = new ResultDispatcher({ controller: options.resultClient, store: options.resultOutbox,
        runner, state: this.stateManager, canDispatch, deferReason, isReplyPending, active, signal: this.notificationAbort.signal });
      this.renewalNotifier = new RenewalNotifier({ state: this.stateManager, isReplyPending, active, signal: this.notificationAbort.signal,
        send: (chatId, text, sendOptions) => this.ilink.sendMarkdownReply(chatId, text, sendOptions) });
      this.stateManager.setReplyEvidenceProtection(key => options.resultOutbox!.protectsDeliveryKey(key) ||
        Object.entries(this.stateManager.contextBudgets).some(([chatId, budget]) => Date.now() >= budget.refreshedAt &&
          Date.now() - budget.refreshedAt < this.stateManager.policy.contextWindowMs &&
          key === renewalDeliveryKey(this.stateManager.getLoginFingerprint(), chatId, budget.refreshedAt)));
    } else {
      if (options.resultClient || options.resultOutbox) throw new Error("Result client and outbox must be configured together");
      this.notificationOutbox = new NotificationOutbox({ stateManager: this.stateManager, ilink: this.ilink,
        controller: this.controller, splitMaxChars: this.splitMaxChars, signal: this.notificationAbort.signal,
        splitMultiPart: this.splitMultiPart, shouldContinue: () => !this.stopped && this.stateManager.isReadyForActivePolling() });
    }
  }

  public stop(): void {
    this.stopped = true;
    this.notificationAbort.abort(new Error("WeChat notification delivery stopped"));
  }

  /** One durable multipart delivery per claim; client IDs only correlate evidence. */
  public async deliverNotificationsOnce(): Promise<NotificationDeliverySummary> {
    if (!this.notifications || this.stopped || !this.stateManager.isReadyForActivePolling()) return { accepted: 0, uncertain: 0, skipped: 0 };
    let replyError: unknown;
    try { await this.flushRepliesOnce(); } catch (error) { replyError = error; }
    let summary: NotificationDeliverySummary;
    if (this.resultDispatcher && this.resultClient) {
      if (!this.notificationInterest || Date.now() - this.notificationInterest.fetchedAt >= NOTIFICATION_INTEREST_CACHE_MS) {
        this.notificationInterest = { ...await this.resultClient.notificationInterest(this.notificationAbort.signal), fetchedAt: Date.now() };
      }
      summary = await this.resultDispatcher.deliverOnce(this.notificationInterest.chatIds);
      await this.renewalNotifier!.deliverOnce(this.notificationInterest.interested);
    } else summary = await this.notificationOutbox!.deliverOnce();
    if (replyError) throw replyError;
    return summary;
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
        this.stateManager.recordInboundContext(msg.deliveryKey, msg.chatId, msg.createdAtMs, false, msg.contextToken);
        if (msg.contextToken && !this.stateManager.contextTokens[msg.chatId]) this.stateManager.setContextToken(msg.chatId, msg.contextToken);
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
          (this.replyEngine?.requestBudgetMs ?? this.controller.requestBudgetMs) + REPLY_TIMEOUT_MS + CHECKPOINT_MARGIN_MS);
        this.activeInboundChats.add(msg.chatId);
        try {
          if (this.hasQuarantinedInboundReply(msg.deliveryKey)) {
            this.quarantineInboundReply(msg.deliveryKey);
            skippedCount++;
            continue;
          }
          await this.controller.assertChatAllowed(msg.chatId);
          const fresh = this.stateManager.recordInboundContext(msg.deliveryKey, msg.chatId, msg.createdAtMs, Boolean(msg.contextToken?.trim()), msg.contextToken);
          const retryingAdmission = this.stateManager.contextBudgets[msg.chatId]?.lastInboundKey === msg.deliveryKey &&
            !this.stateManager.isMessageProcessed(msg.deliveryKey);
          if ((fresh || retryingAdmission) && msg.contextToken?.trim()) this.resultDispatcher?.noteInbound(msg.chatId, msg.deliveryKey);
          if (this.stateManager.outbox[msg.deliveryKey]) {
            this.stateManager.recordProcessedMessageKey(msg.deliveryKey, { preserveReplyEvidence: true });
            processedCount++;
            continue;
          }
          try { this.stateManager.assertOutboxCapacity(msg.deliveryKey); }
          catch (error) {
            if (!(error instanceof OutboxBackpressureError)) throw error;
            // The new inbound may have restored the budget needed to drain a full queue.
            await this.flushRepliesOnce();
            this.stateManager.assertOutboxCapacity(msg.deliveryKey);
          }
          await this.ilink.sendTyping(msg.chatId);
          const request = { chatId: msg.chatId, messageId: msg.messageId, text: msg.text };
          let source: DeliveryOutboxItem["source"] = this.replyEngine ? "engine" : "controller";
          let controllerReply: ControllerMessageResponse;
          try {
            controllerReply = this.replyEngine
              ? await this.replyEngine.reply(this.stateManager.account!.accountId, request, this.controller)
              : await this.controller.forwardMessage(request);
          } catch (error) {
            if (error instanceof ReplyEngineBackpressureError && this.replyEngine) {
              // This inbound may restore a window needed to release pinned replies.
              await this.flushRepliesOnce();
              controllerReply = await this.replyEngine.reply(this.stateManager.account!.accountId, request, this.controller);
            } else {
              if (!(error instanceof ReplyEngineConflictError)) throw error;
              source = "codex-conflict";
              controllerReply = error.reply;
            }
          }
          this.stateManager.putOutbox({ kind: "reply", source, chatId: msg.chatId, messageId: msg.messageId,
            deliveryKey: msg.deliveryKey, splitMaxChars: this.splitMaxChars, splitMultiPart: this.splitMultiPart, status: "pending" });
          if (msg.deliveryKey) {
            this.stateManager.recordProcessedMessageKey(msg.deliveryKey, { preserveReplyEvidence: true });
          }
          await this.deliverReply(this.stateManager.outbox[msg.deliveryKey], controllerReply);
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
        } finally { this.activeInboundChats.delete(msg.chatId); }
      }

      if (interrupted) this.healthTracker?.recordProcessingEnd();
      else {
        this.stateManager.commitCursor(batch.nextSyncBuf);
        await this.flushRepliesOnce();
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

  private isReplyPending(chatId: string): boolean {
    return this.activeInboundChats.has(chatId) || Object.values(this.stateManager.outbox).some(item =>
      item.kind === "reply" && item.chatId === chatId && item.status === "pending");
  }

  private async deliverReply(item: DeliveryOutboxItem, reply: ControllerMessageResponse): Promise<void> {
    if (this.stopped || item.status !== "pending" || this.activeReplyDeliveries.has(item.deliveryKey)) return;
    this.activeReplyDeliveries.add(item.deliveryKey);
    try {
      const deadline = Date.now() + REPLY_TIMEOUT_MS;
      if (reply.images?.length) {
        await this.ilink.sendImageReply(item.chatId, reply.images, { deliveryKey: `image-reply:${item.deliveryKey}`,
          timeoutMs: REPLY_TIMEOUT_MS, shouldContinue: () => !this.stopped,
          getImageBytes: (image, signal) => this.controller.downloadImage({ chatId: item.chatId, messageId: item.messageId, image }, signal) });
      }
      if (reply.text.length) {
        const timeoutMs = deadline - Date.now();
        if (timeoutMs <= 0) throw new Error("WeChat reply timed out before completion");
        await this.ilink.sendMarkdownReply(item.chatId, reply.text, { deliveryKey: item.deliveryKey,
          maxCharsPerChunk: item.splitMaxChars, splitMultiPart: item.splitMultiPart, timeoutMs,
          shouldContinue: () => !this.stopped });
      }
      if (item.source === "engine") this.stateManager.updateOutbox(item.deliveryKey, { status: "receipt", receiptStatus: "accepted" });
      await this.ackEngineReply(item, "accepted");
      this.stateManager.removeOutbox(item.deliveryKey);
    } catch (error) {
      if (error instanceof LocalSendDeferredError) return;
      if (error instanceof PermanentImageDownloadError) {
        this.stateManager.recordReplyFailure(`image-reply:${item.deliveryKey}`, error.reason);
        this.stateManager.updateOutbox(item.deliveryKey, { status: "expired" });
        await this.ackEngineReply(item, "expired");
        return;
      }
      if (this.hasQuarantinedInboundReply(item.deliveryKey)) {
        this.stateManager.updateOutbox(item.deliveryKey, { status: "uncertain" });
        await this.ackEngineReply(item, "uncertain");
        return;
      }
      throw error;
    } finally { this.activeReplyDeliveries.delete(item.deliveryKey); }
  }

  /** Recovery reads immutable responses only; an old command is never POSTed again. */
  public async flushRepliesOnce(): Promise<void> {
    if (this.flushingReplies || this.stopped) return;
    this.flushingReplies = true;
    let firstError: unknown;
    try {
      // Retry terminal journal acknowledgements after a prior journal save failure.
      for (const item of Object.values(this.stateManager.outbox)) {
        if (this.activeReplyDeliveries.has(item.deliveryKey)) continue;
        if (item.kind === "reply" && item.source === "engine" && item.status === "receipt" && item.receiptStatus === "accepted") {
          try {
            await this.ackEngineReply(item, "accepted");
            this.stateManager.removeOutbox(item.deliveryKey);
          } catch (error) { firstError ??= error; }
        } else if (item.kind === "reply" && item.source === "engine" && (item.status === "uncertain" || item.status === "expired")) {
          try { await this.ackEngineReply(item, item.status); }
          catch (error) { firstError ??= error; }
        }
      }
      const items = Object.values(this.stateManager.outbox).filter(item => item.kind === "reply" && item.status === "pending" &&
        !this.activeReplyDeliveries.has(item.deliveryKey));
      const offset = this.replyOutboxCursor % Math.max(1, items.length);
      for (const item of [...items.slice(offset), ...items.slice(0, offset)]) {
        if (this.hasQuarantinedInboundReply(item.deliveryKey)) {
          this.stateManager.updateOutbox(item.deliveryKey, { status: "uncertain" });
          await this.ackEngineReply(item, "uncertain");
          continue;
        }
        const text = this.stateManager.replyDeliveries[item.deliveryKey];
        if (text && text.acknowledgedChunks === text.totalChunks && !text.inFlight) {
          await this.ackEngineReply(item, "accepted");
          this.stateManager.removeOutbox(item.deliveryKey);
          continue;
        }
        if (!this.stateManager.canSendToChat(item.chatId)) continue;
        this.replyOutboxCursor = (items.indexOf(item) + 1) % items.length;
        try { await this.deliverReply(item, await this.getFrozenReply(item)); }
        catch (error) {
          if (error instanceof PermanentReplyUnavailableError) {
            this.stateManager.updateOutbox(item.deliveryKey, {
              status: this.hasQuarantinedInboundReply(item.deliveryKey) ? "uncertain" : "expired",
            });
            await this.ackEngineReply(item, this.hasQuarantinedInboundReply(item.deliveryKey) ? "uncertain" : "expired");
            break;
          }
          firstError ??= error;
        }
        // One resumed reply per turn keeps getupdates and independent chats moving.
        break;
      }
    } finally { this.flushingReplies = false; }
    if (firstError) throw firstError;
  }

  private async getFrozenReply(item: DeliveryOutboxItem): Promise<ControllerMessageResponse> {
    if (item.source === "codex-conflict") return { text: CONFLICT_REPLY };
    if (item.source === "engine") {
      if (!this.replyEngine) throw new ReplyEngineUnavailableError();
      return this.replyEngine.getReply(this.stateManager.account!.accountId, item.chatId, item.messageId, this.controller);
    }
    return this.controller.getMessageReply(item.chatId, item.messageId);
  }

  private async ackEngineReply(item: DeliveryOutboxItem, status: "accepted" | "uncertain" | "expired"): Promise<void> {
    if (item.source !== "engine" || this.stateManager.outbox[item.deliveryKey]?.engineAcked) return;
    if (!this.replyEngine) throw new ReplyEngineUnavailableError();
    await this.replyEngine.ackReply(this.stateManager.account!.accountId, item.chatId, item.messageId, status);
    this.stateManager.updateOutbox(item.deliveryKey, { engineAcked: true });
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
        if (this.stopped || this.notificationAbort.signal.aborted) return;
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
