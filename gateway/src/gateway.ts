import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createMessageTrace, currentTrace, runWithTrace, traceEvent, traceSpan } from "./runtime/telemetry.js";
import { StateManager } from "./runtime/state.js";
import { ILinkClient } from "./wechat/client.js";
import { ControllerClient, ChatNotAllowedError } from "./controller/client.js";
import { PermanentImageDownloadError } from "./controller/image-client.js";
import { PermanentReplyUnavailableError } from "./controller/reply-client.js";
import { DEFAULT_MESSAGE_MAX_CHARS } from "./wechat/markdown.js";
import { HealthTracker, sanitizeErrorType } from "./runtime/health.js";
import { CHECKPOINT_MARGIN_MS, REPLY_TIMEOUT_MS } from "./runtime/budgets.js";
import { type NotificationDeliverySummary } from "./controller/notification-contract.js";
import { NotificationOutbox, NotificationDiagnosticError } from "./runtime/notification-outbox.js";
import { ResultClient } from "./controller/result-client.js";
import { FileResultOutbox } from "./results/outbox.js";
import { ResultDeliveryRunner } from "./results/delivery.js";
import { ResultDispatcher } from "./results/dispatcher.js";
import { RenewalNotifier, renewalDeliveryKey } from "./results/renewal.js";
import { RESULT_TEXT_CHARS } from "./results/contracts.js";
import { getDeferReason, LocalSendDeferredError } from "./runtime/context-policy.js";
import type { ControllerMessageResponse, DeliveryOutboxItem, InboundWeChatMessage } from "./types.js";
import { OutboxBackpressureError } from "./runtime/delivery-state.js";
import { CONFLICT_REPLY, ReplyEngineBackpressureError, ReplyEngineConflictError, ReplyEngineUnavailableError, type GatewayReplyEngine } from "./leader/contracts.js";
export type { GatewayReplyEngine } from "./leader/contracts.js";
export { NotificationDiagnosticError } from "./runtime/notification-outbox.js";

