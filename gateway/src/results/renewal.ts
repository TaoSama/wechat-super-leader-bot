import { createHash } from "node:crypto";
import type { ReplyDeliveryState } from "../types.js";

const RENEWAL_LEAD_MS = 60 * 60 * 1000;
const RESERVED_RESULT_MESSAGES = 3;
const RENEWAL_TEXT = "还有任务更新待接收。发一条消息，可以继续接收后续更新。";

export interface RenewalState {
  contextBudgets: Record<string, { refreshedAt: number }>;
  contextTokens: Record<string, string>;
  policy: { contextWindowMs: number };
  replyDeliveries: Record<string, ReplyDeliveryState>;
  getLoginFingerprint(): string;
  canSendToChat(chatId: string, kind: "final"): boolean;
  /** Must include the current policy and reservations; the persisted raw counter is insufficient. */
  remainingSendBudget(chatId: string): number;
}
export interface RenewalOptions {
  state: RenewalState;
  send: (chatId: string, text: string, options: {
    deliveryKey: string; kind: "final"; shouldContinue: () => boolean; signal?: AbortSignal;
  }) => Promise<number>;
  isReplyPending: (chatId: string) => boolean;
  now?: () => number;
  active?: () => boolean;
  signal?: AbortSignal;
}

export function renewalDeliveryKey(account: string, chatId: string, refreshedAt: number): string {
  return `renewal:${createHash("sha256").update(JSON.stringify([account, chatId, refreshedAt])).digest("hex")}`;
}

/** The caller supplies only chats with an active task, future schedule or pending result. */
export class RenewalNotifier {
  private delivering = false;
  constructor(private readonly options: RenewalOptions) {}
  private active(): boolean { return !this.options.signal?.aborted && (this.options.active?.() ?? true); }
  private eligible(chatId: string): boolean {
    const { state } = this.options;
    const windowMs = state.policy.contextWindowMs, refreshedAt = state.contextBudgets[chatId]?.refreshedAt;
    const now = (this.options.now ?? Date.now)();
    if (!this.active() || !Number.isSafeInteger(windowMs) || windowMs <= RENEWAL_LEAD_MS ||
        typeof refreshedAt !== "number" || !Number.isSafeInteger(refreshedAt) || refreshedAt < 0 || !Number.isFinite(now) ||
        now - refreshedAt < windowMs - RENEWAL_LEAD_MS || now - refreshedAt >= windowMs ||
        this.options.isReplyPending(chatId) || !state.canSendToChat(chatId, "final")) return false;
    const remaining = state.remainingSendBudget(chatId);
    return Number.isSafeInteger(remaining) && remaining > RESERVED_RESULT_MESSAGES;
  }

  async deliverOnce(interestedChats: readonly string[]): Promise<{ sent: number; skipped: number }> {
    const outcome = { sent: 0, skipped: 0 };
    if (this.delivering || !this.active()) return outcome;
    if (interestedChats.some(chat => typeof chat !== "string" || !chat.trim())) throw new Error("Invalid renewal chats");
    this.delivering = true;
    const errors: unknown[] = [];
    try {
      for (const chatId of new Set(interestedChats)) {
        if (!this.active()) break;
        try {
          const { state } = this.options;
          const account = state.getLoginFingerprint(), token = state.contextTokens[chatId];
          if (!account || !token || !this.eligible(chatId)) { outcome.skipped++; continue; }
          const refreshedAt = state.contextBudgets[chatId].refreshedAt;
          const windowMs = state.policy.contextWindowMs;
          const deliveryKey = renewalDeliveryKey(account, chatId, refreshedAt);
          const previous = state.replyDeliveries[deliveryKey];
          if (previous && (previous.acknowledgedChunks > 0 || previous.inFlight || previous.failureReason)) {
            outcome.skipped++; continue;
          }
          // Checked again by the shared send path after queueing and immediately before submission.
          const shouldContinue = () => account === state.getLoginFingerprint() &&
            token === state.contextTokens[chatId] && refreshedAt === state.contextBudgets[chatId]?.refreshedAt &&
            windowMs === state.policy.contextWindowMs && this.eligible(chatId);
          if (!shouldContinue()) { outcome.skipped++; continue; }
          const sent = await this.options.send(chatId, RENEWAL_TEXT, {
            deliveryKey, kind: "final", shouldContinue,
            ...(this.options.signal ? { signal: this.options.signal } : {}),
          });
          if (sent > 0) outcome.sent++; else outcome.skipped++;
        } catch (error) { errors.push(error); }
      }
      if (errors.length) throw errors[0];
      return outcome;
    } finally { this.delivering = false; }
  }
}
