import { z } from "zod";
import type { WorkerArtifact, WorkerInspectOptions } from "./worker/contracts.js";
import type { AutomationRun, RunnerOutcome, RunResult } from "../automations/contracts.js";

export const WORKER_LIFETIME_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_OBSERVATION_DEADLINE_MS = 60 * 60 * 1_000;
export const BACKGROUND_LEASE_MS = 60_000;
export const BACKGROUND_LEASE_RENEWAL_MS = 20_000;
export const WORKER_SHUTDOWN_GRACE_MS = 60_000;
export const WORKER_TURN_TIMEOUT_MS = 5 * 60_000;
export const MAX_WORKER_TURN_TIMEOUT_MS = 60 * 60_000;
export const DEFAULT_CHECK_INTERVALS_MS = [120_000, 300_000, 600_000];
export const BackgroundSourceSchema = z.object({
  nodeId: z.string().min(1), automationId: z.string().min(1),
  offsetMs: z.number().int().min(-WORKER_LIFETIME_MS).max(WORKER_LIFETIME_MS).default(0),
  windowMs: z.number().int().min(0).max(WORKER_LIFETIME_MS).default(WORKER_LIFETIME_MS),
}).strict();
export const BackgroundSpecSchema = z.object({
  prompt: z.string().trim().min(1).max(128_000),
  sources: z.array(BackgroundSourceSchema).max(50).default([]),
  preferences: z.array(z.string().max(8_000)).max(50).default([]),
  deadlineMs: z.number().int().positive().max(WORKER_LIFETIME_MS).default(DEFAULT_OBSERVATION_DEADLINE_MS),
  checkIntervalsMs: z.array(z.number().int().min(1_000).max(WORKER_LIFETIME_MS)).min(1).max(20).default(DEFAULT_CHECK_INTERVALS_MS),
}).strict().refine(spec => spec.sources.every(source => source.offsetMs < spec.deadlineMs), {
  message: "Source expected time must precede the monitoring deadline", path: ["sources"],
});
export type BackgroundSpec = z.infer<typeof BackgroundSpecSchema>;
export interface SourceObservation {
  automationId: string; expectedAt: number; notAfter: number;
  status: "waiting" | "running" | "completed" | "failed" | "unknown";
  sessionId?: string; turnId?: string; text?: string; sources: string[]; observedAt: number; reason?: string;
}
export interface BackgroundSourceReader {
  inspectAutomation(nodeId: string, request: { automationId: string; expectedAt: number; notAfter: number }): Promise<SourceObservation>;
}
export interface WorkerInvocation {
  workerId: string; invocationId: string; task: string; preferences?: string[]; input: unknown; timeoutMs?: number;
  launchDeadlineAt?: number; executionDeadlineAt?: number;
}
export interface WorkerReceipt {
  status: "queued" | "running" | "completed" | "waiting" | "needs_attention" | "failed" | "unknown";
  summary?: string; nextCheckAt?: string; threadId?: string; error?: string;
  attachments?: string[];
  artifacts?: WorkerArtifact[];
  receiptMissing?: boolean;
}
/** start is idempotent by invocationId and returns before model completion. inspect never redispatches. */
export interface BackgroundWorkerRuntime {
  start(input: WorkerInvocation): Promise<WorkerReceipt>;
  inspect(workerId: string, invocationId: string, options?: WorkerInspectOptions): Promise<WorkerReceipt>;
  exportArtifacts(workerId: string, invocationId: string): Promise<WorkerArtifact[]>;
  cancel(workerId: string, invocationId: string): Promise<void>;
  cleanup(workerId: string): Promise<void>;
}
export interface BackgroundPrompt {
  requestId: string; prompt: string; createdAt: number; invocationId: string; deliveredAt?: number; notBefore?: number; cancelledAt?: number;
}
export interface BackgroundInvocation {
  id: string; kind: "initial" | "followup"; task: string; input: unknown;
  createdAt: number; status: "prepared" | "running" | "completed" | "failed";
  receipt?: WorkerReceipt; result?: RunResult; exported?: boolean; acceptedAt?: number; discardedAt?: number;
}
export interface BackgroundWorker {
  id: string; runId: string; scheduleId: string; chatId: string; scheduledAt: number;
  spec: BackgroundSpec; specFingerprint?: string; bodyClearedAt?: number; createdAt: number; expiresAt: number; deadlineAt: number;
  phase: "observing" | "executing" | "completed" | "failed" | "expired" | "cleaning" | "cleaned" | "cancelled" | "quarantined";
  checkCount: number; nextCheckAt: number; observations: (SourceObservation & { nodeId: string })[];
  prompts: BackgroundPrompt[]; invocations: BackgroundInvocation[]; activeInvocationId?: string;
  initialOutcome?: RunnerOutcome; initialAcceptedAt?: number; initialDiscardedAt?: number;
  leaseOwner?: string; leaseUntil: number; updatedAt: number; cleanedAt?: number; suspendedAt?: number; cancelRequestedAt?: number;
}
export interface BackgroundRepository {
  create(worker: BackgroundWorker): Promise<BackgroundWorker>;
  get(id: string): Promise<BackgroundWorker | null>;
  getByRun(runId: string): Promise<BackgroundWorker | null>;
  listLive(limit?: number): Promise<BackgroundWorker[]>;
  list(chatId: string, limit?: number): Promise<BackgroundWorker[]>;
  /** Atomic row mutation; callbacks must be synchronous and perform no I/O. */
  update(id: string, mutate: (worker: BackgroundWorker) => void): Promise<BackgroundWorker | null>;
}
export interface BackgroundServiceOptions {
  repository: BackgroundRepository; runtime: BackgroundWorkerRuntime; sources: BackgroundSourceReader;
  deliverSupplement: (worker: BackgroundWorker, invocation: BackgroundInvocation, result: RunResult) => Promise<void>;
  artifactLinks?: (worker: BackgroundWorker, invocation: BackgroundInvocation, artifacts: WorkerArtifact[]) => Promise<string[]>;
  retainDiscardedArtifacts?: (worker: BackgroundWorker, invocation: BackgroundInvocation, artifacts: WorkerArtifact[]) => Promise<void>;
  isAllowed?: (chatId: string) => boolean;
  isStopping?: () => boolean;
  getScheduleStatus?: (scheduleId: string, chatId: string) => Promise<"active" | "paused" | "cancelled" | "completed" | undefined>;
  turnTimeoutMs?: number;
  now?: () => number; onError?: (error: unknown, context: string) => void;
}
export type BackgroundRun = Pick<AutomationRun, "id" | "scheduleId" | "chatId" | "scheduledAt">;
