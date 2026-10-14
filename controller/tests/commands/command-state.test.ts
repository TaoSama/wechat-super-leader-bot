import { describe, expect, it, vi } from "vitest";
import pg from "pg";
import { nextCommandState } from "../../src/store/command-state.js";
import { ConflictError, IStore } from "../../src/store/interface.js";
import { MemoryStore } from "../../src/store/memory.js";
import { PostgresStore } from "../../src/store/postgres.js";
import { CommandRecord } from "../../src/types.js";

vi.mock("pg", () => ({ default: { Pool: vi.fn() } }));

const command = (action: CommandRecord["action"] = "send", id = "command"): CommandRecord => ({
  commandId: id, requestId: id, nodeId: "node", sessionId: "session", action, status: "pending",
  prompt: action === "send" ? "fixture" : undefined, createdAt: "2026-10-11T01:00:00.000Z",
  updatedAt: "2026-10-11T01:00:00.000Z", expiresAt: "2026-10-11T01:05:00.000Z",
});
type Row = Record<string, unknown>;
function row(record: CommandRecord): Row {
  return { command_id: record.commandId, request_id: record.requestId, node_id: record.nodeId,
    session_id: record.sessionId, action: record.action, status: record.status, prompt: record.prompt,
    output: record.output, error: record.error, turn_id: record.turnId, skills: [],
    created_at: record.createdAt, updated_at: record.updatedAt, expires_at: record.expiresAt };
}

