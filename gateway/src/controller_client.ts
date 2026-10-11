import { ControllerMessageRequest, ControllerMessageResponse } from "./types.js";
import { FetchLike } from "./ilink.js";
import { DEFAULT_CONTROLLER_TIMEOUT_MS, DEFAULT_CONTROLLER_MAX_RETRIES } from "./budgets.js";
import { NotificationClient } from "./notification_client.js";
import { NOTIFICATION_TIMEOUT_MS } from "./notifications.js";
export { DEFAULT_CONTROLLER_TIMEOUT_MS } from "./budgets.js";

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
  public listNotifications(chatIds: string[]) { return this.notifications.listNotifications(chatIds); }
  public getNotification(id: string) { return this.notifications.getNotification(id); }
  public claimNotification(id: string, attemptId: string) { return this.notifications.claimNotification(id, attemptId); }
  public recordNotificationReceipt(id: string, attemptId: string, status: "accepted" | "uncertain") {
    return this.notifications.recordNotificationReceipt(id, attemptId, status);
  }

  public async forwardMessage(req: ControllerMessageRequest): Promise<ControllerMessageResponse> {
    if (!req.chatId || !req.messageId || !req.text) {
      throw new Error("ControllerMessageRequest requires non-empty chatId, messageId, and text");
    }
    const url = `${this.baseUrl}/v1/messages`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.token}`,
          },
          body: JSON.stringify({
            chatId: req.chatId,
            messageId: req.messageId,
            text: req.text,
          }),
          redirect: "error",
          signal: controller.signal,
        });

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

        if (response.status >= 500 && attempt < this.maxRetries) {
          lastError = new Error(`Controller temporary server error (HTTP ${response.status})`);
          continue;
        }

        if (!response.ok) {
          // Never output unverified server body to prevent leaking sensitive tokens or internal traces
          throw new Error(`Controller /v1/messages returned HTTP ${response.status}`);
        }

        const data: unknown = await response.json();
        if (typeof data !== "object" || data === null || typeof (data as Record<string, unknown>).text !== "string") {
          throw new Error("Controller /v1/messages returned invalid response schema (missing string text field)");
        }
        const record = data as Record<string, unknown>;
        return {
          text: record.text as string,
          commandId: typeof record.commandId === "string" ? record.commandId : undefined,
        };
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        // Do not retry poison chats, auth, or schema validation errors
        if (error instanceof ChatNotAllowedError ||
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
        clearTimeout(timer);
      }
    }
    throw lastError || new Error("Controller request failed");
  }
}
