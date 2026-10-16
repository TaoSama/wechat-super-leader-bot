import { describe, expect, it, vi } from "vitest";
import pg from "pg";
import { MemoryStore } from "../../../src/store/memory.js";
import { PostgresStore } from "../../../src/store/postgres.js";
import { ConflictError, type ExecutionConfirmationAuthority } from "../../../src/store/interface.js";
import { createExecution, EXECUTION_TTL_MS, type ExecutionRecord } from "../../../src/leader/plans/execution.js";
import { CLAIM_TTL_MS, PLAN_TTL_MS } from "../../../src/leader/contracts.js";
import { LeaderOrchestrator } from "../../../src/leader/orchestrator.js";
import { ExecutionScheduler } from "../../../src/leader/plans/scheduler.js";
import type { LeaderState } from "../../../src/leader/state.js";

vi.mock("pg", () => ({ default: { Pool: vi.fn() } }));
const NOW = 1_700_000_000_000;
const ID = "00000000-0000-4000-8000-000000000001";
const OTHER_ID = "00000000-0000-4000-8000-000000000002";
const authority: ExecutionConfirmationAuthority = { revision: 1, messageId: "confirm-message", inputHash: "confirmed-input-hash" };
function record(): ExecutionRecord {
  return createExecution("chat", { id: ID, expiresAt: NOW + PLAN_TTL_MS,
    actions: [{ nodeId: "node", sessionId: "session", prompt: "fixture only", dependsOn: [], sendRoute: "control-socket" }] }, NOW);
}
function claimData(execution = record()): Record<string, unknown> {
  return { inflight: { messageId: authority.messageId, inputHash: authority.inputHash,
    expiresAt: NOW + CLAIM_TTL_MS, plan: structuredClone(execution.plan) } };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

interface ExecutionRow {
  id: string; chat_id: string; revision: string; status: string; data: ExecutionRecord; created_at: string;
}
// SQL mock: stage INSERT until COMMIT, serialize row locks and model I/O barriers.
// This is not evidence that PostgreSQL itself enforces these semantics.
class ConfirmationPool {
  states = new Map<string, LeaderState>();
  rows = new Map<string, ExecutionRow>();
  queries: string[] = [];
  released = 0;
  beforeLock?: () => Promise<void>;
  afterInsert?: () => Promise<void>;
  failInsert = false;
  private lockTail = Promise.resolve();
  row(execution: ExecutionRecord): ExecutionRow {
    return { id: execution.id, chat_id: execution.chatId, revision: String(execution.revision), status: execution.status,
      data: structuredClone(execution), created_at: String(execution.createdAt) };
  }
  async query(sql: string, params: unknown[] = []) {
    const statement = sql.replace(/\s+/g, " ").trim();
    this.queries.push(statement);
    if (statement.startsWith("SELECT pg_advisory_xact_lock(") || statement.startsWith("SELECT id FROM leader_goals WHERE chat_id=$1")) return { rows: [] };
    if (statement === "SELECT * FROM leader_executions WHERE id=$1") {
      const row = this.rows.get(params[0] as string);
      return { rows: row ? [structuredClone(row)] : [] };
    }
    throw new Error(`Unexpected mock SQL: ${statement}`);
  }
  async connect() {
    let staged: ExecutionRow | undefined;
    let unlock: (() => void) | undefined;
    return {
      query: async (sql: string, params: unknown[] = []) => {
        const statement = sql.replace(/\s+/g, " ").trim();
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(statement)) {
          this.queries.push(statement);
          if (statement === "COMMIT" && staged) this.rows.set(staged.id, staged);
          if (statement !== "BEGIN") { staged = undefined; unlock?.(); unlock = undefined; }
          return { rows: [] };
        }
        if (statement === "SELECT chat_id,revision,data FROM leader_states WHERE chat_id=$1 FOR UPDATE") {
          this.queries.push(statement);
          await this.beforeLock?.();
          const previous = this.lockTail;
          this.lockTail = new Promise<void>(resolve => { unlock = resolve; });
          await previous;
          const state = this.states.get(params[0] as string);
          return { rows: state ? [{ chat_id: state.chatId, revision: state.revision, data: structuredClone(state.data) }] : [] };
        }
        if (statement.startsWith("INSERT INTO leader_executions")) {
          this.queries.push(statement);
          if (this.failInsert) throw new Error("Simulated insert failure");
          const input = JSON.parse(params[4] as string) as ExecutionRecord;
          if (this.rows.has(input.id) || [...this.rows.values()].some(row => row.chat_id === input.chatId && row.status === "active")) return { rows: [] };
          staged = this.row(input);
          await this.afterInsert?.();
          return { rows: [structuredClone(staged)] };
        }
        return this.query(sql, params);
      },
      release: () => { this.released++; },
    };
  }
}

