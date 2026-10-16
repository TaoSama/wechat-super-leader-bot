import { randomUUID, createHash } from "node:crypto";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../../src/store/memory.js";
import { ConflictError } from "../../../src/store/interface.js";
import { createGoal, goalRequestId, GOAL_SEND_CLAIM_MS, type GoalRecord } from "../../../src/leader/goals/goal.js";
import { readGoalView } from "../../../src/leader/goals/view.js";
import { createExecution } from "../../../src/leader/plans/execution.js";
import { pgConfirmGoal, pgCompareAndSetGoal, pgListRecentGoals, pgListRunnableGoals } from "../../../src/store/goal-postgres.js";
import { authorize, proposal, lease, commit, nextDecision } from "../../fixtures/goals.js";
import type { LeaderState } from "../../../src/leader/state.js";

function fixed(chatId = "chat") {
  const now = Date.now(); return createExecution(chatId, { id: randomUUID(), expiresAt: now + 60_000,
    actions: [{ nodeId: "one", sessionId: "session-1", sendRoute: "control-socket", prompt: "fixed" }] }, now);
}
async function initial(store = new MemoryStore(), chatId = "chat") {
  const goal = createGoal(chatId, proposal(), Date.now()), authority = await authorize(store, goal);
  return { store, goal, authority };
}
function row(goal: GoalRecord) { return { id: goal.id, chat_id: goal.chatId, revision: goal.revision,
  status: goal.status, created_at: goal.createdAt, data: structuredClone(goal) }; }
class GoalPool {
  goals = new Map<string, GoalRecord>(); states = new Map<string, LeaderState>(); fixedChats = new Set<string>();
  private rollback?: Map<string, GoalRecord>;
  released = vi.fn(); calls: { sql: string; values: unknown[] }[] = [];
  pool = this as unknown as pg.Pool;
  async connect() { return { query: this.query.bind(this), release: this.released }; }
  async query(sql: string, values: unknown[] = []) {
    this.calls.push({ sql, values });
    if (sql === "BEGIN") { this.rollback = structuredClone(this.goals); return { rows: [] }; }
    if (sql === "COMMIT") { this.rollback = undefined; return { rows: [] }; }
    if (sql === "ROLLBACK") { if (this.rollback) this.goals = this.rollback; this.rollback = undefined; return { rows: [] }; }
    if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
    if (sql.startsWith("SELECT chat_id,revision,data FROM leader_states")) {
      const state = this.states.get(String(values[0])); return { rows: state ? [{ chat_id: state.chatId, revision: state.revision, data: state.data }] : [] };
    }
    if (sql.startsWith("SELECT id FROM leader_executions")) return { rows: this.fixedChats.has(String(values[0])) ? [{ id: "fixed" }] : [] };
    if (sql.startsWith("SELECT id FROM leader_goals")) return { rows: [...this.goals.values()].filter(g => g.chatId === values[0] && ["active", "blocked"].includes(g.status)).map(g => ({ id: g.id })) };
    if (sql.startsWith("SELECT * FROM leader_goals WHERE id=")) { const goal = this.goals.get(String(values[0])); return { rows: goal ? [row(goal)] : [] }; }
    if (sql.startsWith("INSERT INTO leader_goals")) { const goal = JSON.parse(String(values[5])) as GoalRecord;
      this.goals.set(goal.id, goal); return { rows: [row(goal)] }; }
    if (sql.startsWith("UPDATE leader_goals")) { const goal = JSON.parse(String(values[3])) as GoalRecord;
      this.goals.set(goal.id, goal); return { rows: [row(goal)] }; }
    if (sql.startsWith("SELECT * FROM leader_goals WHERE status")) return { rows: [...this.goals.values()].filter(g => ["active", "blocked"].includes(g.status) && g.id > String(values[0])).sort((a, b) => a.id.localeCompare(b.id)).slice(0, Number(values[1])).map(row) };
    if (sql.startsWith("SELECT * FROM leader_goals WHERE chat_id=ANY")) return { rows: [...this.goals.values()].filter(g => (values[0] as string[]).includes(g.chatId)).sort((a, b) => b.createdAt - a.createdAt).slice(0, Number(values[1])).map(row) };
    throw new Error(`Unexpected test SQL: ${sql}`);
  }
}

