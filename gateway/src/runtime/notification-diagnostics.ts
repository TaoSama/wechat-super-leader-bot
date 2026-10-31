import { notificationFailure, observeRequests, type RequestObservation } from "./request-diagnostics.js";
import { sanitizeErrorType } from "./health.js";

const MAX_PENDING_FAILURES = 64;
const MAX_REPORTED_FAILURES = 8;
type Failure = ReturnType<typeof notificationFailure>;

/** Independent of inbound poll health. A skipped request is not recovery evidence. */
export class NotificationCycleDiagnostics {
  private ready = false;
  private firstFailedAt?: number;
  private consecutiveFailures = 0;
  private totalFailures = 0;
  private lastSucceededAt?: string;
  private readonly pending = new Map<string, Failure>();
  private readonly recoveredOperations = new Set<string>();
  private evidenceOverflow = false;
  constructor(private readonly retryDelayMs: number,
    private readonly sink: (event: Record<string, unknown>) => void = event => {
      process.stderr.write(JSON.stringify(event) + "\n");
    }, private readonly now: () => number = Date.now) {}

  async run<T>(action: () => Promise<T>, active: () => boolean, reportable: (error: unknown) => boolean): Promise<T> {
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
  private clearCompleted(successes: Set<string>): void {
    for (const key of successes) {
      const failure = this.pending.get(key);
      if (failure?.request) this.recoveredOperations.add(failure.request.operation);
      this.pending.delete(key);
    }
  }
  private emit(event: string, fields: Record<string, unknown>): void {
    this.sink({ event, service: "gateway", timestamp: new Date(this.now()).toISOString(), ...fields });
  }
  private rememberFailures(observation: RequestObservation): void {
    for (const [key, failure] of observation.failures) {
      if (this.pending.size < MAX_PENDING_FAILURES || this.pending.has(key)) this.pending.set(key, failure);
      else this.evidenceOverflow = true;
    }
  }
  private failed(error: unknown, observation: RequestObservation): void {
    this.clearCompleted(observation.successes);
    const failure = notificationFailure(error), { key, request, stage, errorName, causeCodes } = failure;
    const recoveryKey = key ?? `stage:${stage}`;
    observation.failures.set(recoveryKey, failure);
    this.rememberFailures(observation);
    this.firstFailedAt ??= this.now();
    this.consecutiveFailures++;
    this.totalFailures++;
    this.emit("notification_cycle_failed", { stage, ...request, errorName, causeCodes,
      errorType: sanitizeErrorType(error), consecutiveFailures: this.consecutiveFailures, totalFailures: this.totalFailures,
      lastSucceededAt: this.lastSucceededAt ?? null, retryScheduled: true, retryDelayMs: this.retryDelayMs,
      failedRequests: [...observation.failures.values()].slice(0, MAX_REPORTED_FAILURES).map(item => ({
        stage: item.stage, ...item.request, errorName: item.errorName, causeCodes: item.causeCodes,
      })), unresolvedFailures: this.pending.size, recoveryEvidenceOverflow: this.evidenceOverflow });
  }
  private succeeded(observation: RequestObservation): void {
    this.clearCompleted(observation.successes);
    this.rememberFailures(observation);
    if (this.pending.size || this.evidenceOverflow) return;
    // A stage without matching request evidence remains unresolved, even if a later cycle skips it.
    if (this.firstFailedAt !== undefined) {
      this.emit("notification_cycle_recovered", { totalFailures: this.totalFailures, elapsedMs: this.now() - this.firstFailedAt,
        recoveredOperations: [...this.recoveredOperations] });
      this.recoveredOperations.clear();
      this.firstFailedAt = undefined;
    } else if (!this.ready) this.emit("notification_cycle_ready", {});
    this.lastSucceededAt = new Date(this.now()).toISOString();
    this.consecutiveFailures = 0;
    this.ready = true;
  }
}
