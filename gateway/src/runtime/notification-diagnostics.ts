import { notificationFailure, observeRequests, safeErrorFacts, type RequestObservation,
  type RequestOperation } from "./request-diagnostics.js";
import { sanitizeErrorType } from "./health.js";
import { InvalidRecoveryStateError, MAX_PENDING_FAILURES, stageKey, type NotificationRecoveryStore,
  type PendingFailure } from "./notification-recovery-store.js";

const MAX_REPORTED_FAILURES = 8;
type Failure = ReturnType<typeof notificationFailure>;

/** Independent of inbound poll health. A skipped request is not recovery evidence. */
export class NotificationCycleDiagnostics {
  private ready = false;
  private restored = false;
  private firstFailedAt?: number;
  private lastFailedAt?: number;
  private consecutiveFailures = 0;
  private totalFailures = 0;
  private lastSucceededAt?: string;
  private readonly pending = new Map<string, PendingFailure>();
  private readonly recoveredOperations = new Set<RequestOperation>();
  private evidenceOverflow = false;
  private dirty = false;
  private persistFailing = false;
  constructor(private readonly retryDelayMs: number,
    private readonly sink: (event: Record<string, unknown>) => void = event => {
      process.stderr.write(JSON.stringify(event) + "\n");
    }, private readonly now: () => number = Date.now,
    /** Persistence is diagnostics only; its failures never reach the notification cycle. */
    private readonly store?: NotificationRecoveryStore) {}

