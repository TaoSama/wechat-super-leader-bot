import { describe, expect, it, vi } from "vitest";
import pg from "pg";
import { MemoryStore } from "../src/store/memory.js";
import { PostgresStore } from "../src/store/postgres.js";
import { ConflictError } from "../src/store/interface.js";
import { createExecution, EXECUTION_CLAIM_MS, type ExecutionRecord } from "../src/leader/execution.js";

vi.mock("pg", () => ({ default: { Pool: vi.fn() } }));

const NOW = 1_700_000_000_000;
const uuid = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
function record(index = 1, chatId = "chat", now = NOW): ExecutionRecord {
  return createExecution(chatId, {
    id: uuid(index), expiresAt: NOW + 600_000,
    actions: [
      { nodeId: "node", sessionId: "first", prompt: "first task", sendRoute: "desktop-owner", dependsOn: [] },
      { nodeId: "node", sessionId: "second", prompt: "second task", sendRoute: "control-socket", dependsOn: [1] },
    ],
  }, now);
}
function updated(current: ExecutionRecord, patch: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return { ...structuredClone(current), revision: current.revision + 1, ...patch };
}
function claim(current: ExecutionRecord): ExecutionRecord {
  const next = updated(current);
  next.attempts[0] = { token: uuid(100), startedAt: NOW, expiresAt: NOW + EXECUTION_CLAIM_MS };
  return next;
}

interface Row {
  id: string; chat_id: string; revision: string; status: string; data: ExecutionRecord; created_at: string;
}
// Exercise production SQL and row decoding without a database or credentials.
class FakeExecutionPool {
  rows = new Map<string, Row>();
  queries: string[] = [];
  released = 0;
  failUpdate = false;
  corruptUpdate = false;
  private lockTail: Promise<void> = Promise.resolve();

