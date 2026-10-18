import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { writePrivateJsonSync } from "../runtime/state.js";
import { resultObject, resultUuid, type ResultDelivery } from "./contracts.js";

export const RESULT_OUTBOX_LIMIT = 1000;
const RESULT_OUTBOX_BYTES = 4 * 1024 * 1024;
export interface ResultReference {
  id: string; chatId: string; identity: string;
  status: "pending" | "claiming" | "claimed" | "defer" | "waiting" | "receipt";
  attemptId?: string; receiptStatus?: "accepted" | "uncertain"; deferReason?: string; submittedMessages?: number;
}
export interface ResultOutboxStore {
  references(): ResultReference[];
  put(reference: ResultReference): void;
  update(id: string, patch: Partial<ResultReference>): void;
  remove(id: string): void;
  lastDispatchAt(chatId: string): number;
  recordDispatch(chatId: string, at: number): void;
  pendingResumes(): { chatId: string; generation: string }[];
  queueResume(chatId: string, generation: string): void;
  completeResume(chatId: string, generation: string): void;
}
export function resultIdentity(item: ResultDelivery): string {
  return createHash("sha256").update(JSON.stringify([item.id, item.key, item.chatId, item.source.type, item.source.id, item.kind, item.mode,
    item.mode === "download" ? item.messages.slice(0, 1) : item.messages, item.artifact.id, item.artifact.name, item.artifact.size,
    item.artifact.sha256, item.createdAt, item.expiresAt, item.retainedUntil, item.business?.category, item.business?.supersedes])).digest("hex");
}
function validReference(raw: unknown): ResultReference {
  const item = resultObject(raw, ["id", "chatId", "identity", "status", "attemptId", "receiptStatus", "deferReason", "submittedMessages"]);
  resultUuid(item.id);
  if (typeof item.chatId !== "string" || !item.chatId.trim() || item.chatId.length > 512 || typeof item.identity !== "string" || !/^[a-f\d]{64}$/.test(item.identity) ||
    !["pending", "claiming", "claimed", "defer", "waiting", "receipt"].includes(String(item.status)) ||
    item.submittedMessages !== undefined && (!Number.isSafeInteger(item.submittedMessages) || (item.submittedMessages as number) < 0 || (item.submittedMessages as number) > 3)) {
    throw new Error("Invalid result outbox reference");
  }
  if (item.status !== "pending") resultUuid(item.attemptId);
  if (item.status === "receipt" && !["accepted", "uncertain"].includes(String(item.receiptStatus)) ||
    item.status === "defer" && (typeof item.deferReason !== "string" || !item.deferReason.trim() || item.deferReason.length > 128)) throw new Error("Invalid result outbox transition intent");
  return item as unknown as ResultReference;
}

