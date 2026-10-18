import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { ControllerClient } from "../controller/client.js";
import { NOTIFICATION_CHAT_LIMIT, NOTIFICATION_LIMIT, NOTIFICATION_RECEIPT_RETRIES, NOTIFICATION_TIMEOUT_MS,
  parseNotification, sameNotification, type Notification, type NotificationDeliverySummary } from "../controller/notification-contract.js";
import type { DeliveryOutboxItem } from "../types.js";
import type { ILinkClient } from "../wechat/client.js";
import { NOTIFICATION_REPLY_TIMEOUT_MS } from "./budgets.js";
import { getDeferReason, LocalSendDeferredError, type DeferReason, type SendKind } from "./context-policy.js";
import { sanitizeErrorType } from "./health.js";
import type { StateManager } from "./state.js";

const RECEIPT_BUDGET_MS = NOTIFICATION_TIMEOUT_MS * (NOTIFICATION_RECEIPT_RETRIES + 1);
const STDERR_FD = 2;
const LOCAL_REPLY_TIMEOUT_MESSAGE = "WeChat reply timed out";
const TERMINAL_LOCAL_STATUSES = new Set(["uncertain", "expired"]);
type NotificationController = Pick<ControllerClient, "listNotifications" | "getNotification" | "claimNotification" |
  "deferNotification" | "recordNotificationReceipt">;

export class NotificationDiagnosticError extends Error {
  constructor() { super("Notification diagnostic write failed"); }
}

export function reportNotificationSendFailure(notificationId: string, attemptId: string, errorType: string): void {
  try {
    const line = JSON.stringify({ event: "notification_send_failed", notificationId, attemptId, errorType }) + "\n";
    if (fs.writeSync(STDERR_FD, line) !== Buffer.byteLength(line)) throw new NotificationDiagnosticError();
  } catch {
    // The permanent receipt is already saved; diagnostics cannot reopen delivery.
    throw new NotificationDiagnosticError();
  }
}

/** References and transition intents survive crashes; message bodies stay in Controller. */
export class NotificationOutbox {
  private delivering = false;
  private chatCursor = 0;
  private sentThisCycle = false;

  constructor(private readonly options: {
    stateManager: StateManager;
    ilink: Pick<ILinkClient, "sendMarkdownReply">;
    controller: NotificationController;
    splitMaxChars: number;
    splitMultiPart?: boolean;
    signal: AbortSignal;
    shouldContinue: () => boolean;
  }) {}

  private get state(): StateManager { return this.options.stateManager; }
  private active(): boolean {
    return !this.options.signal.aborted && this.options.shouldContinue() &&
      this.state.isReadyForActivePolling() && Boolean(this.state.account?.token);
  }
  private references(chatId: string): DeliveryOutboxItem[] {
    return Object.values(this.state.outbox).filter(ref => ref.kind === "notification" && ref.chatId === chatId &&
      !TERMINAL_LOCAL_STATUSES.has(ref.status)).sort((a, b) => Number(a.notificationKind === "progress") - Number(b.notificationKind === "progress"));
  }
  private hasPendingReply(chatId: string): boolean {
    return Object.values(this.state.outbox).some(ref => ref.kind === "reply" && ref.chatId === chatId &&
      !TERMINAL_LOCAL_STATUSES.has(ref.status));
  }
  private kind(item: Notification): SendKind { return item.kind === "progress" ? "progress" : "final"; }
  private deferReason(chatId: string, kind: SendKind): DeferReason {
    return getDeferReason(this.state.contextBudgets[chatId], this.state.policy, kind) ?? "context_changed";
  }
  private hasCompleteReply(deliveryKey: string): boolean {
    const evidence = this.state.replyDeliveries[deliveryKey];
    return Boolean(evidence && !evidence.inFlight && evidence.acknowledgedChunks === evidence.totalChunks);
  }
  private verifyReference(ref: DeliveryOutboxItem, item: Notification): void {
    if (ref.messageId !== item.id || ref.chatId !== item.chatId ||
        ref.notificationKind !== undefined && ref.notificationKind !== item.kind ||
        ref.expiresAt !== undefined && ref.expiresAt !== item.expiresAt) {
      throw new Error("Controller notification recovery identity mismatch");
    }
  }
  private terminal(ref: DeliveryOutboxItem, item: Notification): boolean {
    if (item.status === "accepted") { this.state.removeOutbox(ref.deliveryKey); return true; }
    if (item.status === "uncertain" || item.status === "expired" || item.expiresAt <= Date.now()) {
      this.state.updateOutbox(ref.deliveryKey, { status: item.status === "uncertain" ? "uncertain" : "expired" });
      return true;
    }
    return false;
  }