  private row(record: ExecutionRecord): Row {
    // JSONB does not preserve property order; BIGINT arrives as text in pg.
    const data = Object.fromEntries(Object.entries(record).reverse()) as ExecutionRecord;
    return { id: record.id, chat_id: record.chatId, revision: String(record.revision),
      status: record.status, data: structuredClone(data), created_at: String(record.createdAt) };
  }
  private result(rows: Row[]) { return { rows: structuredClone(rows) }; }
  async query(sql: string, params: unknown[] = []) {
    const normalized = sql.replace(/\s+/g, " ").trim();
    this.queries.push(normalized);
    if (normalized.startsWith("SELECT pg_advisory_xact_lock(") || normalized.startsWith("SELECT id FROM leader_goals WHERE chat_id=$1")) return this.result([]);
    if (normalized === "SELECT * FROM leader_notifications ORDER BY id FOR UPDATE") return this.result([]);
    if (/^(CREATE (UNIQUE )?(TABLE|INDEX)|ALTER TABLE|DELETE FROM node_sessions|UPDATE commands)/.test(normalized)) {
      return this.result([]);
    }
    if (normalized.startsWith("INSERT INTO leader_executions")) {
      const execution = JSON.parse(params[4] as string) as ExecutionRecord;
      if (this.rows.has(execution.id) || [...this.rows.values()].some(row => row.chat_id === execution.chatId && row.status === "active")) {
        return this.result([]);
      }
      const row = this.row(execution);
      this.rows.set(row.id, row);
      return this.result([row]);
    }
    if (normalized.startsWith("SELECT * FROM leader_executions WHERE id=$1")) {
      const row = this.rows.get(params[0] as string);
      return this.result(row ? [row] : []);
    }
    if (normalized.startsWith("SELECT * FROM leader_executions WHERE chat_id=$1")) {
      return this.result([...this.rows.values()].filter(row => row.chat_id === params[0])
        .sort((a, b) => Number(b.status === "active") - Number(a.status === "active") ||
          Number(b.created_at) - Number(a.created_at) || (a.id < b.id ? 1 : -1)).slice(0, 1));
    }
    if (normalized.startsWith("SELECT * FROM leader_executions WHERE chat_id=ANY($1::text[])")) {
      expect(normalized).toContain("ORDER BY (status='active') DESC, created_at DESC, id DESC LIMIT $2");
      return this.result([...this.rows.values()].filter(row => (params[0] as string[]).includes(row.chat_id))
        .sort((a, b) => Number(b.status === "active") - Number(a.status === "active") ||
          Number(b.created_at) - Number(a.created_at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).slice(0, params[1] as number));
    }
    if (normalized.startsWith("SELECT * FROM leader_executions WHERE status='active'")) {
      return this.result([...this.rows.values()].filter(row => row.status === "active" && row.id > (params[0] as string))
        .sort((a, b) => a.id < b.id ? -1 : 1).slice(0, params[1] as number));
    }
    throw new Error(`Unexpected SQL: ${normalized}`);
  }
  async connect() {
    let staged: Row | undefined;
    let unlock: (() => void) | undefined;
    return {
      query: async (sql: string, params: unknown[] = []) => {
        const normalized = sql.replace(/\s+/g, " ").trim();
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(normalized)) {
          this.queries.push(normalized);
          if (normalized === "COMMIT" && staged) this.rows.set(staged.id, staged);
          if (normalized !== "BEGIN") { staged = undefined; unlock?.(); unlock = undefined; }
          return this.result([]);
        }
        if ((normalized.endsWith("FOR UPDATE") || normalized.startsWith("SELECT pg_advisory_xact_lock(")) && !unlock) {
          const previous = this.lockTail;
          this.lockTail = new Promise<void>(resolve => { unlock = resolve; });
          await previous;
          return this.query(sql, params);
        }
        if (normalized.startsWith("INSERT INTO leader_executions")) {
          this.queries.push(normalized);
          const input = JSON.parse(params[4] as string) as ExecutionRecord;
          if (this.rows.has(input.id) || [...this.rows.values()].some(row => row.chat_id === input.chatId && row.status === "active")) return this.result([]);
          staged = this.row(input);
          return this.result([staged]);
        }
        if (normalized.startsWith("UPDATE leader_executions")) {
          this.queries.push(normalized);
          if (this.failUpdate) throw new Error("Simulated execution update failure");
          const current = this.rows.get(params[0] as string);
          if (!current || current.revision !== String(params[4])) return this.result([]);
          staged = this.row(JSON.parse(params[3] as string) as ExecutionRecord);
          const returned = structuredClone(staged);
          if (this.corruptUpdate) returned.revision = "999";
          return this.result([returned]);
        }
        if (normalized.startsWith("INSERT INTO leader_notifications")) {
          this.queries.push(normalized);
          return this.result([]);
        }
        return this.query(sql, params);
      },
      release: () => { this.released++; },
    };
  }
  async end() {}
}

function postgres(): { store: PostgresStore; pool: FakeExecutionPool } {
  const pool = new FakeExecutionPool();
  vi.mocked(pg.Pool).mockImplementation(function () { return pool as unknown as pg.Pool; });
  return { store: new PostgresStore("postgresql://unused/execution-tests"), pool };
}

