import type { ConsoleExecution, ConsoleExecutionStep, ConsoleExecutions, ExecutionResultSource } from "./types";

const EXECUTION_LIMIT = 12;
const STEP_LIMIT = 4;
const PROMPT_CODE_POINT_LIMIT = 512;
const RESULT_SOURCE_LIMIT = 3;
const EXCERPT_CODE_POINT_LIMIT = 1000;
const MAX_TURN_ID_BYTES = 128;
const MAX_DATE_MS = 8_640_000_000_000_000;
const EXECUTION_STATUSES = new Set(["active", "completed", "failed", "cancelled", "expired"]);
const STEP_STATUSES = new Set(["waiting", "claimed", "pending", "accepted", "completed", "failed", "uncertain", "cancelled", "expired"]);
const CLAIMED_SOURCE_STATUSES = new Set(["claimed", "pending", "accepted", "completed"]);
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
function parseResultSource(raw: unknown): ExecutionResultSource {
  const value = object(raw, ["step", "commandId", "turnId", "outputSHA256", "outputLength", "excerptLength", "truncated"]);
  if (!Number.isSafeInteger(value.step) || Number(value.step) < 1 || Number(value.step) > STEP_LIMIT ||
      typeof value.outputSHA256 !== "string" || value.outputSHA256.length !== 64 || !/^[a-f0-9]{64}$/.test(value.outputSHA256) ||
      !Number.isSafeInteger(value.outputLength) || Number(value.outputLength) < 0 ||
      !Number.isSafeInteger(value.excerptLength) || Number(value.excerptLength) < 0 || Number(value.excerptLength) > EXCERPT_CODE_POINT_LIMIT ||
      typeof value.truncated !== "boolean" ||
      (value.truncated ? Number(value.excerptLength) >= Number(value.outputLength) : value.excerptLength !== value.outputLength)) return invalid();
  const commandId = identifier(value.commandId), turnId = identifier(value.turnId);
  if (commandId.length > 64 || new TextEncoder().encode(turnId).length > MAX_TURN_ID_BYTES ||
      /[\p{White_Space}\p{Cc}\uD800-\uDFFF\uFFFD]/u.test(turnId)) return invalid();
  return { step: value.step as number, commandId, turnId, outputSHA256: value.outputSHA256,
    outputLength: value.outputLength as number, excerptLength: value.excerptLength as number, truncated: value.truncated };
}
function parseStep(raw: unknown, index: number): ConsoleExecutionStep {
  const value = object(raw, ["step", "nodeId", "sessionId", "prompt", "promptTruncated", "dependsOn", "resultFrom", "resultSources", "status", "commandId", "turnId"]);
  if (value.step !== index + 1 || typeof value.prompt !== "string" ||
      typeof value.sessionId === "string" && value.sessionId.startsWith("terminal:") ||
      Array.from(value.prompt).length > PROMPT_CODE_POINT_LIMIT || typeof value.promptTruncated !== "boolean" ||
      typeof value.status !== "string" || !STEP_STATUSES.has(value.status) || !Array.isArray(value.dependsOn)) return invalid();
  const dependsOn = value.dependsOn.map(dependency => {
    if (!Number.isSafeInteger(dependency) || dependency < 1 || dependency > index) return invalid();
    return dependency as number;
  });
  if (new Set(dependsOn).size !== dependsOn.length) return invalid();
  if (!Array.isArray(value.resultFrom) || value.resultFrom.length > RESULT_SOURCE_LIMIT) return invalid();
  const resultFrom = value.resultFrom.map(source => {
    if (!Number.isSafeInteger(source) || !dependsOn.includes(source)) return invalid();
    return source as number;
  });
  if (new Set(resultFrom).size !== resultFrom.length) return invalid();
  if (resultFrom.length && CLAIMED_SOURCE_STATUSES.has(value.status) && value.resultSources === undefined) return invalid();
  let resultSources: ExecutionResultSource[] | undefined;
  if (value.resultSources !== undefined) {
    if (!Array.isArray(value.resultSources) || !value.resultSources.length || value.resultSources.length !== resultFrom.length || value.status === "waiting") return invalid();
    resultSources = value.resultSources.map(parseResultSource);
    if (resultSources.some((source, sourceIndex) => source.step !== resultFrom[sourceIndex])) return invalid();
  }
  const commandId = value.commandId === undefined ? undefined : identifier(value.commandId);
  const turnId = value.turnId === undefined ? undefined : identifier(value.turnId);
  if ((value.status === "accepted" || value.status === "completed") && (!commandId || !turnId)) return invalid();
  if (turnId && !commandId) return invalid();
  return { step: index + 1, nodeId: identifier(value.nodeId), sessionId: identifier(value.sessionId),
    prompt: value.prompt, promptTruncated: value.promptTruncated, dependsOn, resultFrom,
    ...(resultSources === undefined ? {} : { resultSources }),
    status: value.status as ConsoleExecutionStep["status"],
    ...(commandId === undefined ? {} : { commandId }), ...(turnId === undefined ? {} : { turnId }) };
}
function parseExecution(raw: unknown): ConsoleExecution {
  const value = object(raw, ["id", "status", "createdAt", "expiresAt", "steps"]);
  if (typeof value.status !== "string" || !EXECUTION_STATUSES.has(value.status) || !Array.isArray(value.steps) ||
      !value.steps.length || value.steps.length > STEP_LIMIT) return invalid();
  const createdAt = timestamp(value.createdAt), expiresAt = timestamp(value.expiresAt);
  if (expiresAt <= createdAt) return invalid();
  const steps = value.steps.map(parseStep);
  for (const step of steps) for (const source of step.resultSources ?? []) {
    const parent = steps[source.step - 1];
    if (!parent || parent.commandId !== undefined && parent.commandId !== source.commandId ||
        parent.turnId !== undefined && parent.turnId !== source.turnId) return invalid();
  }
  return { id: identifier(value.id), status: value.status as ConsoleExecution["status"], createdAt, expiresAt,
    steps };
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
