import { randomUUID } from "node:crypto";
import type { ResultClient } from "../controller/result-client.js";
import type { ResultDelivery, MaterializedResultDelivery } from "./contracts.js";
import { inspectResultStep, resultAcknowledgedSteps, selectResultDeliveries, type ResultDeliveryRunner, type ResultDeliveryOptions, type ResultSendKind } from "./delivery.js";
import { RESULT_OUTBOX_LIMIT, resultIdentity, type ResultOutboxStore, type ResultReference } from "./outbox.js";

export const RESULT_DISPATCH_INTERVAL_MS = 60_000;
export interface ResultDispatchSummary { accepted: number; uncertain: number; skipped: number }
type Client = Pick<ResultClient, "listDeliveries" | "getDelivery" | "claimDelivery" | "materializeDelivery" | "recordReceipt" | "deferDelivery" | "resumeDeliveries" | "blockChatDeliveries">;
export interface ResultDispatcherOptions {
  controller: Client; store: ResultOutboxStore; runner: Pick<ResultDeliveryRunner, "deliver">;
  state: ResultDeliveryOptions["state"];
  canDispatch: (chatId: string, kind: ResultSendKind) => boolean;
  deferReason?: (chatId: string, kind: ResultSendKind) => string;
  isReplyPending: (chatId: string) => boolean;
  active?: () => boolean; signal?: AbortSignal; now?: () => number;
}
function totalSteps(item: ResultDelivery): number { return item.mode === "text" ? item.messages.length : 2; }
function acknowledged(state: ResultDeliveryOptions["state"], item: ResultDelivery): number {
  // Unmaterialized download plans contain only the summary; the link is a second logical step.
  if (item.mode !== "download") return resultAcknowledgedSteps(state, item);
  let count = 0;
  while (count < 2 && inspectResultStep(state, item, count) === "accepted") count++;
  return count;
}

