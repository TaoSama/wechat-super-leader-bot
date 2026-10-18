import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkerInput, WorkerRuntime, WorkerRuntimeOptions, WorkerRuntimeStatus } from "./contracts.js";
import { WorkerStorage, alive, hash, readJson, validId, writeJson, type Receipt } from "./storage.js";
import { CodexCliExecutor, WorkerExecutionFailure } from "./executor.js";
import { outputSchema, parseOutput, workerPrompt } from "./output.js";
import { exportWorkerArtifacts } from "./artifacts.js";

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_MAX_CONCURRENT = 2;
const MAX_CONCURRENT = 16;
const UNCERTAIN = "本轮执行结果不明确，可能已产生外部影响；请核对后再安排后续任务。";
interface ActiveExecution { invocationId: string; abort: AbortController; done: Promise<void> }
interface ProcessState { active: Map<string, ActiveExecution>; stopping: boolean }
// Runtime objects using the same root share handles, including cancellation.
const processStates = new Map<string, ProcessState>();
function publicStatus(receipt: Receipt): WorkerRuntimeStatus {
  const { inputHash: _, ownerPid: __, processPid: ___, exported: ____, pendingInput: _____, queuedAt: ______,
    exportedToCaller: _______, processCleanupUnverified: ________, ...status } = receipt;
  return status;
}

/** Short lived persistent threads; scheduling, retention and delivery belong to the caller. */
export class CodexWorkerRuntime implements WorkerRuntime {
  private readonly store: WorkerStorage;
  private readonly executor;
  private readonly active: Map<string, ActiveExecution>;
  private readonly processState: ProcessState;
  private readonly maxConcurrent: number;
  constructor(private readonly options: WorkerRuntimeOptions) {
    if (!options.model?.trim()) throw new Error("Background worker model is required");
    this.validateTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    if (!Number.isSafeInteger(this.maxConcurrent) || this.maxConcurrent < 1 || this.maxConcurrent > MAX_CONCURRENT) {
      throw new Error("Invalid background worker concurrency limit");
    }
    this.store = new WorkerStorage(options.root, options.artifactRoot);
    this.executor = options.executor ?? new CodexCliExecutor(options);
    this.processState = processStates.get(this.store.root) ?? { active: new Map(), stopping: false };
    this.active = this.processState.active;
    processStates.set(this.store.root, this.processState);
  }

