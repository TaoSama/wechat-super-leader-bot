import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { CommandRecord } from "../../src/types.js";
import { createExecution, executionRequestId, type ExecutionRecord } from "../../src/leader/plans/execution.js";
import { createGoal, goalRequestId } from "../../src/leader/goals/goal.js";
import { createProgressNotification as commitProgress, progressNotificationContext, notificationSource, progressNotificationEligible,
  NOTIFICATION_PROGRESS_INITIAL_DELAY_MS, NOTIFICATION_PROGRESS_INTERVAL_MS } from "../../src/notifications/progress.js";
import { normalizeNotification, createTerminalNotification, NOTIFICATION_TTL_MS, type StoredNotification } from "../../src/notifications/contracts.js";
import { pgEnqueueProgressNotification as commitPgProgress } from "../../src/store/notification-progress-postgres.js";
import { pgClaimNotification, pgListPendingNotifications, pgRecordNotificationReceipt } from "../../src/store/notification-postgres.js";
import { ConflictError } from "../../src/store/interface.js";
import { MemoryStore } from "../../src/store/memory.js";
import { proposal } from "../fixtures/goals.js";

const NOW = 1_700_000_000_000;
const FIRST = NOW + NOTIFICATION_PROGRESS_INITIAL_DELAY_MS;
function execution(): ExecutionRecord {
  const record = createExecution("chat", { id: randomUUID(), expiresAt: NOW + 60_000,
    actions: Array.from({ length: 4 }, (_, index) => ({ nodeId: "node", sessionId: `session-${index}`,
      prompt: `任务 ${index + 1}`, sendRoute: "control-socket" as const, dependsOn: [] })) }, NOW);
  record.attempts = record.plan.actions.map(() => ({ token: randomUUID(), startedAt: NOW, expiresAt: NOW + 15_000 }));
  return record;
}
function command(record: ExecutionRecord, index = 0, now = NOW): CommandRecord {
  const action = record.plan.actions[index], stamp = new Date(now).toISOString();
  return { commandId: randomUUID(), requestId: executionRequestId(record, index), nodeId: action.nodeId, sessionId: action.sessionId,
    prompt: action.prompt, action: "send", sendRoute: action.sendRoute, status: "accepted", turnId: `exact-${index}`,
    createdAt: stamp, updatedAt: stamp, expiresAt: new Date(NOW + 60 * 60_000).toISOString() };
}
function progressFixture(kind: "plan" | "goal") {
  if (kind === "plan") {
    const record = execution();
    return { record, receipt: command(record) };
  }
  const record = createGoal("chat", proposal(NOW), NOW), target = record.proposal.targets[0];
  record.actions.push({ index: 1, target: 1, prompt: "任务", sourceActions: [], input: { prompt: "frozen", sources: [] },
    attempt: { token: randomUUID(), startedAt: NOW, expiresAt: NOW + 15_000 } });
  return { record, receipt: { ...command(execution()), requestId: goalRequestId(record, 0),
    nodeId: target.nodeId, sessionId: target.sessionId, prompt: "frozen" } };
}
function row(notification: StoredNotification) {
  return { id: notification.id, execution_id: notification.source.type === "plan" ? notification.source.id : null,
    goal_id: notification.source.type === "goal" ? notification.source.id : null, chat_id: notification.chatId, kind: notification.kind,
    status: notification.status, created_at: String(notification.createdAt), expires_at: String(notification.expiresAt), data: structuredClone(notification) };
}

