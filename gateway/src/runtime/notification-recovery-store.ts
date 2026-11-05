import * as fs from "node:fs";
import { resolvePath, writePrivateJsonSync } from "./state.js";
import { isSafeCauseCode, isSafeErrorName, NOTIFICATION_STAGES, REQUEST_OPERATIONS, REQUEST_PHASES, requestKey,
  type NotificationStage, type RequestFailure, type RequestOperation } from "./request-diagnostics.js";

export const NOTIFICATION_RECOVERY_STATE_VERSION = 1;
export const MAX_PENDING_FAILURES = 64;
/** Unresolved evidence whose latest failure is older than this no longer describes the current network. */
export const NOTIFICATION_RECOVERY_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_STATE_BYTES = 256 * 1024;
const MAX_CAUSE_CODES = 16;
const MIN_HTTP_STATUS = 100;
const MAX_HTTP_STATUS = 599;
const STAGE_KEY_PREFIX = "stage:";
const IDENTITY_HASH_PATTERN = /^[a-f0-9]{64}$/;
const STAGES: readonly string[] = [...NOTIFICATION_STAGES, "unknown"];

export interface PendingFailure {
  stage: NotificationStage | "unknown";
  operation?: RequestOperation;
  phase?: RequestFailure["phase"];
  httpStatus?: number;
  errorName: string;
  causeCodes: string[];
  count: number;
  firstFailedAt: number;
  lastFailedAt: number;
}
export interface RecoveryEvidence {
  firstFailedAt: number;
  lastFailedAt: number;
  totalFailures: number;
  consecutiveFailures: number;
  lastSucceededAt?: string;
  evidenceOverflow: boolean;
  recoveredOperations: RequestOperation[];
  pending: Map<string, PendingFailure>;
}
export type RecoveryLoad = { kind: "absent" } |
  { kind: "expired"; ageMs: number; unresolvedFailures: number } | { kind: "restored"; evidence: RecoveryEvidence };

export class InvalidRecoveryStateError extends Error {
  constructor() { super("Invalid notification recovery state"); this.name = "InvalidRecoveryStateError"; }
}
function invalid(): never { throw new InvalidRecoveryStateError(); }
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
}
function count(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : invalid();
}
function member<T extends string>(values: readonly T[], value: unknown): T {
  return values.includes(value as T) ? value as T : invalid();
}
export function stageKey(stage: string): string { return STAGE_KEY_PREFIX + stage; }

/** A key is either an operation plus the existing request identity hash, or a fixed stage marker. */
function persistedKey(key: string, failure: PendingFailure): string | undefined {
  if (key === stageKey(failure.stage) && failure.operation === undefined) return undefined;
  const parsed: unknown = JSON.parse(key);
  if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== failure.operation ||
    typeof parsed[1] !== "string" || !IDENTITY_HASH_PATTERN.test(parsed[1])) throw new InvalidRecoveryStateError();
  return parsed[1];
}
function pendingFailure(raw: unknown): [string, PendingFailure] {
  const item = record(raw);
  if (!Array.isArray(item.causeCodes) || item.causeCodes.length > MAX_CAUSE_CODES ||
    !item.causeCodes.every(isSafeCauseCode) || !isSafeErrorName(item.errorName)) invalid();
  const failure: PendingFailure = { stage: member(STAGES, item.stage) as PendingFailure["stage"],
    errorName: item.errorName, causeCodes: [...new Set(item.causeCodes)], count: count(item.count),
    firstFailedAt: count(item.firstFailedAt), lastFailedAt: count(item.lastFailedAt) };
  if (item.operation !== undefined) failure.operation = member(REQUEST_OPERATIONS, item.operation);
  if (item.phase !== undefined) failure.phase = member(REQUEST_PHASES, item.phase);
  if (item.httpStatus !== undefined) {
    const status = count(item.httpStatus);
    if (status < MIN_HTTP_STATUS || status > MAX_HTTP_STATUS) invalid();
    failure.httpStatus = status;
  }
  if (failure.count < 1 || failure.firstFailedAt > failure.lastFailedAt) invalid();
  if (item.identityHash === undefined) {
    if (failure.operation !== undefined) invalid();
    return [stageKey(failure.stage), failure];
  }
  if (failure.operation === undefined || typeof item.identityHash !== "string" ||
    !IDENTITY_HASH_PATTERN.test(item.identityHash)) invalid();
  return [requestKey(failure.operation, item.identityHash), failure];
}

