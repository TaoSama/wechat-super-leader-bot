import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canSend,
  consumeSend,
  DEFAULT_CONTEXT_POLICY,
  LocalSendDeferredError,
  MAX_CONTEXT_WINDOW_MS,
  MAX_OUTBOX_LIMIT,
  MAX_SEND_BUDGET,
  validateContextPolicy,
  type ContextBudgetState,
  type ContextPolicy,
  type DeferReason,
  type SendKind,
} from "../../src/runtime/context-policy.js";

const NOW = 1_800_000_000_000;

function budget(overrides: Partial<ContextBudgetState> = {}): ContextBudgetState {
  return { refreshedAt: NOW, remaining: DEFAULT_CONTEXT_POLICY.sendBudget, progressSent: 0, lastInboundKey: "inbound-key", ...overrides };
}

function assertDeferred(state: ContextBudgetState | undefined, kind: SendKind, reason: DeferReason, now = NOW): void {
  assert.equal(canSend(state, DEFAULT_CONTEXT_POLICY, kind, now), false);
  assert.throws(() => consumeSend(state, DEFAULT_CONTEXT_POLICY, kind, now), error => {
    assert.ok(error instanceof LocalSendDeferredError);
    assert.equal(error.name, "LocalSendDeferredError");
    assert.equal(error.reason, reason);
    return true;
  });
}

test("context policy defaults are conservative and configuration accepts the resource limits", () => {
  assert.deepEqual(validateContextPolicy(), {
    contextWindowMs: 24 * 60 * 60 * 1000,
    sendBudget: 10,
    outboxLimit: 1000,
  });
  assert.equal(MAX_CONTEXT_WINDOW_MS, 604_800_000);
  assert.equal(MAX_SEND_BUDGET, 1000);
  assert.equal(MAX_OUTBOX_LIMIT, DEFAULT_CONTEXT_POLICY.outboxLimit);
  assert.deepEqual(validateContextPolicy({ contextWindowMs: 1000, sendBudget: 1, outboxLimit: 1 }), {
    contextWindowMs: 1000, sendBudget: 1, outboxLimit: 1,
  });
  assert.deepEqual(validateContextPolicy({ sendBudget: 2 }), { ...DEFAULT_CONTEXT_POLICY, sendBudget: 2 });
  assert.deepEqual(validateContextPolicy({ contextWindowMs: MAX_CONTEXT_WINDOW_MS, sendBudget: MAX_SEND_BUDGET }), {
    contextWindowMs: MAX_CONTEXT_WINDOW_MS, sendBudget: MAX_SEND_BUDGET, outboxLimit: MAX_OUTBOX_LIMIT,
  });
  const policy = validateContextPolicy();
  policy.sendBudget = 1;
  assert.equal(DEFAULT_CONTEXT_POLICY.sendBudget, 10);
});

test("context policy rejects invalid numbers and settings above resource limits", () => {
  const limits: ContextPolicy = { contextWindowMs: MAX_CONTEXT_WINDOW_MS, sendBudget: MAX_SEND_BUDGET, outboxLimit: MAX_OUTBOX_LIMIT };
  for (const key of Object.keys(DEFAULT_CONTEXT_POLICY) as (keyof ContextPolicy)[]) {
    for (const value of [0, -1, 1.5, NaN, Infinity, limits[key] + 1]) {
      assert.throws(() => validateContextPolicy({ [key]: value }), new RegExp(`Invalid context policy ${key}`));
    }
  }
});

test("unknown and expired windows defer both kinds of sends including the exact expiry boundary", () => {
  for (const kind of ["final", "progress"] as const) {
    assertDeferred(undefined, kind, "window_expired");
    assertDeferred(budget({ refreshedAt: NaN }), kind, "window_expired");
    assertDeferred(budget({ refreshedAt: Infinity }), kind, "window_expired");
    assertDeferred(budget({ refreshedAt: -1 }), kind, "window_expired");
    assertDeferred(budget({ refreshedAt: NOW + 1 }), kind, "window_expired");
    assertDeferred(budget(), kind, "window_expired", NaN);
    assertDeferred(budget(), kind, "window_expired", NOW + DEFAULT_CONTEXT_POLICY.contextWindowMs);
    assertDeferred(budget(), kind, "window_expired", NOW + DEFAULT_CONTEXT_POLICY.contextWindowMs + 1);
    assert.equal(canSend(budget(), DEFAULT_CONTEXT_POLICY, kind, NOW + DEFAULT_CONTEXT_POLICY.contextWindowMs - 1), true);
  }
});

