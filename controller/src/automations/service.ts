import { randomUUID } from "node:crypto";
import { CreateScheduleSchema, type AutomationRepository, type AutomationRun, type AutomationRunner, type CreateSchedule, type FrozenTarget, type RunnerOutcome, type Schedule } from "./contracts.js";
import type { BackgroundSpec } from "../background/contracts.js";
import { validateTiming } from "./timing.js";
import { assertSameCreation, automationId, automationRequestId } from "./identity.js";
import { AutomationValidationError } from "./errors.js";

export interface CreationAuthority {
  chatId: string;
  currentMessageId: string;
  /** HTTP-only stable creation key; model tools may create distinct tasks in one user turn. */
  idempotencyKey?: string;
  /** Trusted caller derives this from the current user turn, never from a model tool argument. */
  explicitCurrentTurnAuthorization: boolean;
  assertCurrentAuthority?: () => Promise<void>;
}
export interface AutomationServiceOptions {
  repository: AutomationRepository;
  runner: AutomationRunner;
  resolveTarget?: (nodeId: string, sessionId: string) => Promise<FrozenTarget>;
  validateBackground?: (background: BackgroundSpec, authority: CreationAuthority) => Promise<void>;
  /** The run and its outbox are already durable; failures here must never redispatch the run. */
  onFinished?: (run: AutomationRun, schedule: Schedule, outcome: RunnerOutcome) => Promise<void>;
  now?: () => number;
  onError?: (error: unknown, context: string) => void;
}
export class AutomationService {
  readonly repository: AutomationRepository;
  private ticking = false;
  private readonly now: () => number;
  constructor(private readonly options: AutomationServiceOptions) {
    this.repository = options.repository;
    this.now = options.now ?? Date.now;
  }
  async create(input: CreateSchedule, authority: CreationAuthority): Promise<Schedule> {
    if (!authority.explicitCurrentTurnAuthorization || !authority.currentMessageId.trim() || !authority.chatId.trim()) {
      throw new Error("Creating an automation requires explicit authorization in the current user turn");
    }
    const parsed = CreateScheduleSchema.parse(input);
    const id = authority.idempotencyKey === undefined ? automationId(authority.chatId, authority.currentMessageId, parsed)
      : automationRequestId(authority.chatId, authority.idempotencyKey);
    const existing = await this.repository.get(id, authority.chatId);
    if (existing) {
      assertSameCreation(existing, { ...existing, ...parsed, authorizedMessageId: authority.currentMessageId });
      await authority.assertCurrentAuthority?.();
      return existing;
    }
    const now = this.now();
    const nextAt = validateTiming(parsed, now);
    let target: FrozenTarget | undefined;
    if (parsed.kind === "background") {
      if (!this.options.validateBackground) throw new Error("Background worker execution is unavailable");
      await this.options.validateBackground(parsed.background, authority);
    }
    if (parsed.kind === "session") {
      if (!this.options.resolveTarget) throw new Error("Session discovery is unavailable");
      target = await this.options.resolveTarget(parsed.nodeId, parsed.sessionId);
      if (target.nodeId !== parsed.nodeId || target.sessionId !== parsed.sessionId || target.sendRoute === "terminal-pane") {
        throw new AutomationValidationError("Discovered session has no supported completion observation route");
      }
    }
    await authority.assertCurrentAuthority?.();
    return this.repository.create({ ...parsed, id, chatId: authority.chatId,
      authorizedMessageId: authority.currentMessageId, status: "active", nextAt, createdAt: now, updatedAt: now,
      ...(target ? { target } : {}),
    });
  }
  async tick(limit = 20): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const owner = randomUUID();
    try {
      const running = await this.repository.claimRunning(this.now(), owner, limit);
      await Promise.all(running.map(async ({ schedule, run }) => {
        let outcome: RunnerOutcome;
        try {
          outcome = await this.options.runner.inspect(run, schedule);
        } catch (error) {
          this.options.onError?.(error, `automation inspect ${run.id}`);
          // Inspecting again is safe; dispatching again is not.
          outcome = { status: "running", commandId: run.commandId, error: "Inspection temporarily failed; retrying observation without redispatch" };
        }
        await this.finish(run, schedule, owner, outcome);
      }));
      const due = await this.repository.claimDue(this.now(), owner, limit);
      await Promise.all(due.map(async ({ schedule, run }) => {
        let outcome: RunnerOutcome;
        const current = await this.repository.get(schedule.id, schedule.chatId);
        if (!current || current.status !== "active") outcome = { status: "skipped", reason: current?.status === "paused" ? "paused" : "cancelled" };
        else if (schedule.kind === "reminder") outcome = { status: "completed", result: { text: schedule.text } };
        else {
          try { outcome = await this.options.runner.start(run, schedule); }
          catch (error) {
            this.options.onError?.(error, `automation dispatch ${run.id}`);
            outcome = { status: "unknown", error: "Dispatch failed without a definite non-submission receipt; inspect manually before resuming" };
          }
        }
        await this.finish(run, schedule, owner, outcome);
      }));
    } finally { this.ticking = false; }
  }
  private async finish(run: AutomationRun, schedule: Schedule, owner: string, outcome: RunnerOutcome): Promise<void> {
    if (!await this.repository.finish(run.id, owner, outcome, this.now()) || !this.options.onFinished) return;
    try { await this.options.onFinished(run, schedule, outcome); }
    catch (error) {
      if (!this.options.onError) throw error;
      this.options.onError(error, `automation post-commit ${run.id}`);
    }
  }
}