  async run<T>(action: () => Promise<T>, active: () => boolean, reportable: (error: unknown) => boolean): Promise<T> {
    if (!this.restored) this.restore();
    const observation: RequestObservation = { successes: new Set(), failures: new Map() };
    let value: T;
    try {
      value = await observeRequests(observation, action);
    } catch (error) {
      if (active() && reportable(error)) this.failed(error, observation);
      throw error;
    }
    if (active()) this.succeeded(observation);
    return value;
  }
  private restore(): void {
    this.restored = true;
    if (!this.store) return;
    let loaded: ReturnType<NotificationRecoveryStore["load"]>;
    try {
      loaded = this.store.load(this.now());
    } catch (error) {
      this.discard(error instanceof InvalidRecoveryStateError ? "invalid" : "unreadable", safeErrorFacts(error));
      return;
    }
    if (loaded.kind === "absent") return;
    if (loaded.kind === "expired") {
      this.discard("expired", { ageMs: loaded.ageMs, unresolvedFailures: loaded.unresolvedFailures });
      return;
    }
    const { evidence } = loaded, now = this.now();
    this.firstFailedAt = evidence.firstFailedAt;
    this.lastFailedAt = evidence.lastFailedAt;
    this.totalFailures = evidence.totalFailures;
    this.consecutiveFailures = evidence.consecutiveFailures;
    this.lastSucceededAt = evidence.lastSucceededAt;
    this.evidenceOverflow = evidence.evidenceOverflow;
    for (const operation of evidence.recoveredOperations) this.recoveredOperations.add(operation);
    for (const [key, failure] of evidence.pending) this.pending.set(key, failure);
    this.emit("notification_cycle_restored", { unresolvedFailures: this.pending.size, totalFailures: this.totalFailures,
      ageMs: Math.max(0, now - evidence.firstFailedAt), lastFailureAgeMs: Math.max(0, now - evidence.lastFailedAt),
      recoveryEvidenceOverflow: this.evidenceOverflow });
  }
  private discard(reason: "expired" | "invalid" | "unreadable", fields: Record<string, unknown>): void {
    this.emit("notification_cycle_restore_discarded", { reason, ...fields });
    try {
      this.store?.clear();
    } catch (error) {
      this.persistFailed(error);
    }
  }
  private persist(): void {
    if (!this.store || !this.dirty) return;
    try {
      if (this.firstFailedAt === undefined || this.lastFailedAt === undefined) this.store.clear();
      else this.store.save({ firstFailedAt: this.firstFailedAt, lastFailedAt: this.lastFailedAt,
        totalFailures: this.totalFailures, consecutiveFailures: this.consecutiveFailures,
        ...(this.lastSucceededAt === undefined ? {} : { lastSucceededAt: this.lastSucceededAt }),
        evidenceOverflow: this.evidenceOverflow, recoveredOperations: [...this.recoveredOperations], pending: this.pending });
      this.dirty = false;
      this.persistFailing = false;
    } catch (error) {
      // Stay dirty so the next completed cycle retries; log only the transition into failure.
      this.persistFailed(error);
    }
  }
  private persistFailed(error: unknown): void {
    if (!this.persistFailing) this.emit("notification_cycle_persist_failed", safeErrorFacts(error));
    this.persistFailing = true;
  }
  private clearCompleted(successes: Set<string>): void {
    for (const key of successes) {
      const failure = this.pending.get(key);
      if (!failure) continue;
      if (failure.operation) this.recoveredOperations.add(failure.operation);
      this.pending.delete(key);
      this.dirty = true;
    }
  }
  private emit(event: string, fields: Record<string, unknown>): void {
    this.sink({ event, service: "gateway", timestamp: new Date(this.now()).toISOString(), ...fields });
  }
  private rememberFailures(observation: RequestObservation): void {
    const now = this.now();
    for (const [key, failure] of observation.failures) {
      const previous = this.pending.get(key);
      if (previous || this.pending.size < MAX_PENDING_FAILURES) this.pending.set(key, pendingFailure(failure, now, previous));
      else this.evidenceOverflow = true;
      this.dirty = true;
    }
  }
  private failed(error: unknown, observation: RequestObservation): void {
    this.clearCompleted(observation.successes);
    const failure = notificationFailure(error), { key, request, stage, errorName, causeCodes } = failure;
    observation.failures.set(key ?? stageKey(stage), failure);
    this.rememberFailures(observation);
    this.firstFailedAt ??= this.now();
    this.lastFailedAt = this.now();
    this.consecutiveFailures++;
    this.totalFailures++;
    this.dirty = true;
    this.emit("notification_cycle_failed", { stage, ...request, errorName, causeCodes,
      errorType: sanitizeErrorType(error), consecutiveFailures: this.consecutiveFailures, totalFailures: this.totalFailures,
      lastSucceededAt: this.lastSucceededAt ?? null, retryScheduled: true, retryDelayMs: this.retryDelayMs,
      failedRequests: [...observation.failures.values()].slice(0, MAX_REPORTED_FAILURES).map(item => ({
        stage: item.stage, ...item.request, errorName: item.errorName, causeCodes: item.causeCodes,
      })), unresolvedFailures: this.pending.size, recoveryEvidenceOverflow: this.evidenceOverflow });
    this.persist();
  }
  private succeeded(observation: RequestObservation): void {
    this.clearCompleted(observation.successes);
    this.rememberFailures(observation);
    if (this.pending.size || this.evidenceOverflow) {
      this.persist();
      return;
    }
    // A stage without matching request evidence remains unresolved, even if a later cycle skips it.
    if (this.firstFailedAt !== undefined) {
      this.emit("notification_cycle_recovered", { totalFailures: this.totalFailures, elapsedMs: this.now() - this.firstFailedAt,
        recoveredOperations: [...this.recoveredOperations] });
      this.recoveredOperations.clear();
      this.firstFailedAt = undefined;
      this.lastFailedAt = undefined;
      this.dirty = true;
    } else if (!this.ready) this.emit("notification_cycle_ready", {});
    this.lastSucceededAt = new Date(this.now()).toISOString();
    this.consecutiveFailures = 0;
    this.ready = true;
    this.persist();
  }
}

/** Keeps only fixed request facts; per-identity counts span cycles and restarts. */
function pendingFailure(failure: Failure, now: number, previous?: PendingFailure): PendingFailure {
  const { request } = failure;
  return { stage: failure.stage, ...(request ? { operation: request.operation, phase: request.phase } : {}),
    ...(request?.httpStatus === undefined ? {} : { httpStatus: request.httpStatus }),
    errorName: failure.errorName, causeCodes: failure.causeCodes, count: (previous?.count ?? 0) + 1,
    firstFailedAt: previous?.firstFailedAt ?? now, lastFailedAt: now };
}
