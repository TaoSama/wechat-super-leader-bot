import { createHash } from "node:crypto";
import pg from "pg";
import type { Config } from "./config.js";
import type { IStore } from "../store/interface.js";
import type { CommandService } from "../commands/service.js";
import type { NodeHub } from "../nodes/hub.js";
import type { LeaderModel } from "../leader/model/contracts.js";
import { HttpLeaderModel } from "../leader/model/client.js";
import { AutomationService, MemoryAutomationRepository, PostgresAutomationRepository, initAutomationTables, discoverAutomationTarget } from "../automations/index.js";
import { MemoryDeliveryRepository } from "../deliveries/memory.js";
import { PostgresDeliveryRepository, initDeliveryTables } from "../deliveries/postgres.js";
import { ResultDeliveryService } from "../deliveries/service.js";
import { FallbackService, MemoryFallbackRepository, PostgresFallbackRepository, parseFallbackEndpoints } from "../fallback/index.js";
import { NotificationResultCollector } from "../notifications/result-collector.js";
import { createAutomationRunner } from "./automation-runner.js";
import { BackgroundExecution } from "./background.js";
import { consoleDelivery } from "../console/deliveries.js";
import type { LocalSettingsService } from "../settings/local-service.js";

const DEFAULT_TICK_MS = 5_000;
const SUMMARY_RETRY_MS = 60_000;
const OUTBOX_BATCH_SIZE = 8;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const WORKERS = ["schedules", "results", "fallback", "background"] as const;
type WorkerName = typeof WORKERS[number];
interface WorkerState { timer?: ReturnType<typeof setTimeout>; pending?: Promise<void> }

/** Executes tasks independently of the availability of a WeChat reply window. */
export class TaskNotifications {
  readonly automations: AutomationService;
  readonly results: ResultDeliveryService;
  readonly fallback: FallbackService;
  private readonly backgroundExecution?: BackgroundExecution;
  get background() { return this.backgroundExecution?.service; }
  get backgroundArtifacts() { return this.backgroundExecution?.artifacts; }
  private readonly pool?: pg.Pool;
  private readonly fallbackRepository;
  private readonly collector: NotificationResultCollector;
  private readonly workers: Record<WorkerName, WorkerState> = { schedules: {}, results: {}, fallback: {}, background: {} };
  private stopped = true;
  private nextMaintenance = 0;
  private maintenanceCursor = "";
  private readonly preparationRetries = new Map<string, { retryAt: number; expiresAt: number }>();
  private readonly publicationRetries = new Map<string, number>();

  constructor(private readonly config: Config, private readonly store: IStore, hub: NodeHub, commands: CommandService,
    model: LeaderModel | undefined, private readonly now: () => number, private readonly changed: () => void, settings?: LocalSettingsService) {
    this.pool = config.persistenceMode === "postgres" ? new pg.Pool({ connectionString: config.databaseUrl, max: 3 }) : undefined;
    const schedules = this.pool ? new PostgresAutomationRepository(this.pool) : new MemoryAutomationRepository();
    const deliveries = this.pool ? new PostgresDeliveryRepository(this.pool) : new MemoryDeliveryRepository(now);
    this.fallbackRepository = this.pool ? new PostgresFallbackRepository(this.pool) : new MemoryFallbackRepository();
    const backgroundProvider = config.background;
    this.results = new ResultDeliveryService(deliveries, {
      // Short results need no model. Initialize the independent provider only when a summary is requested.
      model: model ?? (backgroundProvider ? {
        complete: (...args: Parameters<LeaderModel["complete"]>) => new HttpLeaderModel({
          baseUrl: backgroundProvider.baseUrl, apiKey: backgroundProvider.apiKey, model: backgroundProvider.model,
        }).complete(...args),
      } : undefined),
      now, publicUrl: config.consolePublicUrl ?? `http://localhost:${config.port}`,
      signingSecret: createHash("sha256").update(`task-results:${config.controllerToken}`).digest("hex"),
      fileMaxBytes: config.taskNotifications?.fileMaxBytes, retentionMs: config.taskNotifications?.retentionMs,
    });
    this.backgroundExecution = config.background
      ? new BackgroundExecution(config, schedules, hub, this.pool, now, changed, settings) : undefined;
    const sessionRunner = createAutomationRunner(store, commands, chatId => config.allowedChatIds.has(chatId), async schedule =>
      (await schedules.get(schedule.id, schedule.chatId))?.status === "active");
    this.automations = new AutomationService({ repository: schedules, now,
      resolveTarget: async (nodeId, sessionId) => discoverAutomationTarget(hub, nodeId, sessionId, now()),
      runner: this.backgroundExecution?.wrap(sessionRunner) ?? sessionRunner,
      validateBackground: this.backgroundExecution ? async (spec, authority) => {
        if (!config.allowedChatIds.has(authority.chatId)) throw new Error("Background chat is not allowed");
        for (const source of spec.sources) {
          const items = await hub.listAutomations(source.nodeId);
          if (!items.some(item => item.id === source.automationId)) throw new Error("Source automation was not discovered on its configured node");
        }
      } : undefined,
      onFinished: async (run, schedule, outcome) => {
        if (schedule.kind === "background" && ["completed", "failed"].includes(outcome.status)) await this.backgroundExecution?.accept(run.id);
      },
      onError: (_error, context) => console.warn("Scheduled task observation failed", { context }),
    });
    this.fallback = new FallbackService(this.fallbackRepository, {
      endpoints: parseFallbackEndpoints(config.taskNotifications?.fallbackEndpointsJson), now,
      materialize: async record => {
        if (!config.allowedChatIds.has(record.chatId)) return { skip: "chat_no_longer_allowed" };
        if (!record.resultId) return {};
        const plan = await this.results.materialize(record.resultId);
        const current = await this.results.repository.get(record.resultId, now());
        if (!plan || !current || current.chatId !== record.chatId) return { skip: "result_unavailable" };
        if (current.expiresAt <= now() || current.retainedUntil <= now()) return { skip: "result_expired" };
        if (current.catchupId) return { skip: "catchup_reserved" };
        if (current.status !== "waiting_for_user") return { skip: `wechat_${current.status}` };
        return { url: plan.artifact.downloadUrl, resultStatus: plan.kind };
      },
    });
    this.collector = new NotificationResultCollector(store, this.results);
  }

