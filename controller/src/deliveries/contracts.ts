export const RESULT_MESSAGE_CHARS = 3800;
export const RESULT_TEXT_MESSAGE_LIMIT = 3;
export const DEFAULT_RESULT_FILE_BYTES = 50 * 1024 * 1024;
export const DEFAULT_RESULT_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const PREPARATION_LEASE_MS = 60_000;
export const SIGNED_DOWNLOAD_TTL_MS = 15 * 60_000;
export const DELIVERY_ATTEMPT_MS = 30 * 60_000;
export const MAX_CATCHUP_SOURCES = 8;
export const MAX_CATCHUP_ARTIFACT_BYTES = 32 * 1024 * 1024;
const RETRYABLE_DEFER_REASONS = new Set(["not_submitted", "artifact_unavailable", "reply_pending", "attempt_expired"]);

export interface ResultInput {
  id?: string;
  key: string;
  chatId: string;
  text: string;
  source: { type: string; id: string };
  kind: string;
  createdAt: number;
  expiresAt: number;
  business?: { category?: string; supersedes?: string };
  /** Internal reservation set; never part of the Gateway transport DTO. */
  catchupSourceIds?: string[];
  resumeGeneration?: string;
}
export interface ResultArtifact {
  id: string;
  chatId: string;
  name: string;
  size: number;
  sha256: string;
  expiresAt: number;
}
export interface StoredResultArtifact extends ResultArtifact { bytes: Buffer }
export interface DeliveryPlan {
  id: string;
  key: string;
  chatId: string;
  source: ResultInput["source"];
  kind: string;
  business?: ResultInput["business"];
  status: "preparing" | "ready" | "claimed" | "waiting_for_user" | "accepted" | "uncertain" | "superseded";
  mode: "text" | "attachment" | "download";
  messages: string[];
  artifact: ResultArtifact;
  createdAt: number;
  expiresAt: number;
  retainedUntil: number;
  preparation?: { token: string; until: number };
  error?: string;
  attemptId?: string;
  attemptedAt?: number;
  attemptExpiresAt?: number;
  deferReason?: string;
  submittedMessages?: number;
  lastDeferredAttemptId?: string;
  lastDeferReason?: string;
  lastDeferredAt?: number;
  catchupSourceIds?: string[];
  catchupId?: string;
  resumeGeneration?: string;
}
export interface MaterializedDelivery extends DeliveryPlan {
  artifact: ResultArtifact & { downloadUrl: string };
}
export interface DeliveryRepository {
  createIfAbsent(plan: DeliveryPlan, artifact: StoredResultArtifact, now?: number): Promise<DeliveryPlan>;
  get(id: string, now?: number): Promise<DeliveryPlan | null>;
  getByKey(key: string): Promise<DeliveryPlan | null>;
  list(chatIds: readonly string[], limit?: number): Promise<DeliveryPlan[]>;
  /** A cursor scan for maintenance work, independent from the bounded recent UI list. */
  listMaintenance(chatIds: readonly string[], now: number, afterId?: string, limit?: number): Promise<DeliveryPlan[]>;
  getArtifact(id: string): Promise<StoredResultArtifact | null>;
  claimPreparation(id: string, token: string, now: number): Promise<DeliveryPlan | null>;
  finishPreparation(id: string, token: string, messages: string[], error?: string, now?: number): Promise<DeliveryPlan | null>;
  listCatchupCandidates(chatId: string, now: number, limit?: number): Promise<DeliveryPlan[]>;
  listResumeCandidates(chatId: string, now: number, limit?: number): Promise<DeliveryPlan[]>;
  getResumeRecord(chatId: string, generation: string): Promise<{ resumed: number } | null>;
  listPending(chatIds: readonly string[], now: number, limit?: number): Promise<DeliveryPlan[]>;
  claim(id: string, attemptId: string, now: number): Promise<DeliveryPlan | null>;
  defer(id: string, attemptId: string, reason: string, now: number, submittedMessages?: number): Promise<DeliveryPlan | null>;
  resumeChat(chatId: string, now: number, generation?: string, sourceIds?: readonly string[]): Promise<number>;
  markChatWaiting(chatId: string, reason: string, now: number): Promise<number>;
  recordReceipt(id: string, status: "accepted" | "uncertain", attemptId: string): Promise<DeliveryPlan | null>;
  prune(now: number): Promise<number>;
}