// This fixture checks the source-before-notification lock protocol and commit visibility.
class ProgressPool {
  record = execution();
  notifications = new Map<string, ReturnType<typeof row>>();
  commands: CommandRecord[] = [];
  statements: string[] = [];
  failInsert = false;
  beforeSourceLock?: () => void;
  private tail = Promise.resolve();
  pool = this as unknown as pg.Pool;
  commandReads = 0;
  reader = vi.fn(() => ({ findCommandByRequestId: async (id: string) => {
    this.commandReads++; return this.commands.find(item => item.requestId === id) ?? null;
  } }));
  async query(raw: string, values: unknown[] = []) {
    const sql = raw.replace(/\s+/g, " ").trim(); this.statements.push(sql);
    if (sql.startsWith("SELECT * FROM leader_executions WHERE id=")) {
      const r = this.record;
      return { rows: r.id === values[0] ? [{ id: r.id, chat_id: r.chatId, revision: r.revision, status: r.status, created_at: r.createdAt, data: structuredClone(r) }] : [] };
    }
    if (sql.startsWith("SELECT * FROM leader_notifications WHERE execution_id=")) return { rows: [...this.notifications.values()].map(value => structuredClone(value)) };
    if (sql.startsWith("SELECT * FROM leader_notifications WHERE id=")) {
      const found = this.notifications.get(String(values[0])); return { rows: found ? [structuredClone(found)] : [] };
    }
    if (sql.startsWith("SELECT * FROM leader_notifications WHERE chat_id=ANY")) {
      expect(sql).toContain("e.status='active'"); expect(sql).toContain("g.status='active'");
      expect(sql).toContain("ORDER BY (kind='progress') ASC");
      return { rows: [...this.notifications.values()].filter(n => (values[0] as string[]).includes(n.chat_id) && n.status === "pending" &&
        Number(n.expires_at) > Number(values[1]) && (n.kind !== "progress" || this.record.status === "active" && this.record.expiresAt > Number(values[1])))
        .sort((a, b) => Number(a.kind === "progress") - Number(b.kind === "progress") || Number(a.created_at) - Number(b.created_at)).slice(0, Number(values[2])) };
    }
    throw new Error(`Unexpected progress SQL: ${sql}`);
  }
  async connect() {
    let releaseLock: (() => void) | undefined, staged: ReturnType<typeof row> | undefined;
    return { release() {}, query: async (raw: string, values: unknown[] = []) => {
      const sql = raw.replace(/\s+/g, " ").trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
        this.statements.push(sql);
        if (sql === "COMMIT" && staged) this.notifications.set(staged.id, staged);
        if (sql !== "BEGIN") { staged = undefined; releaseLock?.(); releaseLock = undefined; }
        return { rows: [] };
      }
      if (sql.endsWith("FOR UPDATE") && !releaseLock) {
        if (sql.startsWith("SELECT * FROM leader_executions")) this.beforeSourceLock?.();
        const previous = this.tail; this.tail = new Promise<void>(resolve => { releaseLock = resolve; }); await previous;
      }
      if (sql.startsWith("INSERT INTO leader_notifications")) {
        this.statements.push(sql);
        if (this.failInsert) throw new Error("progress insert failed");
        staged = row(normalizeNotification(JSON.parse(String(values[8])))); return { rows: [] };
      }
      if (sql.startsWith("UPDATE leader_notifications")) {
        this.statements.push(sql); staged = row(normalizeNotification(JSON.parse(String(values[2])))); return { rows: [structuredClone(staged)] };
      }
      return this.query(raw, values);
    } };
  }
}

function createProgressNotification(record: ExecutionRecord | ReturnType<typeof createGoal>, commands: CommandRecord[], notifications: StoredNotification[], now: number) {
  const context = progressNotificationContext(record, commands, notifications, now);
  return commitProgress(record, commands, notifications, now, { eventKey: context?.eventKey ?? "stale", text: "模型根据真实证据生成的进展" });
}
function pgEnqueueProgressNotification(pool: pg.Pool, source: ReturnType<typeof notificationSource>, reader: ProgressPool["reader"], now: number) {
  const fixture = pool as unknown as ProgressPool;
  const context = progressNotificationContext(fixture.record, fixture.commands, [...fixture.notifications.values()].map(item => item.data), now);
  return commitPgProgress(pool, source, reader, now, { eventKey: context?.eventKey ?? "stale", text: "模型基于回执报告的进展" });
}

