import { randomUUID } from "node:crypto";
import { CommandError, type CommandService } from "../../commands/service.js";
import type { IStore } from "../../store/interface.js";
import { assertNativeExecutionPlan, EXECUTION_CLAIM_MS, EXECUTION_PAGE_SIZE, EXECUTION_TICK_MS, executionRequestId, sameExecutionAuthorization,
  type ExecutionAttempt, type ExecutionRecord } from "./execution.js";
import { readExecutionView, type ExecutionView } from "./view.js";
import { collectExecutionInput, ExecutionInputError, verifyExecutionInput } from "./input-source.js";

export type { ExecutionView } from "./view.js";
type SchedulerOptions = {
  now?: () => number;
  isChatAllowed?: (chatId: string) => boolean;
  canDispatch?: (execution: ExecutionRecord, index: number) => Promise<boolean> | boolean;
  onChanged?: () => void;
  onError?: (error: unknown) => void;
};

export class ExecutionScheduler {
  private readonly now: () => number;
  private readonly isChatAllowed: (chatId: string) => boolean;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private cursor = "";
  private tickInFlight?: Promise<void>;
  private stopping?: Promise<void>;
  private advances = new Map<string, Promise<void>>();

  constructor(private store: IStore, private commands: Pick<CommandService, "submit">,
    private options: SchedulerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.isChatAllowed = options.isChatAllowed ?? (() => true);
  }

