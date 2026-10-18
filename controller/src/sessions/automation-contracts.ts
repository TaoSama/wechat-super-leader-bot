import { z } from "zod";

export const MAX_SOURCE_AUTOMATIONS = 128;
export const MAX_AUTOMATION_RESULT_BYTES = 256 * 1024;
export const AUTOMATION_READ_TIMEOUT_MS = 15_000;
export const SourceAutomationSchema = z.object({
  id: z.string().min(1).max(128), name: z.string().max(512), kind: z.enum(["heartbeat", "cron"]),
  status: z.string().max(32), prompt: z.string().max(65536), rrule: z.string().max(2048),
  targetSessionId: z.string().max(128).optional(), nextRunAt: z.number().int().nonnegative().optional(),
  lastRunAt: z.number().int().nonnegative().optional(),
}).strict();
export type SourceAutomation = z.infer<typeof SourceAutomationSchema>;
export const AutomationInspectOptionsSchema = z.object({
  automationId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  expectedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  notAfter: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict().refine(v => v.notAfter >= v.expectedAt && v.notAfter - v.expectedAt <= 7 * 24 * 3600_000, "Invalid automation window");
export type AutomationInspectOptions = z.infer<typeof AutomationInspectOptionsSchema>;
export const AutomationInspectionSchema = z.object({
  automationId: z.string().min(1).max(128), expectedAt: z.number().int().positive(), notAfter: z.number().int().positive(),
  status: z.enum(["waiting", "running", "completed", "failed", "unknown"]),
  sessionId: z.string().min(1).max(128).optional(), turnId: z.string().min(1).max(128).optional(),
  text: z.string().max(MAX_AUTOMATION_RESULT_BYTES).optional(), sources: z.array(z.string().max(512)).max(12),
  observedAt: z.number().int().positive(), reason: z.string().max(256).optional(),
}).strict().refine(v => v.status !== "completed" || !!(v.sessionId && v.turnId && v.text?.trim() && v.sources.length), "Completion requires exact evidence");
export type AutomationInspection = z.infer<typeof AutomationInspectionSchema>;
export class AutomationError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}
