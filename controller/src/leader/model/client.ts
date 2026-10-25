import { URL } from "node:url";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { traceEvent, traceSpan } from "../../runtime/telemetry.js";
import { responsePayload } from "./responses.js";
import { parseAndValidateResponse } from "./response-parser.js";
import { cancelBodySafely, readBoundedStream, sleepWithAbort } from "./transport.js";
import type { LeaderModel, ModelMessage, ModelTool, ModelReply } from "./contracts.js";
import { ModelFailure, ModelTransportFailure, isQuotaError, providerErrorCode, retryDelay, transportFailure, modelDiagnostic } from './errors.js';

export interface HttpLeaderModelOptions {
  /**
   * OpenAI-compatible API base URL (typically ending with /v1).
   * HTTPS is required except for loopback hosts (127.0.0.1, localhost, ::1).
   */
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningEffort?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
  retryDelayMs?: number;
}

// One completion (including retries) may need more time than a short text response.
export const DEFAULT_MODEL_TIMEOUT_MS = 60000;
const MIN_TIMEOUT_MS = 10;
const MAX_TIMEOUT_MS = 120000;

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024; // 1 MB
const MIN_MAX_RESPONSE_BYTES = 64;
const MAX_MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB

const DEFAULT_RETRY_DELAY_MS = 250;
const MIN_RETRY_DELAY_MS = 0;
const MAX_RETRY_DELAY_MS = 5000;
const MAX_MODEL_ATTEMPTS = 3;

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function isLoopback(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return (
    lower === "localhost" ||
    lower === "127.0.0.1" ||
    lower === "::1" ||
    lower === "[::1]" ||
    lower.endsWith(".localhost")
  );
}

function validateBoundedInt(
  value: number | undefined,
  defaultValue: number,
  min: number,
  max: number,
  name: string
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}: must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * Normalizes the configured base URL into a Responses endpoint.
 * Documented expectation: baseUrl includes /v1 (e.g. https://api.example.com/v1).
 */
function normalizeEndpoint(rawBaseUrl: string): string {
  if (typeof rawBaseUrl !== "string" || rawBaseUrl.trim().length === 0) {
    throw new Error("Invalid baseUrl: must be a non-empty string");
  }
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl.trim());
  } catch {
    throw new Error("Invalid baseUrl: unable to parse URL");
  }

  if (parsed.username || parsed.password) {
    throw new Error("Invalid baseUrl: userinfo (username/password) is not allowed");
  }

  if (parsed.search) {
    throw new Error("Invalid baseUrl: query parameters are not allowed");
  }

  if (parsed.hash) {
    throw new Error("Invalid baseUrl: URL fragment hash is not allowed");
  }

  if (parsed.protocol === "http:") {
    if (!isLoopback(parsed.hostname)) {
      throw new Error("Insecure HTTP baseUrl is only allowed for loopback addresses");
    }
  } else if (parsed.protocol !== "https:") {
    throw new Error("baseUrl must use HTTPS (or HTTP for loopback)");
  }

  const trimmedPath = parsed.pathname.replace(/\/+$/, "");
  if (!trimmedPath.endsWith("/v1")) {
    throw new Error("Invalid baseUrl: path must end with /v1");
  }

  parsed.pathname = `${trimmedPath}/responses`;
  return parsed.toString();
}

export class HttpLeaderModel implements LeaderModel {
  private endpoint: string;
  private apiKey: string;
  private model: string;
  private reasoningEffort?: string;
  private timeoutMs: number;
  private maxResponseBytes: number;
  private fetchImpl: typeof fetch;
  private retryDelayMs: number;