/** Bounded transition references only. This is an API outbox, never a second message budget or send ledger. */
export class FileResultOutbox implements ResultOutboxStore {
  private items: Record<string, ResultReference> = {};
  private dispatchTimes: Record<string, number> = Object.create(null) as Record<string, number>;
  private resumes: Record<string, string> = Object.create(null) as Record<string, string>;
  private fingerprint: string;
  constructor(private readonly path: string, private readonly accountFingerprint: () => string) {
    this.fingerprint = accountFingerprint();
    if (!this.fingerprint) throw new Error("Result outbox requires an active account");
    if (!existsSync(path)) return;
    if (statSync(path).size > RESULT_OUTBOX_BYTES) throw new Error("Result outbox exceeds byte budget");
    let state: Record<string, unknown>;
    try { state = resultObject(JSON.parse(readFileSync(path, "utf8")) as unknown, ["fingerprint", "items", "dispatchTimes", "resumes"]); }
    catch { throw new Error("Failed to read result outbox state"); }
    if (state.fingerprint !== this.fingerprint) return;
    if (!Array.isArray(state.items) || state.items.length > RESULT_OUTBOX_LIMIT || !state.dispatchTimes || typeof state.dispatchTimes !== "object" || Array.isArray(state.dispatchTimes) ||
      Object.keys(state.dispatchTimes).length > RESULT_OUTBOX_LIMIT) throw new Error("Invalid result outbox state");
    for (const raw of state.items) {
      const item = validReference(raw);
      if (this.items[item.id]) throw new Error("Duplicate result outbox reference");
      this.items[item.id] = item;
    }
    for (const [chatId, at] of Object.entries(state.dispatchTimes)) {
      if (!chatId.trim() || chatId.length > 512 || !Number.isSafeInteger(at) || (at as number) < 0) throw new Error("Invalid result outbox dispatch time");
      this.dispatchTimes[chatId] = at as number;
    }
    if (state.resumes !== undefined) {
      if (!state.resumes || typeof state.resumes !== "object" || Array.isArray(state.resumes) || Object.keys(state.resumes).length > RESULT_OUTBOX_LIMIT) throw new Error("Invalid result resume state");
      for (const [chatId, generation] of Object.entries(state.resumes)) {
        if (!chatId.trim() || chatId.length > 512 || typeof generation !== "string" || !generation || generation.length > 512) throw new Error("Invalid result resume reference");
        this.resumes[chatId] = generation;
      }
    }
  }
  private account(): void {
    const current = this.accountFingerprint();
    if (!current) throw new Error("Result outbox account unavailable");
    if (current !== this.fingerprint) {
      this.fingerprint = current; this.items = {}; this.dispatchTimes = Object.create(null) as Record<string, number>; this.resumes = Object.create(null) as Record<string, string>;
      this.save();
    }
  }
  private save(): void { writePrivateJsonSync(this.path, { fingerprint: this.fingerprint, items: Object.values(this.items), dispatchTimes: this.dispatchTimes, resumes: this.resumes }); }
  references(): ResultReference[] { this.account(); return Object.values(this.items).map(item => ({ ...item })); }
  put(reference: ResultReference): void {
    this.account(); validReference(reference);
    const previous = this.items[reference.id];
    if (previous) {
      if (previous.chatId !== reference.chatId || previous.identity !== reference.identity) throw new Error("Result outbox identity changed");
      return;
    }
    if (Object.keys(this.items).length >= RESULT_OUTBOX_LIMIT) throw new Error("Result outbox capacity exhausted");
    this.items[reference.id] = { ...reference };
    try { this.save(); } catch (error) { delete this.items[reference.id]; throw error; }
  }
  update(id: string, patch: Partial<ResultReference>): void {
    this.account(); const previous = this.items[id];
    if (!previous) throw new Error("Missing result outbox reference");
    const next = validReference({ ...previous, ...patch });
    if (next.id !== id || next.chatId !== previous.chatId || next.identity !== previous.identity) throw new Error("Result outbox identity changed");
    this.items[id] = next;
    try { this.save(); } catch (error) { this.items[id] = previous; throw error; }
  }
  remove(id: string): void {
    this.account(); const previous = this.items[id];
    if (!previous) return;
    delete this.items[id];
    try { this.save(); } catch (error) { this.items[id] = previous; throw error; }
  }
  lastDispatchAt(chatId: string): number { this.account(); return this.dispatchTimes[chatId] ?? 0; }
  recordDispatch(chatId: string, at: number): void {
    this.account();
    if (!chatId.trim() || chatId.length > 512 || !Number.isSafeInteger(at) || at < 0) throw new Error("Invalid result dispatch timestamp");
    const previous = { ...this.dispatchTimes };
    this.dispatchTimes[chatId] = at;
    if (Object.keys(this.dispatchTimes).length > RESULT_OUTBOX_LIMIT) {
      const oldest = Object.entries(this.dispatchTimes).sort((a, b) => a[1] - b[1])[0][0];
      delete this.dispatchTimes[oldest];
    }
    try { this.save(); } catch (error) { this.dispatchTimes = previous; throw error; }
  }
  pendingResumes(): { chatId: string; generation: string }[] { this.account(); return Object.entries(this.resumes).map(([chatId, generation]) => ({ chatId, generation })); }
  queueResume(chatId: string, generation: string): void {
    this.account();
    if (!chatId.trim() || chatId.length > 512 || !generation || generation.length > 512) throw new Error("Invalid result resume reference");
    const previous = this.resumes[chatId];
    if (previous === generation) return;
    if (previous === undefined && Object.keys(this.resumes).length >= RESULT_OUTBOX_LIMIT) throw new Error("Result resume outbox capacity exhausted");
    this.resumes[chatId] = generation;
    try { this.save(); } catch (error) { if (previous === undefined) delete this.resumes[chatId]; else this.resumes[chatId] = previous; throw error; }
  }
  completeResume(chatId: string, generation: string): void {
    this.account();
    if (this.resumes[chatId] !== generation) return;
    delete this.resumes[chatId];
    try { this.save(); } catch (error) { this.resumes[chatId] = generation; throw error; }
  }
  protectsDeliveryKey(key: string): boolean {
    this.account();
    const match = /^result:([^:]+):step:/.exec(key);
    return Boolean(match && this.items[match[1]]);
  }
}
