import type { FetchLike } from "./ilink.js";
import { NOTIFICATION_LIMIT, NOTIFICATION_CHAT_LIMIT, NOTIFICATION_TIMEOUT_MS, NOTIFICATION_RESPONSE_BYTES, NOTIFICATION_RECEIPT_RETRIES,
  notificationObject, notificationUuid, parseNotification, type Notification } from "./notifications.js";

class NotificationHttpError extends Error {
  constructor(public readonly status: number) { super(`Controller notification request HTTP ${status}`); }
}
class NotificationJsonError extends Error {
  constructor() { super("Controller notification response schema invalid"); }
}
async function beforeDeadline<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { return await Promise.race([pending, aborted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
export class NotificationClient {
  constructor(private readonly baseUrl: string, private readonly token: string, private readonly fetchImpl: FetchLike,
    private readonly timeoutMs = NOTIFICATION_TIMEOUT_MS) {}

  private async request(path: string, body?: Record<string, unknown>, retries = 0): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), this.timeoutMs);
      try {
        const response = await beforeDeadline(this.fetchImpl(`${this.baseUrl}/v1/notifications${path}`, {
          method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: abort.signal,
        }), abort.signal);
        abort.signal.throwIfAborted();
        if (!response.ok) throw new NotificationHttpError(response.status);
        if (!response.body) throw new Error("Controller notification response schema invalid");
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8", { fatal: true });
        let bytes = 0, text = "";
        try {
          for (;;) {
            const part = await beforeDeadline(reader.read(), abort.signal);
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
          try { return JSON.parse(text) as unknown; }
          catch { throw new NotificationJsonError(); }
        } finally { reader.releaseLock(); }
      } catch (error) {
        if (attempt >= retries || error instanceof NotificationHttpError && error.status < 500 ||
            error instanceof NotificationJsonError || error instanceof TypeError && !abort.signal.aborted &&
            error.message.includes("encoded data")) throw error;
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
    const value = notificationObject(await this.request("/pending", { chatIds }), ["items"]);
    if (!Array.isArray(value.items) || value.items.length > NOTIFICATION_LIMIT) throw new Error("Controller notification response schema invalid");
    const items = value.items.map(parseNotification);
    if (new Set(items.map(item => item.id)).size !== items.length || items.some(item => item.status !== "pending" || !chatIds.includes(item.chatId))) {
      throw new Error("Controller notification response schema invalid");
    }
    return items;
  }
  private async record(path: string, id: string, body?: Record<string, unknown>, retries = 0): Promise<Notification> {
    notificationUuid(id);
    const value = notificationObject(await this.request(`/${id}${path}`, body, retries), ["notification"]);
    const notification = parseNotification(value.notification);
    if (notification.id !== id) throw new Error("Controller notification identity mismatch");
    return notification;
  }
  public getNotification(id: string): Promise<Notification> { return this.record("", id); }
  public async claimNotification(id: string, attemptId: string): Promise<Notification> {
    notificationUuid(attemptId);
    const item = await this.record("/claim", id, { attemptId });
    if (item.status !== "claimed" || item.attemptId !== attemptId) throw new Error("Controller notification claim identity mismatch");
    return item;
  }
  public async recordNotificationReceipt(id: string, attemptId: string, status: "accepted" | "uncertain"): Promise<Notification> {
    notificationUuid(attemptId);
    if (status !== "accepted" && status !== "uncertain") throw new Error("Invalid notification receipt status");
    const item = await this.record("/receipt", id, { attemptId, status }, NOTIFICATION_RECEIPT_RETRIES);
    if (item.attemptId !== attemptId || !["accepted", "uncertain"].includes(item.status) || status === "accepted" && item.status !== "accepted") {
      throw new Error("Controller notification receipt identity mismatch");
    }
    return item;
  }
}
