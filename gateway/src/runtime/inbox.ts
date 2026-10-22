import * as fs from "node:fs";
import type { InboundWeChatMessage } from "../types.js";
import { OutboxBackpressureError } from "./delivery-state.js";
import { resolvePath, writePrivateJsonSync } from "./state.js";

export const INBOUND_INBOX_MAX_BYTES = 16 * 1024 * 1024;
export const INBOUND_INBOX_TEXT_MAX_BYTES = 256 * 1024;
const ID_MAX_BYTES = 4096;
const CONTEXT_MAX_BYTES = 16 * 1024;
const SCHEMA_VERSION = 1;
const MAX_ITEMS = 10_000;
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

/** Full inbound text is durable before a poll cursor advances or a running turn receives a steer. */
export class FileInboundInbox {
  private readonly path: string;
  private fingerprint: string;
  private items = new Map<string, InboundWeChatMessage>();

  constructor(path: string, private readonly accountFingerprint: () => string, private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_ITEMS) throw new Error("Invalid inbound inbox capacity");
    this.path = resolvePath(path);
    this.fingerprint = this.currentFingerprint();
    let fd: number;
    try { fd = fs.openSync(this.path, "r"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let raw: unknown;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > INBOUND_INBOX_MAX_BYTES) throw new Error("Inbound inbox exceeds byte budget");
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
    if (fingerprint !== this.fingerprint) { this.save(new Map()); return; }
    if (loaded.size > limit) throw new OutboxBackpressureError();
    this.items = loaded;
  }

  private currentFingerprint(): string { return string(this.accountFingerprint(), ID_MAX_BYTES); }

  private account(): void {
    const current = this.currentFingerprint();
    if (current === this.fingerprint) return;
    const empty = new Map<string, InboundWeChatMessage>();
    this.save(empty, current);
    this.items = empty;
    this.fingerprint = current;
  }

  private save(items: Map<string, InboundWeChatMessage>, fingerprint = this.fingerprint): void {
    const state = { version: SCHEMA_VERSION, fingerprint, items: [...items.values()] };
    if (Buffer.byteLength(JSON.stringify(state, null, 2) + "\n", "utf8") > INBOUND_INBOX_MAX_BYTES) {
      throw new OutboxBackpressureError();
    }
    writePrivateJsonSync(this.path, state);
  }

  list(): InboundWeChatMessage[] { this.account(); return [...this.items.values()].map(item => ({ ...item })); }

  has(key: string): boolean { this.account(); return this.items.has(string(key, ID_MAX_BYTES)); }

  put(value: InboundWeChatMessage): void {
    this.account();
    const validated = message(value), previous = this.items.get(validated.deliveryKey);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(validated)) throw new InboxConflictError();
      return;
    }
    if (this.items.size >= this.limit) throw new OutboxBackpressureError();
    const next = new Map(this.items);
    next.set(validated.deliveryKey, validated);
    this.save(next);
    this.items = next;
  }

  remove(key: string): void {
    this.account();
    string(key, ID_MAX_BYTES);
    if (!this.items.has(key)) return;
    const next = new Map(this.items);
    next.delete(key);
    this.save(next);
    this.items = next;
  }
}