  public async deliverOnce(): Promise<NotificationDeliverySummary> {
    const summary: NotificationDeliverySummary = { accepted: 0, uncertain: 0, skipped: 0 };
    if (this.delivering || !this.active()) return summary;
    const chatIds = [...new Set([...Object.keys(this.state.contextTokens), ...Object.values(this.state.outbox)
      .filter(ref => ref.kind === "notification" && !TERMINAL_LOCAL_STATUSES.has(ref.status)).map(ref => ref.chatId)])]
      .filter(chatId => chatId.trim()).sort();
    if (!chatIds.length) return summary;
    this.delivering = true;
    this.sentThisCycle = false;
    let firstError: unknown;
    try {
      const offset = this.chatCursor % chatIds.length;
      const batch = [...chatIds.slice(offset), ...chatIds.slice(0, offset)].slice(0, NOTIFICATION_CHAT_LIMIT);
      for (const chatId of batch) {
        this.chatCursor = (chatIds.indexOf(chatId) + 1) % chatIds.length;
        if (!this.active()) break;
        try {
          const fingerprint = this.state.getLoginFingerprint();
          const refs = this.references(chatId);
          for (const ref of refs) {
            try {
              if (ref.status === "pending" && !this.hasCompleteReply(ref.deliveryKey)) {
                if (ref.expiresAt !== undefined && ref.expiresAt <= Date.now()) {
                  this.state.updateOutbox(ref.deliveryKey, { status: "expired" });
                  continue;
                }
                if (!this.state.canSendToChat(chatId, ref.notificationKind === "progress" ? "progress" : "final")) continue;
              }
              const item = parseNotification(await this.options.controller.getNotification(ref.messageId));
              this.verifyReference(ref, item);
              if (await this.deliver(ref, item, summary, fingerprint)) {
                if (firstError !== undefined) throw firstError;
                return summary;
              }
            } catch (error) {
              if (error instanceof NotificationDiagnosticError || this.sentThisCycle) throw error;
              // A stale progress reference cannot hide a terminal notification in the same chat.
              firstError ??= error;
            }
          }
          if (this.active() && this.state.contextTokens[chatId]?.trim() && this.state.canSendToChat(chatId)) {
            // LIMIT=1 requires a separate lookup per chat to avoid an exhausted chat occupying the queue head.
            const items = await this.options.controller.listNotifications([chatId]);
            if (!Array.isArray(items) || items.length > NOTIFICATION_LIMIT) throw new Error("Controller notification response schema invalid");
            for (const raw of items) {
              const item = parseNotification(raw);
              if (item.chatId !== chatId) throw new Error("Controller notification identity mismatch");
              if (!this.active() || item.status !== "pending" || item.expiresAt <= Date.now() || !this.state.contextTokens[chatId]?.trim() ||
                  fingerprint !== this.state.getLoginFingerprint()) {
                summary.skipped++; continue;
              }
              const deliveryKey = `notification:${item.id}`;
              if (this.state.outbox[deliveryKey]) continue;
              this.state.putOutbox({ kind: "notification", deliveryKey, chatId, messageId: item.id,
                splitMaxChars: this.options.splitMaxChars, splitMultiPart: this.options.splitMultiPart ?? true,
                expiresAt: item.expiresAt, notificationKind: item.kind, status: "pending" });
              if (await this.deliver(this.state.outbox[deliveryKey], item, summary, fingerprint)) {
                if (firstError !== undefined) throw firstError;
                return summary;
              }
            }
          }
        } catch (error) {
          if (error instanceof NotificationDiagnosticError) throw error;
          // Keep each failed reference intact and give independent chats a turn before surfacing the failure.
          firstError ??= error;
        }
        if (this.sentThisCycle) break;
      }
      if (firstError !== undefined) throw firstError;
      return summary;
    } finally { this.delivering = false; }
  }