async function fixture(kind: "memory" | "SQL mock") {
  const pool = new ConfirmationPool();
  vi.mocked(pg.Pool).mockImplementation(function () { return pool as unknown as pg.Pool; });
  const store = kind === "memory" ? new MemoryStore() : new PostgresStore("postgresql://unused/confirmation");
  let clock = NOW;
  const write = async (data: Record<string, unknown>, chatId = "chat") => {
    if (store instanceof MemoryStore) {
      const current = await store.getLeaderState(chatId);
      return store.compareAndSetLeaderState(chatId, current?.revision ?? 0, data);
    }
    const state = { chatId, revision: (pool.states.get(chatId)?.revision ?? 0) + 1, data: structuredClone(data),
      updatedAt: new Date(clock).toISOString() };
    pool.states.set(chatId, state);
    return state;
  };
  await write(claimData());
  return { store, pool, write, now: () => clock, tick: (ms: number) => { clock += ms; } };
}

for (const kind of ["memory", "SQL mock"] as const) {
  describe(`${kind} atomic execution confirmation`, () => {
    it("publishes one execution for concurrent identical confirmations and leaves chat revision independent", async () => {
      const f = await fixture(kind);
      const results = await Promise.all(Array.from({ length: 8 }, () => f.store.confirmExecution(record(), authority, f.now)));
      expect(results.filter(result => result.created)).toHaveLength(1);
      expect(await f.store.getExecution(ID)).toEqual(record());
      if (f.store instanceof MemoryStore) expect((await f.store.getLeaderState("chat"))?.revision).toBe(1);
      else expect(f.pool.states.get("chat")?.revision).toBe(1);
    });

    it("rejects missing, replaced, cancelled or conflicting chat authority without publication", async () => {
      const variants = [
        {}, { inflight: { ...(claimData().inflight as object), plan: undefined } },
        { inflight: { ...(claimData().inflight as object), messageId: "replacement" } },
        { inflight: { ...(claimData().inflight as object), inputHash: "changed" } },
      ];
      for (const data of variants) {
        const f = await fixture(kind);
        await f.write(data);
        await expect(f.store.confirmExecution(record(), { ...authority, revision: 2 }, f.now)).rejects.toBeInstanceOf(ConflictError);
        expect(await f.store.getExecution(ID)).toBeNull();
      }
      const f = await fixture(kind);
      await expect(f.store.confirmExecution({ ...record(), chatId: "other-chat" }, authority, f.now)).rejects.toBeInstanceOf(ConflictError);
      expect(await f.store.getExecution(ID)).toBeNull();
    });

    it("checks message and hash independently even when the revision matches", async () => {
      const f = await fixture(kind);
      for (const changed of [{ ...authority, messageId: "different" }, { ...authority, inputHash: "different" },
        { ...authority, revision: 0 }, { ...authority, revision: 1.5 }]) {
        await expect(f.store.confirmExecution(record(), changed, f.now)).rejects.toBeInstanceOf(ConflictError);
      }
      expect(await f.store.getExecution(ID)).toBeNull();
    });

    it("checks every frozen plan field and ignores object property ordering", async () => {
      const mutations = [
        (value: ExecutionRecord) => { value.id = OTHER_ID; value.plan.id = OTHER_ID; },
        (value: ExecutionRecord) => { value.plan.actions[0].prompt = "changed"; },
        (value: ExecutionRecord) => { value.plan.actions[0].nodeId = "changed"; },
        (value: ExecutionRecord) => { value.plan.actions[0].sessionId = "changed"; },
        (value: ExecutionRecord) => { value.plan.actions[0].sendRoute = "desktop-owner"; },
        (value: ExecutionRecord) => { value.plan.actions[0].skills = [{ id: "a".repeat(64), digest: "b".repeat(64) }]; },
        (value: ExecutionRecord) => { value.plan.expiresAt--; },
      ];
      for (const mutate of mutations) {
        const f = await fixture(kind), changed = record();
        mutate(changed);
        await expect(f.store.confirmExecution(changed, authority, f.now)).rejects.toBeInstanceOf(ConflictError);
        expect(await f.store.getExecution(changed.id)).toBeNull();
      }
      const f = await fixture(kind), reordered = record();
      reordered.plan = Object.fromEntries(Object.entries(reordered.plan).reverse()) as ExecutionRecord["plan"];
      expect((await f.store.confirmExecution(reordered, authority, f.now)).created).toBe(true);
    });

    it("rejects claim TTL, plan TTL, execution TTL and invalid clocks at the confirmation boundary", async () => {
      const f = await fixture(kind);
      f.tick(CLAIM_TTL_MS);
      await expect(f.store.confirmExecution(record(), authority, f.now)).rejects.toBeInstanceOf(ConflictError);
      const planExpiry = await fixture(kind);
      const longerClaim = claimData();
      (longerClaim.inflight as { expiresAt: number }).expiresAt = NOW + PLAN_TTL_MS + 1;
      await planExpiry.write(longerClaim);
      planExpiry.tick(PLAN_TTL_MS);
      await expect(planExpiry.store.confirmExecution(record(), { ...authority, revision: 2 }, planExpiry.now)).rejects.toBeInstanceOf(ConflictError);
      const shortExecution = { ...record(), expiresAt: NOW + 1 };
      const expired = await fixture(kind);
      expired.tick(1);
      await expect(expired.store.confirmExecution(shortExecution, authority, expired.now)).rejects.toBeInstanceOf(ConflictError);
      for (const clock of [NaN, Infinity, NOW - 1]) {
        const invalid = await fixture(kind);
        await expect(invalid.store.confirmExecution(record(), authority, () => clock)).rejects.toBeInstanceOf(ConflictError);
        expect(await invalid.store.getExecution(ID)).toBeNull();
      }
      expect(await f.store.getExecution(ID)).toBeNull();
      expect(await planExpiry.store.getExecution(ID)).toBeNull();
      expect(await expired.store.getExecution(ID)).toBeNull();
    });

    it("does not extend authorization on reentry or revive an existing terminal execution", async () => {
      const f = await fixture(kind);
      await f.store.confirmExecution(record(), authority, f.now);
      f.tick(1);
      const retry = { ...record(), createdAt: NOW + 1, expiresAt: NOW + EXECUTION_TTL_MS + 1 };
      expect(await f.store.confirmExecution(retry, authority, f.now)).toEqual({ created: false, execution: record() });
      const terminal = { ...record(), revision: 2, status: "cancelled" as const };
      if (f.store instanceof MemoryStore) await f.store.compareAndSetExecution(terminal, 1);
      else f.pool.rows.set(ID, f.pool.row(terminal));
      expect(await f.store.confirmExecution(retry, authority, f.now)).toEqual({ created: false, execution: terminal });
      f.tick(CLAIM_TTL_MS);
      await expect(f.store.confirmExecution(retry, authority, f.now)).rejects.toBeInstanceOf(ConflictError);
      expect(await f.store.getExecution(ID)).toEqual(terminal);
    });

    it("refuses non-initial records and isolates confirmation input and result clones", async () => {
      const f = await fixture(kind);
      for (const invalid of [{ ...record(), revision: 2 }, { ...record(), status: "completed" as const },
        { ...record(), attempts: [{ token: OTHER_ID, startedAt: NOW, expiresAt: NOW + 1 }] }]) {
        await expect(f.store.confirmExecution(invalid, authority, f.now)).rejects.toBeInstanceOf(ConflictError);
      }
      const original = record(), owned = { ...authority };
      const result = await f.store.confirmExecution(original, owned, f.now);
      original.plan.actions[0].prompt = "mutated";
      owned.messageId = "mutated";
      result.execution.plan.actions[0].prompt = "mutated";
      expect(await f.store.getExecution(ID)).toEqual(record());
    });
  });
}

