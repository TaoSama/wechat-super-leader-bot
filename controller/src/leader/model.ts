import { URL } from "node:url";
import { responsePayload, responseMessage } from './responses.js';
import { ModelFailure, isQuotaError, providerErrorCode, retryDelay } from './errors.js';

export interface ModelToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ModelToolCall[];
  tool_call_id?: string;
  responseOutput?: Record<string, unknown>[];
}

export interface ModelTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ModelReply {
  content: string | null;
  toolCalls: ModelToolCall[];
  responseOutput?: Record<string, unknown>[];
}

export interface LeaderModel {
  complete(messages: ModelMessage[], tools: ModelTool[], signal?: AbortSignal): Promise<ModelReply>;
}

export interface HttpLeaderModelOptions {
  /**
   * OpenAI-compatible API base URL (typically ending with /v1).
   * HTTPS is required except for loopback hosts (127.0.0.1, localhost, ::1).
   */
  baseUrl: string;
  apiKey: string;
  model: string;
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

const MAX_TOOL_CALLS_PER_REPLY = 32;
const MAX_TOOL_CALL_ID_LENGTH = 128;
const MAX_TOOL_NAME_LENGTH = 128;
const MAX_TOOL_ARGUMENTS_LENGTH = 32 * 1024;
const MAX_CONTENT_LENGTH = 64 * 1024;
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

function cancelBodySafely(body: { cancel(): Promise<unknown> } | null | undefined): void {
  if (!body) return;
  try {
    // Do not let an uncooperative stream's cancellation block the request deadline.
    void body.cancel().catch(() => { console.warn("Model stream cancellation failed"); });
  } catch {
    console.warn("Model stream cancellation failed");
  }
}

async function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Model request aborted");
  }
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Model request aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readBoundedStream(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  signal: AbortSignal
): Promise<string> {
  if (signal.aborted) {
    cancelBodySafely(stream);
    throw signal.reason instanceof Error ? signal.reason : new Error("Model request aborted");
  }
  if (!stream) {
    return "";
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  let abortReject: ((err: Error) => void) | undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    abortReject = reject;
  });

  const onAbort = () => {
    const reason =
      signal.reason instanceof Error ? signal.reason : new Error("Model request aborted");
    if (abortReject) {
      abortReject(reason);
    }
    cancelBodySafely(reader);
  };

  signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (true) {
      if (signal.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Model request aborted");
      }

      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await Promise.race([reader.read(), abortPromise]);
      } catch (readErr: unknown) {
        if (signal.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new Error("Model request aborted");
        }
        void readErr;
        throw new Error("Model response stream read failed");
      }

      const { done, value } = readResult;
      if (done) {
        break;
      }
      if (value) {
        if (!(value instanceof Uint8Array)) {
          cancelBodySafely(reader);
          throw new Error("Invalid model response: stream chunk must be Uint8Array");
        }
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          cancelBodySafely(reader);
          throw new Error(`Model response exceeded maximum allowed size of ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch (releaseErr: unknown) {
      console.warn("Model stream lock release failed");
    }
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(combined);
}

export class HttpLeaderModel implements LeaderModel {
  private endpoint: string;
  private apiKey: string;
  private model: string;
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

    const payload = responsePayload(this.model, messages, tools);

    const bodyString = JSON.stringify(payload);
    const maxAttempts = 3; // 1 initial attempt + max 2 additional retry attempts

    try {
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (combinedSignal.aborted) {
          throw combinedSignal.reason instanceof Error
            ? combinedSignal.reason
            : new Error("Model request aborted");
        }

        let response: Response;
        try {
          response = await this.fetchImpl(this.endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.apiKey}`,
            },
            body: bodyString,
            redirect: "error",
            signal: combinedSignal,
          });
        } catch (fetchErr: unknown) {
          void fetchErr;
          if (combinedSignal.aborted) {
            throw combinedSignal.reason instanceof Error
              ? combinedSignal.reason
              : new Error("Model request aborted");
          }
          // Fixed generic message so provider URLs, headers, or tokens are never echoed
          throw new ModelFailure("Model transport request failed", { category: "transport", attempts: attempt + 1 });
        }

        if (!response || typeof response.status !== "number") {
          throw new Error("Invalid model transport response");
        }

        if (!response.ok) {
          const isJson = response.headers.get("content-type")?.includes("json");
          let code: string | undefined;
          if (response.status === 429 || isJson) {
            try {
              code = providerErrorCode(await readBoundedStream(response.body, this.maxResponseBytes, combinedSignal));
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
          if (RETRYABLE_STATUS_CODES.has(response.status) && !isQuotaError(code) && attempt < maxAttempts - 1) {
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
            try {
              await sleepWithAbort(delayMs, combinedSignal);
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

        const rawText = await readBoundedStream(
          response.body,
          this.maxResponseBytes,
          combinedSignal
        );
        try {
          return this.parseAndValidateResponse(rawText);
        } catch (error) {
          throw new ModelFailure(error instanceof Error ? error.message : "Invalid model response", { category: "invalid_response", attempts: attempt + 1 });
        }
      }

      throw new Error("Model request failed after maximum retry attempts");
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private parseAndValidateResponse(rawText: string): ModelReply {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (parseErr: unknown) {
      void parseErr;
      throw new Error("Invalid model response: body is not valid JSON");
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Invalid model response: root is not an object");
    }

    const root = parsed as Record<string, unknown>;
    const messageObj = responseMessage(root);
    if (
      messageObj.content !== null &&
      messageObj.content !== undefined &&
      typeof messageObj.content !== "string"
    ) {
      throw new Error("Invalid model response: message content must be string or null");
    }

    const content = typeof messageObj.content === "string" ? messageObj.content : null;
    if (content !== null && content.length > MAX_CONTENT_LENGTH) {
      throw new Error(`Invalid model response: message content exceeds bound of ${MAX_CONTENT_LENGTH}`);
    }

    const rawToolCalls = messageObj.tool_calls;
    const toolCalls: ModelToolCall[] = [];
    const seenIds = new Set<string>();

    if (rawToolCalls !== undefined && rawToolCalls !== null) {
      if (!Array.isArray(rawToolCalls)) {
        throw new Error("Invalid model response: tool_calls must be an array");
      }
      if (rawToolCalls.length > MAX_TOOL_CALLS_PER_REPLY) {
        throw new Error(`Invalid model response: tool_calls count exceeds bound of ${MAX_TOOL_CALLS_PER_REPLY}`);
      }

      for (const call of rawToolCalls) {
        if (!call || typeof call !== "object" || Array.isArray(call)) {
          throw new Error("Invalid model response: tool_call must be an object");
        }
        const callObj = call as Record<string, unknown>;
        if (typeof callObj.id !== "string" || callObj.id.trim().length === 0) {
          throw new Error("Invalid model response: tool_call.id must be a non-empty string");
        }
        if (callObj.id.length > MAX_TOOL_CALL_ID_LENGTH) {
          throw new Error(`Invalid model response: tool_call.id length exceeds bound of ${MAX_TOOL_CALL_ID_LENGTH}`);
        }
        if (seenIds.has(callObj.id)) {
          throw new Error("Invalid model response: duplicate tool_call.id");
        }
        seenIds.add(callObj.id);

        if (callObj.type !== "function") {
          throw new Error("Invalid model response: tool_call.type must be function");
        }
        const fn = callObj.function;
        if (!fn || typeof fn !== "object" || Array.isArray(fn)) {
          throw new Error("Invalid model response: tool_call.function must be an object");
        }
        const fnObj = fn as Record<string, unknown>;
        if (typeof fnObj.name !== "string" || fnObj.name.trim().length === 0) {
          throw new Error("Invalid model response: tool_call.function.name must be a non-empty string");
        }
        if (fnObj.name.length > MAX_TOOL_NAME_LENGTH) {
          throw new Error(`Invalid model response: tool_call.function.name length exceeds bound of ${MAX_TOOL_NAME_LENGTH}`);
        }
        if (typeof fnObj.arguments !== "string") {
          throw new Error("Invalid model response: tool_call.function.arguments must be a string");
        }
        if (fnObj.arguments.length > MAX_TOOL_ARGUMENTS_LENGTH) {
          throw new Error(
            `Invalid model response: tool_call.function.arguments length exceeds bound of ${MAX_TOOL_ARGUMENTS_LENGTH}`
          );
        }

        toolCalls.push({
          id: callObj.id,
          type: "function",
          function: {
            name: fnObj.name,
            arguments: fnObj.arguments,
          },
        });
      }
    }

    if (content === null && toolCalls.length === 0) {
      throw new Error("Invalid model response: message has neither content nor tool_calls");
    }

    return {
      content,
      toolCalls,
      responseOutput: messageObj.responseOutput,
    };
  }
}
