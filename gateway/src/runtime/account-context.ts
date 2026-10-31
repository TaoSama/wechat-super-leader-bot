import type { GatewaySyncState } from "../types.js";
import { effectiveRemaining, MAX_SEND_BUDGET, type ContextBudgetState, type ContextPolicy } from "./context-policy.js";

export interface ChatContextWindow {
  refreshedAt: number;
  lastInboundKey: string;
}

export interface AccountSendBudget extends ContextBudgetState {
  /** Platform time, before clamping small positive clock skew to the local clock. */
  inboundCreatedAt: number;
}

function validWindow(value: unknown): value is ChatContextWindow {
  const window = value as ChatContextWindow | null;
  return Boolean(window && Number.isSafeInteger(window.refreshedAt) && window.refreshedAt >= 0 &&
    typeof window.lastInboundKey === "string");
}

function validBudget(value: unknown): value is ContextBudgetState {
  const budget = value as ContextBudgetState | null;
  return validWindow(value) && Boolean(budget && Number.isSafeInteger(budget.remaining) && budget.remaining >= 0 &&
    Number.isSafeInteger(budget.progressSent) && budget.progressSent >= 0 &&
    (budget.grantedBudget === undefined || Number.isSafeInteger(budget.grantedBudget) &&
      budget.grantedBudget >= budget.remaining && budget.grantedBudget > 0 && budget.grantedBudget <= MAX_SEND_BUDGET));
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${name}`);
  return value as Record<string, unknown>;
}

export function restoreAccountContext(state: GatewaySyncState, policy: ContextPolicy): {
  windows: Record<string, ChatContextWindow>; budget: AccountSendBudget | undefined;
} {
  const legacy = record(state.context_budgets ?? {}, "legacy context budgets");
  for (const budget of Object.values(legacy)) if (!validBudget(budget)) throw new Error("Invalid legacy context budget");
  if (state.context_windows !== undefined || state.account_send_budget !== undefined) {
    const windows = record(state.context_windows, "chat context windows");
    for (const window of Object.values(windows)) if (!validWindow(window)) throw new Error("Invalid chat context window");
    const budget = state.account_send_budget;
    if (budget !== undefined && (!validBudget(budget) || !Number.isSafeInteger(budget.inboundCreatedAt) ||
        budget.inboundCreatedAt < budget.refreshedAt)) throw new Error("Invalid account send budget");
    return { windows: windows as Record<string, ChatContextWindow>, budget };
  }

  const entries = Object.entries(legacy) as [string, ContextBudgetState][];
  const windows = Object.fromEntries(entries.map(([chat, budget]) => [chat,
    { refreshedAt: budget.refreshedAt, lastInboundKey: budget.lastInboundKey }]));
  const latest = entries.reduce<ContextBudgetState | undefined>((value, [, budget]) =>
    !value || budget.refreshedAt > value.refreshedAt ? budget : value, undefined);
  if (!latest) return { windows, budget: undefined };
  // Old ledgers have no send timestamps. Count every known spend in overlapping windows
  // conservatively instead of creating an extra ten sends for each former chat ledger.
  const overlapping = entries.map(([, budget]) => budget)
    .filter(budget => latest.refreshedAt - budget.refreshedAt < policy.contextWindowMs);
  const grant = Math.min(latest.grantedBudget ?? policy.sendBudget, policy.sendBudget);
  const spent = overlapping.reduce((sum, budget) => Math.min(grant,
    sum + Math.max(0, (budget.grantedBudget ?? policy.sendBudget) - budget.remaining)), 0);
  const inboundCreatedAt = Object.entries(windows).reduce((newest, [chat, window]) => {
    const watermark = state.inbound_watermarks?.[chat];
    return Math.max(newest, watermark?.keys.includes(window.lastInboundKey) ? watermark.createdAtMs : window.refreshedAt);
  }, latest.refreshedAt);
  return { windows, budget: { ...latest, inboundCreatedAt,
    grantedBudget: grant, remaining: Math.max(0, Math.min(effectiveRemaining(latest, policy), grant - spent)),
    progressSent: overlapping.reduce((sum, budget) => Math.min(Number.MAX_SAFE_INTEGER, sum + budget.progressSent), 0) } };
}