describe("SQL mock lock and transaction barriers", () => {
  it("revalidates ownership and the clock after a delayed row-lock read", async () => {
    const f = await fixture("SQL mock"), entered = deferred(), release = deferred();
    f.pool.beforeLock = async () => { entered.resolve(); await release.promise; };
    const pending = f.store.confirmExecution(record(), authority, f.now);
    const rejected = expect(pending).rejects.toBeInstanceOf(ConflictError);
    await entered.promise;
    f.tick(CLAIM_TTL_MS + 1);
    await f.write({});
    release.resolve();
    await rejected;
    expect(await f.store.getExecution(ID)).toBeNull();
    expect(f.pool.queries.some(sql => sql.startsWith("INSERT INTO leader_executions"))).toBe(false);
    expect(f.pool.queries.at(-2)).toBe("ROLLBACK");
    expect(f.pool.released).toBe(1);
  });

  it("rolls back invisible INSERT when index/INSERT waiting crosses claim or plan TTL", async () => {
    for (const delay of [CLAIM_TTL_MS, PLAN_TTL_MS]) {
      const f = await fixture("SQL mock"), entered = deferred(), release = deferred();
      f.pool.afterInsert = async () => { entered.resolve(); await release.promise; };
      const pending = f.store.confirmExecution(record(), authority, f.now);
      const rejected = expect(pending).rejects.toBeInstanceOf(ConflictError);
      await entered.promise;
      expect(await f.store.getExecution(ID)).toBeNull();
      f.tick(delay);
      release.resolve();
      await rejected;
      expect(await f.store.getExecution(ID)).toBeNull();
      expect(f.pool.queries).not.toContain("COMMIT");
      expect(f.pool.queries).toContain("ROLLBACK");
      expect(f.pool.released).toBe(1);
    }
  });

  it("rolls back SQL failure and snapshots caller inputs before asynchronous I/O", async () => {
    const failed = await fixture("SQL mock");
    failed.pool.failInsert = true;
    await expect(failed.store.confirmExecution(record(), authority, failed.now)).rejects.toThrow("Simulated insert failure");
    expect(failed.pool.queries).toContain("ROLLBACK");
    expect(failed.pool.released).toBe(1);
    const f = await fixture("SQL mock"), entered = deferred(), release = deferred();
    f.pool.beforeLock = async () => { entered.resolve(); await release.promise; };
    const input = record(), owned = { ...authority };
    const pending = f.store.confirmExecution(input, owned, f.now);
    await entered.promise;
    input.plan.actions[0].prompt = "changed while awaiting lock";
    owned.messageId = "changed while awaiting lock";
    release.resolve();
    expect((await pending).execution).toEqual(record());
  });
});

