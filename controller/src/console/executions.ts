import { z } from "zod";
import type { IStore } from "../store/interface.js";
import { normalizeExecution, ExecutionSchema } from "../leader/execution.js";
import { readExecutionView } from "../leader/execution-view.js";
import { MAX_PLAN_ACTIONS } from "../leader/contracts.js";
import { TurnIdSchema } from "../types.js";

export const CONSOLE_EXECUTION_LIMIT = 12;
export const CONSOLE_PROMPT_CODE_POINTS = 512;
const timestamp = z.number().int().nonnegative().refine(Number.isSafeInteger);
const identifier = z.string().min(1).max(64);
const StepSchema = z.object({
  step: z.number().int().min(1).max(MAX_PLAN_ACTIONS),
  nodeId: identifier, sessionId: identifier,
  prompt: z.string().refine(value => Array.from(value).length <= CONSOLE_PROMPT_CODE_POINTS),
  promptTruncated: z.boolean(),
  dependsOn: z.array(z.number().int().min(1).max(MAX_PLAN_ACTIONS)).max(MAX_PLAN_ACTIONS - 1),
  status: z.enum(["waiting", "claimed", "pending", "accepted", "completed", "failed", "uncertain", "cancelled", "expired"]),
  commandId: identifier.optional(), turnId: TurnIdSchema.optional(),
}).strict();
export const ConsoleExecutionsSchema = z.object({
  observedAt: timestamp, limit: z.literal(CONSOLE_EXECUTION_LIMIT), hasMore: z.boolean(),
  items: z.array(z.object({
    id: z.string().uuid(), status: ExecutionSchema.shape.status,
    createdAt: timestamp, expiresAt: timestamp,
    steps: z.array(StepSchema).min(1).max(MAX_PLAN_ACTIONS),
  }).strict()).max(CONSOLE_EXECUTION_LIMIT),
}).strict();
export type ConsoleExecutions = z.infer<typeof ConsoleExecutionsSchema>;

/** Explicit read-only boundary: authority, attempts and raw receipts never enter the DTO. */
export async function readConsoleExecutions(store: IStore, chatIds: readonly string[], observedAt: number): Promise<ConsoleExecutions> {
  timestamp.parse(observedAt);
  const recent = await store.listRecentExecutions(chatIds, CONSOLE_EXECUTION_LIMIT + 1);
  if (!Array.isArray(recent) || recent.length > CONSOLE_EXECUTION_LIMIT + 1) throw new Error("Invalid execution list");
  const allowed = new Set(chatIds);
  const records = recent.map(value => {
    const record = normalizeExecution(value);
    if (!allowed.has(record.chatId)) throw new Error("Execution list contains an unauthorized chat");
    return record;
  });
  const items = await Promise.all(records.slice(0, CONSOLE_EXECUTION_LIMIT).map(async record => {
    const view = await readExecutionView(store, record, observedAt);
    return { id: view.id, status: view.status, createdAt: view.createdAt, expiresAt: view.expiresAt,
      steps: view.steps.map(step => {
        const prompt = Array.from(step.prompt);
        return { step: step.step, nodeId: step.nodeId, sessionId: step.sessionId,
          prompt: prompt.slice(0, CONSOLE_PROMPT_CODE_POINTS).join(""), promptTruncated: prompt.length > CONSOLE_PROMPT_CODE_POINTS,
          dependsOn: [...step.dependsOn], status: step.status,
          ...(step.commandId === undefined ? {} : { commandId: step.commandId }),
          ...(step.turnId === undefined ? {} : { turnId: step.turnId }) };
      }) };
  }));
  return ConsoleExecutionsSchema.parse({ observedAt, limit: CONSOLE_EXECUTION_LIMIT, hasMore: records.length > CONSOLE_EXECUTION_LIMIT, items });
}