  start(): void {
    if (this.timer || this.stopping) return;
    this.stopped = false;
    this.timer = setInterval(() => this.triggerTick(), EXECUTION_TICK_MS);
    this.timer.unref?.();
    this.triggerTick();
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const pending = [...this.advances.values(), ...(this.tickInFlight ? [this.tickInFlight] : [])];
    this.stopping = Promise.allSettled(pending).then(results => {
      for (const result of results) if (result.status === "rejected") this.report(result.reason);
    }).finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  advance(executionId: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const previous = this.advances.get(executionId);
    if (previous) return previous;
    const pending = this.advanceOnce(executionId).finally(() => { this.advances.delete(executionId); });
    this.advances.set(executionId, pending);
    return pending;
  }

  async view(executionId: string, chatId: string): Promise<ExecutionView | null> {
    const execution = await this.store.getExecution(executionId);
    if (!execution || execution.chatId !== chatId) return null;
    return readExecutionView(this.store, execution, this.now());
  }

  async cancel(executionId: string, chatId: string): Promise<ExecutionView | null> {
    let execution = await this.store.getExecution(executionId);
    if (!execution || execution.chatId !== chatId) return null;
    // At most one immutable claim can win per step; retry only those bounded CAS races.
    const limit = execution.plan.actions.length + 1;
    for (let attempt = 0; attempt < limit && execution?.status === "active"; attempt++) {
      if (await this.transition(execution, "cancelled")) break;
      execution = await this.store.getExecution(executionId);
      if (!execution || execution.chatId !== chatId) return null;
    }
    return this.view(executionId, chatId);
  }

  private triggerTick(): void {
    if (this.stopped || this.tickInFlight) return;
    this.tickInFlight = this.tick().catch(error => this.report(error))
      .finally(() => { this.tickInFlight = undefined; });
  }

  private async tick(): Promise<void> {
    const executions = await this.store.listActiveExecutions(EXECUTION_PAGE_SIZE, this.cursor);
    if (this.stopped) return;
    if (!executions.length) { this.cursor = ""; return; }
    this.cursor = executions.length === EXECUTION_PAGE_SIZE ? executions.at(-1)!.id : "";
    for (const execution of executions) {
      if (this.stopped) return;
      try { await this.advance(execution.id); }
      catch (error) { this.report(error); }
    }
  }

  private async runnable(id: string): Promise<{ execution: ExecutionRecord; view: ExecutionView } | null> {
    if (this.stopped) return null;
    const execution = await this.store.getExecution(id);
    if (!execution || execution.status !== "active" || this.stopped) return null;
    assertNativeExecutionPlan(execution.plan);
    if (execution.expiresAt <= this.now() || !this.isChatAllowed(execution.chatId)) {
      await this.transition(execution, execution.expiresAt <= this.now() ? "expired" : "failed");
      return null;
    }
    const view = await readExecutionView(this.store, execution, this.now());
    if (view.steps.some(step => ["failed", "cancelled", "expired"].includes(step.status))) {
      await this.transition(execution, "failed");
      return null;
    }
    if (view.steps.some(step => step.status === "uncertain")) return null;
    if (view.steps.every(step => step.status === "completed")) {
      await this.transition(execution, "completed");
      return null;
    }
    await this.store.enqueueProgressNotification({type:"plan",id:execution.id},this.now());
    return { execution, view };
  }

  private async advanceOnce(id: string): Promise<void> {
    await this.store.markExpiredActiveCommandsUncertain();
    const first = await this.runnable(id);
    if (!first) return;
    // The frozen plan has at most four steps; one advance never rescans the database.
    for (const index of first.execution.plan.actions.keys()) {
      const state = await this.runnable(id);
      if (!state || this.stopped) return;
      if (!this.stepReady(state, index)) continue;
      if (this.options.canDispatch && !await this.options.canDispatch(state.execution, index)) continue;
      // Read again after asynchronous preflight: cancellation and competing claims may have won.
      const latest = await this.runnable(id);
      if (!latest || this.stopped) return;
      if (!this.stepReady(latest, index)) continue;
      const { execution } = latest;
      const action = execution.plan.actions[index];
      let input: ExecutionAttempt["input"];
      try { input = await collectExecutionInput(this.store, execution, index); }
      catch (error) {
        if (!(error instanceof ExecutionInputError)) throw error;
        this.report(error);
        await this.transition(execution, "failed");
        return;
      }
      const now = this.now();
      const attempt: ExecutionAttempt = { token: randomUUID(), startedAt: now, expiresAt: now + EXECUTION_CLAIM_MS,
        ...(input ? { input } : {}) };
      const next = { ...execution, revision: execution.revision + 1, attempts: [...execution.attempts] };
      next.attempts[index] = attempt;
      const claimed = await this.store.compareAndSetExecution(next, execution.revision);
      if (!claimed) continue;
      this.changed();
      if (this.stopped) return;
      try {
        await this.commands.submit({ nodeId: action.nodeId, sessionId: action.sessionId, prompt: input?.prompt ?? action.prompt,
          ...(action.skills ? { skills: action.skills } : {}), deliveryMode:action.deliveryMode,expectedTurnId:action.expectedTurnId,action: "send", requestId: executionRequestId(execution, index) },
        0, async () => {
          const snapshot = await this.store.getExecution(id);
          const view = snapshot && await readExecutionView(this.store, snapshot, this.now());
          const validInput = snapshot && await verifyExecutionInput(this.store, snapshot, index);
          // Claims and pending records do not override another step's failure or exact dependencies.
          // Re-read authority after the asynchronous command reads, including cancellation.
          const current = await this.store.getExecution(id);
          if (this.stopped || !current || current.status !== "active" || current.expiresAt <= this.now() ||
              !this.isChatAllowed(current.chatId) || current.attempts[index]?.token !== attempt.token ||
              JSON.stringify(current.attempts[index]) !== JSON.stringify(attempt) ||
              current.attempts[index]!.expiresAt <= this.now() || !view ||
              !validInput || !snapshot || JSON.stringify(snapshot.attempts[index]) !== JSON.stringify(attempt) ||
              !sameExecutionAuthorization(claimed, snapshot) || !sameExecutionAuthorization(claimed, current) ||
              view.steps.some(step => ["failed", "cancelled", "expired", "uncertain"].includes(step.status)) ||
              !action.dependsOn.every(step => view.steps[step - 1].status === "completed")) {
            throw new CommandError(409, "Execution dispatch authority is unavailable");
          }
        }, action.sendRoute,{type:"plan",id:execution.id,chatId:execution.chatId});
      } catch (error) {
        this.report(error);
        if (this.stopped) return;
        const command = await this.store.findCommandByRequestId(executionRequestId(execution, index));
        if (!command && error instanceof CommandError) {
          const current = await this.store.getExecution(id);
          if (current?.status === "active") await this.transition(current, "failed");
        }
        await this.runnable(id);
        return;
      }
    }
    await this.runnable(id);
  }

  private stepReady(state: { execution: ExecutionRecord; view: ExecutionView }, index: number): boolean {
    return !state.execution.attempts[index] && state.view.steps[index].status === "waiting" &&
      state.execution.plan.actions[index].dependsOn.every(step => state.view.steps[step - 1].status === "completed");
  }

  private async transition(execution: ExecutionRecord, status: ExecutionRecord["status"]): Promise<boolean> {
    const saved = await this.store.compareAndSetExecution({ ...execution, status, revision: execution.revision + 1 }, execution.revision, this.now());
    if (saved) this.changed();
    return saved !== null;
  }

  private changed(): void {
    if (this.stopped) return;
    try { this.options.onChanged?.(); }
    catch (error) { this.report(error); }
  }

  private report(error: unknown): void {
    if (!this.options.onError) { console.error("Execution scheduler operation failed"); return; }
    try { this.options.onError(error); }
    catch { console.error("Execution scheduler error reporting failed"); }
  }
}