  async initialize(): Promise<void> {
    if (this.pool) {
      await initAutomationTables(this.pool);
      await initDeliveryTables(this.pool);
    }
    await this.fallbackRepository.init();
    await this.backgroundExecution?.initialize();
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    for (const name of WORKERS) this.schedule(name);
  }
  private schedule(name: WorkerName): void {
    const worker = this.workers[name];
    worker.timer = setTimeout(() => {
      worker.timer = undefined;
      void this.runWorker(name).catch(() => console.warn("Task notification worker failed; durable work retained", { worker: name }))
        .finally(() => { if (!this.stopped) this.schedule(name); });
    }, this.config.taskNotifications?.tickMs ?? DEFAULT_TICK_MS);
    worker.timer.unref();
  }
  private runWorker(name: WorkerName): Promise<void> {
    const worker = this.workers[name];
    if (worker.pending) return worker.pending;
    const running = Promise.resolve().then(() => name === "schedules" ? this.automations.tick() :
      name === "results" ? this.prepareResults() : name === "background" ? this.backgroundExecution?.maintenance() : this.drainFallback());
    worker.pending = running;
    const release = () => { if (worker.pending === running) worker.pending = undefined; };
    void running.then(release, release);
    return running;
  }
  /** Manual polling shares the same locks as the independent background workers. */
  async tick(): Promise<void> {
    const outcomes = await Promise.allSettled(WORKERS.map(name => this.runWorker(name)));
    const errors = outcomes.filter((item): item is PromiseRejectedResult => item.status === "rejected").map(item => item.reason);
    if (errors.length) throw new AggregateError(errors, "Task notification workers failed");
  }
  private async drainFallback(): Promise<void> {
    if (await this.fallback.drain(OUTBOX_BATCH_SIZE)) this.changed();
  }
  private async prepareResults(): Promise<void> {
    let changed = false;
    const excluded = [...this.publicationRetries].filter(([, retryAt]) => retryAt > this.now()).map(([id]) => id);
    for (const item of await this.automations.repository.pendingOutbox(this.now(), OUTBOX_BATCH_SIZE, excluded)) {
      if (!this.config.allowedChatIds.has(item.chatId)) { this.publicationRetries.set(item.id, this.now() + SUMMARY_RETRY_MS); continue; }
      try {
        const schedule = await this.automations.repository.get(item.scheduleId, item.chatId);
        const plan = await this.results.prepareResult({ id: item.id, key: `automation:${item.id}`, chatId: item.chatId,
          source: { type: "automation", id: item.scheduleId }, kind: item.kind, text: item.text,
          createdAt: item.createdAt, expiresAt: item.expiresAt,
          business: { category: item.supplement ? "background-result" : schedule?.kind === "reminder" ? "reminder" : "scheduled-result",
            ...(!item.supplement && schedule?.retention === "latest" ? { supersedes: `automation:${item.scheduleId}` } : {}) } });
        if (plan.status === "preparing") this.preparationRetries.set(plan.id, { retryAt: this.now() + SUMMARY_RETRY_MS, expiresAt: plan.expiresAt });
        await this.automations.repository.markPublished(item.id);
        this.publicationRetries.delete(item.id);
        changed = true;
      } catch {
        this.publicationRetries.set(item.id, this.now() + SUMMARY_RETRY_MS);
        console.warn("Scheduled result publication deferred", { resultId: item.id });
      }
    }
    const collected = await this.collector.collect([...this.config.allowedChatIds], this.now());
    if (collected.failures.length) console.warn("Some task results are waiting for preparation", { count: collected.failures.length });
    const plans = await this.results.repository.listMaintenance([...this.config.allowedChatIds], this.now(), this.maintenanceCursor || undefined);
    this.maintenanceCursor = plans.length === 20 ? plans.at(-1)!.id : "";
    for (const plan of plans) {
      if (plan.status !== "waiting_for_user" || plan.kind === "progress" || plan.catchupId || plan.expiresAt <= this.now()) continue;
      try {
        await this.fallback.enqueue({ key: `result:${plan.id}`, chatId: plan.chatId,
          kind: plan.kind === "failed" || plan.kind === "blocked" || plan.kind === "expired" ? plan.kind : "completed",
          title: "任务有新结果", text: (plan.messages[0] ?? "任务成果已保存，可打开成果查看。").slice(0, 500), resultId: plan.id,
          resultStatus: plan.kind, expiresAt: plan.expiresAt });
      } catch { console.warn("Result fallback preparation deferred", { resultId: plan.id }); }
    }
    for (const plan of plans) if (plan.status === "preparing") {
      if (!this.preparationRetries.has(plan.id)) {
        this.preparationRetries.set(plan.id, { retryAt: this.now() + SUMMARY_RETRY_MS, expiresAt: plan.expiresAt });
        continue;
      }
      if (this.preparationRetries.get(plan.id)!.retryAt > this.now()) continue;
      this.preparationRetries.set(plan.id, { retryAt: this.now() + SUMMARY_RETRY_MS, expiresAt: plan.expiresAt });
      try {
        const next = await this.results.retryPreparation(plan.id);
        if (next?.status !== "preparing") { this.preparationRetries.delete(plan.id); changed = true; }
      } catch { console.warn("Task summary retry deferred", { resultId: plan.id }); }
    }
    if (this.nextMaintenance <= this.now()) {
      await this.results.repository.prune(this.now());
      const retentionMs = this.config.taskNotifications?.retentionMs ?? DEFAULT_RETENTION_MS;
      await this.automations.repository.cleanupBodies(this.now(), retentionMs);
      await this.fallbackRepository.cleanupBodies(this.now(), retentionMs);
      for (const [id, retry] of this.preparationRetries) if (retry.expiresAt <= this.now()) this.preparationRetries.delete(id);
      for (const [id, retryAt] of this.publicationRetries) if (retryAt + SUMMARY_RETRY_MS < this.now()) this.publicationRetries.delete(id);
      this.nextMaintenance = this.now() + SUMMARY_RETRY_MS;
    }
    if (collected.prepared || changed) this.changed();
  }
  async snapshot() {
    const chatIds = [...this.config.allowedChatIds];
    return {
      automations: (await Promise.all(chatIds.map(id => this.automations.repository.list(id)))).flat(),
      deliveries: (await this.results.repository.list(chatIds)).map(consoleDelivery),
      fallbackDeliveries: (await Promise.all(chatIds.map(id => this.fallbackRepository.list(id)))).flat(),
    };
  }
  async notificationInterest(): Promise<string[]> {
    const result: string[] = [];
    for (const chatId of this.config.allowedChatIds) {
      const [schedules, activeDelivery, execution, goal] = await Promise.all([
        this.automations.repository.list(chatId), this.results.repository.hasActiveDelivery(chatId, this.now()),
        this.store.getLatestExecution(chatId), this.store.getLatestGoal(chatId),
      ]);
      if (schedules.some(item => item.status === "active") || activeDelivery ||
        execution?.status === "active" || goal?.status === "active") result.push(chatId);
    }
    return result;
  }
  async authorizeCommand(authority: { chatId: string; scheduleId: string; runId: string }, command: import("../types.js").CommandRecord): Promise<boolean | "paused"> {
    const schedule = await this.automations.repository.get(authority.scheduleId, authority.chatId);
    if (!schedule || schedule.kind !== "session" || !["active", "paused"].includes(schedule.status) || schedule.activeRunId !== authority.runId || !schedule.target) return false;
    const run = (await this.automations.repository.listRuns(schedule.id, authority.chatId)).find(item => item.id === authority.runId);
    const valid = !!run && ["dispatching", "running"].includes(run.status) &&
      (!run.commandId || run.commandId === command.commandId) && command.requestId === `automation:${run.id}` &&
      command.nodeId === schedule.target.nodeId && command.sessionId === schedule.target.sessionId &&
      command.sendRoute === schedule.target.sendRoute && command.prompt === schedule.prompt && command.action === "send";
    return valid ? schedule.status === "paused" ? "paused" : true : false;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const worker of Object.values(this.workers)) if (worker.timer) { clearTimeout(worker.timer); worker.timer = undefined; }
    const backgroundStop = this.backgroundExecution?.stop();
    await Promise.allSettled([...Object.values(this.workers).map(worker => worker.pending), backgroundStop]);
    try { await backgroundStop; }
    finally { await this.pool?.end(); }
  }
}