  private async defer(ref: DeliveryOutboxItem, reason: DeferReason): Promise<void> {
    if (!ref.attemptId) throw new Error("Missing notification defer attempt");
    this.state.updateOutbox(ref.deliveryKey, { status: "defer", deferReason: reason });
    const pending = parseNotification(await this.options.controller.deferNotification(ref.messageId, ref.attemptId, reason));
    this.verifyReference(ref, pending);
    if (this.terminal(ref, pending)) return;
    if (pending.status !== "pending" || pending.lastDeferredAttemptId !== ref.attemptId || pending.lastDeferReason !== reason) {
      throw new Error("Controller notification defer identity mismatch");
    }
    this.state.updateOutbox(ref.deliveryKey, { status: "pending", attemptId: undefined, deferReason: undefined });
  }

  private async receipt(ref: DeliveryOutboxItem, summary: NotificationDeliverySummary): Promise<void> {
    if (!ref.attemptId || !ref.receiptStatus) throw new Error("Missing notification receipt intent");
    const item = parseNotification(await this.options.controller.recordNotificationReceipt(ref.messageId, ref.attemptId, ref.receiptStatus));
    this.verifyReference(ref, item);
    if (item.attemptId !== ref.attemptId || item.status !== ref.receiptStatus) throw new Error("Controller notification receipt identity mismatch");
    if (item.status === "accepted") this.state.removeOutbox(ref.deliveryKey);
    else this.state.updateOutbox(ref.deliveryKey, { status: "uncertain" });
    summary[ref.receiptStatus]++;
  }

