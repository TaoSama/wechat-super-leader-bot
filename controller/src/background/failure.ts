import type { BackgroundInvocation, BackgroundWorker, WorkerReceipt } from "./contracts.js";

const SAFE_FAILURE_CATEGORIES = {
  worker_cancelled_before_launch: "not_started", worker_expired: "expired",
  worker_interrupted: "interrupted", worker_artifact_invalid: "artifact_invalid",
  worker_process_cleanup_unverified: "cleanup_unverified",
} as const;

/** Safe correlation emitted only after the caller has durably accepted the failed receipt. */
export class BackgroundWorkerFailure extends Error {
  readonly diagnostic;
  constructor(worker: BackgroundWorker, invocation: BackgroundInvocation, receipt: WorkerReceipt) {
    super("Background worker failed; durable receipt retained");
    const authentication = receipt.error === "worker_authentication_failed" &&
      receipt.failureDiagnostic?.category === "authentication_failed";
    const known = Object.hasOwn(SAFE_FAILURE_CATEGORIES, receipt.error ?? "")
      ? receipt.error as keyof typeof SAFE_FAILURE_CATEGORIES : undefined;
    const category = authentication ? "authentication_failed" : known ? SAFE_FAILURE_CATEGORIES[known] : "execution_unverified";
    this.diagnostic = {
      event: "background_worker_failed", runId: worker.runId, workerId: worker.id, invocationId: invocation.id,
      category,
      executionEvidence: category === "not_started" ? "not_started" :
        authentication && receipt.failureDiagnostic?.executionEvidence === "tool_activity_observed"
        ? "tool_activity_observed" : "unverified",
    };
  }
}
