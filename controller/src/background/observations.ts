import type { BackgroundSourceReader, BackgroundWorker, SourceObservation } from "./contracts.js";

/** Only completed observations with an exact source-run receipt are retained between polls. */
export async function observeSources(worker: BackgroundWorker, reader: BackgroundSourceReader, now: number): Promise<BackgroundWorker["observations"]> {
  return Promise.all(worker.spec.sources.map(async source => {
    const expectedAt = worker.scheduledAt + source.offsetMs;
    const notAfter = Math.min(expectedAt + source.windowMs, worker.deadlineAt);
    const previous = worker.observations.find(item => item.nodeId === source.nodeId && item.automationId === source.automationId &&
      item.expectedAt === expectedAt && item.notAfter === notAfter && item.status === "completed");
    if (previous) return previous;
    let observation: SourceObservation;
    try { observation = await reader.inspectAutomation(source.nodeId, { automationId: source.automationId, expectedAt, notAfter }); }
    catch (error) {
      observation = { automationId: source.automationId, expectedAt, notAfter, observedAt: now, status: "unknown", sources: [],
        reason: error instanceof Error ? error.message : String(error) };
    }
    if (observation.automationId !== source.automationId || observation.expectedAt !== expectedAt || observation.notAfter !== notAfter) {
      observation = { automationId: source.automationId, expectedAt, notAfter, observedAt: now, status: "unknown", sources: [], reason: "source_identity_mismatch" };
    } else if (observation.status === "completed" && (!observation.sessionId || !observation.turnId || !observation.text?.trim())) {
      observation = { ...observation, status: "unknown", reason: "completion_receipt_or_result_missing" };
    }
    return { ...observation, nodeId: source.nodeId };
  }));
}
export function observationInput(worker: BackgroundWorker, now: number): unknown {
  return {
    task: worker.spec.prompt, scheduledAt: new Date(worker.scheduledAt).toISOString(),
    deadlineAt: new Date(worker.deadlineAt).toISOString(), deadlineReached: now >= worker.deadlineAt,
    observations: worker.observations,
    missing: worker.observations.filter(item => item.status !== "completed").map(item => ({ nodeId: item.nodeId,
      automationId: item.automationId, status: item.status, reason: item.reason })),
    instructions: "来源仅用于只读观察。区分未完成、失败和不可达；不可达不能推断失败。根据本轮证据分析结果，明确缺项和时间；不要催促、重跑或修改源会话。",
  };
}
export function fallbackSummary(worker: BackgroundWorker, reason: string): string {
  const lines = worker.observations.map(item => `${item.nodeId}/${item.automationId}: ${item.status}${item.reason ? ` (${item.reason})` : ""}${item.text ? `\n${item.text}` : ""}`);
  return [reason, ...lines, worker.observations.length ? "以上为本轮已取得结果；未完成或不可达项没有被视为成功。" : "未取得本轮结果。"].join("\n");
}
