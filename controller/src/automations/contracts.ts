import { z } from "zod";
import { PostCommandRequestSchema, type SendRoute } from "../types.js";

export const DEFAULT_BUSINESS_TTL_MS = 24 * 60 * 60 * 1000;
export const CLAIM_LEASE_MS = 60_000;
export const MAX_AUTOMATION_TEXT = 128_000;
export const ScheduleTimingSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("at"), at: z.string().datetime({ offset: true }) }).strict(),
  z.object({ type: z.literal("cron"), expression: z.string().min(1).max(128) }).strict(),
]);
const base = {
  title: z.string().trim().min(1).max(256),
  timing: ScheduleTimingSchema,
  timezone: z.string().min(1).max(128),
  businessTtlMs: z.number().int().positive().max(365 * DEFAULT_BUSINESS_TTL_MS).default(DEFAULT_BUSINESS_TTL_MS),
  retention: z.enum(["latest", "retain"]).default("latest"),
};
export const CreateScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ ...base, kind: z.literal("reminder"), text: z.string().trim().min(1).max(MAX_AUTOMATION_TEXT) }).strict(),
  z.object({ ...base, kind: z.literal("session"), prompt: PostCommandRequestSchema.shape.prompt.unwrap().trim().min(1),
    nodeId: PostCommandRequestSchema.shape.nodeId, sessionId: PostCommandRequestSchema.shape.sessionId,
    monitor: z.boolean().default(false) }).strict(),
]);
export type CreateSchedule = z.infer<typeof CreateScheduleSchema>;
export type FrozenTarget = { nodeId: string; sessionId: string; sendRoute: SendRoute };
export type Schedule = CreateSchedule & {
  id: string; chatId: string; authorizedMessageId: string;
  status: "active" | "paused" | "cancelled" | "completed";
  nextAt: number | null; createdAt: number; updatedAt: number;
  activeRunId?: string; target?: FrozenTarget;
  lastFingerprint?: string; lastOutcome?: "completed" | "failed";
};
export type RunStatus = "dispatching" | "running" | "completed" | "failed" | "unknown" | "expired" | "skipped";
export type RunResult = { text: string; meaningful?: boolean; fingerprint?: string; error?: string };
export interface AutomationRun {
  id: string; scheduleId: string; chatId: string; scheduledAt: number;
  status: RunStatus; createdAt: number; updatedAt: number;
  claimOwner: string; claimUntil: number; commandId?: string;
  result?: RunResult; error?: string; bodyClearedAt?: number;
}
export interface AutomationOutbox {
  id: string; scheduleId: string; runId: string; chatId: string;
  kind: "completed" | "failed" | "recovered";
  text: string; createdAt: number; expiresAt: number;
  status: "pending" | "published" | "superseded" | "expired";
  bodyClearedAt?: number;
}
export type RunnerOutcome =
  | { status: "running"; commandId?: string; error?: string }
  | { status: "completed" | "failed"; result: RunResult }
  | { status: "unknown"; error: string }
  | { status: "skipped"; reason: "paused" | "cancelled" };
export interface AutomationRunner {
  start(run: AutomationRun, schedule: Schedule): Promise<RunnerOutcome>;
  inspect(run: AutomationRun, schedule: Schedule): Promise<RunnerOutcome>;
}
export interface AutomationRepository {
  create(schedule: Schedule): Promise<Schedule>;
  get(id: string, chatId: string): Promise<Schedule | null>;
  list(chatId: string): Promise<Schedule[]>;
  setStatus(id: string, chatId: string, status: "active" | "paused" | "cancelled", now: number): Promise<Schedule | null>;
  listRuns(id: string, chatId: string, limit?: number): Promise<AutomationRun[]>;
  claimDue(now: number, owner: string, limit: number): Promise<{ schedule: Schedule; run: AutomationRun }[]>;
  claimRunning(now: number, owner: string, limit: number): Promise<{ schedule: Schedule; run: AutomationRun }[]>;
  finish(runId: string, owner: string, outcome: RunnerOutcome, now: number): Promise<boolean>;
  pendingOutbox(now: number, limit?: number, excludeIds?: readonly string[]): Promise<AutomationOutbox[]>;
  markPublished(id: string): Promise<void>;
  cleanupBodies(now: number, retentionMs: number): Promise<{ runs: number; outbox: number }>;
}