/** Exercises the actual PG mutation path without a live database or credentials. */
class TransactionPool {
  rows = new Map<string, Row>();
  statements: string[] = [];
  release = vi.fn();
  private staged?: Map<string, Row>;
  query = async (sql: string, params: unknown[] = []) => {
    const statement = sql.replace(/\s+/g, " ").trim();
    this.statements.push(statement);
    if (statement === "BEGIN") { this.staged = structuredClone(this.rows); return { rows: [] }; }
    if (statement === "ROLLBACK") { this.staged = undefined; return { rows: [] }; }
    if (statement === "COMMIT") {
      if (this.staged) this.rows = this.staged;
      this.staged = undefined;
      return { rows: [] };
    }
    if (statement.startsWith("SELECT * FROM commands WHERE command_id = $1")) {
      const record = (this.staged ?? this.rows).get(params[0] as string);
      return { rows: record ? [structuredClone(record)] : [] };
    }
    if (statement.startsWith("UPDATE commands SET status=$1")) {
      if (!this.staged) throw new Error("PG update was not in a transaction");
      const existing = this.staged.get(params[5] as string);
      if (!existing) throw new Error("PG update did not find the locked record");
      this.staged.set(params[5] as string, { ...existing, status: params[0], output: params[1],
        error: params[2], turn_id: params[3], updated_at: params[4] });
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL in fixture: ${statement}`);
  };
  async connect() { return { query: this.query, release: this.release }; }
}

async function fixture(kind: string, record = command()): Promise<{ store: IStore; pool?: TransactionPool }> {
  if (kind === "memory") {
    const store = new MemoryStore();
    await store.createCommandIfAbsent(record);
    return { store };
  }
  const pool = new TransactionPool();
  pool.rows.set(record.commandId, row(record));
  vi.mocked(pg.Pool).mockImplementation(function () { return pool as unknown as pg.Pool; });
  return { store: new PostgresStore("postgresql://unused/test"), pool };
}

describe.each(["memory", "postgres"])("%s shared command state boundary", kind => {
  it.each([undefined, "", "final"])("does not substitute acceptance output for completed output: %j", async output => {
    const { store } = await fixture(kind);
    await store.updateCommandStatus("command", "accepted", "not a final result", undefined, "turn");
    await store.updateCommandStatus("command", "completed", output, undefined, "turn");
    expect((await store.getCommand("command"))?.output).toBe(output);
    await store.updateCommandStatus("command", "completed", "late result", undefined, "turn");
    expect((await store.getCommand("command"))?.output).toBe(output);
  });

  it("rejects missing, malformed and unbound completion IDs without modifying storage", async () => {
    const { store, pool } = await fixture(kind);
    const initial = await store.getCommand("command");
    const attempts: [CommandRecord["status"], string?][] = [
      ["accepted"], ["completed"], ["completed", "valid-but-not-yet-bound"], ["failed", "unbound"], ["uncertain", "unbound"],
      ...["", "space id", "control\u0000", "control\u0085", "turn\ufffd", "x".repeat(129), "é".repeat(65)]
        .map(turnId => ["accepted", turnId] as [CommandRecord["status"], string]),
    ];
    for (const [status, turnId] of attempts) {
      await expect(store.updateCommandStatus("command", status, "invalid output", "invalid error", turnId)).rejects.toBeInstanceOf(ConflictError);
      expect(await store.getCommand("command")).toEqual(initial);
    }
    if (pool) {
      expect(pool.statements.filter(sql => sql === "ROLLBACK")).toHaveLength(attempts.length);
      expect(pool.statements.some(sql => sql.startsWith("UPDATE"))).toBe(false);
      expect(pool.statements.filter(sql => sql.endsWith("FOR UPDATE"))).toHaveLength(attempts.length);
      expect(pool.release).toHaveBeenCalledTimes(attempts.length);
    }
  });

  it("binds once, requires exact terminal correlation, preserves the binding through uncertainty", async () => {
    const { store } = await fixture(kind);
    await store.updateCommandStatus("command", "accepted", "received", undefined, "turn");
    const accepted = await store.getCommand("command");
    for (const status of ["accepted", "completed", "failed"] as const) {
      await expect(store.updateCommandStatus("command", status)).rejects.toBeInstanceOf(ConflictError);
    }
    for (const status of ["accepted", "completed", "failed", "uncertain"] as const) {
      await expect(store.updateCommandStatus("command", status, "wrong", undefined, "other-turn")).rejects.toBeInstanceOf(ConflictError);
    }
    expect(await store.getCommand("command")).toEqual(accepted);
    await store.updateCommandStatus("command", "uncertain", undefined, "transport lost");
    expect(await store.getCommand("command")).toMatchObject({ status: "uncertain", turnId: "turn" });
    await store.updateCommandStatus("command", "completed", "final", undefined, "turn");
    const terminal = await store.getCommand("command");
    expect(terminal).toMatchObject({ status: "completed", output: "final", turnId: "turn" });
    expect(terminal?.error).toBeUndefined();
    for (const status of ["accepted", "completed", "failed"] as const) {
      await store.updateCommandStatus("command", status, "late output", "late error", "turn");
      expect(await store.getCommand("command")).toEqual(terminal);
    }
    await store.updateCommandStatus("command", "uncertain");
    expect(await store.getCommand("command")).toEqual(terminal);
    await expect(store.updateCommandStatus("command", "completed")).rejects.toBeInstanceOf(ConflictError);
  });

  it("accepts ID-less preflight failure/uncertainty but never binds a failed terminal command", async () => {
    const { store } = await fixture(kind);
    await store.updateCommandStatus("command", "uncertain", undefined, "no confirmed acceptance");
    expect(await store.getCommand("command")).toMatchObject({ status: "uncertain" });
    await store.updateCommandStatus("command", "failed", undefined, "preflight rejected");
    const terminal = await store.getCommand("command");
    await expect(store.updateCommandStatus("command", "accepted", undefined, undefined, "late-turn")).rejects.toBeInstanceOf(ConflictError);
    await store.updateCommandStatus("command", "uncertain");
    expect(await store.getCommand("command")).toEqual(terminal);
  });

  it("allows read completion without a turn and rejects accepted or any turn binding", async () => {
    const { store } = await fixture(kind, command("read"));
    for (const [status, turnId] of [["accepted", undefined], ["accepted", "turn"], ["completed", "turn"],
      ["failed", "turn"], ["uncertain", "turn"]] as const) {
      await expect(store.updateCommandStatus("command", status, undefined, undefined, turnId)).rejects.toBeInstanceOf(ConflictError);
    }
    expect((await store.getCommand("command"))?.status).toBe("pending");
    await store.updateCommandStatus("command", "completed", "read output");
    expect(await store.getCommand("command")).toMatchObject({ status: "completed", output: "read output" });
    await expect(store.updateCommandStatus("command", "accepted", undefined, undefined, "turn")).rejects.toBeInstanceOf(ConflictError);
  });
});

it("returns the identical terminal object for legal idempotent receipts and never mutates the input", () => {
  const initial = command();
  const accepted = nextCommandState(initial, "accepted", "received", undefined, "é".repeat(64));
  expect(initial).toEqual(command());
  const completed = nextCommandState(accepted, "completed", "final", undefined, accepted.turnId);
  expect(nextCommandState(completed, "completed", "duplicate", undefined, accepted.turnId)).toBe(completed);
  expect(nextCommandState(completed, "accepted", "late", undefined, accepted.turnId)).toBe(completed);
  expect(() => nextCommandState(completed, "accepted", "invalid", undefined, "other")).toThrow(ConflictError);
});
