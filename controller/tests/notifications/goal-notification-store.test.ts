import { randomUUID } from "node:crypto";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/store/memory.js";
import { ConflictError } from "../../src/store/interface.js";
import { createGoal, goalRequestId, GOAL_SEND_CLAIM_MS, type GoalRecord } from "../../src/leader/goals/goal.js";
import { readGoalView } from "../../src/leader/goals/view.js";
import { createExecution } from "../../src/leader/plans/execution.js";
import { pgCompareAndSetGoal } from "../../src/store/goal-postgres.js";
import { pgGetNotification, pgListPendingNotifications, pgClaimNotification, pgRecordNotificationReceipt } from "../../src/store/notification-postgres.js";
import { createTerminalNotification, normalizeNotification, goalNotificationText, NOTIFICATION_TTL_MS,
  NOTIFICATION_ATTEMPT_MS, type StoredNotification } from "../../src/notifications/contracts.js";
import { authorize, proposal, lease, commit, nextDecision } from "../fixtures/goals.js";

const NOW = 1_700_000_000_000;
const SECRET = "private objective and model reason";
type Row = Record<string, unknown>;
const goalRow = (goal: GoalRecord): Row => ({ id: goal.id, chat_id: goal.chatId, revision: String(goal.revision),
  status: goal.status, created_at: String(goal.createdAt), data: structuredClone(goal) });
const notificationRow = (n: StoredNotification): Row => ({ id: n.id,
  execution_id: n.source.type === "plan" ? n.id : null, goal_id: n.source.type === "goal" ? n.id : null,
  chat_id: n.chatId, kind: n.kind, status: n.status, created_at: String(n.createdAt), expires_at: String(n.expiresAt), data: structuredClone(n) });

// Serializes transaction locks and stages writes; real PostgreSQL lock behavior
// is exercised separately by the integration fixture.
class GoalNotificationPool {
  goals = new Map<string, Row>(); notifications = new Map<string, Row>();
  statements: string[] = []; failInsert = false; private tail = Promise.resolve();
  pool = this as unknown as pg.Pool;
  async query(raw: string, values: unknown[] = []) {
    const sql = raw.replace(/\s+/g, " ").trim(); this.statements.push(sql);
    if (sql.startsWith("SELECT * FROM leader_goals WHERE id=")) {
      const row = this.goals.get(String(values[0])); return { rows: row ? [structuredClone(row)] : [] };
    }
    if (sql.startsWith("SELECT * FROM leader_notifications WHERE id=")) {
      const row = this.notifications.get(String(values[0])); return { rows: row ? [structuredClone(row)] : [] };
    }
    if (sql.startsWith("SELECT * FROM leader_notifications WHERE chat_id=ANY")) {
      return { rows: [...this.notifications.values()].filter(r => (values[0] as string[]).includes(String(r.chat_id)) &&
        r.status === "pending" && Number(r.expires_at) > Number(values[1])).slice(0, Number(values[2])).map(r => structuredClone(r)) };
    }
    throw new Error(`Unexpected goal notification SQL: ${sql}`);
  }
  async connect() {
    let unlock: (() => void) | undefined, stagedGoal: Row | undefined, stagedNotification: Row | undefined;
    return { release: () => {}, query: async (raw: string, values: unknown[] = []) => {
      const sql = raw.replace(/\s+/g, " ").trim();
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) {
        this.statements.push(sql);
        if (sql === "COMMIT") {
          if (stagedGoal) this.goals.set(String(stagedGoal.id), stagedGoal);
          if (stagedNotification) this.notifications.set(String(stagedNotification.id), stagedNotification);
        }
        if (sql !== "BEGIN") { stagedGoal = undefined; stagedNotification = undefined; unlock?.(); unlock = undefined; }
        return { rows: [] };
      }
      if (sql.endsWith("FOR UPDATE") && !unlock) {
        const previous = this.tail; this.tail = new Promise<void>(resolve => { unlock = resolve; }); await previous;
      }
      if (sql.startsWith("UPDATE leader_goals")) {
        this.statements.push(sql); stagedGoal = goalRow(JSON.parse(String(values[3]))); return { rows: [structuredClone(stagedGoal)] };
      }
      if (sql.startsWith("INSERT INTO leader_notifications")) {
        this.statements.push(sql);
        if (this.failInsert) throw new Error("Goal outbox INSERT failed");
        const n = normalizeNotification(JSON.parse(String(values[8])));
        expect(values.slice(0, 8)).toEqual([n.id, null, n.id, n.chatId, n.kind, n.status, n.createdAt, n.expiresAt]);
        if (this.notifications.has(n.id)) throw new Error("Duplicate notification ID");
        stagedNotification = notificationRow(n); return { rows: [] };
      }
      if (sql.startsWith("UPDATE leader_notifications")) {
        this.statements.push(sql); stagedNotification = notificationRow(normalizeNotification(JSON.parse(String(values[2]))));
        return { rows: [structuredClone(stagedNotification)] };
      }
      return this.query(sql, values);
    } };
  }
}

