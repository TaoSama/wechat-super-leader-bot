export type GoalStatus = "active" | "blocked" | "completed" | "cancelled" | "expired";
export interface ConsoleGoalAction {
  index: number; target: number; prompt: string; promptTruncated: boolean; sourceActions: number[];
  status: "waiting" | "claimed" | "queued" | "pending" | "accepted" | "completed" | "failed" | "uncertain" | "blocked" | "cancelled" | "expired";
  commandId?: string; turnId?: string;
}
export interface ConsoleGoal {
  id: string; status: GoalStatus; objective: string; objectiveTruncated: boolean; createdAt: number; expiresAt: number;
  maxActions: number; maxDecisions: number; decisionAttempts: number; reason: string;
  targets: { nodeId: string; sessionId: string }[];
  criteria: { index: number; text: string; supported: boolean; actions: number[] }[];
  actions: ConsoleGoalAction[];
}
export interface ConsoleGoals { observedAt: number; limit: 12; hasMore: boolean; items: ConsoleGoal[] }
const STATUS = new Set(["active", "blocked", "completed", "cancelled", "expired"]);
const ACTION_STATUS = new Set(["waiting", "claimed", "queued", "pending", "accepted", "completed", "failed", "uncertain", "blocked", "cancelled", "expired"]);
const GOAL_LIMIT = 12, ACTION_LIMIT = 12, DECISION_LIMIT = 24, TEXT_LIMIT = 512;
const MAX_DATE_MS = 8_640_000_000_000_000;
const fail = (): never => { throw new Error("持续目标状态格式无效，无法确认目标进度"); };
const record = (raw: unknown, keys: string[]): Record<string, unknown> => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !keys.includes(key))) return fail();
  return raw as Record<string, unknown>;
};
const integer = (raw: unknown, min: number, max: number): number => {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < min || raw > max) return fail();
  return raw;
};
const text = (raw: unknown, min: number, max: number): string => {
  if (typeof raw !== "string" || raw.length < min || [...raw].length > max) return fail();
  return raw;
};
const array = (raw: unknown, min: number, max: number): unknown[] => {
  if (!Array.isArray(raw) || raw.length < min || raw.length > max) return fail();
  return raw;
};
const bool = (raw: unknown): boolean => typeof raw === "boolean" ? raw : fail();
function indices(raw: unknown, minLength: number, maxLength: number, maxIndex: number): number[] {
  const result = array(raw, minLength, maxLength).map(value => integer(value, 1, maxIndex));
  if (new Set(result).size !== result.length) return fail();
  return result;
}
function parseGoal(raw: unknown): ConsoleGoal {
  const goal = record(raw, ["id", "status", "objective", "objectiveTruncated", "createdAt", "expiresAt", "maxActions", "maxDecisions", "decisionAttempts", "reason", "targets", "criteria", "actions"]);
  const id = text(goal.id, 1, 36), status = text(goal.status, 1, 16) as GoalStatus;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || !STATUS.has(status)) return fail();
  const createdAt = integer(goal.createdAt, 0, MAX_DATE_MS), expiresAt = integer(goal.expiresAt, 0, MAX_DATE_MS);
  if (expiresAt <= createdAt) return fail();
  const maxActions = integer(goal.maxActions, 1, ACTION_LIMIT), maxDecisions = integer(goal.maxDecisions, 1, DECISION_LIMIT);
  const targets = array(goal.targets, 1, 4).map(raw => {
    const target = record(raw, ["nodeId", "sessionId"]);
    const nodeId = text(target.nodeId, 1, 64), sessionId = text(target.sessionId, 1, 64);
    if (!nodeId.trim() || !sessionId.trim() || sessionId.startsWith("terminal:")) return fail();
    return { nodeId, sessionId };
  });
  if (new Set(targets.map(value => JSON.stringify(value))).size !== targets.length) return fail();
  const actions = array(goal.actions, 0, maxActions).map((raw, index): ConsoleGoalAction => {
    const value = record(raw, ["index", "target", "prompt", "promptTruncated", "sourceActions", "status", "commandId", "turnId"]);
    const actionStatus = text(value.status, 1, 16) as ConsoleGoalAction["status"];
    if (value.index !== index + 1 || !ACTION_STATUS.has(actionStatus)) return fail();
    const commandId = value.commandId === undefined ? undefined : text(value.commandId, 1, 64);
    const turnId = value.turnId === undefined ? undefined : text(value.turnId, 1, 128);
    if (turnId && (!commandId || new TextEncoder().encode(turnId).length > 128 || /[\p{White_Space}\p{Cc}\uD800-\uDFFF\uFFFD]/u.test(turnId)) ||
      ["accepted", "completed"].includes(actionStatus) && (!commandId || !turnId)) return fail();
    return { index: index + 1, target: integer(value.target, 1, targets.length), prompt: text(value.prompt, 1, TEXT_LIMIT),
      promptTruncated: bool(value.promptTruncated), sourceActions: indices(value.sourceActions, 0, 3, index), status: actionStatus,
      ...(commandId ? { commandId } : {}), ...(turnId ? { turnId } : {}) };
  });
  const criteria = array(goal.criteria, 1, 8).map((raw, index) => {
    const item = record(raw, ["index", "text", "supported", "actions"]);
    if (item.index !== index + 1) return fail();
    const supported = bool(item.supported), evidence = indices(item.actions, supported ? 1 : 0, ACTION_LIMIT, actions.length);
    if (supported && (status !== "completed" || evidence.some(id => actions[id - 1].status !== "completed")) || !supported && evidence.length) return fail();
    return { index: index + 1, text: text(item.text, 1, 500), supported, actions: evidence };
  });
  return { id, status, objective: text(goal.objective, 1, TEXT_LIMIT), objectiveTruncated: bool(goal.objectiveTruncated),
    createdAt, expiresAt, maxActions, maxDecisions, decisionAttempts: integer(goal.decisionAttempts, 0, maxDecisions),
    reason: text(goal.reason, 1, 1000), targets, criteria, actions };
}
/** Both transports require this projection; missing data never means zero active goals. */
export function parseConsoleGoals(raw: unknown): ConsoleGoals {
  const value = record(raw, ["observedAt", "limit", "hasMore", "items"]);
  if (value.limit !== GOAL_LIMIT) return fail();
  const items = array(value.items, 0, GOAL_LIMIT).map(parseGoal);
  if (new Set(items.map(goal => goal.id)).size !== items.length) return fail();
  return { observedAt: integer(value.observedAt, 0, MAX_DATE_MS), limit: GOAL_LIMIT, hasMore: bool(value.hasMore), items };
}