describe("persistent continuous goal stores", () => {
  it("confirms once with exact fenced authority and isolates caller mutations", async () => {
    const { store, goal, authority } = await initial();
    const first = await store.confirmGoal(goal, authority), second = await store.confirmGoal(goal, authority);
    expect(first.created).toBe(true); expect(second.created).toBe(false);
    goal.proposal.objective = "caller mutation"; first.goal.proposal.objective = "result mutation";
    expect((await store.getGoal(goal.id))!.proposal.objective).toBe("完成调查并交叉核验");
    expect((await store.getLatestGoal("other"))).toBeNull();
  });
  it.each(["revision", "messageId", "inputHash"] as const)("rejects wrong confirmation %s", async key => {
    const { store, goal, authority } = await initial();
    await expect(store.confirmGoal(goal, { ...authority, [key]: key === "revision" ? 99 : "other" })).rejects.toBeInstanceOf(ConflictError);
    expect(await store.getGoal(goal.id)).toBeNull();
  });
  it("malformed and expired confirmation claims are stable conflicts", async () => {
    const { store, goal, authority } = await initial();
    await expect(store.confirmGoal(goal, authority, () => goal.proposal.expiresAt)).rejects.toBeInstanceOf(ConflictError);
    const current = (await store.getLeaderState("chat"))!;
    const malformed = await store.compareAndSetLeaderState("chat", current.revision, { inflight: { messageId: "confirm", inputHash: "hash", expiresAt: goal.proposal.expiresAt, goal: {} } });
    await expect(store.confirmGoal(goal, { ...authority, revision: malformed!.revision })).rejects.toBeInstanceOf(ConflictError);
  });
  it("fixed plans and active or blocked goals share one chat slot; cancellation releases it", async () => {
    const { store, goal, authority } = await initial(); await store.confirmGoal(goal, authority);
    await expect(store.createExecutionIfAbsent(fixed())).rejects.toBeInstanceOf(ConflictError);
    const blocked = { ...goal, revision: 2, status: "blocked" as const, blockedReason: "needs proof" };
    await store.compareAndSetGoal(blocked, 1);
    await expect(store.createExecutionIfAbsent(fixed())).rejects.toBeInstanceOf(ConflictError);
    await store.compareAndSetGoal({ ...blocked, revision: 3, status: "cancelled" }, 2);
    expect((await store.createExecutionIfAbsent(fixed())).created).toBe(true);
  });
  it("an active fixed plan blocks a new goal, but not a different chat", async () => {
    const { store, goal, authority } = await initial(); await store.createExecutionIfAbsent(fixed());
    await expect(store.confirmGoal(goal, authority)).rejects.toBeInstanceOf(ConflictError);
    const other = await initial(store, "other"); expect((await store.confirmGoal(other.goal, other.authority)).created).toBe(true);
  });
  it("a blocked goal releases its slot only at the immutable deadline", async () => {
    const { store, goal, authority } = await initial(); await store.confirmGoal(goal, authority);
    const blocked = { ...goal, revision: 2, status: "blocked" as const, blockedReason: "needs proof" };
    await store.compareAndSetGoal(blocked, 1);
    await expect(store.compareAndSetGoal({ ...blocked, revision: 3, status: "expired" }, 2)).rejects.toThrow("terminal");
    await store.compareAndSetGoal({ ...blocked, revision: 3, status: "expired" }, 2, () => goal.expiresAt);
    expect((await store.createExecutionIfAbsent(fixed())).created).toBe(true);
  });
  it("racing confirmations and stale CAS cannot both mutate authorization", async () => {
    const { store, goal, authority } = await initial();
    const results = await Promise.all([store.confirmGoal(goal, authority), store.confirmGoal(goal, authority)]);
    expect(results.filter(r => r.created)).toHaveLength(1);
    const claimed = lease(goal);
    const raced = await Promise.all([store.compareAndSetGoal(claimed, 1), store.compareAndSetGoal(claimed, 1)]);
    expect(raced.filter(Boolean)).toHaveLength(1);
    const terminal = { ...raced.find(Boolean)!, revision: 3, status: "cancelled" as const, lease: undefined };
    await store.compareAndSetGoal(terminal, 2);
    expect(await store.compareAndSetGoal({ ...terminal, revision: 4 }, 3)).toBeNull();
  });
  it("requires real matching completed command proofs rather than valid fabricated hashes", async () => {
    const { store, goal, authority } = await initial(); await store.confirmGoal(goal, authority);
    const firstLease = (await store.compareAndSetGoal(lease(goal), 1))!;
    const action = (await store.compareAndSetGoal(commit(firstLease, nextDecision()), 2))!;
    const claimed = structuredClone(action); claimed.revision++;
    claimed.actions[0].attempt = { token: randomUUID(), startedAt: goal.createdAt, expiresAt: goal.createdAt + 15000 };
    await store.compareAndSetGoal(claimed, 3);
    const output = "fabricated", evidence = { action: 1, commandId: "fake", turnId: "fake-turn", outputSHA256: createHash("sha256").update(output).digest("hex"), outputLength: output.length, excerpt: output, truncated: false };
    const fabricated = lease(claimed, goal.createdAt, [{ index: 1, target: 1, prompt: action.actions[0].prompt, sourceActions: [], status: "completed", commandId: "fake", turnId: "fake-turn", result: evidence }]);
    await expect(store.compareAndSetGoal(fabricated, 4)).rejects.toThrow("recorded commands");
    expect((await store.getGoal(goal.id))!.decisionAttempts).toBe(1);
  });
  it.each(["pending", "completed"] as const)("does not legitimize an orphan %s command by adding a send claim", async status => {
    const { store, goal, authority } = await initial(); await store.confirmGoal(goal, authority);
    const firstLease = (await store.compareAndSetGoal(lease(goal), 1))!;
    const current = (await store.compareAndSetGoal(commit(firstLease, nextDecision()), 2))!;
    const stamp = new Date(goal.createdAt).toISOString();
    await store.createCommandIfAbsent({ commandId: "orphan", requestId: goalRequestId(goal, 0),
      nodeId: goal.proposal.targets[0].nodeId, sessionId: goal.proposal.targets[0].sessionId,
      action: "send", prompt: current.actions[0].input.prompt, sendRoute: "control-socket", status: "pending",
      createdAt: stamp, updatedAt: stamp, expiresAt: new Date(goal.createdAt + 60000).toISOString() });
    if (status === "completed") {
      await store.updateCommandStatus("orphan", "accepted", undefined, undefined, "orphan-turn");
      await store.updateCommandStatus("orphan", "completed", "otherwise valid completed evidence", undefined, "orphan-turn");
    }
    expect((await readGoalView(store, current, goal.createdAt)).actions[0].status).toBe("uncertain");
    const claimed = structuredClone(current); claimed.revision++;
    claimed.actions[0].attempt = { token: randomUUID(), startedAt: goal.createdAt, expiresAt: goal.createdAt + GOAL_SEND_CLAIM_MS };
    await expect(store.compareAndSetGoal(claimed, current.revision)).rejects.toThrow("Goal send predecessors are not completed");
    expect(await store.getGoal(goal.id)).toEqual(current);
    expect((await readGoalView(store, current, goal.createdAt)).actions[0].status).toBe("uncertain");
    expect((await store.getCommand("orphan"))!.status).toBe(status);
  });
  it("filters authorized chats before limiting and paginates active plus blocked", async () => {
    const store = new MemoryStore();
    for (const chat of ["one", "two", "three"]) { const f = await initial(store, chat); await store.confirmGoal(f.goal, f.authority); }
    const one = (await store.getLatestGoal("one"))!;
    await store.compareAndSetGoal({ ...one, revision: 2, status: "blocked", blockedReason: "hold" }, 1);
    expect((await store.listRecentGoals(["one"], 1)).map(g => g.chatId)).toEqual(["one"]);
    const page = await store.listRunnableGoals(1), remaining = await store.listRunnableGoals(8, page[0].id);
    expect(new Set([...page, ...remaining].map(g => g.id)).size).toBe(3);
  });

  it("PostgreSQL confirmation uses row and shared chat locks before committing", async () => {
    const f = await initial(), pool = new GoalPool(); pool.states.set("chat", (await f.store.getLeaderState("chat"))!);
    expect((await pgConfirmGoal(pool.pool, f.goal, f.authority)).created).toBe(true);
    expect((await pgConfirmGoal(pool.pool, f.goal, f.authority)).created).toBe(false);
    const statements = pool.calls.map(c => c.sql);
    expect(statements[0]).toBe("BEGIN"); expect(statements[1]).toContain("FOR UPDATE");
    expect(statements[2]).toBe("SELECT pg_advisory_xact_lock(hashtextextended($1,0))");
    expect(pool.calls[2].values).toEqual(["leader-authorization:chat"]);
    expect(statements.at(-1)).toBe("COMMIT"); expect(pool.released).toHaveBeenCalledTimes(2);
  });
  it("PostgreSQL confirmation rolls back if the authority expires while locks are awaited", async () => {
    const f = await initial(), pool = new GoalPool(); pool.states.set("chat", (await f.store.getLeaderState("chat"))!);
    let reads = 0;
    await expect(pgConfirmGoal(pool.pool, f.goal, f.authority, () => ++reads === 1 ? f.goal.createdAt : f.goal.proposal.expiresAt)).rejects.toBeInstanceOf(ConflictError);
    expect(pool.goals.size).toBe(0); expect(pool.calls.at(-1)!.sql).toBe("ROLLBACK"); expect(pool.released).toHaveBeenCalledOnce();
  });
  it("PostgreSQL checks both fixed and blocked-goal occupancy", async () => {
    for (const kind of ["fixed", "goal"]) {
      const f = await initial(), pool = new GoalPool(); pool.states.set("chat", (await f.store.getLeaderState("chat"))!);
      if (kind === "fixed") pool.fixedChats.add("chat"); else { const other = createGoal("chat", proposal(), Date.now()); pool.goals.set(other.id, { ...other, status: "blocked", blockedReason: "hold" }); }
      await expect(pgConfirmGoal(pool.pool, f.goal, f.authority)).rejects.toBeInstanceOf(ConflictError);
      expect(pool.calls.at(-1)!.sql).toBe("ROLLBACK"); expect(pool.goals.has(f.goal.id)).toBe(false);
    }
  });
  it("PostgreSQL CAS locks, fences revisions and rolls back a late lease commit", async () => {
    const f = await initial(), pool = new GoalPool(); pool.goals.set(f.goal.id, f.goal);
    const claimed = lease(f.goal), reader = () => f.store;
    expect(await pgCompareAndSetGoal(pool.pool, claimed, 99, reader)).toBeNull();
    await pgCompareAndSetGoal(pool.pool, claimed, 1, reader);
    const next = commit(claimed, nextDecision()); let reads = 0;
    await expect(pgCompareAndSetGoal(pool.pool, next, 2, reader, () => ++reads < 3 ? f.goal.createdAt : claimed.lease!.expiresAt)).rejects.toThrow("unavailable");
    expect(pool.goals.get(f.goal.id)!.revision).toBe(2);
    expect(pool.calls.some(c => c.sql === "SELECT * FROM leader_goals WHERE id=$1 FOR UPDATE")).toBe(true);
    expect(pool.calls.at(-1)!.sql).toBe("ROLLBACK");
  });
  it("PostgreSQL list SQL filters by chat before limit and includes blocked", async () => {
    const pool = new GoalPool(), goal = createGoal("allowed", proposal(), Date.now()); pool.goals.set(goal.id, { ...goal, status: "blocked", blockedReason: "hold" });
    const other = createGoal("denied", proposal(), Date.now()); pool.goals.set(other.id, other);
    expect((await pgListRecentGoals(pool.pool, ["allowed"], 1)).map(g => g.chatId)).toEqual(["allowed"]);
    expect((await pgListRunnableGoals(pool.pool)).map(g => g.status)).toContain("blocked");
    expect(pool.calls[0].sql).toContain("WHERE chat_id=ANY($1::text[])");
  });
});
