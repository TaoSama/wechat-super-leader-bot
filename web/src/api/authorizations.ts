import { ApiAuthError, ApiHttpError } from "./errors";
import type { GoalDraft, PlanDraft } from "../features/leader/authorization-forms";

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_MESSAGE_LENGTH = 8000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OUTCOMES = new Set(["created", "cancelled"]);
export const PLAN_INTENT = "plan-authorization";
export const GOAL_INTENT = "goal-authorization";
export const UNBOUND_LOGIN_MESSAGE = "此登录未绑定微信聊天，无法创建或取消计划与目标。请在微信中重新获取控制台链接。";

export interface AuthorizationReceipt { outcome: "created" | "cancelled"; id: string; message: string; replayed: boolean }

/** Strict receipt shape; an unknown or mismatched receipt is never treated as success. */
export function parseAuthorizationReceipt(raw: unknown, expected: AuthorizationReceipt["outcome"], expectedId?: string): AuthorizationReceipt {
  const fail = (): never => { throw new Error("授权回执格式无效，请刷新状态核查"); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !["outcome", "id", "message", "replayed"].includes(key))) return fail();
  if (typeof value.outcome !== "string" || !OUTCOMES.has(value.outcome) || value.outcome !== expected) return fail();
  if (typeof value.id !== "string" || !UUID.test(value.id) || expectedId !== undefined && value.id.toLowerCase() !== expectedId.toLowerCase()) return fail();
  if (typeof value.message !== "string" || value.message.length > MAX_MESSAGE_LENGTH || typeof value.replayed !== "boolean") return fail();
  return { outcome: expected, id: value.id, message: value.message, replayed: value.replayed };
}

/** The server's rejection text (validation, cap, exclusion) is shown verbatim; other bodies fall back to the status. */
export async function authorizationErrorMessage(response: Response): Promise<{ code?: string; message: string }> {
  const fallback = { message: `请求未成功 (HTTP ${response.status})` };
  try {
    const text = await response.text();
    if (text.length > MAX_MESSAGE_LENGTH * 2) return fallback;
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== "object") return fallback;
    const { code, message, error } = body as Record<string, unknown>;
    const detail = typeof message === "string" ? message : typeof error === "string" ? error : undefined;
    return { ...(typeof code === "string" ? { code } : {}), message: detail && detail.length <= MAX_MESSAGE_LENGTH ? detail : fallback.message };
  } catch {
    return fallback;
  }
}

async function authorizationRequest(path: string, intent: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = window.setTimeout(abort, REQUEST_TIMEOUT_MS);
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(path, { method: "POST", credentials: "same-origin", signal: controller.signal,
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-Super-Leader-Intent": intent }, body: JSON.stringify(body) });
    if (response.ok) return await response.json();
    const detail = await authorizationErrorMessage(response);
    if (response.status === 403 && detail.code === "console_chat_unbound") throw new ApiHttpError(403, UNBOUND_LOGIN_MESSAGE);
    if (response.status === 401 || response.status === 403) throw new ApiAuthError(response.status, "会话登录已失效，请重新获取微信登录链接");
    throw new ApiHttpError(response.status, detail.message);
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function createPlan(draft: PlanDraft, requestId: string, signal?: AbortSignal): Promise<AuthorizationReceipt> {
  const steps = draft.steps.map(step => ({ nodeId: step.nodeId, sessionId: step.sessionId, prompt: step.prompt.trim(),
    dependsOn: [...step.dependsOn].sort((a, b) => a - b), resultFrom: [...step.resultFrom].sort((a, b) => a - b) }));
  return parseAuthorizationReceipt(await authorizationRequest("/v1/plans", PLAN_INTENT, { requestId, steps }, signal), "created");
}

export async function createGoal(draft: GoalDraft, requestId: string, signal?: AbortSignal): Promise<AuthorizationReceipt> {
  const body = { requestId, objective: draft.objective.trim(), criteria: draft.criteria.map(item => item.trim()),
    targets: draft.targets.map(({ nodeId, sessionId }) => ({ nodeId, sessionId })), constraints: draft.constraints.trim(),
    maxActions: draft.maxActions, maxDecisions: draft.maxDecisions, durationMinutes: draft.durationMinutes };
  return parseAuthorizationReceipt(await authorizationRequest("/v1/goals", GOAL_INTENT, body, signal), "created");
}

export async function cancelPlan(planId: string, requestId: string, signal?: AbortSignal): Promise<AuthorizationReceipt> {
  const raw = await authorizationRequest(`/v1/plans/${encodeURIComponent(planId)}/cancel`, PLAN_INTENT, { requestId }, signal);
  return parseAuthorizationReceipt(raw, "cancelled", planId);
}

export async function cancelGoal(goalId: string, requestId: string, signal?: AbortSignal): Promise<AuthorizationReceipt> {
  const raw = await authorizationRequest(`/v1/goals/${encodeURIComponent(goalId)}/cancel`, GOAL_INTENT, { requestId }, signal);
  return parseAuthorizationReceipt(raw, "cancelled", goalId);
}