  /** Returns true once one notification has consumed this cycle's delivery opportunity. */
  private async deliver(ref: DeliveryOutboxItem, item: Notification, summary: NotificationDeliverySummary,
    fingerprint: string): Promise<boolean> {
    if (item.status === "accepted") { this.state.removeOutbox(ref.deliveryKey); return false; }
    if (ref.status === "receipt") {
      if (item.attemptId !== ref.attemptId) throw new Error("Controller notification receipt recovery identity mismatch");
      await this.receipt(ref, summary);
      return true;
    }
    if ((ref.status === "claimed" || ref.status === "claiming") && item.attemptId === ref.attemptId &&
        this.hasCompleteReply(ref.deliveryKey)) {
      // Every chunk has a durable successful receipt, even if the receipt-intent write was interrupted.
      this.state.updateOutbox(ref.deliveryKey, { status: "receipt", receiptStatus: "accepted" });
      await this.receipt(this.state.outbox[ref.deliveryKey], summary);
      return true;
    }
    if (this.terminal(ref, item)) return false;
    if (ref.status === "defer") {
      if (!ref.attemptId || !ref.deferReason) throw new Error("Missing notification defer intent");
      if (item.status === "pending" && item.lastDeferredAttemptId === ref.attemptId && item.lastDeferReason === ref.deferReason) {
        this.state.updateOutbox(ref.deliveryKey, { status: "pending", attemptId: undefined, deferReason: undefined });
        return false;
      }
      if (item.status !== "claimed" || item.attemptId !== ref.attemptId) throw new Error("Controller notification defer recovery identity mismatch");
      await this.defer(ref, ref.deferReason);
      return false;
    }
    const kind = this.kind(item);
    const context = this.state.contextTokens[item.chatId];
    if (kind === "progress" && this.hasPendingReply(item.chatId) && item.status === "pending") {
      summary.skipped++; return false;
    }
    if (item.status === "pending") {
      if (!this.active() || !this.state.contextTokens[item.chatId]?.trim() || !this.state.canSendToChat(item.chatId, kind)) {
        summary.skipped++; return false;
      }
      const attemptId = ref.attemptId ?? randomUUID();
      this.state.updateOutbox(ref.deliveryKey, { status: "claiming", attemptId });
      let claimed: Notification;
      try { claimed = parseNotification(await this.options.controller.claimNotification(item.id, attemptId)); }
      catch (error) {
        if (error instanceof Error && /notification (?:claim )?(?:identity mismatch|response schema invalid)/.test(error.message)) {
          this.state.updateOutbox(ref.deliveryKey, { status: "uncertain" });
        }
        throw error;
      }
      if (!sameNotification(item, claimed) || claimed.status !== "claimed" || claimed.attemptId !== attemptId) {
        this.state.updateOutbox(ref.deliveryKey, { status: "uncertain" });
        throw new Error("Controller notification claim identity mismatch");
      }
      item = claimed;
      this.state.updateOutbox(ref.deliveryKey, { status: "claimed" });
      ref = this.state.outbox[ref.deliveryKey];
    }
    if (item.status !== "claimed" || item.attemptId !== ref.attemptId) {
      this.state.updateOutbox(ref.deliveryKey, { status: "uncertain" });
      summary.skipped++;
      return false;
    }
    if (item.expiresAt <= Date.now() || item.attemptExpiresAt! <= Date.now()) {
      this.state.updateOutbox(ref.deliveryKey, { status: "expired" });
      summary.skipped++;
      return false;
    }
    if (this.state.hasUncertainReply(ref.deliveryKey)) {
      this.state.updateOutbox(ref.deliveryKey, { status: "receipt", receiptStatus: "uncertain" });
      await this.receipt(this.state.outbox[ref.deliveryKey], summary);
      return true;
    }
    if (kind === "progress" && this.hasPendingReply(item.chatId)) {
      await this.defer(ref, "budget_exhausted");
      summary.skipped++;
      return false;
    }
    if (context !== this.state.contextTokens[item.chatId] || fingerprint !== this.state.getLoginFingerprint()) {
      await this.defer(ref, "context_changed");
      summary.skipped++;
      return false;
    }
    if (!this.state.contextTokens[item.chatId]?.trim() || !this.state.canSendToChat(item.chatId, kind)) {
      await this.defer(ref, this.deferReason(item.chatId, kind));
      summary.skipped++;
      return false;
    }
    const timeoutMs = Math.min(NOTIFICATION_REPLY_TIMEOUT_MS, item.attemptExpiresAt! - Date.now() - RECEIPT_BUDGET_MS);
    if (timeoutMs <= 0 || !this.active()) {
      await this.defer(ref, timeoutMs <= 0 ? "window_expired" : "context_changed");
      summary.skipped++;
      return false;
    }
    let receiptStatus: "accepted" | "uncertain" = "accepted", sendErrorType: string | undefined;
    try {
      this.sentThisCycle = true;
      await this.options.ilink.sendMarkdownReply(item.chatId, item.text, {
        deliveryKey: ref.deliveryKey, maxCharsPerChunk: ref.splitMaxChars, splitMultiPart: ref.splitMultiPart, kind,
        timeoutMs, signal: this.options.signal,
        shouldContinue: () => {
          if (item.attemptExpiresAt! <= Date.now() || item.expiresAt <= Date.now()) throw new LocalSendDeferredError("window_expired");
          if (!this.active() || context !== this.state.contextTokens[item.chatId] || fingerprint !== this.state.getLoginFingerprint()) {
            throw new LocalSendDeferredError("context_changed");
          }
          if (kind === "progress" && this.hasPendingReply(item.chatId)) throw new LocalSendDeferredError("budget_exhausted");
          return true;
        },
      });
    } catch (error) {
      if (item.expiresAt <= Date.now() || item.attemptExpiresAt! <= Date.now()) {
        this.state.updateOutbox(ref.deliveryKey, { status: "expired" });
        summary.skipped++;
        return true;
      }
      const localTimeout = error instanceof Error && error.message === LOCAL_REPLY_TIMEOUT_MESSAGE;
      if ((error instanceof LocalSendDeferredError || this.options.signal.aborted || localTimeout) && !this.state.hasUncertainReply(ref.deliveryKey)) {
        await this.defer(ref, error instanceof LocalSendDeferredError ? error.reason : localTimeout ? "window_expired" : "context_changed");
        summary.skipped++;
        return true;
      }
      receiptStatus = "uncertain";
      sendErrorType = sanitizeErrorType(error);
    }
    if ((item.expiresAt <= Date.now() || item.attemptExpiresAt! <= Date.now()) &&
        !this.hasCompleteReply(ref.deliveryKey)) {
      this.state.updateOutbox(ref.deliveryKey, { status: "expired" });
      summary.skipped++;
      return true;
    }
    this.state.updateOutbox(ref.deliveryKey, { status: "receipt", receiptStatus });
    await this.receipt(this.state.outbox[ref.deliveryKey], summary);
    if (sendErrorType !== undefined) reportNotificationSendFailure(item.id, ref.attemptId!, sendErrorType);
    return true;
  }
}
