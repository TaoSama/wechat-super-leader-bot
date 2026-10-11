import type { ConsoleExecution, ConsoleExecutionStep, ConsoleExecutions } from "./types";

const EXECUTION_LIMIT = 12;
const STEP_LIMIT = 4;
const PROMPT_CODE_POINT_LIMIT = 512;
const MAX_DATE_MS = 8_640_000_000_000_000;
const EXECUTION_STATUSES = new Set(["active", "completed", "failed", "cancelled", "expired"]);
const STEP_STATUSES = new Set(["waiting", "claimed", "pending", "accepted", "completed", "failed", "uncertain", "cancelled", "expired"]);
const INVALID_EXECUTIONS = "持久计划状态格式无效，无法确认计划进度";

function invalid(): never { throw new Error(INVALID_EXECUTIONS); }
function object(raw: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid();
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !fields.includes(key))) return invalid();
  return value;
}
function timestamp(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0 || raw > MAX_DATE_MS) return invalid();
  return raw;
}
function identifier(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) return invalid();
  return raw;
}
function parseStep(raw: unknown, index: number): ConsoleExecutionStep {
  const value = object(raw, ["step", "nodeId", "sessionId", "prompt", "promptTruncated", "dependsOn", "status", "commandId", "turnId"]);
  if (value.step !== index + 1 || typeof value.prompt !== "string" ||
      Array.from(value.prompt).length > PROMPT_CODE_POINT_LIMIT || typeof value.promptTruncated !== "boolean" ||
      typeof value.status !== "string" || !STEP_STATUSES.has(value.status) || !Array.isArray(value.dependsOn)) return invalid();
  const dependsOn = value.dependsOn.map(dependency => {
    if (!Number.isSafeInteger(dependency) || dependency < 1 || dependency > index) return invalid();
    return dependency as number;
  });
  if (new Set(dependsOn).size !== dependsOn.length) return invalid();
  const commandId = value.commandId === undefined ? undefined : identifier(value.commandId);
  const turnId = value.turnId === undefined ? undefined : identifier(value.turnId);
  if ((value.status === "accepted" || value.status === "completed") && (!commandId || !turnId)) return invalid();
  if (turnId && !commandId) return invalid();
  return { step: index + 1, nodeId: identifier(value.nodeId), sessionId: identifier(value.sessionId),
    prompt: value.prompt, promptTruncated: value.promptTruncated, dependsOn,
    status: value.status as ConsoleExecutionStep["status"],
    ...(commandId === undefined ? {} : { commandId }), ...(turnId === undefined ? {} : { turnId }) };
}
function parseExecution(raw: unknown): ConsoleExecution {
  const value = object(raw, ["id", "status", "createdAt", "expiresAt", "steps"]);
  if (typeof value.status !== "string" || !EXECUTION_STATUSES.has(value.status) || !Array.isArray(value.steps) ||
      !value.steps.length || value.steps.length > STEP_LIMIT) return invalid();
  const createdAt = timestamp(value.createdAt), expiresAt = timestamp(value.expiresAt);
  if (expiresAt <= createdAt) return invalid();
  return { id: identifier(value.id), status: value.status as ConsoleExecution["status"], createdAt, expiresAt,
    steps: value.steps.map(parseStep) };
}

/** HTTP and SSE share one required, bounded projection. Invalid data is never an empty plan list. */
export function parseConsoleExecutions(raw: unknown): ConsoleExecutions {
  const value = object(raw, ["observedAt", "limit", "hasMore", "items"]);
  if (value.limit !== EXECUTION_LIMIT || typeof value.hasMore !== "boolean" ||
      !Array.isArray(value.items) || value.items.length > EXECUTION_LIMIT) return invalid();
  const items = value.items.map(parseExecution);
  if (new Set(items.map(item => item.id)).size !== items.length) return invalid();
  return { observedAt: timestamp(value.observedAt), limit: EXECUTION_LIMIT, hasMore: value.hasMore, items };
}
