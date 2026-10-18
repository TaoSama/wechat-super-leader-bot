import type { AutomationOutbox, AutomationRepository, AutomationRun, RunnerOutcome, Schedule } from "./contracts.js";
import { CLAIM_LEASE_MS } from "./contracts.js";
import { assertSameCreation } from "./identity.js";
import { finishRun, newRun } from "./state.js";
import { dueOccurrence } from "./timing.js";
import { clearRunBody, validateBodyRetention } from "./retention.js";

const copy = <T>(value: T): T => structuredClone(value);
export class MemoryAutomationRepository implements AutomationRepository {
  private schedules = new Map<string, Schedule>();
  private runs = new Map<string, AutomationRun>();
  private outbox = new Map<string, AutomationOutbox>();
  async create(schedule: Schedule): Promise<Schedule> {
    const existing = this.schedules.get(schedule.id);
    if (existing) { assertSameCreation(existing, schedule); return copy(existing); }
    this.schedules.set(schedule.id, copy(schedule));
    return copy(schedule);
  }
  async get(id: string, chatId: string): Promise<Schedule | null> {
    const value = this.schedules.get(id);
    return value?.chatId === chatId ? copy(value) : null;
  }
  async list(chatId: string): Promise<Schedule[]> {
    return [...this.schedules.values()].filter(s => s.chatId === chatId).sort((a, b) => b.createdAt - a.createdAt).map(copy);
  }
  async setStatus(id: string, chatId: string, status: "active" | "paused" | "cancelled", now: number): Promise<Schedule | null> {
    const schedule = this.schedules.get(id);
    if (!schedule || schedule.chatId !== chatId) return null;
    if (schedule.status === "cancelled" || schedule.status === "completed") throw new Error("Finished schedules cannot be resumed or modified");
    schedule.status = status;
    schedule.updatedAt = now;
    if (status === "cancelled") for (const item of this.outbox.values()) if (item.scheduleId === id && item.status === "pending") item.status = "superseded";
    return copy(schedule);
  }
  async listRuns(id: string, chatId: string, limit = 50): Promise<AutomationRun[]> {
    if (!(await this.get(id, chatId))) return [];
    return [...this.runs.values()].filter(run => run.scheduleId === id).sort((a, b) => b.scheduledAt - a.scheduledAt).slice(0, limit).map(copy);
  }
  async claimDue(now: number, owner: string, limit: number): Promise<{ schedule: Schedule; run: AutomationRun }[]> {
    const result: { schedule: Schedule; run: AutomationRun }[] = [];
    for (const schedule of this.schedules.values()) {
      if (result.length >= limit) break;
      if (schedule.status !== "active" || schedule.nextAt === null || schedule.nextAt > now || schedule.activeRunId) continue;
      const candidate = dueOccurrence(schedule, now);
      const skipped = [...this.runs.values()].find(run => run.scheduleId === schedule.id && run.scheduledAt === candidate.scheduledAt);
      if (skipped && skipped.status !== "skipped") throw new Error("Occurrence was already executed");
      const run = newRun(schedule, now, owner, skipped);
      this.runs.set(run.id, run);
      if (run.status === "dispatching") result.push(copy({ schedule, run }));
    }
    return result;
  }
  async claimRunning(now: number, owner: string, limit: number): Promise<{ schedule: Schedule; run: AutomationRun }[]> {
    const result: { schedule: Schedule; run: AutomationRun }[] = [];
    for (const run of this.runs.values()) {
      if (run.claimUntil > now) continue;
      if (!["dispatching", "running"].includes(run.status) || result.length >= limit) continue;
      const schedule = this.schedules.get(run.scheduleId)!;
      // Recovery only inspects the immutable request ID; it never calls start again.
      run.claimOwner = owner; run.claimUntil = now + CLAIM_LEASE_MS;
      result.push(copy({ schedule, run }));
    }
    return result;
  }
  async finish(runId: string, owner: string, outcome: RunnerOutcome, now: number): Promise<boolean> {
    const run = this.runs.get(runId);
    if (!run || run.claimOwner !== owner || run.claimUntil <= now || !["dispatching", "running"].includes(run.status)) return false;
    const schedule = this.schedules.get(run.scheduleId)!;
    const item = finishRun(schedule, run, outcome, now);
    if (item && schedule.status !== "cancelled") {
      if (schedule.retention === "latest") for (const old of this.outbox.values()) if (old.scheduleId === schedule.id && old.status === "pending") old.status = "superseded";
      this.outbox.set(item.id, item);
    }
    return true;
  }
  async pendingOutbox(now: number, limit = 100, excludeIds: readonly string[] = []): Promise<AutomationOutbox[]> {
    for (const item of this.outbox.values()) if (item.status === "pending" && item.expiresAt <= now) item.status = "expired";
    return [...this.outbox.values()].filter(item => item.status === "pending" && !excludeIds.includes(item.id)).sort((a, b) => a.createdAt - b.createdAt).slice(0, limit).map(copy);
  }
  async markPublished(id: string): Promise<void> {
    const item = this.outbox.get(id);
    if (item?.status === "pending") item.status = "published";
  }
  async cleanupBodies(now: number, retentionMs: number): Promise<{ runs: number; outbox: number }> {
    validateBodyRetention(now, retentionMs);
    const cutoff = now - retentionMs;
    const counts = { runs: 0, outbox: 0 };
    for (const item of this.outbox.values()) if (item.status === "pending" && item.expiresAt <= now) item.status = "expired";
    const protectedRun = (run: AutomationRun | undefined) => run && (["dispatching", "running", "unknown"].includes(run.status) || this.schedules.get(run.scheduleId)?.activeRunId === run.id);
    for (const run of this.runs.values()) {
      if (run.bodyClearedAt !== undefined || run.updatedAt > cutoff || protectedRun(run)) continue;
      if ([...this.outbox.values()].some(item => item.runId === run.id && item.status === "pending")) continue;
      clearRunBody(run, now); counts.runs++;
    }
    for (const item of this.outbox.values()) {
      if (item.bodyClearedAt !== undefined || item.createdAt > cutoff || item.status === "pending" || protectedRun(this.runs.get(item.runId))) continue;
      item.text = ""; item.bodyClearedAt = now; counts.outbox++;
    }
    return counts;
  }

}
