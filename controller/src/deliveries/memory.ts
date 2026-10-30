import { MAX_CATCHUP_SOURCES, PREPARATION_LEASE_MS, assertSameResult, canSupersede, claimDelivery, deferDelivery, receiptDelivery, type DeliveryPlan, type DeliveryRepository, type StoredResultArtifact } from "./contracts.js";
import { CatchupConflictError, catchupEligible, catchupSourcesValid } from "./catchup.js";

export class MemoryDeliveryRepository implements DeliveryRepository {
  private readonly plans = new Map<string, DeliveryPlan>();
  private readonly artifacts = new Map<string, StoredResultArtifact>();
  private readonly resumes = new Map<string, { resumed: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  async createIfAbsent(plan: DeliveryPlan, artifact: StoredResultArtifact, now = this.now()): Promise<DeliveryPlan> {
    const existing = [...this.plans.values()].find(value => value.key === plan.key);
    const resumeKey = plan.resumeGeneration ? JSON.stringify([plan.chatId, plan.resumeGeneration]) : undefined;
    if (existing) {
      assertSameResult(existing, plan);
      if (resumeKey) this.resumes.set(resumeKey, { resumed: 1 });
      return structuredClone(existing);
    }
    if (resumeKey && this.resumes.has(resumeKey)) throw new CatchupConflictError();
    if (this.plans.has(plan.id) || this.artifacts.has(artifact.id)) throw new Error("Result ID already exists");
    plan = structuredClone(plan);
    if (plan.catchupSourceIds) {
      const sources = plan.catchupSourceIds.map(id => this.plans.get(id)).filter((source): source is DeliveryPlan => Boolean(source));
      if (!catchupSourcesValid(plan, sources, now, false)) throw new CatchupConflictError();
      plan.status = "preparing";
      for (const source of sources) source.catchupId = plan.id;
    }
    for (const older of this.plans.values()) {
      if (canSupersede(older, plan)) older.status = "superseded";
      else if (canSupersede(plan, older)) plan.status = "superseded";
    }
    this.plans.set(plan.id, structuredClone(plan));
    this.artifacts.set(artifact.id, { ...structuredClone(artifact), bytes: Buffer.from(artifact.bytes) });
    if (resumeKey) this.resumes.set(resumeKey, { resumed: 1 });
    return structuredClone(plan);
  }
  async get(id: string, now = this.now()): Promise<DeliveryPlan | null> {
    const plan = this.plans.get(id);
    if (plan?.status === "claimed" && (plan.attemptExpiresAt ?? 0) <= now) plan.status = "uncertain";
    return structuredClone(plan ?? null);
  }
  async getByKey(key: string): Promise<DeliveryPlan | null> {
    return structuredClone([...this.plans.values()].find(value => value.key === key) ?? null);
  }
  async list(chatIds: readonly string[], limit = 100): Promise<DeliveryPlan[]> {
    return structuredClone([...this.plans.values()].filter(plan => chatIds.includes(plan.chatId))
      .sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id)).slice(0, Math.min(100, Math.max(0, limit))));
  }
  async hasActiveDelivery(chatId: string, now: number): Promise<boolean> {
    return [...this.plans.values()].some(plan => plan.chatId === chatId &&
      ["ready", "preparing", "waiting_for_user", "claimed"].includes(plan.status) &&
      plan.expiresAt > now && plan.retainedUntil > now);
  }
  async listMaintenance(chatIds: readonly string[], now: number, afterId?: string, limit = 20): Promise<DeliveryPlan[]> {
    return structuredClone([...this.plans.values()].filter(plan => chatIds.includes(plan.chatId) &&
      ["preparing", "waiting_for_user"].includes(plan.status) && plan.expiresAt > now && plan.retainedUntil > now &&
      (!afterId || plan.id > afterId)).sort((a, b) => a.id.localeCompare(b.id)).slice(0, Math.min(100, Math.max(0, limit))));
  }
  async getArtifact(id: string): Promise<StoredResultArtifact | null> {
    const artifact = this.artifacts.get(id);
    return artifact ? { ...structuredClone(artifact), bytes: Buffer.from(artifact.bytes) } : null;
  }
  async listCatchupCandidates(chatId: string, now: number, limit = MAX_CATCHUP_SOURCES): Promise<DeliveryPlan[]> {
    return structuredClone([...this.plans.values()].filter(plan => catchupEligible(plan, chatId, now))
      .sort((left, right) => left.id.localeCompare(right.id)).slice(0, Math.max(0, Math.min(MAX_CATCHUP_SOURCES, limit))));
  }
  async listResumeCandidates(chatId: string, now: number, limit = MAX_CATCHUP_SOURCES): Promise<DeliveryPlan[]> {
    return structuredClone([...this.plans.values()].filter(plan => plan.chatId === chatId && plan.status === "waiting_for_user" &&
      !plan.catchupId && plan.expiresAt > now && plan.retainedUntil > now).sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, Math.max(0, Math.min(MAX_CATCHUP_SOURCES, limit))));
  }
  async getResumeRecord(chatId: string, generation: string): Promise<{ resumed: number } | null> {
    return structuredClone(this.resumes.get(JSON.stringify([chatId, generation])) ?? null);
  }
  async claimPreparation(id: string, token: string, now: number): Promise<DeliveryPlan | null> {
    const plan = this.plans.get(id);
    if (!plan || plan.status !== "preparing" || plan.retainedUntil <= now || (plan.preparation?.until ?? 0) > now) return null;
    plan.preparation = { token, until: now + PREPARATION_LEASE_MS };
    delete plan.error;
    return structuredClone(plan);
  }
  async finishPreparation(id: string, token: string, messages: string[], error?: string, now = this.now()): Promise<DeliveryPlan | null> {
    const plan = this.plans.get(id);
    if (!plan || plan.status !== "preparing" || plan.preparation?.token !== token) return null;
    delete plan.preparation;
    if (error) plan.error = error;
    else {
      if (plan.catchupSourceIds) {
        const sources = plan.catchupSourceIds.map(sourceId => this.plans.get(sourceId)).filter((source): source is DeliveryPlan => Boolean(source));
        const valid = catchupSourcesValid(plan, sources, now, true);
        for (const source of sources) if (source.catchupId === plan.id) {
          if (valid) source.status = "superseded";
          else delete source.catchupId;
        }
        if (!valid) { plan.status = "superseded"; plan.error = "catchup_sources_changed"; return structuredClone(plan); }
      }
      plan.messages = [...messages]; plan.status = "ready"; delete plan.error;
    }
    return structuredClone(plan);
  }
  async listPending(chatIds: readonly string[], now: number, limit = 20): Promise<DeliveryPlan[]> {
    for (const plan of this.plans.values()) if (plan.status === "claimed" && (plan.attemptExpiresAt ?? 0) <= now) plan.status = "uncertain";
    return structuredClone([...this.plans.values()].filter(plan => chatIds.includes(plan.chatId) && plan.status === "ready" &&
      plan.expiresAt > now && plan.retainedUntil > now && plan.createdAt <= now).sort((a, b) => Number(a.kind === "progress") - Number(b.kind === "progress") ||
        a.createdAt - b.createdAt || a.id.localeCompare(b.id))
      .slice(0, Math.min(100, Math.max(0, limit))));
  }
  async claim(id: string, attemptId: string, now: number): Promise<DeliveryPlan | null> {
    await this.get(id, now);
    const plan = this.plans.get(id), next = plan ? claimDelivery(plan, attemptId, now) : null;
    if (next) this.plans.set(id, next);
    return structuredClone(next);
  }
  async defer(id: string, attemptId: string, reason: string, now: number, submittedMessages = 0): Promise<DeliveryPlan | null> {
    const plan = this.plans.get(id), next = plan ? deferDelivery(plan, attemptId, reason, now, submittedMessages) : null;
    if (next) this.plans.set(id, next);
    return structuredClone(next);
  }
  async resumeChat(chatId: string, now: number, generation?: string, sourceIds?: readonly string[]): Promise<number> {
    const resumeKey = generation ? JSON.stringify([chatId, generation]) : undefined;
    if (resumeKey && this.resumes.has(resumeKey)) return this.resumes.get(resumeKey)!.resumed;
    let resumed = 0;
    for (const plan of this.plans.values()) if (plan.chatId === chatId && plan.status === "waiting_for_user" && !plan.catchupId &&
      (!sourceIds || sourceIds.includes(plan.id)) && plan.expiresAt > now && plan.retainedUntil > now) {
      plan.status = "ready"; delete plan.deferReason; resumed++;
    }
    if (resumeKey) this.resumes.set(resumeKey, { resumed });
    return resumed;
  }
  async markChatWaiting(chatId: string, reason: string, now: number): Promise<number> {
    let blocked = 0;
    for (const plan of this.plans.values()) if (plan.chatId === chatId && plan.status === "ready" &&
      (plan.submittedMessages ?? 0) === 0 && plan.createdAt <= now && plan.expiresAt > now && plan.retainedUntil > now) {
      plan.status = "waiting_for_user"; plan.deferReason = reason; blocked++;
    }
    return blocked;
  }
  async recordReceipt(id: string, status: "accepted" | "uncertain", attemptId: string): Promise<DeliveryPlan | null> {
    const plan = this.plans.get(id);
    const next = plan ? receiptDelivery(plan, status, attemptId) : null;
    if (next) this.plans.set(id, next);
    return structuredClone(next);
  }
  async prune(now: number): Promise<number> {
    let removed = 0;
    for (const [id, plan] of this.plans) if (plan.retainedUntil <= now) {
      this.plans.delete(id); this.artifacts.delete(plan.artifact.id); removed++;
    }
    return removed;
  }
}
