export type SendKind = "final" | "progress";
export type DeferReason = "budget_exhausted" | "window_expired" | "context_changed";

export interface ContextBudgetState {
  refreshedAt: number;
  remaining: number;
  progressSent: number;
  lastInboundKey: string;
  grantedBudget?: number;
}

export interface ContextPolicy {
  contextWindowMs: number;
  sendBudget: number;
  outboxLimit: number;
}

const MILLISECONDS_PER_HOUR = 60 * 60 * 1000;
const MAX_PROGRESS_SENDS = 3;
const RESERVED_FINAL_SENDS = 3;

export const MAX_CONTEXT_WINDOW_MS = 7 * 24 * MILLISECONDS_PER_HOUR;
export const MAX_SEND_BUDGET = 1000;
export const MAX_OUTBOX_LIMIT = 1000;

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = Object.freeze({
  contextWindowMs: 23 * MILLISECONDS_PER_HOUR,
  sendBudget: 10,
  outboxLimit: MAX_OUTBOX_LIMIT,
});

const CONTEXT_POLICY_LIMITS: ContextPolicy = {
  contextWindowMs: MAX_CONTEXT_WINDOW_MS,
  sendBudget: MAX_SEND_BUDGET,
  outboxLimit: MAX_OUTBOX_LIMIT,
};

export class LocalSendDeferredError extends Error {
  constructor(public readonly reason: DeferReason, message = `Local send deferred: ${reason}`) {
    super(message);
    this.name = "LocalSendDeferredError";
  }
}

export function validateContextPolicy(options: Partial<ContextPolicy> = {}): ContextPolicy {
  const policy: ContextPolicy = {
    contextWindowMs: options.contextWindowMs === undefined ? DEFAULT_CONTEXT_POLICY.contextWindowMs : options.contextWindowMs,
    sendBudget: options.sendBudget === undefined ? DEFAULT_CONTEXT_POLICY.sendBudget : options.sendBudget,
    outboxLimit: options.outboxLimit === undefined ? DEFAULT_CONTEXT_POLICY.outboxLimit : options.outboxLimit,
  };
  for (const key of Object.keys(DEFAULT_CONTEXT_POLICY) as (keyof ContextPolicy)[]) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] <= 0 || policy[key] > CONTEXT_POLICY_LIMITS[key]) {
      throw new Error(`Invalid context policy ${key}: expected an integer between 1 and ${CONTEXT_POLICY_LIMITS[key]}`);
    }
  }
  return policy;
}

export function getDeferReason(
  state: ContextBudgetState | undefined,
  policy: ContextPolicy,
  kind: SendKind,
  now = Date.now(),
): DeferReason | undefined {
  if (!state || !Number.isFinite(now) || !Number.isFinite(state.refreshedAt) ||
      state.refreshedAt < 0 || now < state.refreshedAt ||
      !Number.isSafeInteger(policy.contextWindowMs) || policy.contextWindowMs <= 0 ||
      now - state.refreshedAt >= policy.contextWindowMs) {
    return "window_expired";
  }
  if (!Number.isSafeInteger(state.remaining) || effectiveRemaining(state, policy) <= 0 ||
      state.grantedBudget !== undefined && (!Number.isSafeInteger(state.grantedBudget) || state.grantedBudget < state.remaining ||
        state.grantedBudget <= 0 || state.grantedBudget > MAX_SEND_BUDGET) ||
      !Number.isSafeInteger(state.progressSent) || state.progressSent < 0 ||
      kind === "progress" &&
        (state.progressSent >= MAX_PROGRESS_SENDS || effectiveRemaining(state, policy) <= Math.min(RESERVED_FINAL_SENDS, policy.sendBudget))) {
    return "budget_exhausted";
  }
  return undefined;
}

function effectiveRemaining(state: ContextBudgetState, policy: ContextPolicy): number {
  const spent = state.grantedBudget === undefined ? 0 : Math.max(0, state.grantedBudget - state.remaining);
  return Math.min(state.remaining, Math.max(0, policy.sendBudget - spent));
}

export function canSend(
  state: ContextBudgetState | undefined,
  policy: ContextPolicy,
  kind: SendKind,
  now = Date.now(),
): boolean {
  return getDeferReason(state, policy, kind, now) === undefined;
}

export function consumeSend(
  state: ContextBudgetState | undefined,
  policy: ContextPolicy,
  kind: SendKind,
  now = Date.now(),
): ContextBudgetState {
  const reason = getDeferReason(state, policy, kind, now);
  if (reason !== undefined || state === undefined) {
    throw new LocalSendDeferredError(reason ?? "window_expired");
  }
  return {
    ...state,
    remaining: effectiveRemaining(state, policy) - 1,
    ...(state.grantedBudget === undefined ? {} : { grantedBudget: Math.min(state.grantedBudget, policy.sendBudget) }),
    progressSent: state.progressSent + (kind === "progress" ? 1 : 0),
  };
}
