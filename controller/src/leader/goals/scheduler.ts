import { randomUUID, createHash } from "node:crypto";
import type { IStore } from "../../store/interface.js";
import type { CommandService } from "../../commands/service.js";
import { CommandError } from "../../commands/service.js";
import { GoalDecisionSchema, GOAL_LEASE_MS, GOAL_SEND_CLAIM_MS, goalRequestId, goalIsOpen, validateGoalDecision, renderGoalAction,
  type GoalRecord, type GoalDecision, type GoalDecisionInput } from "./goal.js";
import { readGoalView, type GoalView } from "./view.js";
import { modelDiagnostic } from "../model/errors.js";

const TICK_MS = 2000;
const DECISION_TIMEOUT_MS = 90_000;
const CONCURRENT_GOALS = 2;
type Options = { now?: () => number; isChatAllowed?: (chatId: string) => boolean;
  canDispatch?: (goal: GoalRecord, targetIndex: number) => boolean | Promise<boolean>;
  onChanged?: () => void; onError?: (error: unknown) => void };
export type GoalDecider = (input: GoalDecisionInput, signal: AbortSignal) => Promise<GoalDecision>;

export class GoalScheduler {
  private now: () => number;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private cursor = "";
  private tickInFlight?: Promise<void>;
  private stopping?: Promise<void>;
  private advances = new Map<string, Promise<void>>();
  private modelAborts = new Map<string, AbortController>();
  constructor(private store: IStore, private commands: Pick<CommandService, "submit">, private decide: GoalDecider, private options: Options = {}) {
    this.now = options.now ?? Date.now;
  }
  start(): void {
    if (this.timer || this.stopping) return;
    this.stopped = false;
    this.timer = setInterval(() => this.trigger(), TICK_MS); this.timer.unref?.(); this.trigger();
  }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer); this.timer = undefined;
    for (const abort of this.modelAborts.values()) abort.abort();
    this.stopping = Promise.allSettled([...this.advances.values(), ...(this.tickInFlight ? [this.tickInFlight] : [])]).then(results => {
      for (const result of results) if (result.status === "rejected") this.report(result.reason);
    }).finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
  advance(id: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const previous = this.advances.get(id); if (previous) return previous;
    const pending = this.advanceOnce(id).finally(() => { this.advances.delete(id); });
    this.advances.set(id, pending); return pending;
  }
  async view(id: string, chatId: string): Promise<GoalView | null> {
    const goal = await this.store.getGoal(id);
    return goal?.chatId === chatId ? readGoalView(this.store, goal, this.now()) : null;
  }
  async cancel(id: string, chatId: string): Promise<GoalView | null> {
    for (let count = 0; count < 64; count++) {
      const goal = await this.store.getGoal(id);
      if (!goal || goal.chatId !== chatId) return null;
      if (!goalIsOpen(goal)) return this.view(id, chatId);
      if (await this.save(goal, { status: "cancelled", lease: undefined })) {
        this.modelAborts.get(id)?.abort(); return this.view(id, chatId);
      }
    }
    throw new Error("Goal cancellation CAS contention exhausted");
  }
  private trigger(): void {
    if (this.stopped || this.tickInFlight) return;
    this.tickInFlight = this.tick().catch(e => this.report(e)).finally(() => { this.tickInFlight = undefined; });
  }
  private async tick(): Promise<void> {
    const goals = await this.store.listRunnableGoals(CONCURRENT_GOALS, this.cursor);
    if (!goals.length) { this.cursor = ""; return; }
    this.cursor = goals.length === CONCURRENT_GOALS ? goals.at(-1)!.id : "";
    await Promise.all(goals.map(g => this.advance(g.id).catch(e => this.report(e))));
  }
  private allowed(goal: GoalRecord): boolean { return this.options.isChatAllowed?.(goal.chatId) ?? true; }
  private async save(goal: GoalRecord, patch: Partial<GoalRecord>): Promise<GoalRecord | null> {
    const saved = await this.store.compareAndSetGoal({ ...goal, ...patch, revision: goal.revision + 1 }, goal.revision, this.now);
    if (saved) { try { this.options.onChanged?.(); } catch (e) { this.report(e); } }
    return saved;
  }
  private async block(goal: GoalRecord, reason: string): Promise<void> { await this.save(goal, { status: "blocked", blockedReason: reason, lease: undefined }); }
  private async advanceOnce(id: string): Promise<void> {
    await this.store.markExpiredActiveCommandsUncertain();
    const goal = await this.store.getGoal(id);
    if (!goal || !goalIsOpen(goal) || this.stopped) return;
    if (goal.expiresAt <= this.now()) { await this.save(goal, { status: "expired", lease: undefined }); return; }
    if (goal.status === "blocked") return;
    if (!this.allowed(goal)) { await this.block(goal, "authorization_revoked"); return; }
    const view = await readGoalView(this.store, goal, this.now());
    if (view.actions.some(a => ["uncertain", "failed", "input-written"].includes(a.status))) { await this.block(goal, "result_unavailable_or_failed"); return; }
    const last = goal.actions.at(-1), lastView = view.actions.at(-1);
    if (last && lastView?.status !== "completed") {
      if (!last.attempt && lastView?.status === "waiting") await this.dispatch(goal, goal.actions.length - 1);
      return;
    }
    if (goal.lease && goal.lease.expiresAt > this.now()) return;
    if (goal.decisionAttempts >= goal.proposal.maxDecisions) { await this.block(goal, "decision_budget_exhausted"); return; }
    const availableTargets: number[] = [];
    for (const index of goal.proposal.targets.keys()) if (!this.options.canDispatch || await this.options.canDispatch(goal, index)) availableTargets.push(index + 1);
    if (!availableTargets.length && !goal.actions.length || this.stopped) return;
    const input: GoalDecisionInput = { authorization: structuredClone(goal.proposal), actions: view.actions,
      decisions: goal.decisions.map(({ index, decision }) => ({ index, decision: structuredClone(decision) })),
      availableTargets, decisionAttempts: goal.decisionAttempts + 1 };
    const startedAt = this.now();
    const claimed = await this.save(goal, { decisionAttempts: input.decisionAttempts,
      lease: { token: randomUUID(), startedAt, expiresAt: startedAt + GOAL_LEASE_MS, input } });
    if (!claimed?.lease || this.stopped) return;
    const abort = new AbortController(); this.modelAborts.set(id, abort);
    const timer = setTimeout(() => abort.abort(), DECISION_TIMEOUT_MS);
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => { onAbort = () => reject(new Error("Goal model aborted")); abort.signal.addEventListener("abort", onAbort, { once: true }); });
    try {
      const decision = GoalDecisionSchema.parse(await Promise.race([this.decide(structuredClone(input), abort.signal), aborted]));
      const current = await this.store.getGoal(id);
      if (!current || current.status !== "active" || current.revision !== claimed.revision || current.lease?.token !== claimed.lease.token ||
        this.stopped || current.expiresAt <= this.now() || current.lease.expiresAt <= this.now() || !this.allowed(current)) return;
      const refreshed = await readGoalView(this.store, current, this.now());
      if (JSON.stringify(refreshed.actions) !== JSON.stringify(input.actions)) { await this.block(current, "decision_evidence_changed"); return; }
      validateGoalDecision(decision, input);
      const decisions = [...current.decisions, { index: current.decisions.length + 1, decision,
        inputSHA256: createHash("sha256").update(JSON.stringify(input)).digest("hex"), evidence: input.actions.flatMap(a => a.result ? [a.result] : []) }];
      if (decision.type === "next") {
        const sources = decision.sourceActions.map(index => input.actions[index - 1].result!);
        await this.save(current, { decisions, lease: undefined, actions: [...current.actions, { index: current.actions.length + 1,
          target: decision.target, prompt: decision.prompt, sourceActions: decision.sourceActions,
          input: { prompt: renderGoalAction(current.proposal, decision.prompt, sources), sources } }] });
      } else await this.save(current, { decisions, lease: undefined, status: decision.type === "complete" ? "completed" : "blocked",
        ...(decision.type === "blocked" ? { blockedReason: decision.reason } : {}) });
    } catch (error) {
      if (!this.stopped) {
        const current = await this.store.getGoal(id);
        if (current?.status === "active" && current.revision === claimed.revision && current.lease?.token === claimed.lease.token) {
          await this.block(current, `model_decision_${modelDiagnostic(error).category}`);
        }
      }
      this.report(error);
    } finally { clearTimeout(timer); abort.signal.removeEventListener("abort", onAbort); this.modelAborts.delete(id); }
  }
  private async dispatch(goal: GoalRecord, index: number): Promise<void> {
    const action = goal.actions[index], target = goal.proposal.targets[action.target - 1];
    if (this.options.canDispatch && !await this.options.canDispatch(goal, action.target - 1) || this.stopped) return;
    const startedAt = this.now(), attempt = { token: randomUUID(), startedAt, expiresAt: startedAt + GOAL_SEND_CLAIM_MS };
    const actions = structuredClone(goal.actions); actions[index].attempt = attempt;
    const claimed = await this.save(goal, { actions });
    if (!claimed || this.stopped) return;
    try {
      await this.commands.submit({ nodeId: target.nodeId, sessionId: target.sessionId, action: "send", prompt: action.input.prompt,
        skills: target.skills, requestId: goalRequestId(goal, index) }, 0, async () => {
        const current = await this.store.getGoal(goal.id);
        const view = current && await readGoalView(this.store, current, this.now());
        const latest = await this.store.getGoal(goal.id);
        if (!latest || latest.status !== "active" || !this.allowed(latest) || this.stopped || latest.expiresAt <= this.now() ||
          JSON.stringify(latest.actions[index]) !== JSON.stringify(claimed.actions[index]) || latest.actions[index].attempt!.expiresAt <= this.now() ||
          !view || view.actions.slice(0, index).some(a => a.status !== "completed") ||
          action.input.sources.some(source => JSON.stringify(view.actions[source.action - 1]?.result) !== JSON.stringify(source))) {
          throw new CommandError(409, "Goal dispatch authority unavailable");
        }
      }, target.sendRoute);
    } catch (error) { this.report(error); }
  }
  private report(error: unknown): void {
    if (!this.options.onError) { console.error("Goal scheduler operation failed"); return; }
    try { this.options.onError(error); } catch { console.error("Goal scheduler error reporting failed"); }
  }
}