export function claimDelivery(plan: DeliveryPlan, attemptId: string, now: number): DeliveryPlan | null {
  if (plan.attemptId === attemptId && ["claimed", "accepted", "uncertain"].includes(plan.status)) {
    return plan.status === "claimed" && (plan.attemptExpiresAt ?? 0) <= now ? { ...plan, status: "uncertain" } : plan;
  }
  if (plan.status !== "ready" || plan.expiresAt <= now || plan.retainedUntil <= now || plan.createdAt > now) return null;
  return { ...plan, status: "claimed", attemptId, attemptedAt: now, attemptExpiresAt: now + DELIVERY_ATTEMPT_MS };
}

export function receiptDelivery(plan: DeliveryPlan, status: "accepted" | "uncertain", attemptId: string): DeliveryPlan | null {
  if (!["claimed", "accepted", "uncertain"].includes(plan.status) || plan.attemptId !== attemptId) return null;
  return { ...plan, status: plan.status === "accepted" ? "accepted" : status };
}

export function deferDelivery(plan: DeliveryPlan, attemptId: string, reason: string, now: number, submittedMessages = 0): DeliveryPlan | null {
  if (plan.lastDeferredAttemptId === attemptId) return plan.lastDeferReason === reason ? plan : null;
  if (plan.status !== "claimed" || plan.attemptId !== attemptId || (plan.attemptExpiresAt ?? 0) <= now) return null;
  const { attemptId: _attempt, attemptedAt: _at, attemptExpiresAt: _expires, ...rest } = plan;
  return { ...rest, status: RETRYABLE_DEFER_REASONS.has(reason) ? "ready" : "waiting_for_user", deferReason: reason,
    submittedMessages: Math.max(plan.submittedMessages ?? 0, submittedMessages),
    lastDeferredAttemptId: attemptId, lastDeferReason: reason, lastDeferredAt: now };
}

export function canSupersede(older: DeliveryPlan, newer: DeliveryPlan): boolean {
  if (older.chatId !== newer.chatId || older.id === newer.id || older.createdAt > newer.createdAt ||
    !["ready", "preparing", "waiting_for_user"].includes(older.status) || older.catchupId || (older.submittedMessages ?? 0) > 0) return false;
  const sameSourceProgress = older.kind === "progress" && older.source.type === newer.source.type && older.source.id === newer.source.id;
  return sameSourceProgress || Boolean(older.business?.supersedes && older.business.supersedes === newer.business?.supersedes);
}

/** Exact UTF-16 budget, preserving every character and never dividing an emoji. */
export function splitResultMessages(text: string, maxChars = RESULT_MESSAGE_CHARS): string[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 2) throw new RangeError("Invalid result message budget");
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + maxChars);
    const last = text.charCodeAt(end - 1), next = text.charCodeAt(end);
    if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
    chunks.push(text.slice(offset, end));
    offset = end;
  }
  return chunks;
}

export function assertSameResult(existing: DeliveryPlan, candidate: DeliveryPlan): void {
  if (existing.key !== candidate.key || existing.chatId !== candidate.chatId || existing.kind !== candidate.kind ||
      existing.source.type !== candidate.source.type || existing.source.id !== candidate.source.id ||
      existing.artifact.sha256 !== candidate.artifact.sha256 || existing.createdAt !== candidate.createdAt ||
      existing.expiresAt !== candidate.expiresAt || existing.business?.category !== candidate.business?.category ||
      existing.business?.supersedes !== candidate.business?.supersedes ||
      JSON.stringify(existing.catchupSourceIds) !== JSON.stringify(candidate.catchupSourceIds)) {
    throw new Error("Result idempotency key already belongs to different immutable content");
  }
}