/** Durable claim/defer/receipt intents recover through GET before any new send is considered. */
export class ResultDispatcher {
  private delivering = false;
  private chatCursor = 0;
  private readonly blockedAt = new Map<string, number>();
  constructor(private readonly options: ResultDispatcherOptions) {}
  private now(): number { return (this.options.now ?? Date.now)(); }
  private active(): boolean { return !this.options.signal?.aborted && (this.options.active?.() ?? true); }
  noteInbound(chatId: string, generation: string): void {
    this.options.store.queueResume(chatId, generation);
  }
  async resumeChat(chatId: string): Promise<void> {
    if (!this.active()) return;
    const queued = this.options.store.pendingResumes().find(item => item.chatId === chatId);
    // Caller invokes only after persisting a genuine new user message, never on token polling/replay.
    await this.options.controller.resumeDeliveries(chatId, this.options.signal, queued?.generation);
    this.blockedAt.delete(chatId);
    if (queued) this.options.store.completeResume(chatId, queued.generation);
  }
  async flushResumes(): Promise<void> {
    let firstError: unknown;
    for (const item of this.options.store.pendingResumes()) {
      if (!this.active()) break;
      if (this.options.isReplyPending(item.chatId) || !this.options.canDispatch(item.chatId, "final")) continue;
      try {
        await this.options.controller.resumeDeliveries(item.chatId, this.options.signal, item.generation);
        this.options.store.completeResume(item.chatId, item.generation);
        this.blockedAt.delete(item.chatId);
      } catch (error) { firstError ??= error; }
    }
    if (firstError !== undefined) throw firstError;
  }
  private verify(ref: ResultReference, item: ResultDelivery): void {
    if (ref.id !== item.id || ref.chatId !== item.chatId || ref.identity !== resultIdentity(item)) throw new Error("Controller result recovery identity mismatch");
  }
  private maySend(item: ResultDelivery): boolean {
    return this.active() && !this.options.isReplyPending(item.chatId) && item.expiresAt > this.now() && item.retainedUntil > this.now() &&
      this.options.canDispatch(item.chatId, item.kind === "progress" ? "progress" : "final") &&
      this.now() - this.options.store.lastDispatchAt(item.chatId) >= RESULT_DISPATCH_INTERVAL_MS;
  }
  async deliverOnce(chatIds: readonly string[]): Promise<ResultDispatchSummary> {
    const summary: ResultDispatchSummary = { accepted: 0, uncertain: 0, skipped: 0 };
    if (this.delivering || !this.active()) return summary;
    if (chatIds.length > RESULT_OUTBOX_LIMIT || chatIds.some(chat => typeof chat !== "string" || !chat.trim())) throw new Error("Invalid result dispatcher chats");
    this.delivering = true;
    const attempted = new Set<string>();
    let firstError: unknown;
    try {
      try { await this.flushResumes(); } catch (error) { firstError = error; }
      // Resolve transition intents before selecting fresh notifications; this never blindly replays a claim.
      for (const ref of this.options.store.references()) {
        if (!this.active()) break;
        try {
          const item = await this.options.controller.getDelivery(ref.id, this.options.signal);
          this.verify(ref, item);
          const sent = await this.process(ref, item, summary);
          if (sent) attempted.add(item.chatId);
        } catch (error) { firstError ??= error; attempted.add(ref.chatId); }
      }
      const chats = [...new Set(chatIds)].filter(chat => !attempted.has(chat));
      if (!chats.length || !this.active()) { if (firstError !== undefined) throw firstError; return summary; }
      const offset = this.chatCursor % chats.length;
      const rotated = [...chats.slice(offset), ...chats.slice(0, offset)];
      this.chatCursor = (offset + 1) % chats.length;
      // Query separately so an exhausted chat cannot occupy the Controller's pending limit.
      for (const chatId of rotated) {
        if (!this.active()) break;
        try {
          if (this.options.isReplyPending(chatId)) continue;
          if (!this.options.canDispatch(chatId, "final")) {
            if (this.now() - (this.blockedAt.get(chatId) ?? 0) >= RESULT_DISPATCH_INTERVAL_MS) {
              await this.options.controller.blockChatDeliveries(chatId, this.options.deferReason?.(chatId, "final") ?? "waiting_for_user", this.options.signal);
              this.blockedAt.set(chatId, this.now());
            }
            continue;
          }
          this.blockedAt.delete(chatId);
          if (this.now() - this.options.store.lastDispatchAt(chatId) < RESULT_DISPATCH_INTERVAL_MS) continue;
          const items = selectResultDeliveries(await this.options.controller.listDeliveries([chatId], this.options.signal));
          for (const item of items) {
            if (item.chatId !== chatId) throw new Error("Controller result dispatch chat identity mismatch");
            if (this.options.store.references().some(ref => ref.id === item.id) || !this.maySend(item)) continue;
            const ref: ResultReference = { id: item.id, chatId, identity: resultIdentity(item), status: "pending" };
            this.options.store.put(ref);
            await this.process(ref, item, summary);
          }
        } catch (error) { firstError ??= error; }
      }
      if (firstError !== undefined) throw firstError;
      return summary;
    } finally { this.delivering = false; }
  }
  private async receipt(ref: ResultReference, summary: ResultDispatchSummary): Promise<void> {
    if (!ref.attemptId || !ref.receiptStatus) throw new Error("Missing result receipt intent");
    const item = await this.options.controller.recordReceipt(ref.id, ref.attemptId, ref.receiptStatus, this.options.signal);
    this.verify(ref, item);
    this.options.store.remove(ref.id);
    summary[item.status === "accepted" ? "accepted" : "uncertain"]++;
  }
  private async defer(ref: ResultReference): Promise<void> {
    if (!ref.attemptId || !ref.deferReason) throw new Error("Missing result defer intent");
    const item = await this.options.controller.deferDelivery(ref.id, ref.attemptId, ref.deferReason, ref.submittedMessages ?? 0, this.options.signal);
    this.verify(ref, item);
    this.options.store.remove(ref.id);
  }
  private persistReceipt(ref: ResultReference, status: "accepted" | "uncertain"): ResultReference {
    this.options.store.update(ref.id, { status: "receipt", receiptStatus: status });
    return { ...ref, status: "receipt", receiptStatus: status };
  }
  private async process(initialRef: ResultReference, initialItem: ResultDelivery, summary: ResultDispatchSummary): Promise<boolean> {
    let ref = initialRef, item = initialItem;
    if (item.status === "accepted") { this.options.store.remove(ref.id); return false; }
    if (ref.status === "receipt") {
      if (item.attemptId !== ref.attemptId) throw new Error("Controller result receipt recovery attempt mismatch");
      await this.receipt(ref, summary); return false;
    }
    if (["claimed", "uncertain"].includes(item.status) && item.attemptId === ref.attemptId &&
      acknowledged(this.options.state, item) === totalSteps(item)) {
      await this.receipt(this.persistReceipt(ref, "accepted"), summary); return false;
    }
    if (ref.status === "defer") {
      if (["waiting_for_user", "ready"].includes(item.status) && item.lastDeferredAttemptId === ref.attemptId && item.lastDeferReason === ref.deferReason &&
        (item.submittedMessages ?? 0) >= (ref.submittedMessages ?? 0)) { this.options.store.remove(ref.id); return false; }
      if (item.status === "claimed" && item.attemptId === ref.attemptId) { await this.defer(ref); return false; }
      throw new Error("Controller result defer recovery attempt mismatch");
    }
    if (["uncertain", "superseded", "waiting_for_user"].includes(item.status) || item.expiresAt <= this.now() || item.retainedUntil <= this.now()) {
      this.options.store.remove(ref.id); summary.skipped++; return false;
    }
    if (item.status === "ready") {
      if (!this.maySend(item)) { summary.skipped++; return false; }
      const attemptId = ref.attemptId ?? randomUUID();
      this.options.store.update(ref.id, { status: "claiming", attemptId });
      item = await this.options.controller.claimDelivery(item.id, attemptId, this.options.signal);
      this.verify(ref, item);
      ref = { ...ref, status: "claimed", attemptId };
      this.options.store.update(ref.id, { status: "claimed" });
    }
    if (item.status !== "claimed" || item.attemptId !== ref.attemptId) throw new Error("Controller result claim recovery attempt mismatch");
    if (acknowledged(this.options.state, item) === totalSteps(item)) {
      await this.receipt(this.persistReceipt(ref, "accepted"), summary); return false;
    }
    if (Array.from({ length: totalSteps(item) }, (_, index) => inspectResultStep(this.options.state, item, index)).includes("uncertain")) {
      await this.receipt(this.persistReceipt(ref, "uncertain"), summary); return false;
    }
    if ((item.attemptExpiresAt ?? 0) <= this.now()) { this.options.store.remove(ref.id); summary.skipped++; return false; }
    if (!this.maySend(item)) {
      const kind = item.kind === "progress" ? "progress" : "final";
      if (this.options.isReplyPending(item.chatId) || !this.options.canDispatch(item.chatId, kind)) {
        const reason = this.options.isReplyPending(item.chatId) ? "reply_pending" : this.options.deferReason?.(item.chatId, kind) ?? "waiting_for_user";
        const submittedMessages = acknowledged(this.options.state, item);
        this.options.store.update(ref.id, { status: "defer", deferReason: reason, submittedMessages });
        await this.defer({ ...ref, status: "defer", deferReason: reason, submittedMessages });
      }
      summary.skipped++; return false;
    }
    const materialized: MaterializedResultDelivery = await this.options.controller.materializeDelivery(item.id, ref.attemptId!, this.options.signal);
    this.verify(ref, materialized);
    // Save before send: a process crash cannot bypass the per-chat dispatch interval.
    this.options.store.recordDispatch(item.chatId, this.now());
    const outcome = await this.options.runner.deliver(materialized, this.options.signal);
    if (outcome.status === "deferred") {
      this.options.store.update(ref.id, { status: "defer", deferReason: outcome.reason ?? "not_submitted", submittedMessages: outcome.acknowledgedSteps });
      await this.defer({ ...ref, status: "defer", deferReason: outcome.reason ?? "not_submitted", submittedMessages: outcome.acknowledgedSteps });
      summary.skipped++;
    } else await this.receipt(this.persistReceipt(ref, outcome.status), summary);
    return true;
  }
}
