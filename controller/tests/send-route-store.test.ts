import { describe, expect, it, vi } from "vitest";
import pg from "pg";
import { MemoryStore } from "../src/store/memory.js";
import { PostgresStore } from "../src/store/postgres.js";
import type { CommandRecord } from "../src/types.js";

vi.mock("pg", () => ({ default: { Pool: vi.fn() } }));
type Row = Record<string, unknown>;
class FakeCommandPool {
  rows = new Map<string, Row>();
  statements: string[] = [];
  async query(raw: string, params: unknown[] = []) {
    const sql = raw.replace(/\s+/g, " ").trim();
    this.statements.push(sql);
    if (sql.startsWith("INSERT INTO commands")) {
      if ([...this.rows.values()].some(row => row.request_id === params[1])) return { rows: [] };
      const fields = ["command_id", "request_id", "node_id", "session_id", "action", "prompt", "status", "output", "error",
        "expires_at", "created_at", "updated_at", "skills", "turn_id", "send_route"];
      const row = Object.fromEntries(fields.map((field, index) => [field, params[index]]));
      row.skills = JSON.parse(row.skills as string);
      this.rows.set(row.command_id as string, row);
      return { rows: [structuredClone(row)] };
    }
    if (sql.startsWith("SELECT * FROM commands WHERE")) {
      const row = sql.includes("request_id") ? [...this.rows.values()].find(row => row.request_id === params[0]) : this.rows.get(params[0] as string);
      return { rows: row ? [structuredClone(row)] : [] };
    }
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.startsWith("CREATE TABLE") || sql.startsWith("ALTER TABLE") ||
        sql.startsWith("CREATE INDEX") || sql.startsWith("CREATE UNIQUE INDEX") || sql.startsWith("DELETE FROM node_sessions") || sql.startsWith("UPDATE commands")) return { rows: [] };
    throw new Error(`Unexpected fixture SQL: ${sql}`);
  }
  async connect() { return { query: this.query.bind(this), release: () => {} }; }
  async end() {}
}
const command = (overrides: Partial<CommandRecord> = {}): CommandRecord => ({
  commandId: "cmd", requestId: "req", nodeId: "node", sessionId: "session", action: "send", prompt: "fixture",
  sendRoute: "desktop-owner", status: "pending", createdAt: "2026-10-11T00:00:00.000Z",
  updatedAt: "2026-10-11T00:00:00.000Z", expiresAt: "2026-10-11T00:01:00.000Z", ...overrides,
});
function fixture(kind: string) {
  const pool = new FakeCommandPool();
  vi.mocked(pg.Pool).mockImplementation(function () { return pool as unknown as pg.Pool; });
  return { pool, store: kind === "memory" ? new MemoryStore() : new PostgresStore("postgresql://unused/test") };
}

describe.each(["memory", "postgres"])("%s send route persistence", kind => {
  it.each([undefined, "", "recorded result"])("preserves output presence on insert, lookup and deduplication: %j", async output => {
    const { store } = fixture(kind);
    const record = command({ status: "completed", turnId: "turn", output });
    expect((await store.createCommandIfAbsent(record)).command.output).toBe(output);
    expect((await store.getCommand("cmd"))?.output).toBe(output);
    expect((await store.findCommandByRequestId("req"))?.output).toBe(output);
    const repeated = await store.createCommandIfAbsent({ ...record, commandId: "duplicate", output: "late replacement" });
    expect(repeated.created).toBe(false);
    expect(repeated.command.output).toBe(output);
  });

  it("roundtrips and clones both fixed routes and preserves the first route on request deduplication", async () => {
    const { store } = fixture(kind);
    const created = await store.createCommandIfAbsent(command());
    created.command.sendRoute = "control-socket";
    expect((await store.getCommand("cmd"))?.sendRoute).toBe("desktop-owner");
    const duplicate = await store.createCommandIfAbsent(command({ commandId: "other", sendRoute: "control-socket" }));
    expect(duplicate.created).toBe(false);
    expect(duplicate.command.sendRoute).toBe("desktop-owner");
    await store.createCommandIfAbsent(command({ commandId: "native", requestId: "native", sendRoute: "control-socket" }));
    expect((await store.findCommandByRequestId("native"))?.sendRoute).toBe("control-socket");
  });

  it("keeps historical unbound sends readable and rejects read or invalid route binding", async () => {
    const { store } = fixture(kind);
    await store.createCommandIfAbsent(command({ sendRoute: undefined }));
    expect((await store.getCommand("cmd"))?.sendRoute).toBeUndefined();
    await expect(store.createCommandIfAbsent(command({ action: "read", commandId: "read", requestId: "read" }))).rejects.toThrow("Read commands");
    await expect(store.createCommandIfAbsent(command({ sendRoute: "invalid" as CommandRecord["sendRoute"] }))).rejects.toThrow();
  });
});

it("adds only a nullable route column without dropping command history and preserves null or historical empty routes", async () => {
  const { store, pool } = fixture("postgres");
  await store.init();
  expect(pool.statements).toContain("ALTER TABLE commands ADD COLUMN IF NOT EXISTS send_route VARCHAR(32)");
  expect(pool.statements.some(sql => /(?:DROP|TRUNCATE|DELETE FROM) commands/i.test(sql))).toBe(false);
  await store.createCommandIfAbsent(command());
  for (const route of [null, "", undefined]) {
    pool.rows.get("cmd")!.send_route = route;
    expect((await store.getCommand("cmd"))?.sendRoute).toBeUndefined();
  }
  pool.rows.get("cmd")!.send_route = "unknown";
  await expect(store.getCommand("cmd")).rejects.toThrow();
});
