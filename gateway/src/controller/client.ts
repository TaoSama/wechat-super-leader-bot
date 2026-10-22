import { performance } from "node:perf_hooks";
import { currentTrace, traceEvent } from "../runtime/telemetry.js";
import { ControllerMessageRequest, ControllerMessageResponse } from "../types.js";
import { FetchLike } from "../wechat/client.js";
import { CHAT_AUTHORIZATION_TIMEOUT_MS, DEFAULT_CONTROLLER_TIMEOUT_MS, DEFAULT_CONTROLLER_MAX_RETRIES } from "../runtime/budgets.js";
import { NotificationClient } from "./notification-client.js";
import { NOTIFICATION_TIMEOUT_MS, type NotificationDeferReason } from "./notification-contract.js";
import { downloadControllerImage } from "./image-client.js";
import type { ImageAttachment } from "../wechat/media-delivery.js";
import { getControllerMessageReply, parseControllerReply } from "./reply-client.js";
import { readMessageStream, type ForwardMessageProgress } from "./message-stream.js";
import { beforeAbort } from "../runtime/abort.js";
import { QUERY_PROGRESS_LIMIT } from "../leader/progress.js";
export type { ForwardMessageProgress } from "./message-stream.js";
export { DEFAULT_CONTROLLER_TIMEOUT_MS } from "../runtime/budgets.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export class ChatNotAllowedError extends Error {
  public readonly chatId: string;
  constructor(chatId: string) {
    super(`Chat "${chatId}" is not allowed by Controller`);
    this.name = "ChatNotAllowedError";
    this.chatId = chatId;
  }
}

export function validateControllerUrl(rawUrl: string, allowInsecureController: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid CONTROLLER_URL; must be a valid URL string");
  }
  if (parsed.username || parsed.password) {
    throw new Error("CONTROLLER_URL must not contain user credentials (userinfo)");
  }
  if (parsed.search) {
    throw new Error("CONTROLLER_URL must not contain query parameters");
  }
  if (parsed.hash) {
    throw new Error("CONTROLLER_URL must not contain URL fragments");
  }
  if (parsed.protocol === "https:") {
    return parsed.toString().replace(/\/+$/, "");
  }
  if (parsed.protocol === "http:") {
    const hostname = parsed.hostname.toLowerCase();
    if (LOOPBACK_HOSTS.has(hostname) || allowInsecureController) {
      return parsed.toString().replace(/\/+$/, "");
    }
    throw new Error(
      "Remote CONTROLLER_URL must use https://. Plain http:// is only allowed on loopback (127.0.0.1/localhost/::1) unless ALLOW_INSECURE_CONTROLLER=true is explicitly set for private container networks."
    );
  }
  throw new Error(`Unsupported protocol "${parsed.protocol}" in CONTROLLER_URL; expected https: or loopback http:`);
}

export class ControllerClient {
  public readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly notifications: NotificationClient;

