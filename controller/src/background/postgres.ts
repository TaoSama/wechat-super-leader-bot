import type pg from "pg";
import { assertSameBackgroundCreation, backgroundSpecFingerprint } from "./retention.js";
import type { BackgroundRepository, BackgroundWorker } from "./contracts.js";

type Queryable = Pick<pg.PoolClient, "query">;
export async function initBackgroundTables(client: Queryable): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS background_workers (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, chat_id TEXT NOT NULL,
    state TEXT NOT NULL, updated_at BIGINT NOT NULL, data JSONB NOT NULL);
    CREATE INDEX IF NOT EXISTS background_workers_live ON background_workers(updated_at) WHERE state <> 'cleaned'`);
}
export class PostgresBackgroundRepository implements BackgroundRepository {
  constructor(private readonly pool: pg.Pool) {}
  async create(worker: BackgroundWorker): Promise<BackgroundWorker> {
    worker = { ...worker, specFingerprint: backgroundSpecFingerprint(worker.spec) };
    await this.pool.query(`INSERT INTO background_workers(id,run_id,chat_id,state,updated_at,data)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(run_id) DO NOTHING`,
      [worker.id, worker.runId, worker.chatId, worker.phase, worker.updatedAt, worker]);
    const saved = await this.getByRun(worker.runId);
    if (!saved) throw new Error("Background run creation did not persist");
    assertSameBackgroundCreation(saved, worker);
    return saved;
  }
  async get(id: string): Promise<BackgroundWorker | null> {
    const result = await this.pool.query<{ data: BackgroundWorker }>("SELECT data FROM background_workers WHERE id=$1", [id]);
    return result.rows[0]?.data ?? null;
  }
  async getByRun(runId: string): Promise<BackgroundWorker | null> {
    const result = await this.pool.query<{ data: BackgroundWorker }>("SELECT data FROM background_workers WHERE run_id=$1", [runId]);
    return result.rows[0]?.data ?? null;
  }
  async list(chatId: string, limit = 100): Promise<BackgroundWorker[]> {
    const result = await this.pool.query<{ data: BackgroundWorker }>("SELECT data FROM background_workers WHERE chat_id=$1 ORDER BY (data->>'createdAt')::bigint DESC LIMIT $2", [chatId, limit]);
    return result.rows.map(item => item.data);
  }
  async listLive(limit = 100): Promise<BackgroundWorker[]> {
    const result = await this.pool.query<{ data: BackgroundWorker }>("SELECT data FROM background_workers WHERE state <> 'cleaned' ORDER BY updated_at LIMIT $1", [limit]);
    return result.rows.map(item => item.data);
  }
  async update(id: string, mutate: (worker: BackgroundWorker) => void): Promise<BackgroundWorker | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ data: BackgroundWorker }>("SELECT data FROM background_workers WHERE id=$1 FOR UPDATE", [id]);
      const worker = result.rows[0]?.data;
      if (worker) {
        mutate(worker);
        await client.query("UPDATE background_workers SET state=$2,updated_at=$3,data=$4 WHERE id=$1", [id, worker.phase, worker.updatedAt, worker]);
      }
      await client.query("COMMIT");
      return worker ?? null;
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "Background transaction and rollback failed"); }
      throw error;
    } finally { client.release(); }
  }
}
