import { EventEmitter } from "node:events";
import pg from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { PostgresStore } from "../../src/store/postgres.js";

class OfflineClient extends EventEmitter {
  _queryable = true;
  _ending = false;
  queryError?: Error;
  connect(callback: () => void) { queueMicrotask(callback); }
  query(_sql: string, _values: unknown[], callback: (error?: Error, result?: { rows: unknown[] }) => void) {
    queueMicrotask(() => callback(this.queryError, { rows: [] }));
  }
  end = vi.fn((callback: () => void) => {
    this._ending = true;
    queueMicrotask(callback);
  });
}

const stores: PostgresStore[] = [];
function fixture() {
  const store = new PostgresStore("postgresql://unused/pool-error-test");
  stores.push(store);
  const pool = (store as unknown as { pool: pg.Pool & { Client: typeof OfflineClient } }).pool;
  pool.Client = OfflineClient;
  const clients: OfflineClient[] = [];
  pool.on("connect", client => clients.push(client as unknown as OfflineClient));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  return { store, pool, clients, log };
}

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  vi.restoreAllMocks();
});

it("handles a real pg-pool idle error and serves the next query with a replacement client", async () => {
  const { store, pool, clients, log } = fixture();
  expect(await store.getCommand("before-disconnect")).toBeNull();
  expect(pool.idleCount).toBe(1);
  const disconnected = clients[0];
  const error = new Error("synthetic idle disconnect with private connection details");

  expect(() => disconnected.emit("error", error)).not.toThrow();

  expect(disconnected.end).toHaveBeenCalledOnce();
  expect(pool.totalCount).toBe(0);
  expect(pool.idleCount).toBe(0);
  expect(log).toHaveBeenCalledExactlyOnceWith("PostgreSQL idle client connection failed; the pool removed the client");
  expect(await store.getCommand("after-disconnect")).toBeNull();
  expect(clients).toHaveLength(2);
  expect(pool.idleCount).toBe(1);
});

it("continues to reject query failures without reporting them as idle errors", async () => {
  const { store, pool, clients, log } = fixture();
  await store.getCommand("before-query-error");
  const error = new Error("synthetic query failure");
  clients[0].queryError = error;

  await expect(store.getCommand("failed-query")).rejects.toBe(error);

  expect(log).not.toHaveBeenCalled();
  expect(pool.totalCount).toBe(0);
  expect(await store.getCommand("after-query-error")).toBeNull();
  expect(clients).toHaveLength(2);
});