describe("progress notification evidence and budgets", () => {
  it("waits thirty seconds, sixty seconds between changed facts, and consumes at most three permanent slots", () => {
    const record = execution(), commands = [command(record)], existing: StoredNotification[] = [];
    expect(createProgressNotification(record, commands, existing, FIRST - 1)).toBeNull();
    for (let index = 0; index < 4; index++) {
      const now = FIRST + index * NOTIFICATION_PROGRESS_INTERVAL_MS;
      if (index) commands.push(command(record, index, now));
      expect(createProgressNotification(record, commands, existing, now - 1)).toBeNull();
      const next = createProgressNotification(record, commands, existing, now);
      if (index === 3) expect(next).toBeNull();
      else {
        expect(next).toMatchObject({ source: notificationSource(record), kind: "progress", progress: { sequence: index + 1 }, status: "pending" });
        expect(next!.id).not.toBe(record.id); existing.push(next!);
        expect(createProgressNotification(record, commands, existing, now + NOTIFICATION_PROGRESS_INTERVAL_MS)).toBeNull();
      }
    }
    expect(existing).toHaveLength(3);
  });
  it.each(["turnId", "requestId", "nodeId", "prompt", "sendRoute"] as const)("does not invent progress from a mismatched %s", field => {
    const record = execution(), receipt = command(record);
    const invalid = { ...receipt, [field]: field === "turnId" ? undefined : field === "sendRoute" ? "desktop-owner" : "unrelated" } as CommandRecord;
    expect(createProgressNotification(record, [invalid], [], FIRST)).toBeNull();
  });
  it("uses completed exact receipts and suppresses inactive sources and existing terminal events", () => {
    const record = execution(), receipt = { ...command(record), status: "completed" as const }, next = createProgressNotification(record, [receipt], [], FIRST)!;
    expect(next.text).toBe("模型根据真实证据生成的进展");
    for (const status of ["completed", "failed", "cancelled", "expired"] as const) {
      expect(createProgressNotification({ ...record, status }, [receipt], [], FIRST)).toBeNull();
      expect(progressNotificationEligible(next, { ...record, status }, FIRST)).toBe(false);
    }
    const terminal = createTerminalNotification({ ...record, status: "completed" }, FIRST, [receipt])!;
    expect(createProgressNotification(record, [receipt], [terminal], FIRST)).toBeNull();
  });
  it("binds goal progress to its frozen action prompt and target", () => {
    const goal = createGoal("chat", proposal(NOW), NOW), target = goal.proposal.targets[0];
    goal.actions.push({ index: 1, target: 1, prompt: "任务", sourceActions: [], input: { prompt: "frozen", sources: [] },
      attempt: { token: randomUUID(), startedAt: NOW, expiresAt: NOW + 15_000 } });
    const receipt = { ...command(execution()), requestId: goalRequestId(goal, 0), nodeId: target.nodeId, sessionId: target.sessionId, prompt: "frozen" };
    expect(createProgressNotification(goal, [receipt], [], FIRST)).toMatchObject({ source: { type: "goal", id: goal.id }, kind: "progress" });
    expect(createProgressNotification(goal, [{ ...receipt, prompt: "wrong" }], [], FIRST)).toBeNull();
  });
});

describe.each(["plan", "goal"] as const)("%s admission progress evidence", kind => {
  it("normalizes admission to claimed before hashing, deduplicates unchanged facts and rejects a draft after publication", () => {
    const { record, receipt } = progressFixture(kind);
    const admitting: CommandRecord = { ...receipt, status: "admitting", turnId: undefined, output: "not a completed result" };
    const context = progressNotificationContext(record, [admitting], [], FIRST)!;
    const evidence = [{ step: 1, prompt: "plan" in record ? record.plan.actions[0].prompt : record.actions[0].prompt,
      status: "claimed", commandId: admitting.commandId }];
    expect(context).not.toBeNull();
    expect(context.evidence).toEqual(evidence);
    expect(context.eventKey).toBe(createHash("sha256").update(JSON.stringify(evidence)).digest("hex"));
    expect(admitting.status).toBe("admitting");
    expect(progressNotificationContext(record, [{ ...admitting, updatedAt: new Date(NOW + 1).toISOString(),
      output: "different non-result body" }], [], FIRST)?.eventKey).toBe(context.eventKey);
    const notification = createProgressNotification(record, [admitting], [], FIRST)!;
    expect(notification).not.toBeNull();
    expect(progressNotificationContext(record, [admitting], [notification], FIRST + NOTIFICATION_PROGRESS_INTERVAL_MS)).toBeNull();
    const queued: CommandRecord = { ...admitting, status: "queued" };
    const next = progressNotificationContext(record, [queued], [], FIRST)!;
    expect(next.evidence[0].status).toBe("queued");
    expect(next.eventKey).not.toBe(context.eventKey);
    expect(commitProgress(record, [queued], [], FIRST, { eventKey: context.eventKey, text: "stale admission draft" })).toBeNull();
    expect(commitProgress(record, [queued], [], FIRST, { eventKey: next.eventKey, text: "current queued draft" })).not.toBeNull();
  });

  it.each(["queued", "pending", "accepted", "completed"] as const)("preserves %s evidence without broadening completion proof", status => {
    const { record, receipt } = progressFixture(kind);
    const context = progressNotificationContext(record, [{ ...receipt, status, output: "exact completed output" }], [], FIRST)!;
    expect(context.evidence[0]).toMatchObject({ status });
    if (status === "completed") expect(context.evidence[0].output).toBe("exact completed output");
    else expect(context.evidence[0]).not.toHaveProperty("output");
  });

  it("keeps admitting subject to exact identity, timestamp and native-only safety filters", () => {
    const { record, receipt } = progressFixture(kind);
    const admitting: CommandRecord = { ...receipt, status: "admitting", turnId: undefined };
    const invalid: CommandRecord[] = [
      { ...admitting, requestId: "unrelated-request" }, { ...admitting, prompt: "unrelated-prompt" },
      { ...admitting, updatedAt: "invalid-timestamp" }, { ...admitting, updatedAt: new Date(FIRST + 1).toISOString() },
      { ...admitting, sendRoute: "terminal-pane" }, { ...admitting, sessionId: "terminal:unrelated" },
      { ...admitting, inputReceipt: { kind: "terminal-input-written", sessionId: admitting.sessionId,
        requestId: randomUUID(), promptSHA256: "a".repeat(64), responseRevision: 0, observedRevision: 1 } },
    ];
    for (const command of invalid) expect(progressNotificationContext(record, [command], [], FIRST)).toBeNull();
  });
});

