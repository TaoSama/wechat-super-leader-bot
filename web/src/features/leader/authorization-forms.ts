import type { ConsoleExecution, ScopedSession } from "../../types";
import { ACTION_LIMIT as MAX_GOAL_ACTIONS, DECISION_LIMIT as MAX_GOAL_DECISIONS, DURATION_LIMIT_MINUTES as MAX_GOAL_MINUTES, type ConsoleGoal } from "./goal-contract";
import { isTerminalSession } from "../sessions/terminal-session";
import { isSessionMessageTarget } from "../sessions/send-availability";

// Mirrors the controller's authorization limits; the server remains the authority.
export const MAX_PLAN_STEPS = 4;
export const MAX_STEP_PROMPT = 1000;
export const MAX_GOAL_TARGETS = 4;
export const MAX_GOAL_CRITERIA = 8;
export { MAX_GOAL_ACTIONS, MAX_GOAL_DECISIONS, MAX_GOAL_MINUTES };
export const MAX_GOAL_OBJECTIVE = 2000;
export const MAX_GOAL_CONSTRAINTS = 2000;
export const MAX_CRITERION = 500;
const WECHAT_NODE_ID = "wechat";
const DEFAULT_GOAL_ACTIONS = 4;
const DEFAULT_GOAL_DECISIONS = 8;
const DEFAULT_GOAL_MINUTES = 120;

export interface SessionKey { nodeId: string; sessionId: string }
export interface PlanStepDraft extends SessionKey { prompt: string; dependsOn: number[]; resultFrom: number[] }
export interface PlanDraft { steps: PlanStepDraft[] }
export interface GoalDraft { objective: string; criteria: string[]; targets: SessionKey[]; constraints: string; maxActions: number; maxDecisions: number; durationMinutes: number }
/** Field path → message; empty means the draft may be submitted. */
export type DraftErrors = Record<string, string>;

/** Unambiguous form value for a session; decoded with parseSessionKey. */
export const sessionKey = (value: SessionKey) => JSON.stringify([value.nodeId, value.sessionId]);
export function parseSessionKey(key: string): SessionKey {
  const [nodeId, sessionId] = JSON.parse(key) as [string, string];
  return { nodeId, sessionId };
}
export const sessionDisplay = (value: SessionKey) => `${value.nodeId} / ${value.sessionId}`;
export const sessionLabel = (session: ScopedSession) => `${session.title || session.id} · ${session.nodeId}`;
const length = (value: string) => [...value].length;

/** Sessions a console plan or goal may target: discovered, non-terminal, sendable and not the read-only WeChat view. */
export function authorizableSessions(sessions: ScopedSession[]): ScopedSession[] {
  return sessions.filter(session => session.nodeId !== WECHAT_NODE_ID && !isTerminalSession(session) && isSessionMessageTarget(session) &&
    (session.capabilities.includes("send") || session.capabilities.includes("resume-send")));
}

export function emptyPlanStep(): PlanStepDraft { return { nodeId: "", sessionId: "", prompt: "", dependsOn: [], resultFrom: [] }; }
export function emptyGoalDraft(): GoalDraft {
  return { objective: "", criteria: [""], targets: [], constraints: "", maxActions: DEFAULT_GOAL_ACTIONS, maxDecisions: DEFAULT_GOAL_DECISIONS, durationMinutes: DEFAULT_GOAL_MINUTES };
}

export function planDraftFromExecution(plan: ConsoleExecution): PlanDraft {
  return { steps: plan.steps.map(step => ({ nodeId: step.nodeId, sessionId: step.sessionId, prompt: step.prompt,
    dependsOn: [...step.dependsOn], resultFrom: [...step.resultFrom] })) };
}
export function goalDraftFromGoal(goal: ConsoleGoal): GoalDraft {
  return { objective: goal.objective, criteria: goal.criteria.map(item => item.text), targets: goal.targets.map(target => ({ ...target })),
    constraints: "", maxActions: goal.maxActions, maxDecisions: goal.maxDecisions, durationMinutes: goal.durationMinutes ?? DEFAULT_GOAL_MINUTES };
}

/** Truncated console summaries cannot silently become a new authorization. */
export function truncatedPlanSteps(plan: ConsoleExecution): number[] {
  return plan.steps.filter(step => step.promptTruncated).map(step => step.step);
}