/**
 * Minimal, bounded recovery evidence for one Gateway state directory. It holds only fixed enums,
 * allowlisted codes, counts, timestamps and existing request identity hashes.
 */
export class NotificationRecoveryStore {
  readonly path: string;
  constructor(targetPath: string) { this.path = resolvePath(targetPath); }

  /** Throws InvalidRecoveryStateError for corrupt content and the original error when unreadable. */
  load(now: number): RecoveryLoad {
    let stat: fs.Stats;
    try { stat = fs.statSync(this.path); }
    catch (error) {
      if ((error as { code?: unknown })?.code === "ENOENT") return { kind: "absent" };
      throw error;
    }
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES) invalid();
    const content = fs.readFileSync(this.path, "utf8");
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { invalid(); }
    const state = record(parsed);
    if (state.version !== NOTIFICATION_RECOVERY_STATE_VERSION || typeof state.recoveryEvidenceOverflow !== "boolean" ||
      !Array.isArray(state.unresolved) || state.unresolved.length > MAX_PENDING_FAILURES ||
      !Array.isArray(state.recoveredOperations) || state.recoveredOperations.length > REQUEST_OPERATIONS.length) invalid();
    const evidence: RecoveryEvidence = { firstFailedAt: count(state.firstFailedAt), lastFailedAt: count(state.lastFailedAt),
      totalFailures: count(state.totalFailures), consecutiveFailures: count(state.consecutiveFailures),
      evidenceOverflow: state.recoveryEvidenceOverflow,
      recoveredOperations: [...new Set(state.recoveredOperations.map(operation => member(REQUEST_OPERATIONS, operation)))],
      pending: new Map() };
    if (state.lastSucceededAt !== undefined) {
      if (typeof state.lastSucceededAt !== "string" || Number.isNaN(Date.parse(state.lastSucceededAt))) invalid();
      evidence.lastSucceededAt = new Date(Date.parse(state.lastSucceededAt)).toISOString();
    }
    for (const raw of state.unresolved) {
      const [key, failure] = pendingFailure(raw);
      if (evidence.pending.has(key)) invalid();
      evidence.pending.set(key, failure);
    }
    if (evidence.firstFailedAt > evidence.lastFailedAt || evidence.totalFailures < 1 ||
      !evidence.pending.size && !evidence.evidenceOverflow) invalid();
    const ageMs = Math.max(0, now - evidence.lastFailedAt);
    return ageMs > NOTIFICATION_RECOVERY_EXPIRY_MS
      ? { kind: "expired", ageMs, unresolvedFailures: evidence.pending.size } : { kind: "restored", evidence };
  }

  save(evidence: RecoveryEvidence): void {
    writePrivateJsonSync(this.path, { version: NOTIFICATION_RECOVERY_STATE_VERSION,
      firstFailedAt: evidence.firstFailedAt, lastFailedAt: evidence.lastFailedAt, totalFailures: evidence.totalFailures,
      consecutiveFailures: evidence.consecutiveFailures,
      ...(evidence.lastSucceededAt === undefined ? {} : { lastSucceededAt: evidence.lastSucceededAt }),
      recoveryEvidenceOverflow: evidence.evidenceOverflow, recoveredOperations: evidence.recoveredOperations,
      unresolved: [...evidence.pending].map(([key, failure]) => {
        const identityHash = persistedKey(key, failure);
        return identityHash === undefined ? failure : { identityHash, ...failure };
      }) });
  }

  clear(): void {
    fs.rmSync(this.path, { force: true });
  }
}