async function fixture(kind: "memory" | "postgres") {
  const memory = new MemoryStore(), pool = new GoalNotificationPool();
  const goal = createGoal("allowed", { ...proposal(NOW), objective: SECRET }, NOW);
  await memory.confirmGoal(goal, await authorize(memory, goal), () => NOW);
  pool.goals.set(goal.id, goalRow(goal));
  return { goal, memory, pool,
    cas: (next: GoalRecord, revision: number, now = NOW) => kind === "memory" ? memory.compareAndSetGoal(next, revision, () => now) :
      pgCompareAndSetGoal(pool.pool, next, revision, () => memory, () => now),
    current: async () => kind === "memory" ? (await memory.getGoal(goal.id))! : structuredClone(pool.goals.get(goal.id)!.data as GoalRecord),
    get: (now = NOW) => kind === "memory" ? memory.getNotification(goal.id, now) : pgGetNotification(pool.pool, goal.id, now),
    list: (chats = ["allowed"], now = NOW) => kind === "memory" ? memory.listPendingNotifications(chats, now) : pgListPendingNotifications(pool.pool, chats, now),
    claim: (id: string, chats = ["allowed"], now = NOW) => kind === "memory" ? memory.claimNotification(goal.id, id, chats, now) : pgClaimNotification(pool.pool, goal.id, id, chats, now),
    receipt: (id: string, status: "accepted" | "uncertain", now = NOW) => kind === "memory" ? memory.recordNotificationReceipt(goal.id, id, status, now) :
      pgRecordNotificationReceipt(pool.pool, goal.id, id, status, now),
    clear: () => kind === "memory" ? (memory as unknown as { notifications: Map<string, StoredNotification> }).notifications.clear() : pool.notifications.clear(),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const blocked = (g: GoalRecord): GoalRecord => ({ ...g, revision: g.revision + 1, status: "blocked", blockedReason: SECRET });
async function complete(f: Fixture) {
  let current = (await f.cas(lease(f.goal), 1))!;
  current = (await f.cas(commit(current, nextDecision()), current.revision))!;
  const claimed = structuredClone(current); claimed.revision++;
  claimed.actions[0].attempt = { token: randomUUID(), startedAt: NOW, expiresAt: NOW + GOAL_SEND_CLAIM_MS };
  current = (await f.cas(claimed, current.revision))!;
  const stamp = new Date(NOW).toISOString(), commandId = randomUUID();
  await f.memory.createCommandIfAbsent({ commandId, requestId: goalRequestId(current, 0), nodeId: "one", sessionId: "session-1",
    action: "send", prompt: current.actions[0].input.prompt, sendRoute: "control-socket", status: "pending",
    createdAt: stamp, updatedAt: stamp, expiresAt: new Date(NOW + 60_000).toISOString() });
  await f.memory.updateCommandStatus(commandId, "accepted", undefined, undefined, "exact-turn");
  await f.memory.updateCommandStatus(commandId, "completed", SECRET, undefined, "exact-turn");
  const view = await readGoalView(f.memory, current, NOW);
  current = (await f.cas(lease(current, NOW, view.actions), current.revision))!;
  return f.cas(commit(current, { type: "complete", criteria: [{ criterion: 1, actions: [1] }], reason: SECRET }), current.revision);
}

describe.each(["memory", "postgres"] as const)("%s goal notifications", kind => {
  it.each(["blocked", "expired", "completed"] as const)("creates exactly one static %s event from an active goal", async status => {
    const f = await fixture(kind);
    const saved = status === "completed" ? await complete(f) : await f.cas(status === "blocked" ? blocked(f.goal) :
      { ...f.goal, revision: 2, status }, 1, f.goal.expiresAt);
    const event = (await f.get(status === "expired" ? f.goal.expiresAt : NOW))!;
    expect(event).toMatchObject({ id: f.goal.id, source: { type: "goal", id: f.goal.id }, kind: status, chatId: "allowed", status: "pending" });
    expect(event.text).toBe(goalNotificationText(f.goal.id, status)); expect(event.text).not.toContain(SECRET);
    expect(event).not.toHaveProperty("executionId"); expect(event.expiresAt - event.createdAt).toBe(NOTIFICATION_TTL_MS);
    expect(await f.cas(saved!, saved!.revision - 1, event.createdAt)).toBeNull(); expect(await f.get(event.createdAt)).toEqual(event);
  });
  it("active and cancelled never emit, and startup/stale CAS do not backfill old terminal goals", async () => {
    const f = await fixture(kind); expect(await f.get()).toBeNull();
    await f.cas({ ...f.goal, revision: 2, status: "cancelled" }, 1); expect(await f.get()).toBeNull();
    const old = await fixture(kind), saved = (await old.cas(blocked(old.goal), 1))!;
    old.clear(); await old.memory.init(); expect(await old.cas(saved, 1)).toBeNull(); expect(await old.get()).toBeNull();
  });
  it("concurrent terminal CAS publishes only the winner and no cancellation event", async () => {
    const f = await fixture(kind);
    const winners = await Promise.all([f.cas(blocked(f.goal), 1), f.cas({ ...f.goal, revision: 2, status: "cancelled" }, 1)]);
    expect(winners.filter(Boolean)).toHaveLength(1);
    const current = await f.current(); expect(current.status).toBe("blocked");
    expect(await f.list()).toHaveLength(1); expect((await f.get())!.kind).toBe(current.status);
  });
  it.each(["pending", "claimed", "uncertain", "accepted"] as const)("blocked expiry preserves the first %s notification and permanent attempt", async status => {
    const f = await fixture(kind), saved = (await f.cas(blocked(f.goal), 1))!, attempt = randomUUID();
    if (status !== "pending") await f.claim(attempt);
    if (status === "uncertain" || status === "accepted") await f.receipt(attempt, status);
    const first = await f.get(f.goal.expiresAt);
    await f.cas({ ...saved, revision: 3, status: "expired" }, 2, f.goal.expiresAt);
    expect(await f.get(f.goal.expiresAt)).toEqual(first);
    expect((await f.get(f.goal.expiresAt))!.kind).toBe("blocked");
    if (status !== "pending") await expect(f.claim(attempt, ["allowed"], f.goal.expiresAt)).rejects.toBeInstanceOf(ConflictError);
  });
  it("blocked cancellation preserves the first event; forbidden chats cannot claim or change authority", async () => {
    const f = await fixture(kind);
    await expect(f.cas({ ...blocked(f.goal), chatId: "other" }, 1)).rejects.toThrow("immutable");
    expect(await f.current()).toEqual(f.goal); expect(await f.get()).toBeNull();
    const saved = (await f.cas(blocked(f.goal), 1))!, first = await f.get();
    expect(await f.list(["other"])).toEqual([]); await expect(f.claim(randomUUID(), ["other"])).rejects.toBeInstanceOf(ConflictError);
    await f.cas({ ...saved, revision: 3, status: "cancelled" }, 2); expect(await f.get()).toEqual(first);
  });
  it("uses the existing TTL, single claim, timeout and irreversible late receipt", async () => {
    const f = await fixture(kind); await f.cas(blocked(f.goal), 1); const attempt = randomUUID();
    await expect(f.claim(attempt, [])).rejects.toBeInstanceOf(ConflictError);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => f.claim(randomUUID())));
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const claimed = (await f.get())!;
    expect((await f.get(NOW + NOTIFICATION_ATTEMPT_MS))!.status).toBe("uncertain");
    await expect(f.claim(claimed.attemptId!, ["allowed"], NOW + NOTIFICATION_TTL_MS)).rejects.toBeInstanceOf(ConflictError);
    expect((await f.receipt(claimed.attemptId!, "accepted", NOW + NOTIFICATION_TTL_MS))!.status).toBe("accepted");
    expect((await f.receipt(claimed.attemptId!, "uncertain", NOW + NOTIFICATION_TTL_MS))!.status).toBe("accepted");
    const pending = await fixture(kind); await pending.cas(blocked(pending.goal), 1);
    expect(await pending.list(["allowed"], NOW + NOTIFICATION_TTL_MS)).toEqual([]);
    expect((await pending.get(NOW + NOTIFICATION_TTL_MS))!.status).toBe("expired");
  });
  it("a plan/goal UUID collision cannot overwrite the plan event or partially publish the goal", async () => {
    const f = await fixture(kind), execution = createExecution("other", { id: f.goal.id, expiresAt: NOW + 60_000,
      actions: [{ nodeId: "one", sessionId: "session", prompt: "private plan", sendRoute: "control-socket" }] }, NOW);
    const n = createTerminalNotification({ ...execution, status: "completed" }, NOW)!;
    if (kind === "memory") (f.memory as unknown as { notifications: Map<string, StoredNotification> }).notifications.set(n.id, n);
    else f.pool.notifications.set(n.id, notificationRow(n));
    await expect(f.cas(blocked(f.goal), 1)).rejects.toThrow();
    expect(await f.current()).toEqual(f.goal); expect(await f.get()).toEqual(n);
  });
});