  async start(input: WorkerInput): Promise<WorkerRuntimeStatus> {
    if (this.processState.stopping) throw new Error("Background worker runtime is shutting down");
    validId(input.workerId); validId(input.invocationId);
    if (!input.task?.trim()) throw new Error("Background worker task is required");
    this.validateTimeout(input.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    input = JSON.parse(JSON.stringify(input)) as WorkerInput;
    const inputHash = hash(JSON.stringify(input));
    const dir = this.store.worker(input.workerId, true)!;
    const prior = this.store.receipt(dir, input.invocationId);
    // Cancellation may win before start has even recorded its input. The same
    // durable decision also fences a start already preparing its queued receipt.
    if (this.store.launchClaim(dir, input.invocationId)?.decision === "cancel") {
      return publicStatus(this.cancelledReceipt(dir, input.workerId, input.invocationId));
    }
    if (prior) {
      if (prior.inputHash !== inputHash) throw new Error("Invocation ID conflicts with previously authorized input");
      return this.inspect(input.workerId, input.invocationId);
    }
    this.store.claim(dir, input.invocationId);
    const receipt: Receipt = { workerId: input.workerId, invocationId: input.invocationId, inputHash,
      ownerPid: process.pid, status: "queued", summary: "后台会话已排队，等待执行容量。", attachments: [],
      queuedAt: Date.now(), pendingInput: input,
      ...(this.store.state(dir)?.threadId ? { threadId: this.store.state(dir)!.threadId } : {}) };
    try {
      writeJson(path.join(dir, "output-schema.json"), outputSchema);
      this.store.save(dir, receipt);
    } catch (error) { this.store.release(dir, input.invocationId); throw error; }
    this.drain();
    if (this.store.launchClaim(dir, input.invocationId)?.decision === "cancel") {
      return publicStatus(this.cancelledReceipt(dir, input.workerId, input.invocationId));
    }
    return publicStatus(receipt);
  }

  async inspect(workerId: string, invocationId: string): Promise<WorkerRuntimeStatus> {
    validId(invocationId);
    const dir = this.store.worker(workerId);
    let receipt = dir ? this.store.receipt(dir, invocationId) : undefined;
    if (dir && this.store.launchClaim(dir, invocationId)?.decision === "cancel") {
      return publicStatus(this.cancelledReceipt(dir, workerId, invocationId));
    }
    if (!receipt) return { workerId, invocationId, status: "unknown", summary: "没有本轮执行回执。", attachments: [], receiptMissing: true };
    if (receipt.status === "queued") {
      // Only receipts that never crossed the launch boundary are safely resumable.
      this.drain(); receipt = this.store.receipt(dir!, invocationId)!;
    } else if (receipt.status === "running" && this.active.get(workerId)?.invocationId !== invocationId &&
      (receipt.ownerPid === process.pid || !alive(receipt.ownerPid))) {
      receipt.status = "needs_attention"; receipt.summary = UNCERTAIN; receipt.error = "worker_owner_lost";
      this.store.save(dir!, receipt);
      if (!alive(receipt.processPid)) this.store.release(dir!, invocationId);
    }
    return publicStatus(receipt);
  }

  async cancel(workerId: string, invocationId: string): Promise<void> {
    validId(workerId); validId(invocationId);
    const active = this.active.get(workerId);
    if (active?.invocationId === invocationId) { active.abort.abort(); await active.done; return; }
    if (this.store.removed(workerId)) return;
    const dir = this.store.worker(workerId) ?? this.store.worker(workerId, true)!;
    const receipt = this.store.receipt(dir, invocationId);
    if (receipt?.processPid && alive(receipt.processPid)) {
      throw new Error("Worker process ownership is unavailable; verify orphan process before cleanup");
    }
    if (!receipt || receipt.status === "queued" || this.store.launchClaim(dir, invocationId)?.decision === "cancel") {
      // Cancellation and launch compete for the same permanent atomic marker.
      // A stale queued snapshot can never execute after cancellation succeeds.
      if (!this.store.claimLaunch(dir, invocationId, "cancel") && this.store.launchClaim(dir, invocationId)?.decision !== "cancel") {
        throw new Error("Worker launch is already claimed; inspect ownership before cancellation");
      }
      this.cancelledReceipt(dir, workerId, invocationId);
    } else await this.inspect(workerId, invocationId);
  }

  async exportArtifacts(workerId: string, invocationId: string) {
    validId(invocationId);
    const dir = this.store.worker(workerId);
    if (!dir) throw new Error("Worker does not exist");
    const artifacts = exportWorkerArtifacts(this.store, dir, invocationId);
    this.store.save(dir, { ...this.store.receipt(dir, invocationId)!, exportedToCaller: true });
    return artifacts;
  }

  async cleanup(workerId: string): Promise<void> {
    const dir = this.store.worker(workerId);
    if (!dir) return;
    if (this.active.has(workerId)) throw new Error("Cannot clean an active worker");
    this.store.claim(dir, "cleanup");
    try {
      for (const name of fs.readdirSync(path.join(dir, "invocations"))) {
        if (name.endsWith(".launch")) continue;
        if (/^[a-f0-9-]+\.(json|launch)\.[a-f0-9-]+\.tmp$/.test(name)) continue;
        if (!name.endsWith(".json")) throw new Error("Unexpected worker metadata");
        const receipt = readJson<Receipt>(path.join(dir, "invocations", name));
        if (!receipt || receipt.workerId !== workerId || ["queued", "running"].includes(receipt.status) || alive(receipt.processPid) || receipt.processCleanupUnverified) {
          throw new Error("Cannot clean a worker with active or uncertain execution");
        }
        if (!receipt.exportedToCaller) throw new Error("Export and accept results before worker cleanup");
      }
      this.store.remove(dir, workerId);
    } finally { this.store.release(dir, "cleanup"); }
  }

  async shutdown(): Promise<void> {
    this.processState.stopping = true;
    const executions = [...this.active.values()];
    for (const execution of executions) execution.abort.abort();
    await Promise.all(executions.map(execution => execution.done));
    // Queued receipts and workspaces remain durable for the next controller process.
  }

  private drain(): void {
    if (this.processState.stopping) return;
    for (const receipt of this.store.queued()) {
      if (this.active.has(receipt.workerId)) continue;
      const slot = this.store.slot(this.maxConcurrent, receipt.workerId, receipt.invocationId);
      if (!slot) break;
      const dir = this.store.worker(receipt.workerId)!;
      if (!this.store.claimLaunch(dir, receipt.invocationId)) {
        fs.unlinkSync(slot);
        const launcher = this.store.launchClaim(dir, receipt.invocationId);
        if (launcher?.decision === "cancel") {
          this.cancelledReceipt(dir, receipt.workerId, receipt.invocationId);
          continue;
        }
        if (!launcher || !alive(launcher.ownerPid)) {
          receipt.status = "needs_attention"; receipt.summary = UNCERTAIN; receipt.error = "worker_launch_unverified";
          delete receipt.pendingInput;
          this.store.save(dir, receipt); this.store.release(dir, receipt.invocationId);
        }
        continue;
      }
      const input = receipt.pendingInput!;
      const abort = new AbortController();
      // Persist before spawn: a crash after this boundary is uncertain, never replayed.
      receipt.status = "running"; receipt.ownerPid = process.pid; receipt.summary = "后台会话正在启动。";
      delete receipt.pendingInput;
      try { this.store.save(dir, receipt); }
      catch (error) { fs.unlinkSync(slot); throw error; }
      const done = Promise.resolve().then(() => this.run(dir, input, receipt, abort, slot))
        .catch(error => this.report("Background worker execution requires reconciliation", error));
      this.active.set(receipt.workerId, { invocationId: receipt.invocationId, abort, done });
    }
  }

  private async run(dir: string, input: WorkerInput, receipt: Receipt, abort: AbortController, slot: string): Promise<void> {
    const timer = setTimeout(() => abort.abort(), input.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let exporting = false;
    try {
      const text = await this.executor.execute({ workspace: path.join(dir, "workspace"), home: path.join(dir, "home"),
        schemaPath: path.join(dir, "output-schema.json"), prompt: workerPrompt(input), threadId: receipt.threadId,
        signal: abort.signal,
        onThread: async threadId => { this.store.setThread(dir, threadId); receipt.threadId = threadId; this.store.save(dir, receipt); },
        onProcess: async pid => {
          receipt.processPid = pid; receipt.summary = "后台会话正在执行。";
          writeJson(slot, { ...readJson<Record<string, unknown>>(slot), processPid: pid });
          this.store.save(dir, receipt);
        } });
      if (abort.signal.aborted || !receipt.threadId) throw new Error("Worker completion could not be verified");
      Object.assign(receipt, parseOutput(text));
      exporting = true;
      this.store.save(dir, receipt);
      exportWorkerArtifacts(this.store, dir, input.invocationId);
      Object.assign(receipt, this.store.receipt(dir, input.invocationId));
    } catch (error) {
      receipt.status = "needs_attention";
      receipt.summary = exporting ? "执行已结束，但结果附件未通过接收校验，需要核对。" : UNCERTAIN;
      receipt.error = abort.signal.aborted ? "worker_interrupted" : exporting ? "worker_artifact_invalid" : "worker_execution_unverified";
      if (error instanceof WorkerExecutionFailure && error.processCleanupUnverified) {
        receipt.processCleanupUnverified = true; receipt.error = "worker_process_cleanup_unverified";
        receipt.summary = "有后台子进程未能确认退出；工作区已保留隔离，需要人工核对。";
        writeJson(slot, { ...readJson<Record<string, unknown>>(slot), cleanupUnverified: true });
      }
      receipt.attachments = []; delete receipt.nextCheckAt;
      this.report(`Background worker ${input.workerId}: ${receipt.error}`, error);
    } finally {
      clearTimeout(timer);
      if (!receipt.processCleanupUnverified) delete receipt.processPid;
      try {
        this.store.save(dir, receipt);
        if (!receipt.processCleanupUnverified) this.store.release(dir, input.invocationId);
      }
      catch (error) { this.report("Unable to persist worker result", error); }
      try { if (!receipt.processCleanupUnverified) fs.unlinkSync(slot); }
      finally { this.active.delete(input.workerId); }
      this.drain();
    }
  }

  private validateTimeout(value: number): void {
    if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) throw new Error("Invalid worker timeout budget");
  }
  private cancelledReceipt(dir: string, workerId: string, invocationId: string): Receipt {
    const prior = this.store.receipt(dir, invocationId);
    if (prior?.status === "failed" && prior.error === "worker_cancelled_before_launch") return prior;
    const receipt: Receipt = { ...prior, workerId, invocationId,
      inputHash: prior?.inputHash ?? "", ownerPid: process.pid,
      status: "failed", summary: "任务在开始执行前已取消。", error: "worker_cancelled_before_launch", attachments: [] };
    delete receipt.pendingInput;
    this.store.save(dir, receipt);
    this.store.release(dir, invocationId);
    return receipt;
  }
  private report(message: string, cause: unknown): void {
    if (!this.options.onError) { console.error(message); return; }
    try { this.options.onError(new Error(message, { cause })); }
    catch { console.error("Background worker error reporter failed"); }
  }
}