for (const [name, factory] of [
  ["memory", () => new MemoryStore()], ["postgres SQL", () => postgres().store],
] as const) {
  describe(`${name} execution boundaries`, () => {
    it("returns null for absent records", async () => {
      const store = factory();
      expect(await store.getExecution(uuid(1))).toBeNull();
      expect(await store.getLatestExecution("chat")).toBeNull();
      expect((await store.createExecutionIfAbsent(record())).created).toBe(true);
    });

    it("deduplicates concurrent identical creation without resetting authorization or claims", async () => {
      const store = factory();
      const original = record();
      const results = await Promise.all(Array.from({ length: 8 }, () => store.createExecutionIfAbsent(original)));
      expect(results.filter(result => result.created)).toHaveLength(1);
      const claimed = claim(original);
      await store.compareAndSetExecution(claimed, 1);
      const retry = await store.createExecutionIfAbsent(record(1, "chat", NOW + 100));
      expect(retry).toEqual({ created: false, execution: claimed });
    });

    it("rejects reused IDs with different chat or plan and accepts only unclaimed revision one", async () => {
      const store = factory();
      const original = record();
      await store.createExecutionIfAbsent(original);
      await expect(store.createExecutionIfAbsent(record(1, "other"))).rejects.toBeInstanceOf(ConflictError);
      const differentPlan = record();
      differentPlan.plan.actions[0].prompt = "changed";
      await expect(store.createExecutionIfAbsent(differentPlan)).rejects.toBeInstanceOf(ConflictError);
      for (const invalid of [updated(record(2)), { ...record(2), status: "completed" as const },
        { ...claim(record(2)), revision: 1 }]) {
        await expect(store.createExecutionIfAbsent(invalid)).rejects.toThrow();
      }
      expect(await store.getExecution(original.id)).toEqual(original);
    });

    it("allows only one active execution per chat even during concurrent creation", async () => {
      const store = factory();
      const results = await Promise.allSettled([1, 2, 3].map(index => store.createExecutionIfAbsent(record(index))));
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      for (const result of results) if (result.status === "rejected") expect(result.reason).toBeInstanceOf(ConflictError);
      expect((await store.createExecutionIfAbsent(record(4, "different"))).created).toBe(true);
    });

    it("has one CAS winner; stale, missing and terminal records cannot advance", async () => {
      const store = factory();
      const original = record();
      await store.createExecutionIfAbsent(original);
      const claimed = claim(original);
      const results = await Promise.all(Array.from({ length: 8 }, () => store.compareAndSetExecution(claimed, 1)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await store.compareAndSetExecution(updated(record(99)), 1)).toBeNull();
      expect(await store.compareAndSetExecution(claimed, 1)).toBeNull();
      const terminal = updated(claimed, { status: "cancelled" });
      expect(await store.compareAndSetExecution(terminal, 2)).toEqual(terminal);
      expect(await store.compareAndSetExecution(updated(terminal, { status: "active" }), 3)).toBeNull();
      expect((await store.createExecutionIfAbsent(original)).execution).toEqual(terminal);
      await expect(store.compareAndSetExecution(updated(original), -1)).rejects.toThrow();
      await expect(store.compareAndSetExecution(updated(original), 1.5)).rejects.toThrow();
      await expect(store.compareAndSetExecution(original, 1)).rejects.toThrow();
    });

    it("rejects immutable changes without changing stored state", async () => {
      const store = factory();
      const original = record();
      await store.createExecutionIfAbsent(original);
      const changedPlan = structuredClone(original.plan);
      changedPlan.actions[0].prompt = "changed";
      for (const patch of [{ chatId: "other" }, { plan: changedPlan },
        { createdAt: NOW + 1 }, { expiresAt: original.expiresAt - 1 }]) {
        await expect(store.compareAndSetExecution(updated(original, patch), 1)).rejects.toThrow();
        expect(await store.getExecution(original.id)).toEqual(original);
      }
    });

    it("does not resurrect any terminal status and allows a new confirmed plan", async () => {
      const store = factory();
      for (const [index, status] of (["completed", "failed", "cancelled", "expired"] as const).entries()) {
        const original = record(index + 1);
        await store.createExecutionIfAbsent(original);
        const terminal = updated(original, { status });
        await store.compareAndSetExecution(terminal, 1);
        expect(await store.compareAndSetExecution(updated(terminal), 2)).toBeNull();
        expect((await store.createExecutionIfAbsent(original)).execution).toEqual(terminal);
      }
    });

    it("makes attempt identity permanent while permitting later step claims", async () => {
      const store = factory();
      const original = record();
      await store.createExecutionIfAbsent(original);
      const claimed = claim(original);
      await store.compareAndSetExecution(claimed, 1);
      for (const attempt of [null, { ...claimed.attempts[0]!, token: uuid(101) },
        { ...claimed.attempts[0]!, startedAt: NOW + 1 }, { ...claimed.attempts[0]!, expiresAt: NOW + 100 }]) {
        const next = updated(claimed);
        next.attempts[0] = attempt;
        await expect(store.compareAndSetExecution(next, 2)).rejects.toThrow();
      }
      const second = updated(claimed);
      second.attempts[1] = { token: uuid(102), startedAt: NOW + 1, expiresAt: NOW + EXECUTION_CLAIM_MS };
      expect(await store.compareAndSetExecution(second, 2)).toEqual(second);
    });

    it("selects active first, then creation time and ID, and permits replacement after termination", async () => {
      const store = factory();
      for (const index of [1, 2, 3]) {
        const original = record(index, "chat", NOW + (index === 1 ? 100 : 200));
        await store.createExecutionIfAbsent(original);
        await store.compareAndSetExecution(updated(original, { status: "completed" }), 1);
      }
      expect((await store.getLatestExecution("chat"))?.id).toBe(uuid(3));
      const active = record(4, "chat", NOW);
      await store.createExecutionIfAbsent(active);
      expect(await store.getLatestExecution("chat")).toEqual(active);
    });

    it("paginates active IDs exclusively, in ascending order, with bounded limits", async () => {
      const store = factory();
      for (const index of [3, 1, 4, 2]) await store.createExecutionIfAbsent(record(index, `chat-${index}`));
      await store.compareAndSetExecution(updated(record(2, "chat-2"), { status: "expired" }), 1);
      const first = await store.listActiveExecutions(2);
      expect(first.map(item => item.id)).toEqual([uuid(1), uuid(3)]);
      expect((await store.listActiveExecutions(2, first[1].id)).map(item => item.id)).toEqual([uuid(4)]);
      expect(await store.listActiveExecutions(2, uuid(4))).toEqual([]);
      for (const limit of [0, -1, 65, 1.5, NaN, Infinity]) await expect(store.listActiveExecutions(limit)).rejects.toThrow();
      expect(await store.listActiveExecutions()).toHaveLength(3);
    });

    it("isolates nested mutation of inputs and every returned record", async () => {
      const store = factory();
      const original = record();
      const expected = structuredClone(original);
      const created = await store.createExecutionIfAbsent(original);
      original.plan.actions[0].prompt = "mutated input";
      created.execution.plan.actions[0].dependsOn.push(4);
      const duplicate = await store.createExecutionIfAbsent(expected);
      const get = await store.getExecution(expected.id);
      const latest = await store.getLatestExecution(expected.chatId);
      const list = await store.listActiveExecutions();
      for (const result of [duplicate.execution, get!, latest!, list[0]]) result.plan.actions[0].prompt = "mutated output";
      expect(await store.getExecution(expected.id)).toEqual(expected);
      const next = claim(expected);
      const result = await store.compareAndSetExecution(next, 1);
      const claimed = structuredClone(result);
      next.attempts[0]!.token = uuid(200);
      result!.attempts[0]!.token = uuid(201);
      expect(await store.getExecution(expected.id)).toEqual(claimed);
    });

    it("filters authorized chats before recent limit, sorts active/time/ID and clones validated results", async () => {
      const store = factory();
      for (const index of [1, 3, 2, 4, 5]) {
        const execution = record(index, index === 5 ? "forbidden" : `chat-${index}`, NOW + (index === 1 ? 1 : index === 4 ? 4 : 2));
        await store.createExecutionIfAbsent(execution);
        if (index !== 1 && index !== 5) await store.compareAndSetExecution(updated(execution, { status: "completed" }), 1);
      }
      const allowed = ["chat-1", "chat-2", "chat-3", "chat-4", "chat-4"];
      const results = await store.listRecentExecutions(allowed, 3);
      expect(results.map(item => item.id)).toEqual([uuid(1), uuid(4), uuid(3)]);
      results[0].plan.actions[0].prompt = "output mutation";
      expect((await store.listRecentExecutions(allowed, 1))[0].plan.actions[0].prompt).toBe("first task");
      expect(await store.listRecentExecutions([], 3)).toEqual([]);
      for (const limit of [0, 65, 1.5, NaN, Infinity]) await expect(store.listRecentExecutions(allowed, limit)).rejects.toThrow();
      for (const chatIds of [[""], [" chat"], ["chat\u0000"], ["a".repeat(65)]]) {
        await expect(store.listRecentExecutions(chatIds, 1)).rejects.toThrow();
      }
    });
  });
}

describe("postgres execution transaction safety", () => {
  it("preserves executions at startup and retains legacy command recovery", async () => {
    const { store, pool } = postgres();
    const original = record();
    await store.createExecutionIfAbsent(original);
    await store.init();
    expect(await store.getExecution(original.id)).toEqual(original);
    expect(pool.queries.some(sql => sql.includes("CREATE UNIQUE INDEX") && sql.includes("leader_executions") && sql.includes("WHERE status='active'"))).toBe(true);
    expect(pool.queries.some(sql => sql.includes('id VARCHAR(36) COLLATE "C"'))).toBe(true);
    expect(pool.queries.some(sql => sql.startsWith("DELETE FROM node_sessions"))).toBe(true);
    expect(pool.queries.some(sql => sql.startsWith("UPDATE commands") && sql.includes("status = 'uncertain'"))).toBe(true);
    expect(pool.queries.some(sql => sql.startsWith("DELETE FROM leader_executions"))).toBe(false);
    expect(pool.released).toBe(2);
  });

  it("rolls back and releases clients on validation, SQL or row-decoding failure", async () => {
    const { store, pool } = postgres();
    const original = record();
    await store.createExecutionIfAbsent(original);
    pool.queries.length = 0;
    pool.released = 0;
    await expect(store.compareAndSetExecution(updated(original, { chatId: "different" }), 1)).rejects.toThrow();
    pool.failUpdate = true;
    await expect(store.compareAndSetExecution(claim(original), 1)).rejects.toThrow("Simulated execution update failure");
    pool.failUpdate = false;
    pool.corruptUpdate = true;
    await expect(store.compareAndSetExecution(claim(original), 1)).rejects.toThrow("metadata");
    expect(await store.getExecution(original.id)).toEqual(original);
    expect(pool.queries.filter(sql => sql === "ROLLBACK")).toHaveLength(3);
    expect(pool.queries.filter(sql => sql === "COMMIT")).toHaveLength(0);
    expect(pool.released).toBe(3);
    pool.corruptUpdate = false;
    expect(await store.compareAndSetExecution(claim(original), 1)).toEqual(claim(original));
  });

  it("refuses inconsistent stored metadata instead of trusting duplicated JSON", async () => {
    const { store, pool } = postgres();
    const original = record();
    await store.createExecutionIfAbsent(original);
    pool.rows.get(original.id)!.chat_id = "corrupt";
    await expect(store.getExecution(original.id)).rejects.toThrow("metadata");
    await expect(store.listRecentExecutions(["corrupt"], 13)).rejects.toThrow("metadata");
  });
});

it("keeps chat state revisions independent from execution ownership", async () => {
  const store = new MemoryStore();
  await store.compareAndSetLeaderState("chat", 0, { pending: "unrelated" });
  const original = record();
  await store.createExecutionIfAbsent(original);
  await store.compareAndSetExecution(claim(original), 1);
  expect((await store.getLeaderState("chat"))?.revision).toBe(1);
  await store.compareAndSetLeaderState("chat", 1, { pending: "another" });
  expect(await store.getExecution(original.id)).toEqual(claim(original));
});
