import type { FallbackInput, FallbackRecord, FallbackRepository, FallbackSettlement } from "./contracts.js";
import { FallbackInputSchema } from "./contracts.js";
import { validateFallbackEndpoint } from "./config.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const CLAIM_MARGIN_MS = 30_000;
const SEND_MARGIN_MS = 1_000;
const RETRY_BASE_MS = 30_000;
const MAX_ATTEMPTS = 5;
const DEFAULT_DRAIN_LIMIT = 10;
const MAX_PAYLOAD_TEXT_CHARS = 500;
const PRE_SUBMISSION_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT"]);

export interface FallbackMaterialized {
  /** A separately scoped, authenticated result URL. Never use a controller or WeChat token. */
  url?: string;
  resultStatus?: string;
}
export interface FallbackOptions {
  endpoints: ReadonlyMap<string, string>;
  materialize?: (record: FallbackRecord) => Promise<FallbackMaterialized>;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

function definitelyNotSubmitted(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = "code" in error ? error.code : undefined;
  if (typeof code === "string" && PRE_SUBMISSION_CODES.has(code)) return true;
  return "cause" in error && error.cause !== error && definitelyNotSubmitted(error.cause);
}

export class FallbackService {
  private readonly endpoints: ReadonlyMap<string, string>;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  constructor(private readonly repository: FallbackRepository, private readonly options: FallbackOptions) {
    this.endpoints = new Map([...options.endpoints].map(([chatId, endpoint]) => [chatId, validateFallbackEndpoint(endpoint)]));
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) throw new Error("Invalid fallback HTTP timeout");
  }

  async enqueue(input: FallbackInput): Promise<FallbackRecord | undefined> {
    const valid = FallbackInputSchema.parse(input);
    if (!this.endpoints.has(valid.chatId)) return undefined;
    return this.repository.enqueue(valid, this.now());
  }

  async drain(limit = DEFAULT_DRAIN_LIMIT): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid fallback drain limit");
    let drained = 0;
    while (drained < limit) {
      const record = await this.repository.claim(this.now(), this.timeoutMs + CLAIM_MARGIN_MS);
      if (!record) break;
      // A crashed sender remains leased until its deadline; recovery never resends an unknown submission.
      const outcome = await this.submit(record);
      await this.repository.settle(record.id, record.claimToken!, outcome, this.now());
      drained++;
    }
    return drained;
  }

  private retry(record: FallbackRecord, outcome: string): FallbackSettlement {
    return record.attempts >= MAX_ATTEMPTS ? { status: "failed", outcome: `${outcome}_attempts_exhausted` } :
      { status: "pending", outcome, nextAttemptAt: this.now() + RETRY_BASE_MS * 2 ** (record.attempts - 1) };
  }

  private async submit(record: FallbackRecord): Promise<FallbackSettlement> {
    const endpoint = this.endpoints.get(record.chatId);
    if (!endpoint) return { status: "failed", outcome: "destination_not_configured" };
    let materialized: FallbackMaterialized;
    try {
      materialized = await this.options.materialize?.(record) ?? {};
      if (materialized.url) validateFallbackEndpoint(materialized.url);
    } catch {
      return this.retry(record, "materialize_failed_before_submission");
    }
    if ((record.claimExpiresAt ?? 0) - this.now() < this.timeoutMs + SEND_MARGIN_MS) {
      return this.retry(record, "insufficient_lease_before_submission");
    }
    const payload = { id: record.id, key: record.key, kind: record.kind, title: record.title,
      text: record.text.slice(0, MAX_PAYLOAD_TEXT_CHARS), resultId: record.resultId,
      resultStatus: materialized.resultStatus ?? record.resultStatus,
      resultUrl: materialized.url, createdAt: record.createdAt };
    try {
      const response = await (this.options.fetch ?? fetch)(endpoint, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs),
        headers: { "content-type": "application/json", "idempotency-key": record.id }, body: JSON.stringify(payload),
      });
      // No response content is trusted or persisted; cancel without buffering arbitrarily large bodies.
      let bodyOutcome = "";
      try { await response.body?.cancel(); } catch { bodyOutcome = "_response_body_cancel_failed"; }
      if (response.status >= 200 && response.status < 300) return { status: "sent", outcome: `endpoint_accepted_http_${response.status}${bodyOutcome}` };
      if (response.status === 429) return this.retry(record, "endpoint_rate_limited_http_429");
      if (response.status >= 500) return { status: "unknown", outcome: `endpoint_error_may_have_processed_http_${response.status}` };
      return { status: "failed", outcome: `endpoint_rejected_http_${response.status}` };
    } catch (error) {
      if (definitelyNotSubmitted(error)) return this.retry(record, "connection_failed_before_submission");
      return { status: "unknown", outcome: "network_outcome_unknown" };
    }
  }
}
