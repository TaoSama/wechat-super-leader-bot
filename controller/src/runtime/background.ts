import { createHash } from "node:crypto";
import type pg from "pg";
import { BackgroundService, MemoryBackgroundRepository, PostgresBackgroundRepository, initBackgroundTables } from "../background/index.js";
import { CodexWorkerRuntime } from "../background/worker/index.js";
import type { AutomationRepository, AutomationRunner, Schedule } from "../automations/contracts.js";
import type { NodeHub } from "../nodes/hub.js";
import type { Config } from "./config.js";
import { BackgroundArtifacts, BACKGROUND_ARTIFACT_RETENTION_MS } from "./background-artifacts.js";

const ARTIFACT_MAINTENANCE_INTERVAL_MS = 60_000;

/** Shares the existing schedule tick and result queue; never sends into source chats. */
export class BackgroundExecution {
  readonly service: BackgroundService;
  readonly artifacts: BackgroundArtifacts;
  private readonly runtime: CodexWorkerRuntime;
  private nextArtifactMaintenance = 0;
  private stopping = false;
  constructor(private readonly config: Config, private readonly schedules: AutomationRepository,
    hub: NodeHub, private readonly pool?: pg.Pool,
    private readonly now: () => number = Date.now, private readonly changed: () => void = () => {}) {
    if (!config.background) throw new Error("Background execution is disabled");
    const repository = pool ? new PostgresBackgroundRepository(pool) : new MemoryBackgroundRepository();
    this.runtime = new CodexWorkerRuntime({ ...config.background,
      onError: () => console.warn("Background execution requires reconciliation; durable receipt retained") });
    this.artifacts = new BackgroundArtifacts({ root: config.background.artifactRoot,
      publicUrl: config.consolePublicUrl ?? `http://localhost:${config.port}`,
      secret: createHash("sha256").update(`background-artifacts:${config.controllerToken}`).digest("hex"),
      repository, allowed: () => config.allowedChatIds, now });
    this.service = new BackgroundService({ repository, runtime: this.runtime, sources: hub, now,
      isAllowed: chatId => config.allowedChatIds.has(chatId), isStopping: () => this.stopping,
      turnTimeoutMs: config.background.timeoutMs,
      getScheduleStatus: async (scheduleId, chatId) => (await schedules.get(scheduleId, chatId))?.status,
      artifactLinks: (worker, invocation, artifacts) => this.artifacts.links(worker, invocation, artifacts),
      retainDiscardedArtifacts: (worker, invocation, artifacts) => this.artifacts.retainDiscarded(worker, invocation, artifacts),
      deliverSupplement: async (worker, invocation, result) => {
        if (!config.allowedChatIds.has(worker.chatId)) throw new Error("Background result chat is no longer allowed");
        await schedules.publishSupplement({ runId: worker.runId, scheduleId: worker.scheduleId,
          invocationId: invocation.id, chatId: worker.chatId, kind: result.error ? "failed" : "completed",
          text: result.text, createdAt: invocation.createdAt,
          expiresAt: invocation.createdAt + BACKGROUND_ARTIFACT_RETENTION_MS });
        changed();
      },
      onError: (_error, context) => console.warn("Background observation deferred", { context }),
    });
  }
  async initialize(): Promise<void> { if (this.pool) await initBackgroundTables(this.pool); }
  wrap(session: AutomationRunner): AutomationRunner {
    const allowed = (schedule: Schedule) => this.config.allowedChatIds.has(schedule.chatId);
    return {
      start: async (run, schedule) => {
        if (schedule.kind !== "background") return session.start(run, schedule);
        if (!allowed(schedule) || (await this.schedules.get(schedule.id, schedule.chatId))?.status !== "active") {
          return { status: "failed", result: { text: "后台任务授权已停止，本轮未执行。", error: "schedule_not_active" } };
        }
        await this.service.register(run, schedule.background);
        return { status: "running" };
      },
      inspect: async (run, schedule) => {
        if (schedule.kind !== "background") return session.inspect(run, schedule);
        const worker = await this.service.repository.getByRun(run.id) ?? await this.service.register(run, schedule.background);
        return worker.initialOutcome ?? { status: "running" };
      },
    };
  }
  async accept(runId: string): Promise<void> {
    const worker = await this.service.repository.getByRun(runId);
    if (worker?.initialOutcome && !worker.initialAcceptedAt) await this.service.acceptResult(runId);
  }
  async maintenance(): Promise<void> {
    // Recover a crash after schedule.finish committed but before its handoff callback ran.
    for (const worker of await this.service.repository.listLive()) {
      if (!worker.initialOutcome || worker.initialAcceptedAt) continue;
      const runs = await this.schedules.listRuns(worker.scheduleId, worker.chatId);
      const run = runs.find(item => item.id === worker.runId);
      if (run && ["completed", "failed"].includes(run.status) && run.result) await this.accept(run.id);
    }
    await this.service.maintenance();
    if (!this.stopping && this.nextArtifactMaintenance <= this.now()) {
      await this.artifacts.maintenance();
      this.nextArtifactMaintenance = this.now() + ARTIFACT_MAINTENANCE_INTERVAL_MS;
    }
    this.changed();
  }
  async stop(): Promise<void> {
    this.stopping = true;
    try { await this.runtime.shutdown(); }
    finally { await this.artifacts.close(); }
  }
}