describe("PostgreSQL progress transaction protocol", () => {
  it("checks source time and permanent budgets before constructing readers or reading command evidence", async () => {
    const fixture = new ProgressPool(), source = notificationSource(fixture.record);
    fixture.commands.push(command(fixture.record));
    expect(await pgEnqueueProgressNotification(fixture.pool, source, fixture.reader, FIRST - 1)).toBeNull();
    expect(fixture.statements.some(sql => sql.includes("FROM leader_notifications"))).toBe(false);
    expect(fixture.reader).not.toHaveBeenCalled();
    for (let index = 0; index < 3; index++) {
      const now = FIRST + index * NOTIFICATION_PROGRESS_INTERVAL_MS;
      if (index) fixture.commands.push(command(fixture.record, index, now));
      expect(await pgEnqueueProgressNotification(fixture.pool, source, fixture.reader, now)).not.toBeNull();
      const reads = fixture.commandReads, readers = fixture.reader.mock.calls.length;
      expect(await pgEnqueueProgressNotification(fixture.pool, source, fixture.reader, now + NOTIFICATION_PROGRESS_INTERVAL_MS - 1)).toBeNull();
      expect(fixture.commandReads).toBe(reads); expect(fixture.reader).toHaveBeenCalledTimes(readers);
    }
    const reads = fixture.commandReads, readers = fixture.reader.mock.calls.length;
    expect(await pgEnqueueProgressNotification(fixture.pool, source, fixture.reader, FIRST + 3 * NOTIFICATION_PROGRESS_INTERVAL_MS)).toBeNull();
    expect(fixture.commandReads).toBe(reads); expect(fixture.reader).toHaveBeenCalledTimes(readers);
  });
  it("serializes competing enqueues, preserves uncertainty across restart, and never refills three slots", async () => {
    const fixture = new ProgressPool(), source = notificationSource(fixture.record);
    fixture.commands.push(command(fixture.record));
    for (let index = 0; index < 4; index++) {
      const now = FIRST + index * NOTIFICATION_PROGRESS_INTERVAL_MS;
      if (index) fixture.commands.push(command(fixture.record, index, now));
      const results = await Promise.all(Array.from({ length: 8 }, () => pgEnqueueProgressNotification(fixture.pool, source, fixture.reader, now)));
      expect(results.filter(Boolean)).toHaveLength(index < 3 ? 1 : 0);
      if (index === 0) {
        const notification = results.find(Boolean)!;
        await pgClaimNotification(fixture.pool, notification.id, randomUUID(), ["chat"], now);
        const claimed = fixture.notifications.get(notification.id)!.data;
        await pgRecordNotificationReceipt(fixture.pool, claimed.id, claimed.attemptId!, "uncertain", now);
      }
    }
    expect(fixture.notifications.size).toBe(3);
    expect([...fixture.notifications.values()].map(n => n.data.kind === "progress" && n.data.progress.sequence)).toEqual([1, 2, 3]);
    expect(await pgEnqueueProgressNotification(fixture.pool, source, fixture.reader, FIRST + NOTIFICATION_TTL_MS)).toBeNull();
    expect(fixture.notifications.size).toBe(3);
  });
  it("rolls back failed inserts and rechecks the source before claiming a previously listed progress", async () => {
    const fixture = new ProgressPool(), source = notificationSource(fixture.record);
    fixture.commands.push(command(fixture.record)); fixture.failInsert = true;
    await expect(pgEnqueueProgressNotification(fixture.pool, source, fixture.reader, FIRST)).rejects.toThrow("progress insert failed");
    expect(fixture.notifications.size).toBe(0); expect(fixture.statements.at(-1)).toBe("ROLLBACK");
    fixture.failInsert = false;
    const progress = (await pgEnqueueProgressNotification(fixture.pool, source, fixture.reader, FIRST))!;
    expect(await pgListPendingNotifications(fixture.pool, ["chat"], FIRST)).toHaveLength(1);
    fixture.beforeSourceLock = () => { fixture.record.status = "completed"; };
    await expect(pgClaimNotification(fixture.pool, progress.id, randomUUID(), ["chat"], FIRST)).rejects.toBeInstanceOf(ConflictError);
    expect(fixture.notifications.get(progress.id)!.status).toBe("pending");
    const terminal = createTerminalNotification(fixture.record, FIRST + 1, fixture.commands)!;
    fixture.notifications.set(terminal.id, row(terminal));
    expect((await pgListPendingNotifications(fixture.pool, ["chat"], FIRST + 1)).map(n => n.id)).toEqual([terminal.id]);
    expect(await pgEnqueueProgressNotification(fixture.pool, source, fixture.reader, FIRST + 60_000)).toBeNull();
    const sourceLock = fixture.statements.lastIndexOf("SELECT * FROM leader_executions WHERE id=$1 FOR UPDATE");
    const notificationLock = fixture.statements.indexOf("SELECT * FROM leader_notifications WHERE id=$1 FOR UPDATE", sourceLock);
    expect(notificationLock).toBe(-1);
  });
});

