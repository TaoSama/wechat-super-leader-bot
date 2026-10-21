import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export type TraceFields = Record<string, string | number | boolean | null | undefined>;
export interface MessageTrace {
  traceId: string;
  attemptId: string;
  started: number;
  sink: (event: Record<string, unknown>) => void;
}
const context = new AsyncLocalStorage<MessageTrace>();
const instanceId = randomUUID();
const FIELD_NAMES = new Set([
  "durationMs", "outcome", "spanId", "threadId", "turnId", "itemId", "itemType", "tool",
  "status", "exitCode", "timingCoverage", "inputTokens", "cachedInputTokens", "outputTokens",
  "batchId", "batchIndex", "batchCount", "batchWaitMs", "platformCreatedAtMs", "platformToReceivedMs",
  "clockSkew", "chars", "chunkIndex", "chunkCount", "acknowledgedChunks", "attempt", "httpStatus",
  "source", "receiptStatus", "recovery", "firstEventMs", "firstAgentMessageMs", "streamDrainMs",
  "eventCount", "itemCount", "reason", "model", "purpose", "toolCalls", "inputChars", "outputChars",
  "nativeTurnIdAvailable", "ttftAvailable", "usageAvailable", "pendingItems", "coverage", "commandId",
  "cacheWriteInputTokens", "reasoningOutputTokens", "queued", "isTool", "startObserved",
  "turnCompletedObserved", "firstEventObserved", "untrackedItemStarts", "cliExitTimeAvailable",
  "aborted", "emptyReply", "failed",
]);
let warned = false;

export function createMessageTrace(chatId: string, messageId: string,
  sink: MessageTrace["sink"] = event => console.info(JSON.stringify(event))): MessageTrace {
  return { traceId: createHash("sha256").update(JSON.stringify([chatId, messageId])).digest("hex"),
    attemptId: randomUUID(), started: performance.now(), sink };
}
export function currentTrace(): MessageTrace | undefined { return context.getStore(); }
export function runWithTrace<T>(trace: MessageTrace | undefined, action: () => T): T {
  return context.run(trace as MessageTrace, action);
}
export function traceEvent(stage: string, fields: TraceFields = {}): void {
  const trace = currentTrace();
  if (!trace) return;
  const safe: TraceFields = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!FIELD_NAMES.has(key) || value === undefined) continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    safe[key] = typeof value === "string" ? value.slice(0, 128) : value;
  }
  try {
    trace.sink({ schema: 1, event: "message_latency", service: "gateway", instanceId,
      traceId: trace.traceId, attemptId: trace.attemptId, stage,
      timestamp: new Date().toISOString(), elapsedMs: performance.now() - trace.started, ...safe });
  } catch {
    if (!warned) {
      warned = true;
      try { process.stderr.write("[telemetry] event sink failed\n"); }
      catch { /* Both logging channels are unavailable; preserve the delivery result. */ }
    }
  }
}
export async function traceSpan<T>(stage: string, action: () => Promise<T>, fields: TraceFields = {}): Promise<T> {
  const started = performance.now();
  const spanId = randomUUID();
  traceEvent(`${stage}.start`, { ...fields, spanId });
  try {
    const value = await action();
    traceEvent(`${stage}.end`, { ...fields, spanId, durationMs: performance.now() - started, outcome: "ok" });
    return value;
  } catch (error) {
    traceEvent(`${stage}.end`, { ...fields, spanId, durationMs: performance.now() - started, outcome: "error" });
    throw error;
  }
}
