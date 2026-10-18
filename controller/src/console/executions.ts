import { z } from "zod";
import type { IStore } from "../store/interface.js";
import { normalizeExecution, ExecutionSchema } from "../leader/plans/execution.js";
import { readExecutionView } from "../leader/plans/view.js";
import { MAX_PLAN_ACTIONS, MAX_RESULT_CODE_POINTS } from "../leader/contracts.js";
import { TurnIdSchema } from "../types.js";
import { consoleCommandReader } from "./command-reader.js";

export const CONSOLE_EXECUTION_LIMIT = 12;
export const CONSOLE_PROMPT_CODE_POINTS = 512;
const timestamp = z.number().int().nonnegative().refine(Number.isSafeInteger);
const identifier = z.string().min(1).max(64);
const stepNumber = z.number().int().min(1).max(MAX_PLAN_ACTIONS);
const RESULT_SOURCE_LIMIT = MAX_PLAN_ACTIONS - 1;
const CLAIMED_SOURCE_STATUSES = new Set(["claimed", "queued", "pending", "accepted", "completed"]);
const length = z.number().int().nonnegative().refine(Number.isSafeInteger);
const ResultSourceSchema = z.object({
  step: stepNumber, commandId: identifier.refine(value => value.trim().length > 0), turnId: TurnIdSchema,
  outputSHA256: z.string().regex(/^[a-f0-9]{64}$/).length(64),
  outputLength: length, excerptLength: length.max(MAX_RESULT_CODE_POINTS), truncated: z.boolean(),
}).strict().refine(source => source.truncated ? source.excerptLength < source.outputLength : source.excerptLength === source.outputLength,
  "Inconsistent result source lengths");
const StepSchema = z.object({
  step: z.number().int().min(1).max(MAX_PLAN_ACTIONS),
  nodeId: identifier, sessionId: identifier,
  prompt: z.string().refine(value => Array.from(value).length <= CONSOLE_PROMPT_CODE_POINTS),
  promptTruncated: z.boolean(),
  dependsOn: z.array(z.number().int().min(1).max(MAX_PLAN_ACTIONS)).max(MAX_PLAN_ACTIONS - 1),
  resultFrom: z.array(stepNumber).max(RESULT_SOURCE_LIMIT),
  resultSources: z.array(ResultSourceSchema).min(1).max(RESULT_SOURCE_LIMIT).optional(),
  status: z.enum(["waiting", "claimed", "queued", "pending", "accepted", "completed", "failed", "uncertain", "cancelled", "expired"]),
  commandId: identifier.optional(), turnId: TurnIdSchema.optional(),
}).strict();
export const ConsoleExecutionsSchema = z.object({
  observedAt: timestamp, limit: z.literal(CONSOLE_EXECUTION_LIMIT), hasMore: z.boolean(),
  items: z.array(z.object({
    id: z.string().uuid(), status: ExecutionSchema.shape.status,
    createdAt: timestamp, expiresAt: timestamp,
    steps: z.array(StepSchema).min(1).max(MAX_PLAN_ACTIONS),
  }).strict().superRefine((plan, context) => {
    for (const [index, step] of plan.steps.entries()) {
      const invalid = step.step !== index + 1 || step.sessionId.startsWith("terminal:") ||
        new Set(step.dependsOn).size !== step.dependsOn.length || step.dependsOn.some(number => number >= step.step) ||
        new Set(step.resultFrom).size !== step.resultFrom.length || step.resultFrom.some(number => !step.dependsOn.includes(number)) ||
        step.resultFrom.length > 0 && CLAIMED_SOURCE_STATUSES.has(step.status) && step.resultSources === undefined ||
        step.resultSources !== undefined && (step.status === "waiting" || step.resultSources.length !== step.resultFrom.length ||
          step.resultSources.some((source, sourceIndex) => {
            const parent = plan.steps[source.step - 1];
            return source.step !== step.resultFrom[sourceIndex] || !parent ||
              parent.commandId !== undefined && parent.commandId !== source.commandId ||
              parent.turnId !== undefined && parent.turnId !== source.turnId;
          }));
      if (invalid) context.addIssue({ code: "custom", message: "Inconsistent execution result sources", path: ["steps", index] });
    }
  })).max(CONSOLE_EXECUTION_LIMIT),
}).strict();
export type ConsoleExecutions = z.infer<typeof ConsoleExecutionsSchema>;

/** Explicit read-only boundary: authority, attempts and raw receipts never enter the DTO. */
export async function readConsoleExecutions(store: IStore, chatIds: readonly string[], observedAt: number, metadataOnly = false): Promise<ConsoleExecutions> {
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
    const view = await readExecutionView(metadataOnly ? consoleCommandReader(store) : store, record, observedAt, metadataOnly);
    return { id: view.id, status: view.status, createdAt: view.createdAt, expiresAt: view.expiresAt,
      steps: view.steps.map(step => {
        const prompt = Array.from(step.prompt);
        return { step: step.step, nodeId: step.nodeId, sessionId: step.sessionId,
          prompt: prompt.slice(0, CONSOLE_PROMPT_CODE_POINTS).join(""), promptTruncated: prompt.length > CONSOLE_PROMPT_CODE_POINTS,
          dependsOn: [...step.dependsOn], resultFrom: [...step.resultFrom], status: step.status,
          ...(step.resultSources === undefined ? {} : { resultSources: step.resultSources.map(source => ({
            step: source.step, commandId: source.commandId, turnId: source.turnId, outputSHA256: source.outputSHA256,
            outputLength: source.outputLength, excerptLength: source.excerptLength, truncated: source.truncated,
          })) }),
          ...(step.commandId === undefined ? {} : { commandId: step.commandId }),
          ...(step.turnId === undefined ? {} : { turnId: step.turnId }) };
      }) };
  }));
  return ConsoleExecutionsSchema.parse({ observedAt, limit: CONSOLE_EXECUTION_LIMIT, hasMore: records.length > CONSOLE_EXECUTION_LIMIT, items });
}
