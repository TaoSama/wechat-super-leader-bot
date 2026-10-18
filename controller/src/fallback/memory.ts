import { randomUUID } from "node:crypto";
import { CLEARED_FALLBACK_TITLE, DEFAULT_FALLBACK_CLAIM_LEASE_MS, validateFallbackCleanup, validateFallbackLease, FallbackInputSchema, type FallbackInput, type FallbackRecord, type FallbackRepository, type FallbackSettlement } from "./contracts.js";

export class MemoryFallbackRepository implements FallbackRepository {
  private readonly records = new Map<string, FallbackRecord>();
  async init(now = Date.now()): Promise<void> {
    this.recoverExpired(now);
  }
  private recoverExpired(now: number): void {
    for (const record of this.records.values()) {
      if (record.status === "sending" && (record.claimExpiresAt ?? record.updatedAt + DEFAULT_FALLBACK_CLAIM_LEASE_MS) <= now) {
        record.status = "unknown";
        record.updatedAt = now;
        record.outcome = "submission_lease_expired";
        delete record.claimToken;
        delete record.claimExpiresAt;
      }
    }
  }
  async enqueue(input: FallbackInput, now: number): Promise<FallbackRecord> {
    const valid = FallbackInputSchema.parse(input);
    const existing = [...this.records.values()].find((record) => record.chatId === valid.chatId && record.key === valid.key);
    if (existing) return structuredClone(existing);
    const record: FallbackRecord = { ...valid, id: randomUUID(), status: "pending", createdAt: now, updatedAt: now, nextAttemptAt: now, attempts: 0 };
    this.records.set(record.id, record);
    return structuredClone(record);
  }
  async claim(now: number, leaseMs = DEFAULT_FALLBACK_CLAIM_LEASE_MS): Promise<FallbackRecord | undefined> {
    validateFallbackLease(leaseMs);
    this.recoverExpired(now);
    for (const record of this.records.values()) {
      if (record.status !== "pending" || record.nextAttemptAt > now) continue;
      if (record.expiresAt !== undefined && record.expiresAt <= now) {
        record.status = "failed";
        record.updatedAt = now;
        record.outcome = "expired_before_submission";
        continue;
      }
      Object.assign(record, { status: "sending", updatedAt: now, attempts: record.attempts + 1, claimToken: randomUUID(), claimExpiresAt: now + leaseMs });
      return structuredClone(record);
    }
    return undefined;
  }
  async settle(id: string, claimToken: string, settlement: FallbackSettlement, now: number): Promise<void> {
    this.recoverExpired(now);
    const record = this.records.get(id);
    if (!record || record.status !== "sending" || record.claimToken !== claimToken) throw new Error("Fallback claim no longer owned");
    Object.assign(record, settlement, { updatedAt: now });
    delete record.claimToken;
    delete record.claimExpiresAt;
  }
  async get(id: string): Promise<FallbackRecord | undefined> {
    const record = this.records.get(id);
    return record && structuredClone(record);
  }
  async list(chatId: string, limit = 100): Promise<FallbackRecord[]> {
    return [...this.records.values()].filter((record) => record.chatId === chatId).slice(-limit).reverse().map((record) => structuredClone(record));
  }
  async cleanupBodies(now: number, retentionMs: number): Promise<number> {
    validateFallbackCleanup(now, retentionMs);
    let cleared = 0;
    for (const record of this.records.values()) {
      if ((record.status !== "sent" && record.status !== "failed") || record.bodyClearedAt !== undefined || record.updatedAt > now - retentionMs) continue;
      record.text = "";
      record.title = CLEARED_FALLBACK_TITLE;
      delete record.outcome;
      record.bodyClearedAt = now;
      cleared++;
    }
    return cleared;
  }
}
