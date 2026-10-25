import * as fs from "node:fs";
import * as path from "node:path";
import type { InboundWeChatMessage } from "../types.js";
import { OutboxBackpressureError } from "./delivery-state.js";
import { resolvePath, writePrivateJsonSync } from "./state.js";

export const INBOUND_INBOX_MAX_BYTES = 16 * 1024 * 1024;
export const INBOUND_INBOX_TEXT_MAX_BYTES = 256 * 1024;
const ID_MAX_BYTES = 4096;
const CONTEXT_MAX_BYTES = 16 * 1024;
const SCHEMA_VERSION = 1;
const MAX_ITEMS = 10_000;
const LOCK_WAIT_TIMEOUT_MS = 10_000;
const LOCK_RETRY_DELAY_MS = 10;
const LOCK_STALE_AFTER_MS = 60_000;
const MESSAGE_FIELDS = new Set(["chatId", "text", "messageId", "deliveryKey", "contextToken", "createdAtMs"]);
const STATE_FIELDS = new Set(["version", "fingerprint", "items"]);

export class InboxConflictError extends Error {
  constructor() { super("Durable inbound message identity or content changed"); this.name = "InboxConflictError"; }
}

function object(value: unknown, fields: Set<string>): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some(key => !fields.has(key))) throw new Error("Invalid inbound inbox schema");
  return value as Record<string, unknown>;
}

function string(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new Error("Invalid inbound inbox string");
  }
  return value;
}

