import type { DeliveryOutboxItem, DeliveryOutboxSource, GatewaySyncState } from "../types.js";
import { consumeSend, effectiveRemaining, getDeferReason, LocalSendDeferredError, validateContextPolicy, type ContextPolicy, type SendKind } from "./context-policy.js";
import { restoreAccountContext, type AccountSendBudget, type ChatContextWindow } from "./account-context.js";

const MAX_SAME_TIMESTAMP_KEYS = 256;
export const MAX_INBOUND_CLOCK_SKEW_MS = 30_000;
const OUTBOX_STATUSES = new Set(["pending", "claiming", "claimed", "defer", "receipt", "uncertain", "expired"]);
const OUTBOX_SOURCES = new Set<DeliveryOutboxSource>(["controller", "engine", "codex-conflict"]);
const NOTIFICATION_IDENTITY = /^[0-9a-f]{64}$/;

function outboxSource(source: unknown): DeliveryOutboxSource {
  if (source === undefined) return "controller";
  if (typeof source !== "string" || !OUTBOX_SOURCES.has(source as DeliveryOutboxSource)) {
    throw new Error("Invalid delivery outbox source");
  }
  return source as DeliveryOutboxSource;
}

function validateEngineAcknowledgement(item: DeliveryOutboxItem): void {
  if (item.engineAcked !== undefined && typeof item.engineAcked !== "boolean" ||
      item.engineAcked === true && outboxSource(item.source) !== "engine") {
    throw new Error("Invalid delivery outbox engine acknowledgement");
  }
}

export class OutboxBackpressureError extends Error {
  constructor() { super("Gateway durable outbox capacity exhausted; inbound cursor retained"); this.name = "OutboxBackpressureError"; }
}

/** Small references only: full replies remain in the originating reply store. */
export abstract class DeliveryState {
  public readonly policy: ContextPolicy;
  public contextWindows: Record<string, ChatContextWindow> = {};
  public accountSendBudget: AccountSendBudget | undefined;
  public contextTokens: Record<string, string> = {};
  public inboundWatermarks: Record<string, { createdAtMs: number; keys: string[] }> = {};
  public outbox: Record<string, DeliveryOutboxItem> = {};
  public abstract saveState(): void;

  constructor(policy: Partial<ContextPolicy> = {}) { this.policy = validateContextPolicy(policy); }

  protected restoreDeliveryState(state: GatewaySyncState): void {
    const context = restoreAccountContext(state, this.policy);
    const watermarks = state.inbound_watermarks ?? {};
    if (!watermarks || typeof watermarks !== "object" || Array.isArray(watermarks)) throw new Error("Invalid inbound watermarks");
    for (const item of Object.values(watermarks)) {
      if (!item || !Number.isSafeInteger(item.createdAtMs) || item.createdAtMs < 0 || !Array.isArray(item.keys) ||
          item.keys.length > MAX_SAME_TIMESTAMP_KEYS || item.keys.some(key => typeof key !== "string" || !key)) {
        throw new Error("Invalid inbound watermark");
      }
    }
    const outbox = state.delivery_outbox ?? {};
    if (!outbox || typeof outbox !== "object" || Array.isArray(outbox)) throw new Error("Invalid delivery outbox");
    for (const [key, item] of Object.entries(outbox)) {
      if (!item || item.deliveryKey !== key || !["reply", "notification"].includes(item.kind) ||
          typeof item.chatId !== "string" || !item.chatId || typeof item.messageId !== "string" || !item.messageId ||
          !Number.isSafeInteger(item.splitMaxChars) || item.splitMaxChars <= 0 ||
          !OUTBOX_STATUSES.has(item.status) || item.notificationIdentity !== undefined &&
          (item.kind !== "notification" || typeof item.notificationIdentity !== "string" || !NOTIFICATION_IDENTITY.test(item.notificationIdentity))) {
        throw new Error("Invalid delivery outbox reference");
      }
      // Older state files contain a retired switch that never affected the chunk plan.
      delete (item as DeliveryOutboxItem & { splitMultiPart?: unknown }).splitMultiPart;
      item.source = outboxSource(item.source);
      validateEngineAcknowledgement(item);
    }
    this.contextWindows = context.windows;
    this.accountSendBudget = context.budget;
    this.inboundWatermarks = watermarks;
    this.outbox = outbox;
  }