import { FileInboundInbox, InboxConflictError } from "./runtime/inbox.js";
import { InboundRunner } from "./runtime/inbound-runner.js";
import { QueryProgress, MAX_PROGRESS_CHARS, type ProgressSink } from "./leader/progress.js";

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
  public readonly healthTracker?: HealthTracker;
  private readonly replyEngine?: GatewayReplyEngine;
  private stopped: boolean = false;
  private readonly notificationOutbox?: NotificationOutbox;
  private readonly resultDispatcher?: ResultDispatcher;
  private readonly renewalNotifier?: RenewalNotifier;
  private readonly resultClient?: ResultClient;
  private notificationInterest?: { fetchedAt: number; chatIds: string[]; interested: string[] };
  private readonly inbox: FileInboundInbox;
  private readonly inboundRunner: InboundRunner;
  private inboundError?: Error;
  private onInboundError?: (error: Error) => void;
  private readonly queryStarts = new Map<string, Promise<void>>();
  private readonly activeInboundChats = new Set<string>();
  private replyFlushCompletion?: Promise<void>;
  private readonly activeReplyDeliveries = new Set<string>();
  private replyOutboxCursor = 0;
  private readonly notificationAbort = new AbortController();

  constructor(options: {
    stateManager: StateManager;
    ilink: ILinkClient;
    controller: ControllerClient;
    splitMaxChars?: number;
    healthTracker?: HealthTracker;
    replyEngine?: GatewayReplyEngine;
    resultClient?: ResultClient;
    resultOutbox?: FileResultOutbox;
  }) {
    this.replyEngine = options.replyEngine;
    this.stateManager = options.stateManager;
    this.ilink = options.ilink;
    this.controller = options.controller;
    this.splitMaxChars = options.splitMaxChars ?? DEFAULT_MESSAGE_MAX_CHARS;
    this.healthTracker = options.healthTracker;
    this.inbox = new FileInboundInbox(`${this.stateManager.statePath}.inbox.json`,
      () => this.stateManager.getLoginFingerprint(), this.stateManager.policy.outboxLimit);
    this.inboundRunner = new InboundRunner({ inbox: this.inbox,
      process: msg => runWithTrace(createMessageTrace(msg.chatId, msg.messageId), async () => { await this.processMessage(msg); }),
      steer: async msg => {
        await this.queryStarts.get(msg.chatId);
        return this.replyEngine?.steer?.(this.stateManager.account!.accountId,
          { chatId: msg.chatId, messageId: msg.messageId, text: msg.text }, this.controller) ?? false;
      },
      covered: msg => this.stateManager.recordProcessedMessageKey(msg.deliveryKey, { preserveReplyEvidence: true }),
      onError: error => {
        const failure = error instanceof Error ? error : new Error("Inbound processing failed");
        this.healthTracker?.recordPollError(failure);
        try {
          if (this.onInboundError) this.onInboundError(failure);
          else { this.inboundError = failure; this.stop(); }
        } catch (reportError) {
          this.inboundError = reportError instanceof Error ? reportError : new Error("Inbound error reporting failed");
          this.stop();
        }
      },
    });
    if (options.resultClient && options.resultOutbox) {
      this.resultClient = options.resultClient;
      const active = () => !this.stopped && this.stateManager.isReadyForActivePolling();
      const isReplyPending = (chatId: string) => this.isReplyPending(chatId);
      const canDispatch = (chatId: string, kind: "final" | "progress") => Boolean(this.stateManager.contextTokens[chatId]) && this.stateManager.canSendToChat(chatId, kind);
      const deferReason = (chatId: string, kind: "final" | "progress") => getDeferReason(this.stateManager.contextBudgets[chatId], this.stateManager.policy, kind) ?? "context_changed";
      const runner = new ResultDeliveryRunner({ state: this.stateManager,
        transport: {
          sendText: (chatId, text, sendOptions) => this.ilink.sendMarkdownReply(chatId, text, { ...sendOptions, maxCharsPerChunk: RESULT_TEXT_CHARS, verbatim: true }),
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
      this.renewalNotifier = new RenewalNotifier({ state: this.stateManager, active, signal: this.notificationAbort.signal,
        send: (chatId, text, sendOptions) => this.ilink.sendMarkdownReply(chatId, text, sendOptions) });
      this.ilink.setBeforeSendCheck((chatId, deliveryKey) => {
        if (this.renewalInterestedChats().includes(chatId) && this.renewalNotifier!.shouldYield(chatId, deliveryKey)) {
          throw new LocalSendDeferredError("budget_exhausted", "Local send deferred for a priority renewal reminder");
        }
      });
      this.stateManager.setReplyEvidenceProtection(key => options.resultOutbox!.protectsDeliveryKey(key) ||
        Object.entries(this.stateManager.contextBudgets).some(([chatId, budget]) => Date.now() >= budget.refreshedAt &&
          Date.now() - budget.refreshedAt < this.stateManager.policy.contextWindowMs &&
          key === renewalDeliveryKey(this.stateManager.getLoginFingerprint(), chatId, budget.refreshedAt)));
    } else {
      if (options.resultClient || options.resultOutbox) throw new Error("Result client and outbox must be configured together");
      this.notificationOutbox = new NotificationOutbox({ stateManager: this.stateManager, ilink: this.ilink,
        controller: this.controller, splitMaxChars: this.splitMaxChars, signal: this.notificationAbort.signal,
        shouldContinue: () => !this.stopped && this.stateManager.isReadyForActivePolling() });
    }
  }

  public stop(): void {
    this.stopped = true;
    this.inboundRunner.halt();
    this.notificationAbort.abort(new Error("WeChat notification delivery stopped"));
  }

  /** One durable multipart delivery per claim; client IDs only correlate evidence. */
  public async deliverNotificationsOnce(): Promise<NotificationDeliverySummary> {
    if (this.stopped || !this.stateManager.isReadyForActivePolling()) return { accepted: 0, uncertain: 0, skipped: 0 };
    let firstError: unknown;
    let renewalError: unknown;
    let summary: NotificationDeliverySummary = { accepted: 0, uncertain: 0, skipped: 0 };
    if (this.resultDispatcher && this.resultClient) {
      try {
        if (!this.notificationInterest || Date.now() - this.notificationInterest.fetchedAt >= NOTIFICATION_INTEREST_CACHE_MS) {
          this.notificationInterest = { ...await this.resultClient.notificationInterest(this.notificationAbort.signal), fetchedAt: Date.now() };
        }
      } catch (error) { firstError = error; }
      // Renewal has priority over ordinary replies and task results, including local SDK replies.
      try { await this.renewalNotifier!.deliverOnce(this.renewalInterestedChats()); }
      catch (error) { renewalError = error; }
    }
    try { await this.flushRepliesOnce(); } catch (error) { firstError ??= error; }
    try {
      if (this.resultDispatcher) {
        try { summary = await this.resultDispatcher.deliverOnce(this.notificationInterest?.chatIds ?? []); }
        catch (error) { firstError ??= error; }
        // A multipart reply can cross 3 -> 2 and yield its unsent suffix during this pass.
        try { await this.renewalNotifier!.deliverOnce(this.renewalInterestedChats()); }
        catch (error) { renewalError ??= error; }
      } else summary = await this.notificationOutbox!.deliverOnce();
    } catch (error) { firstError ??= error; }
    if (firstError !== undefined) throw firstError;
    if (renewalError !== undefined) throw renewalError;
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
  public async pollOnce(waitForReplies = true): Promise<PollCycleSummary> {
    if (!this.stateManager.isReadyForActivePolling()) {
      throw new Error(
        "Gateway cannot poll for active messages: baseline is not established. Run with --establish-baseline first."
      );
    }

    this.healthTracker?.recordPollStart(this.ilink.pollBudgetMs + CHECKPOINT_MARGIN_MS);
    try {
      const batchId = randomUUID();
      const batch = await runWithTrace(createMessageTrace("poll", batchId), () =>
        traceSpan("wechat.poll", () => this.ilink.pollBatch()));
      const receivedAt = Date.now();
      const receivedClock = performance.now();
      const traces = batch.messages.map((msg, batchIndex) => {
        const trace = createMessageTrace(msg.chatId, msg.messageId);
        runWithTrace(trace, () => traceEvent("message.received", {
          batchId, batchIndex, batchCount: batch.messages.length, chars: msg.text.length,
          platformCreatedAtMs: msg.createdAtMs,
          platformToReceivedMs: Number.isFinite(msg.createdAtMs) ? receivedAt - msg.createdAtMs! : undefined,
          clockSkew: Number.isFinite(msg.createdAtMs) && msg.createdAtMs! > receivedAt,
        }));
        return trace;
      });
      let processedCount = 0;
      let skippedCount = 0;
      let interrupted = false;

      for (const [batchIndex, msg] of batch.messages.entries()) {
        if (this.stopped) { interrupted = true; break; }
        if (waitForReplies) this.healthTracker?.recordMessageStart(this.controller.authorizationBudgetMs +
          (this.replyEngine?.requestBudgetMs ?? this.controller.requestBudgetMs) + REPLY_TIMEOUT_MS + CHECKPOINT_MARGIN_MS);
        const outcome = await runWithTrace(traces[batchIndex], () => waitForReplies
          ? this.processMessage(msg, { batchId, batchIndex, receivedClock }) : this.admitMessage(msg));
        if (outcome === "processed") processedCount++; else skippedCount++;
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

  private renewalInterestedChats(): string[] {
    const pendingReplies = Object.values(this.stateManager.outbox).filter(item => {
      if (item.kind !== "reply" || item.status !== "pending" || this.hasQuarantinedInboundReply(item.deliveryKey)) return false;
      const text = this.stateManager.replyDeliveries[item.deliveryKey];
      return !text || text.acknowledgedChunks < text.totalChunks;
    });
    return [...new Set([...(this.notificationInterest?.interested ?? []),
      ...pendingReplies.map(item => item.chatId)])];
  }

  private async processMessage(msg: InboundWeChatMessage, batch?: { batchId: string; batchIndex: number; receivedClock: number }): Promise<string> {
    if (this.stateManager.isMessageProcessed(msg.deliveryKey)) return "skipped";
    let ready!: () => void;
    const starting = new Promise<void>(resolve => { ready = resolve; });
    this.queryStarts.set(msg.chatId, starting);
    this.activeInboundChats.add(msg.chatId);
    traceEvent("message.processing.start", batch ? { batchId: batch.batchId, batchIndex: batch.batchIndex,
      batchWaitMs: performance.now() - batch.receivedClock } : {});
    let outcome = "error";
    try {
      if (this.hasQuarantinedInboundReply(msg.deliveryKey)) {
        this.quarantineInboundReply(msg.deliveryKey);
        outcome = "skipped";
        return outcome;
      }
      await traceSpan("message.authorization", () => this.controller.assertChatAllowed(msg.chatId));
      const fresh = await traceSpan("message.context.persist", async () => this.stateManager.recordInboundContext(msg.deliveryKey, msg.chatId, msg.createdAtMs, Boolean(msg.contextToken?.trim()), msg.contextToken));
      const retryingAdmission = this.stateManager.contextBudgets[msg.chatId]?.lastInboundKey === msg.deliveryKey &&
        !this.stateManager.isMessageProcessed(msg.deliveryKey);
      if ((fresh || retryingAdmission) && msg.contextToken?.trim()) this.resultDispatcher?.noteInbound(msg.chatId, msg.deliveryKey);
      if ((fresh || retryingAdmission) && msg.contextToken?.trim()) {
        // Give deferred replies this chat's refreshed budget before new progress or results.
        try { await this.flushRepliesOnce(msg.chatId); }
        catch (error) { traceEvent("message.admission.flush.failed", { reason: sanitizeErrorType(error) }); }
      }
      if (this.stateManager.outbox[msg.deliveryKey]) {
        this.stateManager.recordProcessedMessageKey(msg.deliveryKey, { preserveReplyEvidence: true });
        outcome = "processed";
        return outcome;
      }
      try { this.stateManager.assertOutboxCapacity(msg.deliveryKey); }
      catch (error) {
        if (!(error instanceof OutboxBackpressureError)) throw error;
        // The new inbound may have restored the budget needed to drain a full queue.
        await this.flushRepliesOnce(undefined, msg.chatId);
        this.stateManager.assertOutboxCapacity(msg.deliveryKey);
      }
      this.ilink.sendTyping(msg.chatId);
      const request = { chatId: msg.chatId, messageId: msg.messageId, text: msg.text };
      const progress = this.progressSink(msg.chatId);
      const queryProgress = new QueryProgress(request, progress);
      let source: DeliveryOutboxItem["source"] = this.replyEngine ? "engine" : "controller";
      let controllerReply: ControllerMessageResponse;
      ready();
      try {
        controllerReply = this.replyEngine
          ? await traceSpan("message.leader", () => this.replyEngine!.reply(this.stateManager.account!.accountId, request, this.controller, { progress }))
          : await traceSpan("message.controller", () => this.controller.forwardMessage(request, {
            onProgress: text => queryProgress.report(text), progressRemaining: queryProgress.remaining }));
      } catch (error) {
        if (error instanceof ReplyEngineBackpressureError && this.replyEngine) {
          // This inbound may restore a window needed to release pinned replies.
          await this.flushRepliesOnce(undefined, msg.chatId);
          controllerReply = await this.replyEngine.reply(this.stateManager.account!.accountId, request, this.controller, { progress });
        } else {
          if (!(error instanceof ReplyEngineConflictError)) throw error;
          source = "codex-conflict";
          controllerReply = error.reply;
        }
      }
      await traceSpan("message.outbox.persist", async () => this.stateManager.putOutbox({ kind: "reply", source, chatId: msg.chatId, messageId: msg.messageId,
        deliveryKey: msg.deliveryKey, splitMaxChars: this.splitMaxChars, status: "pending" }));
      if (msg.deliveryKey) {
        this.stateManager.recordProcessedMessageKey(msg.deliveryKey, { preserveReplyEvidence: true });
      }
      await this.deliverReply(this.stateManager.outbox[msg.deliveryKey], controllerReply);
      outcome = "processed";
      this.healthTracker?.recordMessageProgress();
      return outcome;
    } catch (err) {
      if (err instanceof PermanentImageDownloadError) {
        this.stateManager.recordReplyFailure(`image-reply:${msg.deliveryKey}`, err.reason);
      }
      if (this.hasQuarantinedInboundReply(msg.deliveryKey)) {
        this.quarantineInboundReply(msg.deliveryKey);
        outcome = "skipped";
        return outcome;
      }
      if (err instanceof ChatNotAllowedError) {
        // Poison batch protection: unauthorized chat is rejected by Controller allowlist.
        // Mark message processed so the cursor advances and subsequent messages are not starved.
        if (msg.deliveryKey) {
          this.stateManager.recordProcessedMessageKey(msg.deliveryKey);
        }
        outcome = "skipped";
        this.healthTracker?.recordMessageProgress();
        return outcome;
      }
      throw err;
    } finally {
      ready();
      if (this.queryStarts.get(msg.chatId) === starting) this.queryStarts.delete(msg.chatId);
      traceEvent("message.processing.end", { outcome });
      this.activeInboundChats.delete(msg.chatId);
    }
  }

  private progressSink(chatId: string): ProgressSink {
    return async (text, id) => {
      if (this.stopped || !this.stateManager.isReadyForActivePolling()) return { sent: false, reason: "unavailable" };
      if (!text.trim() || text.length > MAX_PROGRESS_CHARS) return { sent: false, reason: "rejected" };
      if (this.stateManager.hasUncertainReply(id)) return { sent: false, reason: "previous_send_unknown" };
      try {
        await this.ilink.sendMarkdownReply(chatId, text, { deliveryKey: id, kind: "progress",
          maxCharsPerChunk: MAX_PROGRESS_CHARS, signal: this.notificationAbort.signal,
          shouldContinue: () => !this.stopped });
        return { sent: true };
      } catch (error) {
        if (error instanceof LocalSendDeferredError) return { sent: false, reason: error.reason };
        traceEvent("query.progress.failed");
        return { sent: false, reason: this.stateManager.hasUncertainReply(id) ? "send_unknown" : "delivery_failed" };
      }
    };
  }

  private async admitMessage(msg: InboundWeChatMessage): Promise<string> {
    if (this.stateManager.isMessageProcessed(msg.deliveryKey)) return "skipped";
    try { await this.controller.assertChatAllowed(msg.chatId); }
    catch (error) {
      if (!(error instanceof ChatNotAllowedError)) throw error;
      this.stateManager.recordProcessedMessageKey(msg.deliveryKey);
      return "skipped";
    }
    const retryingAdmission = this.stateManager.contextBudgets[msg.chatId]?.lastInboundKey === msg.deliveryKey &&
      !this.stateManager.isMessageProcessed(msg.deliveryKey);
    if (this.inbox.has(msg.deliveryKey)) {
      try { this.inbox.put(msg); }
      catch (error) {
        if (!(error instanceof InboxConflictError)) throw error;
        traceEvent("message.inbox.conflict");
      }
      if (retryingAdmission && msg.contextToken?.trim()) this.resultDispatcher?.noteInbound(msg.chatId, msg.deliveryKey);
      return "skipped";
    }
    const { createdAtMs, ...message } = msg;
    // Persist the full inbound message before refreshing the context budget. If
    // the process stops between these checkpoints, the durable inbox keeps the
    // message pending and prevents notification delivery from observing a
    // context that was never admitted.
    this.inbox.put({ ...message, ...(Number.isSafeInteger(createdAtMs) && createdAtMs! >= 0 ? { createdAtMs } : {}) });
    const fresh = this.stateManager.recordInboundContext(msg.deliveryKey, msg.chatId, msg.createdAtMs,
      Boolean(msg.contextToken?.trim()), msg.contextToken);
    // Create a result resume intent only after both admission checkpoints have
    // succeeded. Retrying the poll or inbound runner then observes the same
    // durable generation without releasing results early.
    if ((fresh || retryingAdmission) && msg.contextToken?.trim()) this.resultDispatcher?.noteInbound(msg.chatId, msg.deliveryKey);
    this.inboundRunner.schedule();
    return "processed";
  }

  private isReplyPending(chatId: string): boolean {
    return this.activeInboundChats.has(chatId) || this.inboundRunner.hasPending(chatId) || Object.values(this.stateManager.outbox).some(item =>
      item.kind === "reply" && item.chatId === chatId && item.status === "pending");
  }

  private async deliverReply(item: DeliveryOutboxItem, reply: ControllerMessageResponse): Promise<void> {
    if (this.stopped || item.status !== "pending" || this.activeReplyDeliveries.has(item.deliveryKey)) return;
    this.activeReplyDeliveries.add(item.deliveryKey);
    const deliveryTrace = createMessageTrace(item.chatId, item.messageId);
    const inherited = currentTrace();
    await runWithTrace(inherited?.traceId === deliveryTrace.traceId ? inherited : deliveryTrace, async () => {
      const deliveryStarted = performance.now();
      let receiptStatus = "error";
      traceEvent("delivery.start", { source: item.source });
      try {
        const deadline = Date.now() + REPLY_TIMEOUT_MS;
        if (reply.images?.length) {
          await this.ilink.sendImageReply(item.chatId, reply.images, { deliveryKey: `image-reply:${item.deliveryKey}`,
            timeoutMs: REPLY_TIMEOUT_MS, shouldContinue: () => !this.stopped,
            getImageBytes: (image, signal) => traceSpan("delivery.image.download", () => this.controller.downloadImage({ chatId: item.chatId, messageId: reply.imageSourceMessageId ?? item.messageId, image }, signal)) });
        }
        if (reply.text.length) {
          const timeoutMs = deadline - Date.now();
          if (timeoutMs <= 0) throw new Error("WeChat reply timed out before completion");
          await this.ilink.sendMarkdownReply(item.chatId, reply.text, { deliveryKey: item.deliveryKey,
            maxCharsPerChunk: item.splitMaxChars, timeoutMs,
            shouldContinue: () => !this.stopped });
        }
        if (item.source === "engine") this.stateManager.updateOutbox(item.deliveryKey, { status: "receipt", receiptStatus: "accepted" });
        await traceSpan("delivery.journal.ack", () => this.ackEngineReply(item, "accepted"));
        await traceSpan("delivery.outbox.remove", async () => this.stateManager.removeOutbox(item.deliveryKey));
        receiptStatus = "wechat_api_accepted";
      } catch (error) {
        if (error instanceof LocalSendDeferredError) { receiptStatus = "deferred"; return; }
        if (error instanceof PermanentImageDownloadError) {
          this.stateManager.recordReplyFailure(`image-reply:${item.deliveryKey}`, error.reason);
          receiptStatus = "expired";
          this.stateManager.updateOutbox(item.deliveryKey, { status: "expired" });
          await this.ackEngineReply(item, "expired");
          return;
        }
        if (this.hasQuarantinedInboundReply(item.deliveryKey)) {
          receiptStatus = "uncertain";
          this.stateManager.updateOutbox(item.deliveryKey, { status: "uncertain" });
          await this.ackEngineReply(item, "uncertain");
          return;
        }
        throw error;
      } finally {
        traceEvent("delivery.end", { receiptStatus, durationMs: performance.now() - deliveryStarted });
        this.activeReplyDeliveries.delete(item.deliveryKey);
      }
    });
  }

  /** Recovery reads immutable responses only; an old command is never POSTed again. */
  public async flushRepliesOnce(chatId?: string, callerChatId = chatId): Promise<void> {
    // A concurrent recovery pass must not bypass a newly refreshed chat's turn.
    while (this.replyFlushCompletion) await this.replyFlushCompletion;
    if (this.stopped) return;
    let complete!: () => void;
    this.replyFlushCompletion = new Promise<void>(resolve => { complete = resolve; });
    let firstError: unknown;
    const canRecover = (item: DeliveryOutboxItem) => (chatId === undefined || item.chatId === chatId) &&
      (item.chatId === callerChatId || !this.activeInboundChats.has(item.chatId));
    try {
      // Retry terminal journal acknowledgements after a prior journal save failure.
      for (const item of Object.values(this.stateManager.outbox)) {
        if (!canRecover(item)) continue;
        if (this.activeReplyDeliveries.has(item.deliveryKey)) continue;
        if (item.kind === "reply" && item.source === "engine" && item.status === "receipt" && item.receiptStatus === "accepted") {
          try {
            await this.withRecoveryTrace(item, async () => {
              await traceSpan("delivery.recovery.ack", () => this.ackEngineReply(item, "accepted"));
              await traceSpan("delivery.recovery.outbox.remove", async () => this.stateManager.removeOutbox(item.deliveryKey));
            });
          } catch (error) { firstError ??= error; }
        } else if (item.kind === "reply" && item.source === "engine" && (item.status === "uncertain" || item.status === "expired")) {
          const status = item.status;
          try {
            await this.withRecoveryTrace(item, () => traceSpan("delivery.recovery.ack", () => this.ackEngineReply(item, status)));
          }
          catch (error) { firstError ??= error; }
        }
      }
      const items = Object.values(this.stateManager.outbox).filter(item => item.kind === "reply" && item.status === "pending" &&
        canRecover(item) &&
        !this.activeReplyDeliveries.has(item.deliveryKey));
      const offset = this.replyOutboxCursor % Math.max(1, items.length);
      for (const item of [...items.slice(offset), ...items.slice(0, offset)]) {
        if (!canRecover(item) || this.activeReplyDeliveries.has(item.deliveryKey)) continue;
        if (this.hasQuarantinedInboundReply(item.deliveryKey)) {
          await this.withRecoveryTrace(item, async () => {
            this.stateManager.updateOutbox(item.deliveryKey, { status: "uncertain" });
            await traceSpan("delivery.recovery.ack", () => this.ackEngineReply(item, "uncertain"));
          });
          continue;
        }
        const text = this.stateManager.replyDeliveries[item.deliveryKey];
        if (text && text.acknowledgedChunks === text.totalChunks && !text.inFlight) {
          await this.withRecoveryTrace(item, async () => {
            await traceSpan("delivery.recovery.ack", () => this.ackEngineReply(item, "accepted"));
            await traceSpan("delivery.recovery.outbox.remove", async () => this.stateManager.removeOutbox(item.deliveryKey));
          });
          continue;
        }
        if (!this.stateManager.canSendToChat(item.chatId)) continue;
        this.replyOutboxCursor = (items.indexOf(item) + 1) % items.length;
        await this.withRecoveryTrace(item, async () => {
          try {
            await traceSpan("delivery.recovery.attempt", async () => {
              const reply = await traceSpan("delivery.recovery.read", () => this.getFrozenReply(item));
              await this.deliverReply(item, reply);
            });
          } catch (error) {
            if (error instanceof PermanentReplyUnavailableError) {
              this.stateManager.updateOutbox(item.deliveryKey, {
                status: this.hasQuarantinedInboundReply(item.deliveryKey) ? "uncertain" : "expired",
              });
              await traceSpan("delivery.recovery.ack", () => this.ackEngineReply(item,
                this.hasQuarantinedInboundReply(item.deliveryKey) ? "uncertain" : "expired"));
              return;
            }
            firstError ??= error;
          }
        });
        // One resumed reply per turn keeps getupdates and independent chats moving.
        break;
      }
    } finally {
      this.replyFlushCompletion = undefined;
      complete();
    }
    if (firstError) throw firstError;
  }

  private withRecoveryTrace<T>(item: DeliveryOutboxItem, action: () => Promise<T>): Promise<T> {
    // Outbox recovery is its own attempt even when admission of a new message
    // triggers it. Its reads, sends and receipts must never inherit that message.
    return runWithTrace(createMessageTrace(item.chatId, item.messageId), () =>
      traceSpan("delivery.recovery", action, { recovery: true, source: item.source, status: item.status }));
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

    this.onInboundError = onError;
    this.inboundRunner.schedule();
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
    const notificationTask = (async () => {
      while (!this.stopped) {
        await deliver();
        if (!this.stopped) await waitForNotificationPoll(pollIntervalMs, this.notificationAbort.signal);
      }
    })();
    try {
      while (!this.stopped) {
        try { await this.pollOnce(false); this.inboundRunner.schedule(); }
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
      await this.inboundRunner.stop();
    }
    if (notificationFailure) throw notificationFailure;
    if (this.inboundError) throw this.inboundError;
  }
}