it("goal and outbox rollback together on INSERT failure and retry publishes one event", async () => {
  const f = await fixture("postgres"); f.pool.failInsert = true;
  await expect(f.cas(blocked(f.goal), 1)).rejects.toThrow("Goal outbox INSERT failed");
  expect(await f.current()).toEqual(f.goal); expect(await f.get()).toBeNull();
  expect(f.pool.statements).toContain("ROLLBACK"); expect(f.pool.statements).not.toContain("COMMIT");
  f.pool.failInsert = false; await f.cas(blocked(f.goal), 1);
  expect((await f.current()).status).toBe("blocked"); expect(await f.list()).toHaveLength(1);
  expect(await f.cas(blocked(f.goal), 1)).toBeNull();
});

it("strict source-kind union rejects legacy, mismatched IDs, mixed kinds and model-controlled prose", async () => {
  const f = await fixture("memory"); await f.cas(blocked(f.goal), 1); const n = (await f.get())!;
  for (const invalid of [{ ...n, executionId: n.id }, { ...n, source: undefined, executionId: n.id },
    { ...n, source: { type: "plan", id: n.id } }, { ...n, kind: "failed" }, { ...n, source: { type: "goal", id: randomUUID() } },
    { ...n, source: { ...n.source, chatId: "allowed" } }, { ...n, text: SECRET }, { ...n, reason: SECRET }]) {
    expect(() => normalizeNotification(invalid)).toThrow();
  }
  expect(goalNotificationText(n.id, "completed")).toBe(`持续目标 ${n.id}：模型根据精确完成记录判断条件已满足；这不是独立业务验收。可查询目标进展核对。`);
  expect(goalNotificationText(n.id, "blocked")).toBe(`持续目标 ${n.id}：已停止自动推进，需要处理。请查询目标进展核对当前状态；这不表示原会话任务停止。`);
  expect(goalNotificationText(n.id, "expired")).toBe(`持续目标 ${n.id}：授权已到期，已停止后续派发。请查询目标进展核对当前状态；这不表示原会话任务停止。`);
});
