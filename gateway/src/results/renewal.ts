import { createHash } from "node:crypto";
import type { ReplyDeliveryState } from "../types.js";

const RENEWAL_LEAD_MS = 60 * 60 * 1000;
const RENEWAL_BUDGET_THRESHOLD = 3;
function renewalText(sendBudget: number): string {
  return `回复窗口即将结束。请主动发一条消息，刷新本轮 ${sendBudget} 条消息额度，避免定时任务结果继续等待。`;
}

export interface RenewalState {
  contextBudgets: Record<string, { refreshedAt: number }>;
  contextTokens: Record<string, string>;
  policy: { contextWindowMs: number; sendBudget: number };
  replyDeliveries: Record<string, ReplyDeliveryState>;
  getLoginFingerprint(): string;
  canSendToChat(chatId: string, kind: "final"): boolean;
  /** Must include the current policy and reservations; the persisted raw counter is insufficient. */
  remainingSendBudget(chatId: string): number;
}
export interface RenewalOptions {
  state: RenewalState;
  send: (chatId: string, text: string, options: {
    deliveryKey: string; kind: "final"; shouldContinue: () => boolean; signal?: AbortSignal; renewalReminder?: true;
  }) => Promise<number>;
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
        !Number.isSafeInteger(state.policy.sendBudget) || state.policy.sendBudget <= 0 ||
        typeof refreshedAt !== "number" || !Number.isSafeInteger(refreshedAt) || refreshedAt < 0 || !Number.isFinite(now) ||
        now - refreshedAt < windowMs - RENEWAL_LEAD_MS || now - refreshedAt >= windowMs ||
        !state.canSendToChat(chatId, "final")) return false;
    const remaining = state.remainingSendBudget(chatId);
    return Number.isSafeInteger(remaining) && remaining > 0 && remaining < RENEWAL_BUDGET_THRESHOLD;
  }

  private pendingDelivery(chatId: string) {
    const { state } = this.options;
    const account = state.getLoginFingerprint(), token = state.contextTokens[chatId];
    if (!account || !token || !this.eligible(chatId)) return undefined;
    const refreshedAt = state.contextBudgets[chatId].refreshedAt, windowMs = state.policy.contextWindowMs;
    const deliveryKey = renewalDeliveryKey(account, chatId, refreshedAt);
    const prior = state.replyDeliveries[deliveryKey];
    if (prior && (prior.acknowledgedChunks > 0 || prior.inFlight || prior.failureReason)) return undefined;
    return { account, token, refreshedAt, windowMs, sendBudget: state.policy.sendBudget, deliveryKey };
  }

  /** A synchronous policy check for transport admission; no network work while its chat lock is held. */
  public shouldYield(chatId: string, deliveryKey?: string): boolean {
    const pending = this.pendingDelivery(chatId);
    return pending !== undefined && pending.deliveryKey !== deliveryKey;
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
          const pending = this.pendingDelivery(chatId);
          if (!pending) { outcome.skipped++; continue; }
          const { account, token, refreshedAt, windowMs, sendBudget, deliveryKey } = pending;
          // Checked again by the shared send path after queueing and immediately before submission.
          const shouldContinue = () => account === state.getLoginFingerprint() &&
            token === state.contextTokens[chatId] && refreshedAt === state.contextBudgets[chatId]?.refreshedAt &&
            windowMs === state.policy.contextWindowMs && sendBudget === state.policy.sendBudget && this.eligible(chatId);
          if (!shouldContinue()) { outcome.skipped++; continue; }
          const sent = await this.options.send(chatId, renewalText(sendBudget), {
            deliveryKey, kind: "final", shouldContinue, renewalReminder: true,
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
