import type { BackgroundWorker } from "./contracts.js";

const TASK_PREVIEW_CHARS = 256;

/** Explicit fields keep workspace paths, receipts and model input out of API responses. */
export function publicBackgroundWorker(worker: BackgroundWorker) {
  return { runId: worker.runId, scheduleId: worker.scheduleId, phase: worker.phase,
    task: worker.spec.prompt.slice(0, TASK_PREVIEW_CHARS), createdAt: worker.createdAt, expiresAt: worker.expiresAt,
    deadlineAt: worker.deadlineAt, nextCheckAt: worker.nextCheckAt, checkCount: worker.checkCount,
    executing: !!worker.activeInvocationId, pendingFollowups: worker.prompts.filter(item => !item.deliveredAt && !item.cancelledAt).length,
    sources: worker.spec.sources.map(({ nodeId, automationId }) => ({ nodeId, automationId })) };
}

export function publicBackgroundDetails(worker: BackgroundWorker) {
  return { ...publicBackgroundWorker(worker), observations: worker.observations,
    result: worker.initialOutcome,
    followups: worker.invocations.filter(item => item.kind === "followup")
      .map(item => ({ status: item.status, result: item.result })) };
}
