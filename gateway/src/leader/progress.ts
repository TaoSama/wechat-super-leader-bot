import { createHash } from "node:crypto";
import type { ControllerMessageRequest } from "../types.js";

export const QUERY_PROGRESS_LIMIT = 3;
export const MAX_PROGRESS_CHARS = 2000;
export type ProgressSink = (text: string, id: string) => Promise<{ sent: boolean; reason?: string }>;
export interface QueryProgressResult {
  sent: boolean;
  status: "sent" | "not_sent" | "limit_reached" | "unavailable";
  used: number;
  remaining: number;
  limit: number;
  reason?: string;
}
const SAFE_REASONS = new Set(["budget_exhausted", "window_expired", "context_changed", "limit_reached",
  "previous_send_unknown", "send_unknown", "rejected", "not_submitted", "delivery_failed", "unavailable"]);

/** One root query owns the allowance, including every message steered into it. */
export class QueryProgress {
  private used = 0;
  private blockedReason?: string;
  private tail: Promise<void> = Promise.resolve();
  private readonly identity: string;
  constructor(request: ControllerMessageRequest, private readonly sink?: ProgressSink) {
    this.identity = createHash("sha256").update(JSON.stringify([request.chatId, request.messageId])).digest("hex");
  }
  public get remaining(): number { return this.blockedReason ? 0 : QUERY_PROGRESS_LIMIT - this.used; }
  public drain(): Promise<void> { return this.tail; }
  public withController<T>(run: (remaining: number, report: (text: string) => Promise<QueryProgressResult>) => Promise<T>): Promise<T> {
    // Controller advertises its initial remaining budget to its model. Hold the
    // same queue until the stream ends so native calls cannot spend those slots.
    return this.enqueue(() => run(this.remaining, text => this.reportNow(text)));
  }
  public report(text: string): Promise<QueryProgressResult> {
    return this.enqueue(() => this.reportNow(text));
  }
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run);
    // The caller receives the failure; the serialization barrier must still
    // release so later explicitly authorized work can run.
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }
  private async reportNow(text: string): Promise<QueryProgressResult> {
    if (typeof text !== "string" || !text.trim() || text.length > MAX_PROGRESS_CHARS) {
      return this.result("not_sent", false, "rejected");
    }
    if (this.blockedReason) return this.result("unavailable", false, this.blockedReason);
    if (this.remaining === 0) return this.result("limit_reached", false, "limit_reached");
    // An attempted send consumes its slot even if its receipt is unknown. Never
    // retry a failed update or grant extra slots after additional inbound text.
    const sequence = ++this.used;
    if (!this.sink) return this.result("unavailable", false, "unavailable");
    try {
      const outcome = await this.sink(text, `query-progress:${this.identity}:${sequence}`);
      const reason = outcome.reason && SAFE_REASONS.has(outcome.reason) ? outcome.reason : "delivery_failed";
      if (!outcome.sent && ["budget_exhausted", "window_expired"].includes(reason)) this.blockedReason = reason;
      return this.result(outcome.sent ? "sent" : "not_sent", outcome.sent, outcome.sent ? undefined : reason);
    } catch {
      return this.result("not_sent", false, "delivery_failed");
    }
  }
  private result(status: QueryProgressResult["status"], sent: boolean, reason?: string): QueryProgressResult {
    return { sent, status, used: this.used, remaining: this.remaining, limit: QUERY_PROGRESS_LIMIT,
      ...(reason ? { reason } : {}) };
  }
}
