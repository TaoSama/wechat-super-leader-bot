import { randomUUID } from "node:crypto";
import type { RunnerOutcome, RunResult } from "../automations/contracts.js";
import { BACKGROUND_LEASE_MS, BACKGROUND_LEASE_RENEWAL_MS, BackgroundSpecSchema, WORKER_LIFETIME_MS, WORKER_SHUTDOWN_GRACE_MS, WORKER_TURN_TIMEOUT_MS, MAX_WORKER_TURN_TIMEOUT_MS,
  type BackgroundInvocation, type BackgroundRun, type BackgroundServiceOptions, type BackgroundSpec,
  type BackgroundWorker, type WorkerReceipt } from "./contracts.js";
import { clearBackgroundBody } from "./retention.js";
import { fallbackSummary, observationInput, observeSources } from "./observations.js";

const terminal = (receipt: WorkerReceipt) => !["running", "queued", "unknown"].includes(receipt.status);
const running = (): RunnerOutcome => ({ status: "running" });
export class BackgroundService {
  readonly repository;
  private readonly now: () => number;
  private readonly turnTimeoutMs: number;
  constructor(private readonly options: BackgroundServiceOptions) {
    this.repository = options.repository;
    this.now = options.now ?? Date.now;
    this.turnTimeoutMs = options.turnTimeoutMs ?? WORKER_TURN_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.turnTimeoutMs) || this.turnTimeoutMs <= 0 || this.turnTimeoutMs > MAX_WORKER_TURN_TIMEOUT_MS) {
      throw new Error("Background turn timeout must be a positive integer of at most one hour");
    }
  }
  async start(run: BackgroundRun, spec: BackgroundSpec): Promise<RunnerOutcome> {
    return this.advance((await this.register(run, spec)).id);
  }
  /** Registration performs no source I/O or model work, so the schedule tick stays responsive. */
  async register(run: BackgroundRun, spec: BackgroundSpec): Promise<BackgroundWorker> {
    const parsed = BackgroundSpecSchema.parse(spec);
    if (parsed.sources.some(source => source.offsetMs >= parsed.deadlineMs)) {
      throw new Error("Source expected time must precede the monitoring deadline");
    }
    const now = this.now();
    return this.repository.create({ id: randomUUID(), runId: run.id, scheduleId: run.scheduleId,
      chatId: run.chatId, scheduledAt: run.scheduledAt, spec: parsed, createdAt: now, expiresAt: now + WORKER_LIFETIME_MS,
      deadlineAt: run.scheduledAt + parsed.deadlineMs, phase: "observing", checkCount: 0, nextCheckAt: now,
      observations: [], prompts: [], invocations: [], leaseUntil: 0, updatedAt: now });
  }
  async inspect(run: BackgroundRun, spec?: BackgroundSpec): Promise<RunnerOutcome> {
    const worker = await this.repository.getByRun(run.id);
    // Claim recovery may happen before start created a worker: no submission has taken place.
    if (!worker) return spec ? this.start(run, spec) : { status: "unknown", error: "Background worker binding is unavailable; automatic redispatch is disabled" };
    if (worker.chatId !== run.chatId || worker.scheduleId !== run.scheduleId || worker.scheduledAt !== run.scheduledAt) throw new Error("Background run identity mismatch");
    return this.advance(worker.id);
  }
  async list(chatId: string, limit = 100): Promise<BackgroundWorker[]> { return this.repository.list(chatId, limit); }
  async get(workerId: string, chatId: string): Promise<BackgroundWorker | null> {
    const worker = await this.repository.get(workerId);
    return worker?.chatId === chatId ? worker : null;
  }
  async enqueue(workerId: string, chatId: string, prompt: string, requestId: string): Promise<BackgroundWorker> {
    if (!prompt.trim() || prompt.length > 128_000 || !requestId.trim()) throw new Error("A bounded prompt and idempotency key are required");
    const now = this.now();
    const result = await this.repository.update(workerId, worker => {
      this.assertChat(worker, chatId);
      if (worker.bodyClearedAt || worker.expiresAt <= now || ["cleaned", "cleaning", "expired", "cancelled", "quarantined"].includes(worker.phase) || worker.cancelRequestedAt) throw new Error("Background worker expired; extend it before enqueueing work");
      const previous = worker.prompts.find(item => item.requestId === requestId);
      if (previous) { if (previous.prompt !== prompt) throw new Error("Follow-up idempotency key was reused for different input"); return; }
      worker.prompts.push({ requestId, prompt, invocationId: randomUUID(), createdAt: now });
      worker.updatedAt = now;
    });
    if (!result) throw new Error("Background worker not found");
    return result;
  }
  async cancel(workerId: string, chatId: string): Promise<BackgroundWorker> {
    const worker = await this.repository.update(workerId, current => {
      this.assertChat(current, chatId);
      current.cancelRequestedAt ??= this.now(); current.updatedAt = this.now();
    });
    if (!worker) throw new Error("Background worker not found");
    if (worker.activeInvocationId && worker.phase !== "quarantined") await this.options.runtime.cancel(worker.id, worker.activeInvocationId);
    return worker;
  }
  /** Explicit user action only: inspection and automatic activity never call this method. */
  async extend(workerId: string, chatId: string, expiresAt: number): Promise<BackgroundWorker> {
    const now = this.now();
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + WORKER_LIFETIME_MS) throw new Error("Extension must end within the next 24 hours");
    const result = await this.repository.update(workerId, worker => {
      this.assertChat(worker, chatId);
      if (["cleaned", "cleaning", "expired", "cancelled", "quarantined"].includes(worker.phase) || worker.cancelRequestedAt) throw new Error("Cleaned or expired worker cannot be resumed");
      if (expiresAt <= worker.expiresAt) throw new Error("Extension must increase the current expiry");
      worker.expiresAt = expiresAt; worker.updatedAt = now;
    });
    if (!result) throw new Error("Background worker not found");
    return result;
  }
  /** Called only after the initial outcome is durably committed to the unified outbox. */
  async acceptResult(runId: string): Promise<void> {
    const worker = await this.repository.getByRun(runId);
    if (!worker) throw new Error("Cannot accept result for an unknown worker");
    await this.repository.update(worker.id, current => {
      if (!current.initialOutcome || !["completed", "failed"].includes(current.initialOutcome.status)) throw new Error("No final background result to accept");
      current.initialAcceptedAt ??= this.now();
      for (const invocation of current.invocations.filter(item => item.kind === "initial" && item.result && item.receipt?.status !== "waiting")) invocation.acceptedAt ??= this.now();
    });
  }
  async maintenance(limit = 100): Promise<void> {
    const workers = await this.repository.listLive(limit);
    const results = await Promise.allSettled(workers.map(worker => this.advance(worker.id)));
    const failures = results.flatMap((result, index) => {
      if (result.status === "fulfilled") return [];
      this.options.onError?.(result.reason, `background maintenance ${workers[index].id}`);
      return [result.reason];
    });
    if (failures.length) throw new AggregateError(failures, "Background maintenance failed; durable state retained for retry");
  }
  private allowed(chatId: string): boolean { return this.options.isAllowed?.(chatId) ?? true; }
  private stopping(): boolean { return this.options.isStopping?.() ?? false; }
  private assertChat(worker: BackgroundWorker, chatId: string): void {
    if (worker.chatId !== chatId) throw new Error("Background worker does not belong to this chat");
    if (!this.allowed(chatId)) throw new Error("Background authorization has been revoked");
  }
  private async advance(workerId: string): Promise<RunnerOutcome> {
    const owner = randomUUID();
    const now = this.now();
    let acquired = false;
    let worker = await this.repository.update(workerId, current => {
      if (current.leaseUntil > now || current.phase === "cleaned") return;
      current.leaseOwner = owner; current.leaseUntil = now + BACKGROUND_LEASE_MS; current.updatedAt = now; acquired = true;
    });
    if (!worker) throw new Error("Background worker disappeared");
    if (!acquired) return this.allowed(worker.chatId) ? worker.initialOutcome ?? running() : running();
    let renewalFailure: unknown;
    let renewing: Promise<void> | undefined;
    const renewalTimer = setInterval(() => {
      if (renewing || renewalFailure) return;
      renewing = this.repository.update(workerId, current => {
        if (current.leaseOwner !== owner || current.leaseUntil <= this.now()) throw new Error("Background lease lost during renewal");
        current.leaseUntil = this.now() + BACKGROUND_LEASE_MS; current.updatedAt = this.now();
      }).then(saved => { if (!saved) throw new Error("Background worker disappeared during renewal"); })
        .catch(error => { renewalFailure = error; })
        .finally(() => { renewing = undefined; });
    }, BACKGROUND_LEASE_RENEWAL_MS);
    renewalTimer.unref();
    const save = async (mutate: (current: BackgroundWorker) => void): Promise<BackgroundWorker> => {
      if (renewalFailure) throw renewalFailure;
      const saved = await this.repository.update(workerId, current => {
        if (current.leaseOwner !== owner || current.leaseUntil <= this.now()) throw new Error("Background lease lost");
        mutate(current); current.updatedAt = this.now();
      });
      if (!saved) throw new Error("Background worker disappeared during update");
      return saved;
    };
    try {
      if (this.stopping()) return worker.initialOutcome ?? running();
      if (!this.allowed(worker.chatId)) {
        if (worker.activeInvocationId && !worker.suspendedAt) await this.options.runtime.cancel(worker.id, worker.activeInvocationId);
        if (this.stopping()) return worker.initialOutcome ?? running();
        worker = await save(current => { current.suspendedAt ??= this.now(); });
        if (this.now() >= worker.expiresAt && worker.phase !== "quarantined") await this.expireRevoked(worker, save);
        return running();
      }
      if (worker.suspendedAt) worker = await save(current => { delete current.suspendedAt; });
      if (worker.phase === "quarantined") {
        worker = await this.deliverFollowups(worker, save);
        return worker.initialOutcome ?? running();
      }
      const scheduleStatus = await this.options.getScheduleStatus?.(worker.scheduleId, worker.chatId);
      if (this.stopping()) return worker.initialOutcome ?? running();
      if (worker.cancelRequestedAt || scheduleStatus === "cancelled") {
        worker = await save(current => { current.cancelRequestedAt ??= this.now(); });
        if (worker.activeInvocationId) {
          const invocation = worker.invocations.find(item => item.id === worker!.activeInvocationId)!;
          await this.options.runtime.cancel(worker.id, invocation.id);
          const receipt = await this.options.runtime.inspect(worker.id, invocation.id);
          if (this.stopping()) return worker.initialOutcome ?? running();
          if (receipt.error === "worker_process_cleanup_unverified") return (await this.recordReceipt(worker, invocation, receipt, save)).initialOutcome ?? running();
          if (!terminal(receipt) && !receipt.receiptMissing) return worker.initialOutcome ?? running();
          worker = await this.recordReceipt(worker, invocation, { ...receipt, status: "failed", summary: receipt.summary || "后台任务已按要求取消。", error: "worker_cancelled" }, save);
        }
        worker = await save(current => {
          current.phase = "cancelled";
          current.initialOutcome ??= { status: "failed", result: { text: "后台任务已按要求取消。", error: "worker_cancelled" } };
          for (const prompt of current.prompts) if (!prompt.deliveredAt) prompt.cancelledAt ??= this.now();
          for (const invocation of current.invocations) if (invocation.result && !invocation.acceptedAt) invocation.discardedAt ??= this.now();
        });
        if (this.now() >= worker.expiresAt) worker = await this.expire(worker, save);
        return worker.initialOutcome ?? running();
      }
      if (worker.activeInvocationId) {
        const invocation = worker.invocations.find(item => item.id === worker!.activeInvocationId)!;
        const bounds = { launchDeadlineAt: worker.expiresAt, executionDeadlineAt: worker.expiresAt + WORKER_SHUTDOWN_GRACE_MS };
        if (this.now() >= worker.expiresAt) {
          // Reading an expired queue must not itself cross the launch boundary.
          // Already active turns retain their bounded shutdown grace.
          const beforeCancel = await this.options.runtime.inspect(worker.id, invocation.id, { ...bounds, resumeQueued: false });
          if (this.stopping()) return worker.initialOutcome ?? running();
          if (terminal(beforeCancel)) worker = await this.recordReceipt(worker, invocation, beforeCancel, save);
          else if (beforeCancel.status === "queued" || this.now() >= worker.expiresAt + WORKER_SHUTDOWN_GRACE_MS) {
            worker = await save(current => { current.phase = "expired"; });
            await this.options.runtime.cancel(worker.id, invocation.id);
            const afterCancel = await this.options.runtime.inspect(worker.id, invocation.id, { ...bounds, resumeQueued: false });
            if (this.stopping()) return worker.initialOutcome ?? running();
            worker = await this.recordReceipt(worker, invocation,
              afterCancel.status === "completed" || afterCancel.error === "worker_process_cleanup_unverified" ? afterCancel : {
                receiptMissing: afterCancel.receiptMissing, status: "failed", summary: fallbackSummary(worker, "后台会话保留期已结束，本轮执行已停止。"), error: "worker_expired" }, save);
          } else {
            worker = await save(current => { current.invocations.find(item => item.id === invocation.id)!.receipt = beforeCancel; });
            return worker.initialOutcome ?? running();
          }
          if (worker.phase === "quarantined") return worker.initialOutcome ?? running();
        } else {
          const receipt = await this.options.runtime.inspect(worker.id, invocation.id, bounds);
          if (this.stopping()) return worker.initialOutcome ?? running();
          if (terminal(receipt)) worker = await this.recordReceipt(worker, invocation, receipt, save);
          else {
            worker = await save(current => { current.invocations.find(item => item.id === invocation.id)!.receipt = receipt; });
            return worker.initialOutcome ?? running();
          }
        }
      }
      if (this.stopping()) return worker.initialOutcome ?? running();
      if (this.now() >= worker.expiresAt) {
        worker = await this.expire(worker, save);
        return worker.initialOutcome ?? running();
      }
      worker = await this.deliverFollowups(worker, save);
      const pending = worker.prompts.find(item => !item.deliveredAt && !item.cancelledAt);
      const queued = pending && (pending.notBefore ?? 0) <= this.now() && !worker.invocations.some(invocation => invocation.id === pending.invocationId) ? pending : undefined;
      if (queued && (!worker.initialOutcome || worker.initialAcceptedAt)) {
        const observations = await observeSources({ ...worker, observations: [] }, this.options.sources, this.now());
        if (this.stopping()) return worker.initialOutcome ?? running();
        worker = await save(current => { current.observations = observations; });
        worker = await this.launch(worker, { id: queued.invocationId, kind: "followup", task: queued.prompt,
          input: { observations: worker.observations, previousResult: worker.initialOutcome }, createdAt: this.now(), status: "prepared" }, save);
        return worker.initialOutcome ?? running();
      }
      // Initial result acceptance is the durable handoff boundary. Pending user work waits behind it.
      if (worker.initialOutcome) return worker.initialOutcome;
      if (worker.nextCheckAt > this.now()) return running();
      if (worker.spec.sources.length) {
        const observations = await observeSources(worker, this.options.sources, this.now());
        if (this.stopping()) return worker.initialOutcome ?? running();
        const failures = observations.filter(item => item.status === "failed" && !worker!.observations.some(previous =>
          previous.nodeId === item.nodeId && previous.automationId === item.automationId && previous.status === "failed"));
        worker = await save(current => {
          current.observations = observations; current.checkCount++;
          if (failures.length) current.invocations.push({ id: randomUUID(), kind: "followup", task: "Source failure observation",
            input: {}, createdAt: this.now(), status: "failed", exported: true,
            result: { text: fallbackSummary(current, "检测到来源任务失败；其余任务将继续跟踪至结果齐备或汇报截止。"), error: "source_failed" } });
        });
        worker = await this.deliverFollowups(worker, save);
        const allSettled = observations.every(item => ["completed", "failed"].includes(item.status));
        if (!allSettled && this.now() < worker.deadlineAt) {
          const index = Math.min(worker.checkCount - 1, worker.spec.checkIntervalsMs.length - 1);
          worker = await save(current => { current.nextCheckAt = Math.min(this.now() + current.spec.checkIntervalsMs[index], current.deadlineAt, current.expiresAt); });
          return running();
        }
      }
      worker = await this.launch(worker, { id: randomUUID(), kind: "initial", task: worker.spec.prompt,
        input: observationInput(worker, this.now()), createdAt: this.now(), status: "prepared" }, save);
      return worker.initialOutcome ?? running();
    } finally {
      clearInterval(renewalTimer);
      if (renewing) await renewing;
      await this.repository.update(workerId, current => {
        if (current.leaseOwner === owner) { current.leaseUntil = 0; delete current.leaseOwner; }
      });
      if (renewalFailure) throw renewalFailure;
    }
  }
  private async launch(worker: BackgroundWorker, invocation: BackgroundInvocation,
    save: (mutate: (current: BackgroundWorker) => void) => Promise<BackgroundWorker>): Promise<BackgroundWorker> {
    if (this.stopping() || !this.allowed(worker.chatId) || worker.cancelRequestedAt || this.now() >= worker.expiresAt) return worker;
    // Persist the invocation before calling external runtime; a crash can only inspect this identity.
    worker = await save(current => { current.invocations.push(invocation); current.activeInvocationId = invocation.id; current.phase = "executing"; });
    const cancelled = (await this.options.getScheduleStatus?.(worker.scheduleId, worker.chatId)) === "cancelled";
    let canLaunch = false;
    worker = await save(current => {
      if (cancelled && !this.stopping()) current.cancelRequestedAt ??= this.now();
      canLaunch = !this.stopping() && this.allowed(current.chatId) && !current.cancelRequestedAt && this.now() < current.expiresAt;
      if (canLaunch) return;
      current.invocations = current.invocations.filter(item => item.id !== invocation.id);
      delete current.activeInvocationId;
      current.phase = !current.initialOutcome ? "observing" : current.initialOutcome.status === "failed" ? "failed" : "completed";
    });
    if (!canLaunch) return worker;
    let receipt: WorkerReceipt;
    try { receipt = await this.options.runtime.start({ workerId: worker.id, invocationId: invocation.id, task: invocation.task,
      preferences: worker.spec.preferences, input: invocation.input,
      launchDeadlineAt: worker.expiresAt, executionDeadlineAt: worker.expiresAt + WORKER_SHUTDOWN_GRACE_MS,
      timeoutMs: Math.min(this.turnTimeoutMs, MAX_WORKER_TURN_TIMEOUT_MS, Math.max(1, worker.expiresAt + WORKER_SHUTDOWN_GRACE_MS - this.now())) }); }
    catch (error) {
      this.options.onError?.(error, `background submit ${invocation.id}`);
      // Ambiguous submission remains active; inspect the same operation after recovery.
      return save(current => { const active = current.invocations.find(item => item.id === invocation.id)!;
        active.status = "running"; active.receipt = { status: "unknown", error: "Submission receipt unavailable; observing without redispatch" }; });
    }
    if (terminal(receipt)) return this.recordReceipt(worker, invocation, receipt, save);
    return save(current => { const active = current.invocations.find(item => item.id === invocation.id)!; active.status = "running"; active.receipt = receipt; });
  }
  private async recordReceipt(worker: BackgroundWorker, invocation: BackgroundInvocation, receipt: WorkerReceipt,
    save: (mutate: (current: BackgroundWorker) => void) => Promise<BackgroundWorker>): Promise<BackgroundWorker> {
    // Export precedes durable result acceptance, so workspace removal cannot remove deliverables.
    const quarantined = receipt.error === "worker_process_cleanup_unverified";
    const artifacts = receipt.receiptMissing || quarantined ? [] : await this.options.runtime.exportArtifacts(worker.id, invocation.id);
    const links = artifacts.length ? await this.options.artifactLinks?.(worker, invocation, artifacts) : [];
    if (artifacts.length && !links) throw new Error("Artifact delivery links are unavailable; exported results remain retained");
    let summary = receipt.summary?.trim() || fallbackSummary(worker, receipt.error ?? "后台任务未提供完整结果。");
    if (receipt.status === "waiting" && invocation.kind === "initial" && this.now() >= worker.deadlineAt) {
      summary = `已到本轮汇报截止时间，跟踪已结束；以下为现有结果及缺项。\n${summary}`;
    }
    const text = [summary, ...(links ?? [])].join("\n\n");
    if (receipt.status === "waiting" && this.now() < (invocation.kind === "initial" ? worker.deadlineAt : worker.expiresAt)) {
      const requestedAt = receipt.nextCheckAt ? Date.parse(receipt.nextCheckAt) : NaN;
      return save(current => {
        const active = current.invocations.find(item => item.id === invocation.id)!;
        active.status = "completed"; active.receipt = { ...receipt, artifacts }; active.exported = true;
        if (artifacts.length) active.result = { text, meaningful: true };
        delete current.activeInvocationId;
        current.phase = !current.initialOutcome ? "observing" : current.initialOutcome.status === "failed" ? "failed" : "completed";
        const fallback = this.now() + current.spec.checkIntervalsMs[Math.min(current.checkCount++, current.spec.checkIntervalsMs.length - 1)];
        const nextAt = Math.min(Number.isFinite(requestedAt) && requestedAt > this.now() ? requestedAt : fallback,
          invocation.kind === "initial" ? current.deadlineAt : current.expiresAt, current.expiresAt);
        if (invocation.kind === "initial") current.nextCheckAt = nextAt;
        else {
          const prompt = current.prompts.find(item => item.invocationId === invocation.id);
          if (!prompt) throw new Error("Follow-up continuation lost its queued prompt");
          prompt.invocationId = randomUUID(); prompt.notBefore = nextAt;
        }
      });
    }
    const failed = ["failed", "needs_attention", "unknown"].includes(receipt.status);
    const result: RunResult = { text, meaningful: true, ...(failed ? { error: receipt.error ?? receipt.status } : {}) };
    // Artifacts belong in the durable receipt even when result delivery has not succeeded yet.
    const durableReceipt = { ...receipt, artifacts };
    return save(current => {
      const active = current.invocations.find(item => item.id === invocation.id)!;
      active.status = failed ? "failed" : "completed"; active.receipt = durableReceipt; active.result = result; active.exported = !quarantined;
      delete current.activeInvocationId;
      if (invocation.kind === "initial") {
        current.initialOutcome = { status: failed ? "failed" : "completed", result };
        current.phase = failed ? "failed" : "completed";
      } else current.phase = !current.initialOutcome ? "observing" : current.initialOutcome.status === "failed" ? "failed" : "completed";
      if (quarantined) current.phase = "quarantined";
    });
  }
  private async deliverFollowups(worker: BackgroundWorker,
    save: (mutate: (current: BackgroundWorker) => void) => Promise<BackgroundWorker>): Promise<BackgroundWorker> {
    if (this.stopping() || !this.allowed(worker.chatId) || worker.cancelRequestedAt) return worker;
    for (const invocation of worker.invocations.filter(item => (item.kind === "followup" || item.receipt?.status === "waiting") && item.result && !item.acceptedAt && !item.discardedAt)) {
      await this.options.deliverSupplement(worker, invocation, invocation.result!);
      worker = await save(current => {
        current.invocations.find(item => item.id === invocation.id)!.acceptedAt = this.now();
        const prompt = current.prompts.find(item => item.invocationId === invocation.id);
        if (prompt && invocation.receipt?.status !== "waiting") prompt.deliveredAt = this.now();
      });
    }
    return worker;
  }
  private async expire(worker: BackgroundWorker,
    save: (mutate: (current: BackgroundWorker) => void) => Promise<BackgroundWorker>): Promise<BackgroundWorker> {
    if (!worker.initialOutcome) {
      worker = await save(current => { current.phase = "expired"; current.initialOutcome = { status: "failed", result: {
        text: fallbackSummary(current, "24 小时保留期已结束，本轮跟踪结束。"), error: "worker_expired" } }; });
    }
    worker = await this.deliverFollowups(worker, save);
    if ((!worker.initialAcceptedAt && !worker.initialDiscardedAt) || worker.activeInvocationId || worker.invocations.some(item => item.result && !item.acceptedAt && !item.discardedAt)) return worker;
    // Unstarted queued work is reported through the same outbox before disposing its workspace.
    for (const prompt of worker.prompts.filter(item => !item.deliveredAt && !item.cancelledAt)) {
      const invocation: BackgroundInvocation = { id: prompt.invocationId, kind: "followup", task: prompt.prompt, input: {},
        createdAt: prompt.createdAt, status: "failed", result: { text: "后台会话已到期，此追问尚未开始执行。", error: "worker_expired" } };
      await this.options.deliverSupplement(worker, invocation, invocation.result!);
      worker = await save(current => { current.prompts.find(item => item.invocationId === prompt.invocationId)!.deliveredAt = this.now(); });
    }
    let claimed = false;
    worker = await save(current => {
      if (current.expiresAt > this.now() || current.activeInvocationId || (!current.initialAcceptedAt && !current.initialDiscardedAt) ||
        current.invocations.some(item => item.result && !item.acceptedAt && !item.discardedAt) || current.prompts.some(item => !item.deliveredAt && !item.cancelledAt)) return;
      current.phase = "cleaning"; claimed = true;
    });
    if (!claimed) return worker;
    await this.options.runtime.cleanup(worker.id);
    return save(current => { current.phase = "cleaned"; current.cleanedAt = this.now(); clearBackgroundBody(current, this.now()); });
  }
  /** Revoked chats cannot receive results. Expiry explicitly discards bodies after safe export and shutdown. */
  private async expireRevoked(worker: BackgroundWorker,
    save: (mutate: (current: BackgroundWorker) => void) => Promise<BackgroundWorker>): Promise<BackgroundWorker> {
    if (worker.activeInvocationId) {
      const invocation = worker.invocations.find(item => item.id === worker.activeInvocationId)!;
      await this.options.runtime.cancel(worker.id, invocation.id);
      const receipt = await this.options.runtime.inspect(worker.id, invocation.id);
      if (receipt.error === "worker_process_cleanup_unverified") return save(current => {
        current.phase = "quarantined";
        current.invocations.find(item => item.id === invocation.id)!.receipt = receipt;
      });
      if (!terminal(receipt) && !receipt.receiptMissing) return worker;
      const artifacts = receipt.receiptMissing ? [] : await this.options.runtime.exportArtifacts(worker.id, invocation.id);
      if (artifacts.length) {
        if (!this.options.retainDiscardedArtifacts) throw new Error("Discarded artifact retention is unavailable; workspace retained");
        await this.options.retainDiscardedArtifacts(worker, invocation, artifacts);
      }
      worker = await save(current => {
        const active = current.invocations.find(item => item.id === invocation.id)!;
        active.receipt = { ...receipt, artifacts }; active.exported = true;
        active.status = receipt.status === "completed" ? "completed" : "failed";
        active.discardedAt ??= this.now();
        delete current.activeInvocationId;
      });
    }
    worker = await save(current => {
      if (current.expiresAt > this.now() || current.activeInvocationId) throw new Error("Revoked worker is not ready for expiry");
      for (const invocation of current.invocations) if (!invocation.acceptedAt) invocation.discardedAt ??= this.now();
      for (const prompt of current.prompts) if (!prompt.deliveredAt) prompt.cancelledAt ??= this.now();
      if (!current.initialAcceptedAt) current.initialDiscardedAt ??= this.now();
      current.phase = "cleaning";
    });
    await this.options.runtime.cleanup(worker.id);
    return save(current => { current.phase = "cleaned"; current.cleanedAt = this.now(); clearBackgroundBody(current, this.now()); });
  }
}