it("a delayed old confirmation cannot publish after another Leader instance cancels the expired claim", async () => {
  const store = new MemoryStore();
  let clock = NOW;
  await store.compareAndSetLeaderState("chat", 0, { pending: record().plan });
  const original = store.confirmExecution.bind(store), entered = deferred(), release = deferred();
  vi.spyOn(store, "confirmExecution").mockImplementation(async (...args) => {
    entered.resolve();
    await release.promise;
    return original(...args);
  });
  const hub = { getAllSkills: () => [], getNodeSkills: () => [], getAllSessions: async () => [], getNodeStatusList: () => [],
    isNodeConnected: () => true, getNodeSession: () => ({ id: "session", nodeId: "node", provider: "codex-app",
      title: "fixture", cwd: "/fixture", loaded: true, status: "idle", capabilities: ["send", "read"] as ("send" | "read")[],
      observedAt: new Date(clock).toISOString() }) };
  const commands = { submit: vi.fn() };
  const model = { complete: vi.fn() };
  const scheduler = new ExecutionScheduler(store, commands, { now: () => clock });
  const leaderA = new LeaderOrchestrator(store, hub, commands, model, () => clock, undefined, scheduler);
  const leaderB = new LeaderOrchestrator(store, hub, commands, model, () => clock, undefined, scheduler);
  const old = leaderA.handle("chat", "old-confirm", "确认执行").then(() => null, error => error);
  await entered.promise;
  clock += CLAIM_TTL_MS + 1;
  const cancellation = await leaderB.handle("chat", "cancel", "取消计划");
  expect(cancellation.text).toContain("没有活动执行计划");
  release.resolve();
  expect(await old).toMatchObject({ httpStatus: 409 });
  await scheduler.advance(ID);
  expect(await store.getExecution(ID)).toBeNull();
  expect(await store.listActiveExecutions()).toEqual([]);
  expect(commands.submit).not.toHaveBeenCalled();
  expect((await store.getLeaderState("chat"))?.data.inflight).toBeUndefined();
});