test("independent queries share the context budget while preserving final sends", () => {
  let state = budget();
  for (let count = 1; count <= 7; count++) {
    state = consumeSend(state, DEFAULT_CONTEXT_POLICY, "progress", NOW);
    assert.equal(state.progressSent, count);
    assert.equal(state.remaining, DEFAULT_CONTEXT_POLICY.sendBudget - count);
  }
  assertDeferred(state, "progress", "budget_exhausted");
  while (state.remaining > 0) {
    state = consumeSend(state, DEFAULT_CONTEXT_POLICY, "final", NOW);
    assert.equal(state.progressSent, 7);
  }
  assertDeferred(state, "final", "budget_exhausted");
});

test("progress preserves three sends for final replies even after earlier final sends", () => {
  const beforeProgress = budget({ remaining: 4 });
  const state = consumeSend(beforeProgress, DEFAULT_CONTEXT_POLICY, "progress", NOW);
  assert.equal(state.remaining, 3);
  assertDeferred(state, "progress", "budget_exhausted");
  assert.equal(canSend(state, DEFAULT_CONTEXT_POLICY, "final", NOW), true);
  const strictPolicy = validateContextPolicy({ sendBudget: 3 });
  assert.equal(canSend(budget({ remaining: 3 }), strictPolicy, "progress", NOW), false);
  assert.equal(canSend(budget({ remaining: 1 }), strictPolicy, "final", NOW), true);
  const singleSendPolicy = validateContextPolicy({ sendBudget: 1 });
  assert.equal(canSend(budget({ remaining: 1 }), singleSendPolicy, "progress", NOW), false);
  assert.equal(canSend(budget({ remaining: 1 }), singleSendPolicy, "final", NOW), true);
});

test("consumeSend returns a new state and a deferred attempt preserves the original", () => {
  const original = Object.freeze(budget());
  const next = consumeSend(original, DEFAULT_CONTEXT_POLICY, "final", NOW);
  assert.notEqual(next, original);
  assert.deepEqual(next, { ...original, remaining: DEFAULT_CONTEXT_POLICY.sendBudget - 1 });
  assert.equal(original.remaining, DEFAULT_CONTEXT_POLICY.sendBudget);
  const exhausted = Object.freeze(budget({ remaining: 0 }));
  assertDeferred(exhausted, "final", "budget_exhausted");
  assert.equal(exhausted.remaining, 0);
});

test("invalid persisted counters fail closed without spending a send", () => {
  for (const state of [
    budget({ remaining: NaN }), budget({ remaining: -1 }), budget({ remaining: 0.5 }),
    budget({ progressSent: NaN }), budget({ progressSent: -1 }), budget({ progressSent: 0.5 }),
  ]) {
    for (const kind of ["final", "progress"] as const) assertDeferred(state, kind, "budget_exhausted");
  }
});

test("local send deferrals carry a stable context-changed reason for callers", () => {
  const error = new LocalSendDeferredError("context_changed");
  assert.ok(error instanceof Error);
  assert.equal(error.reason, "context_changed");
  assert.equal(error.message, "Local send deferred: context_changed");
});

test("tightening a budget counts prior charges and never restores spent sends", () => {
  const tightened = validateContextPolicy({ sendBudget: 5 });
  const overspent = budget({ grantedBudget: 10, remaining: 3 });
  assert.equal(canSend(overspent, tightened, "final", NOW), false);
  assert.throws(() => consumeSend(overspent, tightened, "final", NOW), { reason: "budget_exhausted" });
  let state = budget({ grantedBudget: 10, remaining: 8 });
  assert.equal(canSend(state, tightened, "progress", NOW), false);
  for (let expectedRemaining = 2; expectedRemaining >= 0; expectedRemaining--) {
    state = consumeSend(state, tightened, "final", NOW);
    assert.equal(state.remaining, expectedRemaining);
    assert.equal(state.grantedBudget, 5);
  }
  assert.equal(canSend(state, tightened, "final", NOW), false);
  assert.throws(() => consumeSend(state, tightened, "final", NOW), { reason: "budget_exhausted" });
});

test("raising a budget preserves a previous window's remaining allowance", () => {
  const raised = validateContextPolicy({ sendBudget: 20 });
  let state = budget({ grantedBudget: 10, remaining: 2 });
  state = consumeSend(state, raised, "final", NOW);
  assert.equal(state.remaining, 1);
  assert.equal(state.grantedBudget, 10);
  state = consumeSend(state, raised, "final", NOW);
  assert.equal(state.remaining, 0);
  assert.equal(canSend(state, raised, "final", NOW), false);
});

test("invalid persisted initial grants fail closed without producing invalid remaining counters", () => {
  for (const grantedBudget of [NaN, Infinity, -1, 0, 0.5, 1, MAX_SEND_BUDGET + 1]) {
    const state = budget({ grantedBudget });
    for (const kind of ["final", "progress"] as const) assertDeferred(state, kind, "budget_exhausted");
  }
});
