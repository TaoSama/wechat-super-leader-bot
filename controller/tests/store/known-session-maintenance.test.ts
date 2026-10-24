import pg from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { PostgresStore } from "../../src/store/postgres.js";

vi.mock("pg", () => ({ default: { Pool: vi.fn() } }));

class SingleConnectionPool {
  active = false;
  waiting: Array<(client: pg.PoolClient) => void> = [];
  statements: string[] = [];
  readFailure?: Error;
  on = vi.fn();

  connect(): Promise<pg.PoolClient> {
    if (this.active) return new Promise(resolve => this.waiting.push(resolve));
    this.active = true;
    return Promise.resolve(this.client());
  }

  async query(sql: string, values?: unknown[]) {
    const client = await this.connect();
    try { return await client.query(sql, values); }
    finally { client.release(); }
  }

  private client(): pg.PoolClient {
    return {
      query: async (sql: string) => {
        this.statements.push(sql);
        if (sql.includes("SELECT k.data") && this.readFailure) {
          const error = this.readFailure; this.readFailure = undefined; throw error;
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => {
        const next = this.waiting.shift();
        if (next) next(this.client());
        else this.active = false;
      },
    } as unknown as pg.PoolClient;
  }
}

function fixture() {
  const pool = new SingleConnectionPool();
  vi.mocked(pg.Pool).mockImplementation(function () { return pool as unknown as pg.Pool; });
  return { pool, store: new PostgresStore("postgresql://unused/single-connection-maintenance") };
}

afterEach(() => vi.restoreAllMocks());

it("lets an observation read and write share a one-client pool without blocking the maintenance queue", async () => {
  const { pool, store } = fixture();
  const operations = Promise.all([store.getKnownSession("node", "known"), store.upsertNodeSessions("other", [])]);
  await expect(operations).resolves.toEqual([null, undefined]);
  expect(pool.active).toBe(false);
  expect(pool.waiting).toEqual([]);
  expect(pool.statements).toContain("COMMIT");
});

it("releases the client and advances maintenance after a failed identity read", async () => {
  const { pool, store } = fixture(), error = new Error("synthetic identity lookup failure");
  pool.readFailure = error;
  const outcomes = await Promise.allSettled([store.getKnownSession("node", "known"), store.removeNodeSessions("other")]);
  expect(outcomes).toEqual([{ status: "rejected", reason: error }, { status: "fulfilled", value: undefined }]);
  expect(pool.active).toBe(false);
  expect(pool.waiting).toEqual([]);
  expect(await store.getKnownSession("node", "known")).toBeNull();
});