function message(value: unknown): InboundWeChatMessage {
  const raw = object(value, MESSAGE_FIELDS);
  const result: InboundWeChatMessage = {
    chatId: string(raw.chatId, ID_MAX_BYTES), text: string(raw.text, INBOUND_INBOX_TEXT_MAX_BYTES),
    messageId: string(raw.messageId, ID_MAX_BYTES), deliveryKey: string(raw.deliveryKey, ID_MAX_BYTES),
  };
  if (raw.contextToken !== undefined) result.contextToken = string(raw.contextToken, CONTEXT_MAX_BYTES);
  if (raw.createdAtMs !== undefined) {
    if (!Number.isSafeInteger(raw.createdAtMs) || (raw.createdAtMs as number) < 0) throw new Error("Invalid inbound inbox timestamp");
    result.createdAtMs = raw.createdAtMs as number;
  }
  return result;
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function reclaimableLock(lockPath: string): boolean {
  let stat: fs.Stats;
  try { stat = fs.statSync(lockPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (Date.now() - stat.mtimeMs < LOCK_STALE_AFTER_MS) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(lockPath, "utf8")) as { pid?: unknown };
    return typeof raw.pid !== "number" || !Number.isSafeInteger(raw.pid) || raw.pid <= 0 || !processIsAlive(raw.pid);
  } catch (error) {
    if (error instanceof SyntaxError) return true;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function withFileLock<T>(targetPath: string, action: () => T): T {
  const lockPath = `${targetPath}.lock`;
  const startedAt = Date.now();
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  while (true) {
    let fd: number | undefined;
    try {
      fs.mkdirSync(path.dirname(resolvePath(targetPath)), { recursive: true, mode: 0o700 });
      fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      try { return action(); }
      finally {
        try { fs.unlinkSync(lockPath); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    } catch (error) {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch (closeError) {
          if ((closeError as NodeJS.ErrnoException).code !== "EBADF") throw closeError;
        }
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (reclaimableLock(lockPath)) {
        try { fs.unlinkSync(lockPath); } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
        }
        continue;
      }
      if (Date.now() - startedAt >= LOCK_WAIT_TIMEOUT_MS) throw new Error("Timed out waiting for inbound inbox lock");
      Atomics.wait(waitBuffer, 0, 0, LOCK_RETRY_DELAY_MS);
    }
  }
}

/** Full inbound text is durable before a poll cursor advances or a running turn receives a steer. */
export class FileInboundInbox {
  private readonly path: string;
  private fingerprint: string;
  private items = new Map<string, InboundWeChatMessage>();

  constructor(path: string, private readonly accountFingerprint: () => string, private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_ITEMS) throw new Error("Invalid inbound inbox capacity");
    this.path = resolvePath(path);
    this.fingerprint = this.currentFingerprint();
    const state = this.read();
    if (!state) return;
    if (state.fingerprint !== this.fingerprint) {
      withFileLock(this.path, () => {
        const latest = this.read();
        if (latest && latest.fingerprint !== this.fingerprint) this.save(new Map());
      });
      return;
    }
    if (state.items.size > limit) throw new OutboxBackpressureError();
    this.items = state.items;
  }

  private currentFingerprint(): string { return string(this.accountFingerprint(), ID_MAX_BYTES); }

  private account(): void {
    const current = this.currentFingerprint();
    if (current === this.fingerprint) return;
    const empty = new Map<string, InboundWeChatMessage>();
    withFileLock(this.path, () => {
      const latest = this.read({ directoryError: "eisdir" });
      if (!latest || latest.fingerprint !== current) this.save(empty, current);
    });
    this.items = empty;
    this.fingerprint = current;
  }

  private read(options: { directoryError?: "budget" | "eisdir" } = {}): { fingerprint: string; items: Map<string, InboundWeChatMessage> } | undefined {
    let fd: number;
    try { fd = fs.openSync(this.path, "r"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let raw: unknown;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) {
        if (options.directoryError === "eisdir") {
          const error = new Error("EISDIR: inbound inbox path is a directory") as NodeJS.ErrnoException;
          error.code = "EISDIR";
          throw error;
        }
        throw new Error("Inbound inbox exceeds byte budget");
      }
      if (stat.size > INBOUND_INBOX_MAX_BYTES) throw new Error("Inbound inbox exceeds byte budget");
      const content = fs.readFileSync(fd, "utf8");
      if (Buffer.byteLength(content, "utf8") > INBOUND_INBOX_MAX_BYTES) throw new Error("Inbound inbox exceeds byte budget");
      raw = JSON.parse(content) as unknown;
    } finally { fs.closeSync(fd); }
    const state = object(raw, STATE_FIELDS);
    if (state.version !== SCHEMA_VERSION || !Array.isArray(state.items) || state.items.length > MAX_ITEMS) {
      throw new Error("Invalid inbound inbox state");
    }
    const fingerprint = string(state.fingerprint, ID_MAX_BYTES);
    const loaded = new Map<string, InboundWeChatMessage>();
    for (const item of state.items) {
      const validated = message(item);
      if (loaded.has(validated.deliveryKey)) throw new Error("Duplicate inbound inbox delivery key");
      loaded.set(validated.deliveryKey, validated);
    }
    return { fingerprint, items: loaded };
  }

  private reload(): void {
    this.account();
    try {
      if (fs.statSync(this.path).isDirectory()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const state = this.read();
    if (!state || state.fingerprint !== this.fingerprint) {
      this.items = new Map();
      return;
    }
    if (state.items.size > this.limit) throw new OutboxBackpressureError();
    this.items = state.items;
  }

  private save(items: Map<string, InboundWeChatMessage>, fingerprint = this.fingerprint): void {
    const state = { version: SCHEMA_VERSION, fingerprint, items: [...items.values()] };
    if (Buffer.byteLength(JSON.stringify(state, null, 2) + "\n", "utf8") > INBOUND_INBOX_MAX_BYTES) {
      throw new OutboxBackpressureError();
    }
    writePrivateJsonSync(this.path, state);
  }

  list(): InboundWeChatMessage[] { this.reload(); return [...this.items.values()].map(item => ({ ...item })); }

  has(key: string): boolean { this.reload(); return this.items.has(string(key, ID_MAX_BYTES)); }

  put(value: InboundWeChatMessage): void {
    this.account();
    const validated = message(value);
    withFileLock(this.path, () => {
      const state = this.read({ directoryError: "eisdir" });
      if (state && state.fingerprint !== this.fingerprint) throw new Error("Inbound inbox account fingerprint changed");
      const current = state?.items ?? new Map<string, InboundWeChatMessage>();
      const previous = current.get(validated.deliveryKey);
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(validated)) throw new InboxConflictError();
        this.items = current;
        return;
      }
      if (current.size >= this.limit) throw new OutboxBackpressureError();
      const next = new Map(current);
      next.set(validated.deliveryKey, validated);
      this.save(next);
      this.items = next;
    });
  }

  remove(key: string): void {
    this.account();
    string(key, ID_MAX_BYTES);
    withFileLock(this.path, () => {
      const state = this.read({ directoryError: "eisdir" });
      if (state && state.fingerprint !== this.fingerprint) throw new Error("Inbound inbox account fingerprint changed");
      const current = state?.items ?? new Map<string, InboundWeChatMessage>();
      if (!current.has(key)) { this.items = current; return; }
      const next = new Map(current);
      next.delete(key);
      this.save(next);
      this.items = next;
    });
  }
}