export function validatePlanDraft(draft: PlanDraft, allowed: ScopedSession[]): DraftErrors {
  const errors: DraftErrors = {}, eligible = new Set(allowed.map(session => sessionKey({ nodeId: session.nodeId, sessionId: session.id })));
  if (!draft.steps.length || draft.steps.length > MAX_PLAN_STEPS) errors.steps = `计划需要 1–${MAX_PLAN_STEPS} 个步骤。`;
  draft.steps.forEach((step, index) => {
    const number = index + 1;
    if (!step.nodeId || !step.sessionId) errors[`steps.${index}.session`] = `请为步骤 ${number} 选择会话。`;
    else if (!eligible.has(sessionKey(step))) errors[`steps.${index}.session`] = `步骤 ${number} 的会话当前不可派发，请重新选择。`;
    if (!step.prompt.trim()) errors[`steps.${index}.prompt`] = `请填写步骤 ${number} 的任务。`;
    else if (length(step.prompt.trim()) > MAX_STEP_PROMPT) errors[`steps.${index}.prompt`] = `步骤 ${number} 的任务最多 ${MAX_STEP_PROMPT} 字。`;
    if (step.dependsOn.some(dependency => dependency < 1 || dependency >= number)) errors[`steps.${index}.dependsOn`] = `步骤 ${number} 只能依赖更早的步骤。`;
    if (step.resultFrom.some(source => !step.dependsOn.includes(source))) errors[`steps.${index}.resultFrom`] = `步骤 ${number} 只能使用其直接依赖步骤的结果。`;
  });
  return errors;
}

export function validateGoalDraft(draft: GoalDraft, allowed: ScopedSession[]): DraftErrors {
  const errors: DraftErrors = {}, eligible = new Set(allowed.map(session => sessionKey({ nodeId: session.nodeId, sessionId: session.id })));
  const integer = (value: number, max: number) => Number.isSafeInteger(value) && value >= 1 && value <= max;
  if (!draft.objective.trim()) errors.objective = "请填写目标。";
  else if (length(draft.objective.trim()) > MAX_GOAL_OBJECTIVE) errors.objective = `目标最多 ${MAX_GOAL_OBJECTIVE} 字。`;
  const criteria = draft.criteria.map(item => item.trim());
  if (!criteria.length || criteria.length > MAX_GOAL_CRITERIA || criteria.some(item => !item)) errors.criteria = `请填写 1–${MAX_GOAL_CRITERIA} 条完成条件，不能留空。`;
  else if (criteria.some(item => length(item) > MAX_CRITERION)) errors.criteria = `每条完成条件最多 ${MAX_CRITERION} 字。`;
  if (!draft.targets.length || draft.targets.length > MAX_GOAL_TARGETS) errors.targets = `请选择 1–${MAX_GOAL_TARGETS} 个会话。`;
  else if (draft.targets.some(target => !eligible.has(sessionKey(target)))) errors.targets = "所选会话中有当前不可派发的会话，请重新选择。";
  if (length(draft.constraints) > MAX_GOAL_CONSTRAINTS) errors.constraints = `约束最多 ${MAX_GOAL_CONSTRAINTS} 字。`;
  if (!integer(draft.maxActions, MAX_GOAL_ACTIONS)) errors.maxActions = `动作预算需为 1–${MAX_GOAL_ACTIONS} 的整数。`;
  if (!integer(draft.maxDecisions, MAX_GOAL_DECISIONS)) errors.maxDecisions = `决策预算需为 1–${MAX_GOAL_DECISIONS} 的整数。`;
  if (!integer(draft.durationMinutes, MAX_GOAL_MINUTES)) errors.durationMinutes = `时长需为 1–${MAX_GOAL_MINUTES} 分钟的整数。`;
  return errors;
}

/** Removes a step and renumbers later dependencies so every reference stays on an earlier step. */
export function removePlanStep(draft: PlanDraft, index: number): PlanDraft {
  const removed = index + 1;
  const shift = (values: number[]) => values.filter(value => value !== removed).map(value => value > removed ? value - 1 : value);
  return { steps: draft.steps.filter((_, position) => position !== index).map(step => ({ ...step, dependsOn: shift(step.dependsOn), resultFrom: shift(step.resultFrom) })) };
}
