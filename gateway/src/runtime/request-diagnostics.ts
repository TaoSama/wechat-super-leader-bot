import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";

export type RequestOperation = "notification_interest" | "result_pending" | "result_get" | "result_claim" |
  "result_materialize" | "result_receipt" | "result_defer" | "result_resume" | "result_blocked" | "artifact_download" |
  "notification_pending" | "notification_get" | "notification_claim" | "notification_receipt" | "notification_defer" |
  "reply_get" | "image_download" | "wechat_sendmessage";
export type NotificationStage = "interest" | "renewal" | "reply_recovery" | "result_delivery" | "notification_delivery";
export interface RequestFailure {
  operation: RequestOperation;
  phase: "fetch" | "headers" | "body" | "decode" | "validate";
  requestAttempts: number;
  requestMaxAttempts: number;
  elapsedMs: number;
  timedOut: boolean;
  parentAborted: boolean;
  httpStatus?: number;
}
const failures = new WeakMap<object, { request: RequestFailure; key: string }>();
const stages = new WeakMap<object, NotificationStage>();
export interface RequestObservation { successes: Set<string>; failures: Map<string, ReturnType<typeof notificationFailure>> }
const observations = new AsyncLocalStorage<RequestObservation>();
const MAX_CAUSE_NODES = 8;
const SAFE_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_ABORTED",
  "UND_ERR_RESPONSE_STATUS_CODE", "UND_ERR_RES_CONTENT_LENGTH_MISMATCH", "UND_ERR_REQ_CONTENT_LENGTH_MISMATCH",
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER", "ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR", "ERR_ENCODING_INVALID_ENCODED_DATA",
]);
const SAFE_NAMES = new Set(["Error", "TypeError", "SyntaxError", "RangeError", "AbortError", "TimeoutError", "AggregateError"]);

function object(value: unknown): value is object { return typeof value === "object" && value !== null; }
function ownValue(value: object, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}
/** Never serialize error messages, stacks, hostnames, arbitrary codes or cause objects. */
export function safeErrorFacts(error: unknown): { errorName: string; causeCodes: string[] } {
  const name = object(error) && error instanceof Error ? error.name : undefined;
  const codes = new Set<string>(), seen = new Set<object>(), queue: unknown[] = [error];
  while (queue.length && seen.size < MAX_CAUSE_NODES) {
    const next = queue.shift();
    if (!object(next) || seen.has(next)) continue;
    seen.add(next);
    const code = ownValue(next, "code");
    if (code !== undefined) codes.add(typeof code === "string" && SAFE_CODES.has(code) ? code : "OtherCode");
    queue.push(ownValue(next, "cause"));
    const nested = ownValue(next, "errors");
    if (Array.isArray(nested)) queue.push(...nested.slice(0, MAX_CAUSE_NODES));
  }
  return { errorName: typeof name === "string" && SAFE_NAMES.has(name) ? name : "OtherError", causeCodes: [...codes] };
}

export function rememberNotificationStage(error: unknown, stage: NotificationStage): void {
  if (object(error)) {
    stages.set(error, stage);
    const failure = notificationFailure(error);
    observations.getStore()?.failures.set(failure.key ?? `stage:${stage}`, failure);
  }
}
export function notificationFailure(error: unknown) {
  return { stage: object(error) ? stages.get(error) ?? "unknown" : "unknown",
    ...(object(error) ? failures.get(error) : undefined), ...safeErrorFacts(error) };
}
export function observeRequests<T>(observation: RequestObservation, action: () => Promise<T>): Promise<T> {
  return observations.run(observation, action);
}

/** Metadata stays beside the original error, preserving instanceof and retry decisions. */
export class RequestDiagnostics {
  phase: RequestFailure["phase"] = "fetch";
  httpStatus?: number;
  private readonly started = performance.now();
  private readonly key: string;
  constructor(private readonly operation: RequestOperation, identity: string = operation) {
    // The key can contain a request identity but is never included in emitted fields.
    this.key = JSON.stringify([operation, createHash("sha256").update(identity).digest("hex")]);
  }
  success(): void {
    observations.getStore()?.successes.add(this.key);
    observations.getStore()?.failures.delete(this.key);
  }
  failure(error: unknown, requestAttempts: number, requestMaxAttempts: number, timedOut: boolean, parentAborted = false): void {
    if (!object(error)) return;
    const detail = { key: this.key, request: { operation: this.operation, phase: this.phase,
      requestAttempts, requestMaxAttempts, elapsedMs: Math.round(performance.now() - this.started),
      timedOut, parentAborted, ...(this.httpStatus === undefined ? {} : { httpStatus: this.httpStatus }) } };
    failures.set(error, detail);
    observations.getStore()?.successes.delete(this.key);
    observations.getStore()?.failures.set(this.key, notificationFailure(error));
  }
}
