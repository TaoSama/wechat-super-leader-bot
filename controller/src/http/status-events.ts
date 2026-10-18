import type { Response } from "express";

export const STATUS_AUTH_INTERVAL_MS = 5000;
export const STATUS_AUTH_DEADLINE_MS = 5000;
export const STATUS_COALESCE_MS = 25;
export const STATUS_MAX_CONNECTIONS = 100;
const MAX_BUFFERED_BYTES = 1024 * 1024;

interface Subscriber {
  response: Response;
  key?: string;
  verify: () => Promise<boolean>;
  checking?: Promise<boolean>;
  cancelCheck?: () => void;
  authDeadline?: ReturnType<typeof setTimeout>;
  drainDeadline?: ReturnType<typeof setTimeout>;
  pendingSnapshot?: string;
  sending: boolean;
  lastSnapshot?: string;
  blocked: boolean;
  closed: boolean;
}

/** One shared snapshot per update; each stream independently retains its authorization. */
export class StatusEvents<T> {
  private subscribers = new Set<Subscriber>();
  private snapshot?: Promise<T>;
  private coalesce?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private publishing = false;
  private pending = false;
  private stopped = false;

  constructor(private readonly load: () => Promise<T>) {}

  readSnapshot(): Promise<T> {
    if (!this.snapshot) {
      this.snapshot = this.load().finally(() => { this.snapshot = undefined; });
    }
    return this.snapshot;
  }

  open(response: Response, verify: () => Promise<boolean>, key?: string): void {
    if (this.stopped || this.subscribers.size >= STATUS_MAX_CONNECTIONS) {
      response.status(503).json({ error: "Status stream temporarily unavailable" });
      return;
    }
    const subscriber: Subscriber = { response, verify, key, blocked: false, closed: false, sending: false };
    this.subscribers.add(subscriber);
    response.status(200).set({ "Content-Type": "text/event-stream", "Cache-Control": "no-store",
      "X-Accel-Buffering": "no", Connection: "keep-alive" });
    response.flushHeaders();
    response.once("close", () => this.close(subscriber));
    response.once("error", () => this.close(subscriber));
    response.on("drain", () => {
      clearTimeout(subscriber.drainDeadline);
      subscriber.drainDeadline = undefined;
      subscriber.blocked = false;
      this.changed();
    });
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => this.tick(), STATUS_AUTH_INTERVAL_MS);
    }
    this.changed();
  }

  changed(): void {
    if (this.stopped || !this.subscribers.size) return;
    this.pending = true;
    if (this.publishing || this.coalesce) return;
    this.coalesce = setTimeout(() => {
      this.coalesce = undefined;
      void this.publish();
    }, STATUS_COALESCE_MS);
  }

  revoke(key: string): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.key === key) this.expire(subscriber);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const subscriber of [...this.subscribers]) this.close(subscriber);
    this.clearTimers();
  }

  private clearTimers(): void {
    if (this.coalesce) clearTimeout(this.coalesce);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.coalesce = undefined;
    this.heartbeat = undefined;
  }

  private close(subscriber: Subscriber): void {
    if (subscriber.closed) return;
    subscriber.closed = true;
    clearTimeout(subscriber.authDeadline);
    clearTimeout(subscriber.drainDeadline);
    subscriber.cancelCheck?.();
    subscriber.pendingSnapshot = undefined;
    this.subscribers.delete(subscriber);
    subscriber.response.removeAllListeners("drain");
    if (subscriber.blocked) subscriber.response.destroy();
    else subscriber.response.end();
    if (!this.subscribers.size) this.clearTimers();
  }

  private expire(subscriber: Subscriber): void {
    if (subscriber.closed) return;
    if (!subscriber.blocked) this.write(subscriber, "event: auth-expired\ndata: {}\n\n");
    this.close(subscriber);
  }

  private async authorized(subscriber: Subscriber): Promise<boolean> {
    if (subscriber.closed) return false;
    if (!subscriber.checking) {
      subscriber.checking = new Promise<boolean>((resolve, reject) => {
        subscriber.cancelCheck = () => resolve(false);
        subscriber.authDeadline = setTimeout(() => resolve(false), STATUS_AUTH_DEADLINE_MS);
        Promise.resolve().then(() => subscriber.verify()).then(resolve, reject);
      }).finally(() => {
        clearTimeout(subscriber.authDeadline);
        subscriber.authDeadline = undefined;
        subscriber.cancelCheck = undefined;
        subscriber.checking = undefined;
      });
    }
    try {
      const valid = await subscriber.checking;
      if (!valid) this.expire(subscriber);
      return valid && !subscriber.closed;
    } catch {
      // Storage failures fail closed without exposing operational details.
      this.close(subscriber);
      return false;
    }
  }

  private write(subscriber: Subscriber, frame: string): boolean {
    if (subscriber.closed || subscriber.blocked) return false;
    if (subscriber.response.writableLength + Buffer.byteLength(frame) > MAX_BUFFERED_BYTES) {
      this.close(subscriber);
      return false;
    }
    try {
      subscriber.blocked = !subscriber.response.write(frame);
      if (subscriber.blocked) {
        subscriber.drainDeadline = setTimeout(() => this.close(subscriber), STATUS_AUTH_INTERVAL_MS);
      }
      return true;
    } catch {
      this.close(subscriber);
      return false;
    }
  }

  private tick(): void {
    for (const subscriber of this.subscribers) {
      void this.authorized(subscriber).then(valid => {
        if (!valid) return;
        // Each blocked write has its own full drain interval, independent of the global heartbeat phase.
        if (!subscriber.blocked) this.write(subscriber, ": heartbeat\n\n");
      });
    }
    this.changed();
  }

  private async sendSnapshot(subscriber: Subscriber, snapshot: string): Promise<void> {
    subscriber.pendingSnapshot = snapshot;
    if (subscriber.sending || subscriber.closed) return;
    subscriber.sending = true;
    try {
      while (!subscriber.closed && subscriber.pendingSnapshot !== undefined) {
        if (!await this.authorized(subscriber)) return;
        // Authorization never stalls other subscribers; keep only this client's latest update.
        const latest = subscriber.pendingSnapshot;
        subscriber.pendingSnapshot = undefined;
        if (latest !== subscriber.lastSnapshot &&
            this.write(subscriber, `event: status\ndata: ${latest}\n\n`)) subscriber.lastSnapshot = latest;
      }
    } finally {
      subscriber.sending = false;
    }
  }

  private async publish(): Promise<void> {
    if (this.publishing || this.stopped || !this.subscribers.size) return;
    this.publishing = true;
    this.pending = false;
    try {
      const snapshot = JSON.stringify(await this.readSnapshot());
      for (const subscriber of this.subscribers) void this.sendSnapshot(subscriber, snapshot);
    } catch {
      for (const subscriber of [...this.subscribers]) this.close(subscriber);
    } finally {
      this.publishing = false;
      if (this.pending) this.changed();
    }
  }
}