  public recordInboundContext(deliveryKey: string, chatId: string, createdAtMs?: number, grantBudget = true, contextToken?: string): boolean {
    const now = Date.now(), watermark = this.inboundWatermarks[chatId];
    if (!deliveryKey || !chatId || createdAtMs === undefined || !Number.isSafeInteger(createdAtMs) ||
        createdAtMs < 0 || createdAtMs - now > MAX_INBOUND_CLOCK_SKEW_MS || watermark && (createdAtMs < watermark.createdAtMs ||
          createdAtMs === watermark.createdAtMs && (watermark.keys.includes(deliveryKey) || watermark.keys.length >= MAX_SAME_TIMESTAMP_KEYS))) return false;
    const previous = this.contextWindows[chatId], previousToken = this.contextTokens[chatId];
    const previousBudget = this.accountSendBudget;
    this.inboundWatermarks[chatId] = { createdAtMs, keys: watermark?.createdAtMs === createdAtMs ? [...watermark.keys, deliveryKey] : [deliveryKey] };
    if (grantBudget) {
      const refreshedAt = Math.min(createdAtMs, now);
      this.contextWindows[chatId] = { refreshedAt, lastInboundKey: deliveryKey };
      if (!previousBudget || createdAtMs >= previousBudget.inboundCreatedAt) {
        this.accountSendBudget = { refreshedAt, inboundCreatedAt: createdAtMs, remaining: this.policy.sendBudget,
          grantedBudget: this.policy.sendBudget, progressSent: 0, lastInboundKey: deliveryKey };
      }
    }
    if (contextToken) this.contextTokens[chatId] = contextToken;
    try { this.saveState(); }
    catch (error) {
      if (previous) this.contextWindows[chatId] = previous; else delete this.contextWindows[chatId];
      this.accountSendBudget = previousBudget;
      if (watermark) this.inboundWatermarks[chatId] = watermark; else delete this.inboundWatermarks[chatId];
      if (previousToken !== undefined) this.contextTokens[chatId] = previousToken; else delete this.contextTokens[chatId];
      throw error;
    }
    return true;
  }

  public canSendToChat(chatId: string, kind: SendKind = "final"): boolean {
    return this.sendDeferReason(chatId, kind) === undefined;
  }

  public sendDeferReason(chatId: string, kind: SendKind = "final") {
    const window = this.contextWindows[chatId], budget = this.accountSendBudget;
    if (!window || !budget) return "window_expired" as const;
    return getDeferReason({ ...budget, refreshedAt: window.refreshedAt }, this.policy, kind) ??
      getDeferReason(budget, this.policy, kind);
  }

  public remainingSendBudget(chatId: string): number {
    return this.accountSendBudget && this.canSendToChat(chatId) ? effectiveRemaining(this.accountSendBudget, this.policy) : 0;
  }

  public consumeSendBudget(chatId: string, kind: SendKind = "final"): void {
    const reason = this.sendDeferReason(chatId, kind);
    if (reason) throw new LocalSendDeferredError(reason);
    const previous = this.accountSendBudget!;
    this.accountSendBudget = { ...previous, ...consumeSend(previous, this.policy, kind) };
    try { this.saveState(); }
    catch (error) { this.accountSendBudget = previous; throw error; }
  }

  public assertOutboxCapacity(deliveryKey?: string): void {
    if ((!deliveryKey || !this.outbox[deliveryKey]) && Object.keys(this.outbox).length >= this.policy.outboxLimit) {
      throw new OutboxBackpressureError();
    }
  }

  public putOutbox(item: DeliveryOutboxItem): void {
    const source = outboxSource(item.source);
    if (item.notificationIdentity !== undefined &&
        (item.kind !== "notification" || !NOTIFICATION_IDENTITY.test(item.notificationIdentity))) {
      throw new Error("Invalid notification outbox identity");
    }
    validateEngineAcknowledgement(item);
    const previous = this.outbox[item.deliveryKey];
    if (previous) {
      if (previous.chatId !== item.chatId || previous.messageId !== item.messageId || previous.kind !== item.kind ||
          outboxSource(previous.source) !== source) {
        throw new Error("Outbox reference identity changed");
      }
      return;
    }
    this.assertOutboxCapacity(item.deliveryKey);
    this.outbox[item.deliveryKey] = { ...item, source };
    try { this.saveState(); } catch (error) { delete this.outbox[item.deliveryKey]; throw error; }
  }

  public updateOutbox(deliveryKey: string, patch: Partial<DeliveryOutboxItem>): void {
    const previous = this.outbox[deliveryKey];
    if (!previous) throw new Error("Missing durable outbox reference");
    if (patch.deliveryKey !== undefined && patch.deliveryKey !== deliveryKey ||
        patch.chatId !== undefined && patch.chatId !== previous.chatId ||
        patch.messageId !== undefined && patch.messageId !== previous.messageId ||
        patch.kind !== undefined && patch.kind !== previous.kind ||
        Object.hasOwn(patch, "source") && outboxSource(patch.source) !== outboxSource(previous.source)) {
      throw new Error("Outbox reference identity changed");
    }
    const updated = { ...previous, ...patch, source: outboxSource(previous.source) };
    if (updated.notificationIdentity !== undefined &&
        (updated.kind !== "notification" || !NOTIFICATION_IDENTITY.test(updated.notificationIdentity))) {
      throw new Error("Invalid notification outbox identity");
    }
    validateEngineAcknowledgement(updated);
    this.outbox[deliveryKey] = updated;
    try { this.saveState(); } catch (error) { this.outbox[deliveryKey] = previous; throw error; }
  }

  public removeOutbox(deliveryKey: string): void {
    const previous = this.outbox[deliveryKey];
    if (!previous) return;
    delete this.outbox[deliveryKey];
    try { this.saveState(); } catch (error) { this.outbox[deliveryKey] = previous; throw error; }
  }
}
