import { z } from "zod";

export const FallbackInputSchema = z.object({
  key: z.string().min(1).max(256),
  chatId: z.string().min(1).max(128),
  kind: z.enum(["completed", "failed", "blocked", "expired", "reminder"]),
  title: z.string().min(1).max(256),
  text: z.string().max(2000),
  resultId: z.string().min(1).max(256).optional(),
  resultStatus: z.string().min(1).max(64).optional(),
  expiresAt: z.number().int().nonnegative().optional(),
}).strict();

export type FallbackInput = z.infer<typeof FallbackInputSchema>;
export type FallbackStatus = "pending" | "sending" | "sent" | "failed" | "unknown";
export const DEFAULT_FALLBACK_CLAIM_LEASE_MS = 60_000;
export function validateFallbackLease(leaseMs: number): void {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000) throw new Error("Invalid fallback claim lease");
}
export function validateFallbackCleanup(now: number, retentionMs: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(retentionMs) || retentionMs < 0) {
    throw new Error("Invalid fallback body retention");
  }
}
export const CLEARED_FALLBACK_TITLE = "正文已清理";
export interface FallbackRecord extends FallbackInput {
  id: string;
  status: FallbackStatus;
  createdAt: number;
  updatedAt: number;
  nextAttemptAt: number;
  attempts: number;
  claimToken?: string;
  claimExpiresAt?: number;
  outcome?: string;
  bodyClearedAt?: number;
}

export interface FallbackSettlement {
  status: Exclude<FallbackStatus, "sending">;
  outcome: string;
  nextAttemptAt?: number;
}

export interface FallbackRepository {
  init(now?: number): Promise<void>;
  enqueue(input: FallbackInput, now: number): Promise<FallbackRecord>;
  claim(now: number, leaseMs?: number): Promise<FallbackRecord | undefined>;
  settle(id: string, claimToken: string, settlement: FallbackSettlement, now: number): Promise<void>;
  get(id: string): Promise<FallbackRecord | undefined>;
  list(chatId: string, limit?: number): Promise<FallbackRecord[]>;
  cleanupBodies(now: number, retentionMs: number): Promise<number>;
}
