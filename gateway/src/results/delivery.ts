import { createHash } from "node:crypto";
import type { StateManager } from "../runtime/state.js";
import { ILinkSendReceiptError } from "../wechat/send-receipt.js";
import { parseResultDelivery, type MaterializedResultDelivery, type ResultArtifact } from "./contracts.js";

export type ResultSendKind = "final" | "progress";
export interface ResultBudget { allowed: boolean; remaining: number; reason?: string }
export interface ResultSendOptions { deliveryKey: string; kind: ResultSendKind; signal?: AbortSignal; shouldContinue: () => boolean }
export interface ResultTransport {
  /** Send one verbatim message with the shared transport's durable per-message checkpoint. */
  sendText(chatId: string, text: string, options: ResultSendOptions): Promise<unknown>;
  sendFile(chatId: string, artifact: ResultArtifact, bytes: Buffer, options: ResultSendOptions): Promise<unknown>;
}
export interface ResultDeliveryOutcome {
  status: "accepted" | "uncertain" | "deferred";
  acknowledgedSteps: number; totalSteps: number; reason?: string;
}
export interface ResultDeliveryOptions {
  state: Pick<StateManager, "getLoginFingerprint" | "replyDeliveries">;
  transport: ResultTransport;
  downloadArtifact: (artifact: ResultArtifact, signal?: AbortSignal) => Promise<Buffer>;
  /** Common ledger admission; atomic reservations belong to transport. */
  budget: (chatId: string, kind: ResultSendKind) => ResultBudget;
  contextFingerprint: (chatId: string) => string;
  isReplyPending: (chatId: string) => boolean;
  classifyError?: (error: unknown) => "not_submitted" | "rejected" | "unknown";
  now?: () => number;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function resultStepKey(plan: MaterializedResultDelivery, index: number): string {
  return `result:${plan.id}:step:${index}${plan.mode === "download" && index === 1 ? `:${hash(plan.messages[index])}` : ""}`;
}
/** Signed links may renew after definite non-submit; inspect all signatures for acceptance or ambiguity. */
export function inspectResultStep(state: ResultDeliveryOptions["state"], plan: Pick<MaterializedResultDelivery, "id" | "mode">, index: number): "accepted" | "uncertain" | "pending" {
  const prefix = `result:${plan.id}:step:${index}`;
  const evidence = Object.entries(state.replyDeliveries).filter(([key]) => key === prefix || plan.mode === "download" && index === 1 && key.startsWith(`${prefix}:`));
  if (evidence.some(([, item]) => item.inFlight)) return "uncertain";
  return evidence.some(([, item]) => item.acknowledgedChunks === item.totalChunks && item.totalChunks > 0) ? "accepted" : "pending";
}
export function resultAcknowledgedSteps(state: ResultDeliveryOptions["state"], plan: Pick<MaterializedResultDelivery, "id" | "mode" | "messages">): number {
  const total = plan.messages.length + (plan.mode === "attachment" ? 1 : 0);
  let count = 0;
  while (count < total && inspectResultStep(state, plan, count) === "accepted") count++;
  return count;
}
function defaultClassification(error: unknown): "not_submitted" | "rejected" | "unknown" {
  if (error instanceof ILinkSendReceiptError && ["RejectedRet", "RejectedErrcode"].includes(error.reason)) return "rejected";
  if (error instanceof Error && error.name === "LocalSendDeferredError") return "not_submitted";
  return "unknown";
}
/** Orchestration only: transport owns the shared budget and every per-message checkpoint. */
export class ResultDeliveryRunner {
  private readonly inProgress = new Map<string, Promise<ResultDeliveryOutcome>>();
  constructor(private readonly options: ResultDeliveryOptions) {}
  deliver(plan: MaterializedResultDelivery, signal?: AbortSignal): Promise<ResultDeliveryOutcome> {
    const identity = `${plan.chatId}:${plan.id}`, existing = this.inProgress.get(identity);
    if (existing) return existing;
    const pending = this.run(plan, signal).finally(() => { this.inProgress.delete(identity); });
    this.inProgress.set(identity, pending);
    return pending;
  }
  private async run(rawPlan: MaterializedResultDelivery, signal?: AbortSignal): Promise<ResultDeliveryOutcome> {
    const plan = parseResultDelivery(rawPlan, true) as MaterializedResultDelivery;
    if (plan.status !== "claimed") throw new Error("Result must be claimed before delivery");
    if (plan.kind === "progress" && (plan.mode !== "text" || plan.messages.length !== 1)) throw new Error("Progress must occupy one message");
    const total = plan.messages.length + (plan.mode === "attachment" ? 1 : 0), { state } = this.options;
    const account = state.getLoginFingerprint(), context = this.options.contextFingerprint(plan.chatId), kind = plan.kind === "progress" ? "progress" : "final";
    const outcome = (status: ResultDeliveryOutcome["status"], reason?: string): ResultDeliveryOutcome => ({ status,
      acknowledgedSteps: resultAcknowledgedSteps(state, plan), totalSteps: total, ...(reason ? { reason } : {}) });
    const admissible = (checkBudget = true): string | undefined => {
      const now = (this.options.now ?? Date.now)();
      if (signal?.aborted || !account || !context || account !== state.getLoginFingerprint() || context !== this.options.contextFingerprint(plan.chatId)) return "context_changed";
      if (plan.expiresAt <= now || plan.retainedUntil <= now) return "business_expired";
      if ((plan.attemptExpiresAt ?? 0) <= now) return "attempt_expired";
      if (this.options.isReplyPending(plan.chatId)) return "reply_pending";
      if (checkBudget) {
        const budget = this.options.budget(plan.chatId, kind);
        if (!budget.allowed) return budget.reason ?? "waiting_for_user";
        if (!Number.isSafeInteger(budget.remaining) || budget.remaining < 0) throw new Error("Invalid shared result budget");
        if (budget.remaining < total - resultAcknowledgedSteps(state, plan)) return "budget_exhausted";
      }
      return undefined;
    };
    for (let index = 0; index < total; index++) {
      const prior = inspectResultStep(state, plan, index);
      if (prior === "uncertain") return outcome("uncertain", "previous_send_unknown");
      if (prior === "accepted") continue;
      let reason = admissible();
      if (reason) return outcome("deferred", reason);
      let fileBytes: Buffer | undefined;
      const fileStep = index === plan.messages.length;
      if (fileStep) {
        try { fileBytes = await this.options.downloadArtifact(plan.artifact, signal); }
        catch { return outcome("deferred", signal?.aborted ? "context_changed" : "artifact_unavailable"); }
        reason = admissible();
        if (reason) return outcome("deferred", reason);
      }
      try {
        const options: ResultSendOptions = { deliveryKey: resultStepKey(plan, index), kind, signal, shouldContinue: () => admissible(false) === undefined };
        if (fileStep) await this.options.transport.sendFile(plan.chatId, plan.artifact, fileBytes!, options);
        else await this.options.transport.sendText(plan.chatId, plan.messages[index], options);
      } catch (error) {
        const evidence = inspectResultStep(state, plan, index);
        if (evidence === "uncertain") return outcome("uncertain", "send_unknown");
        if (evidence === "accepted") continue;
        // Transport persists intent before sendmessage: without in-flight intent, no unknown send exists.
        const classification = (this.options.classifyError ?? defaultClassification)(error);
        return outcome("deferred", classification === "rejected" ? "rejected" : admissible() ?? "not_submitted");
      }
      if (inspectResultStep(state, plan, index) !== "accepted") throw new Error("Result transport returned without durable acceptance evidence");
    }
    return outcome("accepted");
  }
}
/** One important, recent result per chat per dispatch pass; terminal results outrank milestones. */
export function selectResultDeliveries<T extends { id: string; chatId: string; kind: string; createdAt: number }>(items: readonly T[]): T[] {
  const ordered = [...items].sort((a, b) => Number(a.kind === "progress") - Number(b.kind === "progress") || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  const chats = new Set<string>();
  return ordered.filter(item => { if (chats.has(item.chatId)) return false; chats.add(item.chatId); return true; });
}
