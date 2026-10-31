import type { FetchLike } from "../wechat/client.js";
import { beforeAbort } from "../runtime/abort.js";
import { RequestDiagnostics, type RequestOperation } from "../runtime/request-diagnostics.js";
import { NOTIFICATION_LIMIT, NOTIFICATION_CHAT_LIMIT, NOTIFICATION_TIMEOUT_MS, NOTIFICATION_RESPONSE_BYTES, NOTIFICATION_RECEIPT_RETRIES,
  notificationObject, notificationUuid, notificationDeferReason, parseNotification, type Notification, type NotificationDeferReason } from "./notification-contract.js";

class NotificationHttpError extends Error {
  constructor(public readonly status: number) { super(`Controller notification request HTTP ${status}`); }
}
class NotificationJsonError extends Error {
  constructor() { super("Controller notification response schema invalid"); }
}
export class NotificationClient {
  constructor(private readonly baseUrl: string, private readonly token: string, private readonly fetchImpl: FetchLike,
    private readonly timeoutMs = NOTIFICATION_TIMEOUT_MS) {}

  private async request<T>(operation: RequestOperation, path: string, parse: (value: unknown) => T, body?: Record<string, unknown>, retries = 0): Promise<T> {
    const diagnostics = new RequestDiagnostics(operation, JSON.stringify([path, body]));
    for (let attempt = 0; ; attempt++) {
      diagnostics.phase = "fetch";
      diagnostics.httpStatus = undefined;
      const abort = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; abort.abort(); }, this.timeoutMs);
      try {
        const response = await beforeAbort(this.fetchImpl(`${this.baseUrl}/v1/notifications${path}`, {
          method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: abort.signal,
        }), abort.signal);
        diagnostics.phase = "headers";
        diagnostics.httpStatus = response.status;
        abort.signal.throwIfAborted();
        if (!response.ok) throw new NotificationHttpError(response.status);
        if (!response.body) throw new Error("Controller notification response schema invalid");
        diagnostics.phase = "body";
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let bytes = 0, text = "";
        try {
          for (;;) {
            const part = await beforeAbort(reader.read(), abort.signal);
            abort.signal.throwIfAborted();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > NOTIFICATION_RESPONSE_BYTES) {
              abort.abort();
              throw new Error("Controller notification response exceeded byte budget");
            }
            text += decoder.decode(part.value, { stream: true });
          }
          text += decoder.decode();
          diagnostics.phase = "decode";
          let value: unknown;
          try { value = JSON.parse(text); } catch { throw new NotificationJsonError(); }
          diagnostics.phase = "validate";
          const result = parse(value);
          diagnostics.success();
          return result;
        } finally { reader.releaseLock(); }
      } catch (error) {
        if (diagnostics.phase === "validate" || attempt >= retries || error instanceof NotificationHttpError && error.status < 500 ||
            error instanceof NotificationJsonError || error instanceof TypeError && !abort.signal.aborted &&
            error.message.includes("encoded data")) {
          diagnostics.failure(error, attempt + 1, retries + 1, timedOut);
          throw error;
        }
      } finally {
        clearTimeout(timer);
        // Abort also releases an unread/erroring fetch body; deadline listeners and reader locks are already removed.
        abort.abort();
      }
    }
  }
  public async listNotifications(chatIds: string[]): Promise<Notification[]> {
    if (!Array.isArray(chatIds) || chatIds.length > NOTIFICATION_CHAT_LIMIT || new Set(chatIds).size !== chatIds.length ||
        chatIds.some(id => typeof id !== "string" || !id.trim())) throw new Error("Invalid notification chatIds");
    return this.request("notification_pending", "/pending", raw => {
      const value = notificationObject(raw, ["items"]);
      if (!Array.isArray(value.items) || value.items.length > NOTIFICATION_LIMIT) throw new Error("Controller notification response schema invalid");
      const items = value.items.map(parseNotification);
      if (new Set(items.map(item => item.id)).size !== items.length || items.some(item => item.status !== "pending" || !chatIds.includes(item.chatId))) {
        throw new Error("Controller notification response schema invalid");
      }
      return items;
    }, { chatIds });
  }
  private async record(operation: RequestOperation, path: string, id: string, body?: Record<string, unknown>,
    options: { retries?: number; validate?: (item: Notification) => void } = {}): Promise<Notification> {
    notificationUuid(id);
    return this.request(operation, `/${id}${path}`, raw => {
      const value = notificationObject(raw, ["notification"]);
      const notification = parseNotification(value.notification);
      if (notification.id !== id) throw new Error("Controller notification identity mismatch");
      options.validate?.(notification);
      return notification;
    }, body, options.retries);
  }
  public getNotification(id: string): Promise<Notification> { return this.record("notification_get", "", id); }
  public async claimNotification(id: string, attemptId: string): Promise<Notification> {
    notificationUuid(attemptId);
    return this.record("notification_claim", "/claim", id, { attemptId }, { validate: item => {
      if (item.status !== "claimed" || item.attemptId !== attemptId) throw new Error("Controller notification claim identity mismatch");
    } });
  }
  public async recordNotificationReceipt(id: string, attemptId: string, status: "accepted" | "uncertain"): Promise<Notification> {
    notificationUuid(attemptId);
    if (status !== "accepted" && status !== "uncertain") throw new Error("Invalid notification receipt status");
    return this.record("notification_receipt", "/receipt", id, { attemptId, status }, { retries: NOTIFICATION_RECEIPT_RETRIES, validate: item => {
      if (item.attemptId !== attemptId || !["accepted", "uncertain"].includes(item.status) || status === "accepted" && item.status !== "accepted") {
        throw new Error("Controller notification receipt identity mismatch");
      }
    } });
  }
  public async deferNotification(id: string, attemptId: string, reason: NotificationDeferReason): Promise<Notification> {
    notificationUuid(attemptId);
    notificationDeferReason(reason);
    return this.record("notification_defer", "/defer", id, { attemptId, reason }, { validate: item => {
      if (item.status !== "pending" || item.lastDeferredAttemptId !== attemptId || item.lastDeferReason !== reason) {
        throw new Error("Controller notification defer identity mismatch");
      }
    } });
  }
}
