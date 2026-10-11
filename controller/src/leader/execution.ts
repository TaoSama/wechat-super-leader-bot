import { createHash } from "node:crypto";
import { z } from "zod";
import { PlanSchema, type Plan } from "./contracts.js";
import { validateChatId } from "./state.js";
import { type CommandRecord } from "../types.js";
import { sameSkillRefs } from "../skills.js";
import { ExecutionInputSchema, normalizeExecutionInput } from "./execution-input.js";

export const EXECUTION_TTL_MS = 24 * 60 * 60 * 1000;
export const EXECUTION_CLAIM_MS = 15_000;
export const EXECUTION_TICK_MS = 2_000;
export const EXECUTION_PAGE_SIZE = 8;
const timestamp = z.number().int().nonnegative().refine(Number.isSafeInteger);
const AttemptSchema = z.object({ token: z.string().uuid(), startedAt: timestamp, expiresAt: timestamp,
  input: ExecutionInputSchema.optional() }).strict();
export const ExecutionSchema = z.object({
  id: z.string().uuid(), chatId: z.string(), revision: z.number().int().positive().refine(Number.isSafeInteger),
  plan: PlanSchema, createdAt: timestamp, expiresAt: timestamp,
  status: z.enum(["active", "completed", "failed", "cancelled", "expired"]),
  attempts: z.array(AttemptSchema.nullable()).min(1).max(4),
}).strict();
export type ExecutionRecord = z.infer<typeof ExecutionSchema>;
export type ExecutionAttempt = z.infer<typeof AttemptSchema>;
export interface CreateExecutionResult { created: boolean; execution: ExecutionRecord }

export function hasTerminalTarget(plan: Pick<Plan, "actions">): boolean {
  return plan.actions.some(action => action.sendRoute === "terminal-pane" || action.sessionId.startsWith("terminal:"));
}

export function assertNativeExecutionPlan(plan: Pick<Plan, "actions">): void {
  if (hasTerminalTarget(plan)) throw new Error("Terminal input cannot participate in a durable execution plan");
}

// Step identity is its one-based position in the immutable, confirmed plan.
// Reordering or editing requires a new plan UUID and another confirmation.
export function validatePlanDependencies(plan: Pick<Plan, "actions">): void {
  const ancestors: Set<number>[] = [];
  const targets = new Map<string, number>();
  for (const [index, action] of plan.actions.entries()) {
    const dependencies = action.dependsOn;
    if (new Set(dependencies).size !== dependencies.length || dependencies.some(step => step < 1 || step > index)) {
      throw new Error("Dependencies must refer to distinct earlier steps");
    }
    const sources = action.resultFrom ?? [];
    if (new Set(sources).size !== sources.length || sources.some(step => !Number.isSafeInteger(step) || step < 1 || step > index || !dependencies.includes(step))) {
      throw new Error("Result sources must refer to distinct direct dependencies");
    }
    const reachable = new Set<number>();
    for (const step of dependencies) {
      reachable.add(step);
      for (const ancestor of ancestors[step - 1]) reachable.add(ancestor);
    }
    const target = JSON.stringify([action.nodeId, action.sessionId]);
    const earlier = targets.get(target);
    if (earlier !== undefined && !reachable.has(earlier)) {
      throw new Error("Tasks for the same session must form a dependency chain");
    }
    targets.set(target, index + 1);
    ancestors.push(reachable);
  }
}

export function normalizeExecution(value: unknown): ExecutionRecord {
  const execution = ExecutionSchema.parse(value);
  assertNativeExecutionPlan(execution.plan);
  validateChatId(execution.chatId);
  validatePlanDependencies(execution.plan);
  if (execution.id !== execution.plan.id || execution.attempts.length !== execution.plan.actions.length ||
      execution.plan.actions.some(action => !action.sendRoute) ||
      execution.expiresAt <= execution.createdAt || execution.expiresAt - execution.createdAt > EXECUTION_TTL_MS ||
      execution.attempts.some(attempt => attempt && (attempt.startedAt < execution.createdAt ||
        attempt.expiresAt <= attempt.startedAt || attempt.expiresAt - attempt.startedAt > EXECUTION_CLAIM_MS))) {
    throw new Error("Invalid confirmed execution record");
  }
  for (const [index, attempt] of execution.attempts.entries()) {
    if (!attempt) continue;
    const action = execution.plan.actions[index], sources = action.resultFrom ?? [];
    if (sources.length) attempt.input = normalizeExecutionInput(action.prompt, sources, attempt.input);
    else if (attempt.input !== undefined) throw new Error("Execution without result sources cannot carry input");
  }
  return execution;
}

export function createExecution(chatId: string, plan: Plan, now: number): ExecutionRecord {
  if (plan.expiresAt <= now) throw new Error("Plan confirmation expired");
  return normalizeExecution({ id: plan.id, chatId, revision: 1, plan, createdAt: now,
    expiresAt: now + EXECUTION_TTL_MS, status: "active", attempts: plan.actions.map(() => null) });
}

export function validateExecutionUpdate(current: ExecutionRecord, next: ExecutionRecord): void {
  if (current.status !== "active" || next.revision !== current.revision + 1 || !sameExecutionAuthorization(current, next)) {
    throw new Error("Confirmed execution is immutable or terminal");
  }
  for (const [index, attempt] of current.attempts.entries()) {
    if (attempt && JSON.stringify(attempt) !== JSON.stringify(next.attempts[index])) {
      throw new Error("Execution attempt cannot be changed or replayed");
    }
  }
}

export function sameExecutionAuthorization(first: ExecutionRecord, second: ExecutionRecord): boolean {
  const immutable = (value: ExecutionRecord) => JSON.stringify([value.id, value.chatId, value.plan, value.createdAt, value.expiresAt]);
  return immutable(first) === immutable(second);
}

export function executionRequestId(execution: Pick<ExecutionRecord, "id" | "chatId">, index: number): string {
  return `leader_exec_${createHash("sha256").update(JSON.stringify([execution.chatId, execution.id, index + 1])).digest("hex")}`;
}

export function matchesExecutionCommand(execution: ExecutionRecord, index: number, command: CommandRecord): boolean {
  const action = execution.plan.actions[index];
  return command.requestId === executionRequestId(execution, index) && command.action === "send" &&
    command.nodeId === action.nodeId && command.sessionId === action.sessionId && command.prompt === executionPrompt(execution, index) &&
    command.sendRoute === action.sendRoute && sameSkillRefs(command.skills, action.skills);
}

export function executionPrompt(execution: ExecutionRecord, index: number): string {
  return execution.attempts[index]?.input?.prompt ?? execution.plan.actions[index].prompt;
}

export function executionPageLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new Error("Invalid execution page limit");
  return limit;
}