  constructor(options: HttpLeaderModelOptions) {
    if (!options || typeof options !== "object") {
      throw new Error("HttpLeaderModel options must be an object");
    }
    if (typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
      throw new Error("apiKey must be a non-empty string");
    }
    if (typeof options.model !== "string" || options.model.trim().length === 0) {
      throw new Error("model must be a non-empty string");
    }
    this.endpoint = normalizeEndpoint(options.baseUrl);
    this.apiKey = options.apiKey.trim();
    this.model = options.model.trim();
    if (options.reasoningEffort !== undefined && !/^[a-z_]{1,32}$/.test(options.reasoningEffort)) throw new Error("Invalid reasoning effort");
    this.reasoningEffort = options.reasoningEffort;
    this.timeoutMs = validateBoundedInt(
      options.timeoutMs,
      DEFAULT_MODEL_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      "timeoutMs"
    );
    this.maxResponseBytes = validateBoundedInt(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      MIN_MAX_RESPONSE_BYTES,
      MAX_MAX_RESPONSE_BYTES,
      "maxResponseBytes"
    );
    this.retryDelayMs = validateBoundedInt(
      options.retryDelayMs,
      DEFAULT_RETRY_DELAY_MS,
      MIN_RETRY_DELAY_MS,
      MAX_RETRY_DELAY_MS,
      "retryDelayMs"
    );
    if (options.fetchImpl !== undefined && typeof options.fetchImpl !== "function") {
      throw new Error("fetchImpl must be a function");
    }
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  async complete(
    messages: ModelMessage[],
    tools: ModelTool[],
    signal?: AbortSignal
  ): Promise<ModelReply> {
    const completionId = randomUUID();
    return traceSpan("model.complete", async () => {
      try {
        const reply = await this.completeRequest(messages, tools, completionId, signal);
        traceEvent("model.reply", { completionId, toolCalls: reply.toolCalls.length,
          outputChars: reply.content?.length ?? 0 });
        return reply;
      } catch (error) {
        const diagnostic = modelDiagnostic(error);
        traceEvent("model.failure", { completionId, category: diagnostic.category,
          httpStatus: diagnostic.httpStatus, attempt: diagnostic.attempts,
          transportPhase: diagnostic.transportPhase });
        throw error;
      }
    }, { completionId, model: this.model, inputChars: messages.reduce((total, message) => total + (message.content?.length ?? 0), 0) });
  }

  private async completeRequest(
    messages: ModelMessage[], tools: ModelTool[], completionId: string, signal?: AbortSignal
  ): Promise<ModelReply> {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("Model request aborted");
    }

    const timeoutController = new AbortController();
    const completionDeadline = Date.now() + this.timeoutMs;
    const timeoutId = setTimeout(() => {
      timeoutController.abort(new ModelFailure(`Model request timed out after ${this.timeoutMs}ms`, { category: "timeout" }));
    }, this.timeoutMs);

    const combinedSignal = signal
      ? AbortSignal.any([signal, timeoutController.signal])
      : timeoutController.signal;

    const payload = responsePayload(this.model, messages, tools, this.reasoningEffort);

    const bodyString = JSON.stringify(payload);
    const retryTransport = async (failure: ModelTransportFailure, attempt: number): Promise<void> => {
      if (!failure.retryable || attempt >= MAX_MODEL_ATTEMPTS - 1) throw failure;
      const delayMs = retryDelay(undefined, this.retryDelayMs, attempt);
      if (delayMs >= completionDeadline - Date.now()) {
        throw new ModelFailure(`${failure.message}; retry exceeds request budget`, failure.diagnostic);
      }
      console.warn("Leader model temporary transport failure; retry scheduled", { ...failure.diagnostic, delayMs });
      await traceSpan("model.http.backoff", () => sleepWithAbort(delayMs, combinedSignal),
        { completionId, attempt: attempt + 1, delayMs });
    };

    try {
      for (let attempt = 0; attempt < MAX_MODEL_ATTEMPTS; attempt++) {
        if (combinedSignal.aborted) {
          throw combinedSignal.reason instanceof Error
            ? combinedSignal.reason
            : new Error("Model request aborted");
        }

        const attemptStarted = performance.now();
        const attemptSpanId = randomUUID();
        const attemptFields = { completionId, attempt: attempt + 1 };
        traceEvent("model.http.attempt.start", { ...attemptFields, spanId: attemptSpanId });
        let ended = false;
        let status: number | undefined;
        const finishAttempt = (outcome: string) => {
          if (ended) return;
          ended = true;
          traceEvent("model.http.attempt.end", { ...attemptFields, spanId: attemptSpanId,
            httpStatus: status, durationMs: performance.now() - attemptStarted, outcome });
        };
        try {
          let response: Response;
          try {
            response = await traceSpan("model.http.headers", () => this.fetchImpl(this.endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.apiKey}`,
              },
              body: bodyString,
              redirect: "error",
              signal: combinedSignal,
            }), attemptFields);
          } catch (fetchErr: unknown) {
            if (combinedSignal.aborted) {
              throw combinedSignal.reason instanceof Error
                ? combinedSignal.reason
                : new Error("Model request aborted");
            }
            finishAttempt("transport_error");
            await retryTransport(transportFailure(fetchErr, "fetch", attempt + 1), attempt);
            continue;
          }

          if (!response || typeof response.status !== "number") {
            throw new ModelFailure("Invalid model transport response", { category: "invalid_response", attempts: attempt + 1 });
          }

          status = response.status;
          traceEvent("model.http.response_headers", { ...attemptFields, httpStatus: status });
          if (!response.ok) {
            const isJson = response.headers.get("content-type")?.includes("json");
            let code: string | undefined;
            if (response.status === 429 || isJson) {
              try {
                code = providerErrorCode(await traceSpan("model.http.error_body", () =>
                  readBoundedStream(response.body, this.maxResponseBytes, combinedSignal), attemptFields));
              } catch {
                // The HTTP failure is already known; optional diagnostics must not replace it.
                // Do not retry when an unreadable body could conceal a quota failure.
                throw new ModelFailure(`Model request failed with HTTP status ${response.status}; error details unavailable`, {
                  category: "http", httpStatus: response.status, attempts: attempt + 1,
                });
              }
            } else {
              cancelBodySafely(response.body);
            }
            if (RETRYABLE_STATUS_CODES.has(response.status) && !isQuotaError(code) && attempt < MAX_MODEL_ATTEMPTS - 1) {
              const delayMs = retryDelay(response, this.retryDelayMs, attempt);
              if (delayMs >= completionDeadline - Date.now()) {
                console.warn("Leader model temporary HTTP failure; retry exceeds request budget", {
                  category: "http", httpStatus: response.status, providerCode: code, attempt: attempt + 1, delayMs,
                });
                throw new ModelFailure(`Model request failed with HTTP status ${response.status}; retry exceeds request budget`, {
                  category: "http", httpStatus: response.status, providerCode: code, attempts: attempt + 1,
                });
              }
              console.warn("Leader model temporary HTTP failure; retry scheduled", {
                category: "http", httpStatus: response.status, providerCode: code, attempt: attempt + 1, delayMs,
              });
              finishAttempt("retry");
              try {
                await traceSpan("model.http.backoff", () => sleepWithAbort(delayMs, combinedSignal),
                  { completionId, attempt: attempt + 1, delayMs });
              } catch (error) {
                if (combinedSignal.aborted) {
                  throw new ModelFailure(`Model request failed with HTTP status ${response.status}; retry interrupted by deadline`, {
                    category: "http", httpStatus: response.status, providerCode: code, attempts: attempt + 1,
                  });
                }
                throw error;
              }
              continue;
            }
            // Never echo provider error body or tokens
            throw new ModelFailure(`Model request failed with HTTP status ${response.status}`, {
              category: "http", httpStatus: response.status, providerCode: code, attempts: attempt + 1,
            });
          }

          let rawText: string;
          try {
            rawText = await traceSpan("model.http.body", () =>
              readBoundedStream(response.body, this.maxResponseBytes, combinedSignal), attemptFields);
          } catch (error) {
            if (combinedSignal.aborted) throw combinedSignal.reason;
            if (error instanceof ModelTransportFailure) {
              const failure = new ModelTransportFailure(error.retryable, { ...error.diagnostic, attempts: attempt + 1 });
              finishAttempt("transport_error");
              await retryTransport(failure, attempt);
              continue;
            }
            if (error instanceof ModelFailure) throw new ModelFailure(error.message, { ...error.diagnostic, attempts: attempt + 1 });
            throw new ModelFailure("Invalid model response stream", { category: "invalid_response", attempts: attempt + 1 });
          }
          try {
            const reply = await traceSpan("model.http.parse", async () => parseAndValidateResponse(rawText), attemptFields);
            finishAttempt("ok");
            return reply;
          } catch (error) {
            throw new ModelFailure(error instanceof Error ? error.message : "Invalid model response", { category: "invalid_response", attempts: attempt + 1 });
          }
        } finally {
          finishAttempt("error");
        }
      }

      throw new Error("Model request failed after maximum retry attempts");
    } finally {
      clearTimeout(timeoutId);
    }
  }

}