  constructor(options: {
    controllerUrl: string;
    controllerToken: string;
    allowInsecureController?: boolean;
    timeoutMs?: number;
    maxRetries?: number;
    fetchImpl?: FetchLike;
  }) {
    if (!options.controllerToken || !options.controllerToken.trim()) {
      throw new Error("Missing CONTROLLER_TOKEN; required for authenticating with Controller /v1/messages");
    }
    this.baseUrl = validateControllerUrl(options.controllerUrl, Boolean(options.allowInsecureController));
    this.token = options.controllerToken.trim();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CONTROLLER_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_CONTROLLER_MAX_RETRIES;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > DEFAULT_CONTROLLER_TIMEOUT_MS ||
      !Number.isSafeInteger(this.maxRetries) || this.maxRetries < 0 || this.maxRetries > DEFAULT_CONTROLLER_MAX_RETRIES) {
      throw new Error("Invalid Controller request timeout or retry budget");
    }
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.notifications = new NotificationClient(this.baseUrl, this.token, this.fetchImpl, Math.min(this.timeoutMs, NOTIFICATION_TIMEOUT_MS));
  }

  public get requestBudgetMs(): number { return this.timeoutMs * (this.maxRetries + 1); }
  public get authorizationBudgetMs(): number { return Math.min(this.timeoutMs, CHAT_AUTHORIZATION_TIMEOUT_MS); }

  public downloadImage(request: { chatId: string; messageId: string; image: ImageAttachment }, signal?: AbortSignal): Promise<Buffer> {
    return downloadControllerImage({ baseUrl: this.baseUrl, token: this.token, fetchImpl: this.fetchImpl,
      timeoutMs: this.timeoutMs }, request, signal);
  }

  public async assertChatAllowed(chatId: string): Promise<void> {
    if (!chatId.trim()) throw new Error("Invalid Controller chat authorization request");
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error("Controller chat authorization timed out"));
      }, this.authorizationBudgetMs);
    });
    try {
      const result = (async () => {
        const response = await this.fetchImpl(`${this.baseUrl}/v1/chats/authorize`, {
          method: "POST", redirect: "error", signal: abort.signal,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
          body: JSON.stringify({ chatId }),
        });
        abort.signal.throwIfAborted();
        if (!response.ok && response.status !== 403) {
          throw new Error(`Controller chat authorization failed HTTP ${response.status}`);
        }
        let data: unknown;
        try { data = await response.json(); }
        catch {
          if (response.status !== 403) throw new Error("Controller chat authorization returned invalid response schema");
          data = {};
        }
        abort.signal.throwIfAborted();
        if (response.status === 403 && data && typeof data === "object" &&
            (data as Record<string, unknown>).code === "CHAT_NOT_ALLOWED") throw new ChatNotAllowedError(chatId);
        if (!response.ok) throw new Error(`Controller chat authorization failed HTTP ${response.status}`);
        if (!data || typeof data !== "object" || Array.isArray(data) ||
            Object.keys(data).length !== 1 || (data as Record<string, unknown>).allowed !== true) {
          throw new Error("Controller chat authorization returned invalid response schema");
        }
      })();
      await Promise.race([result, expired]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      abort.abort();
    }
  }
  public listNotifications(chatIds: string[]) { return this.notifications.listNotifications(chatIds); }
  public getMessageReply(chatId: string, messageId: string): Promise<ControllerMessageResponse> {
    return getControllerMessageReply({ baseUrl: this.baseUrl, token: this.token, fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs }, chatId, messageId);
  }
  public getNotification(id: string) { return this.notifications.getNotification(id); }
  public claimNotification(id: string, attemptId: string) { return this.notifications.claimNotification(id, attemptId); }
  public deferNotification(id: string, attemptId: string, reason: NotificationDeferReason) {
    return this.notifications.deferNotification(id, attemptId, reason);
  }
  public recordNotificationReceipt(id: string, attemptId: string, status: "accepted" | "uncertain") {
    return this.notifications.recordNotificationReceipt(id, attemptId, status);
  }

  public async forwardMessage(req: ControllerMessageRequest, progress?: ForwardMessageProgress): Promise<ControllerMessageResponse> {
    if (!req.chatId || !req.messageId || !req.text) {
      throw new Error("ControllerMessageRequest requires non-empty chatId, messageId, and text");
    }
    if (progress && (!Number.isInteger(progress.progressRemaining) || progress.progressRemaining < 0 ||
      progress.progressRemaining > QUERY_PROGRESS_LIMIT || typeof progress.onProgress !== "function")) {
      throw new Error("Invalid Controller progress budget");
    }
    const url = `${this.baseUrl}/v1/messages`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const started = performance.now();
      let outcome = "error";
      traceEvent("controller.http.start", { attempt });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const pendingResponse = this.fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.token}`,
            ...(currentTrace() ? { "X-Latency-Attempt": currentTrace()!.attemptId } : {}),
            ...(progress ? { Accept: "application/x-ndjson", "X-Progress-Remaining": String(progress.progressRemaining) } : {}),
          },
          body: JSON.stringify({
            chatId: req.chatId,
            messageId: req.messageId,
            text: req.text,
          }),
          redirect: "error",
          signal: controller.signal,
        });
        const response = await (progress ? beforeAbort(pendingResponse, controller.signal) : pendingResponse);

        traceEvent("controller.http.headers", { attempt, httpStatus: response.status, durationMs: performance.now() - started });
        if (response.status === 403) {
          let errCode = "";
          try {
            const errBody = await response.json() as Record<string, unknown>;
            if (typeof errBody?.code === "string") errCode = errBody.code;
          } catch (parseErr: unknown) {
            // Non-JSON 403 body; treat as generic auth failure rather than CHAT_NOT_ALLOWED
            errCode = "";
          }
          if (errCode === "CHAT_NOT_ALLOWED") {
            throw new ChatNotAllowedError(req.chatId);
          }
          throw new Error("Controller authentication/authorization failed (HTTP 403); verify CONTROLLER_TOKEN");
        }

        if (response.status === 401) {
          throw new Error("Controller authentication failed (HTTP 401); verify CONTROLLER_TOKEN");
        }

        if (response.status >= 500 && !progress && attempt < this.maxRetries) {
          outcome = "retry";
          lastError = new Error(`Controller temporary server error (HTTP ${response.status})`);
          continue;
        }

        if (!response.ok) {
          // Never output unverified server body to prevent leaking sensitive tokens or internal traces
          throw new Error(`Controller /v1/messages returned HTTP ${response.status}`);
        }

        const streamed = response.headers.get("content-type")?.split(";")[0] === "application/x-ndjson";
        if (streamed && !progress) throw new Error("Controller /v1/messages returned invalid response schema (unexpected stream)");
        const reply = streamed
          ? await readMessageStream(response, progress!, controller.signal)
          : parseControllerReply(await beforeAbort(response.json(), controller.signal), "/v1/messages");
        outcome = "ok";
        return reply;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        // Do not retry poison chats, auth, or schema validation errors
        if (progress || error instanceof ChatNotAllowedError ||
            error.message.includes("authentication") ||
            error.message.includes("returned HTTP 4") ||
            error.message.includes("invalid response schema")) {
          throw error;
        }
        lastError = error;
        if (attempt >= this.maxRetries) {
          throw lastError;
        }
      } finally {
        traceEvent("controller.http.end", { attempt, outcome, durationMs: performance.now() - started });
        clearTimeout(timer);
        controller.abort();
      }
    }
    throw lastError || new Error("Controller request failed");
  }
}
