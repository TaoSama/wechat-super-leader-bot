import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import fs from "node:fs";

export type TraceFields = Record<string, string | number | boolean | null | undefined>;
export interface MessageTrace {
  traceId: string;
  attemptId: string;
  started: number;
  parentAttemptId?: string;
  sink: (event: Record<string, unknown>) => void;
}
const context = new AsyncLocalStorage<MessageTrace>();
const instanceId = randomUUID();
const STDERR_FD = 2;
const FIELD_NAMES = new Set([
  "durationMs", "outcome", "spanId", "threadId", "turnId", "itemId", "itemType", "tool",
  "status", "exitCode", "timingCoverage", "inputTokens", "cachedInputTokens", "outputTokens",
  "batchId", "batchIndex", "batchCount", "batchWaitMs", "platformCreatedAtMs", "platformToReceivedMs",
  "clockSkew", "chars", "chunkIndex", "chunkCount", "acknowledgedChunks", "attempt", "httpStatus",
  "source", "receiptStatus", "recovery", "firstEventMs", "firstAgentMessageMs", "streamDrainMs",
  "eventCount", "itemCount", "reason", "model", "purpose", "toolCalls", "inputChars", "outputChars",
  "completionId", "delayMs", "category", "transportPhase", "replayed", "nativeTurnIdAvailable", "ttftAvailable", "usageAvailable", "pendingItems", "coverage", "commandId",
  "cacheWriteInputTokens", "reasoningOutputTokens", "queued", "isTool", "startObserved",
  "turnCompletedObserved", "firstEventObserved", "untrackedItemStarts", "cliExitTimeAvailable",
  "aborted", "emptyReply", "failed",
]);
let warned = false;

export function createMessageTrace(chatId: string, messageId: string,
  sink: MessageTrace["sink"] = event => { fs.writeSync(STDERR_FD, JSON.stringify(event) + "\n"); },
  parentAttemptId?: string): MessageTrace {
  return { traceId: createHash("sha256").update(JSON.stringify([chatId, messageId])).digest("hex"),
    attemptId: randomUUID(), started: performance.now(), sink,
    ...(validAttemptId(parentAttemptId) ? { parentAttemptId } : {}) };
}
export function validAttemptId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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
    trace.sink({ schema: 1, event: "message_latency", service: "controller", instanceId,
      traceId: trace.traceId, attemptId: trace.attemptId,
      ...(trace.parentAttemptId ? { parentAttemptId: trace.parentAttemptId } : {}), stage,
      timestamp: new Date().toISOString(), elapsedMs: performance.now() - trace.started, ...safe });
  } catch {
    if (!warned) {
      warned = true;
      try { fs.writeSync(STDERR_FD, "[telemetry] event sink failed\n"); } catch { /* No logging failure can affect delivery. */ }
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