it("memory skips command reads outside its progress budget and snapshots pending notifications only once", async () => {
  const store = new MemoryStore(), record = execution();
  await store.createExecutionIfAbsent({ ...record, attempts: record.attempts.map(() => null) });
  await store.compareAndSetExecution({ ...record, revision: 2 }, 1, NOW);
  const receipts = record.plan.actions.map((_action, index) => command(record, index));
  const reads = vi.spyOn(store, "findCommandByRequestId").mockImplementation(async id => receipts.find(item => item.requestId === id) ?? null);
  expect(await store.enqueueProgressNotification(notificationSource(record), FIRST - 1)).toBeNull();
  expect(reads).not.toHaveBeenCalled();
  const context = await store.getProgressNotificationContext(notificationSource(record), FIRST);
  expect(await store.enqueueProgressNotification(notificationSource(record), FIRST, { eventKey: context!.eventKey, text: "模型正文" })).not.toBeNull();
  reads.mockClear();
  expect(await store.enqueueProgressNotification(notificationSource(record), FIRST + NOTIFICATION_PROGRESS_INTERVAL_MS - 1)).toBeNull();
  expect(reads).not.toHaveBeenCalled();
  const notifications = (store as unknown as { notifications: Map<string, StoredNotification> }).notifications;
  const values = vi.spyOn(notifications, "values");
  await store.listPendingNotifications(["chat"], FIRST);
  expect(values).toHaveBeenCalledTimes(1);
});


it("offers durable goal decision waiting evidence without inventing a native receipt", () => {
  const goal = createGoal("chat", proposal(NOW), NOW);
  const context = progressNotificationContext(goal, [], [], FIRST)!;
  expect(context.evidence).toEqual([{ prompt: goal.proposal.objective, status: "waiting_for_decision" }]);
  expect(createProgressNotification(goal, [], [], FIRST)?.kind).toBe("progress");
});


it("binds model drafts to the exact bounded completed excerpt", () => {
  const record = execution(), receipt = { ...command(record), status: "completed" as const, output: "已核验的第一份结果" };
  const context = progressNotificationContext(record, [receipt], [], FIRST)!;
  expect(commitProgress(record, [{ ...receipt, output: "不同的结果正文" }], [], FIRST,
    { eventKey: context.eventKey, text: "基于旧结果生成的进度" })).toBeNull();
});
