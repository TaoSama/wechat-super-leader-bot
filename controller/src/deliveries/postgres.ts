import type pg from "pg";
import { MAX_CATCHUP_SOURCES, PREPARATION_LEASE_MS, assertSameResult, canSupersede, claimDelivery, deferDelivery, receiptDelivery, type DeliveryPlan, type DeliveryRepository, type StoredResultArtifact } from "./contracts.js";
import { CatchupConflictError, catchupSourcesValid } from "./catchup.js";

type Queryable = Pick<pg.PoolClient, "query">;
type PlanRow = { data: DeliveryPlan };

export async function initDeliveryTables(client: Queryable): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS result_artifacts (
    id UUID PRIMARY KEY, chat_id TEXT NOT NULL, expires_at BIGINT NOT NULL,
    metadata JSONB NOT NULL, bytes BYTEA NOT NULL
  )`);
  await client.query(`CREATE TABLE IF NOT EXISTS result_deliveries (
    id UUID PRIMARY KEY, result_key TEXT UNIQUE NOT NULL, chat_id TEXT NOT NULL,
    artifact_id UUID UNIQUE NOT NULL REFERENCES result_artifacts(id),
    created_at BIGINT NOT NULL, retained_until BIGINT NOT NULL, data JSONB NOT NULL
  )`);
  await client.query("CREATE INDEX IF NOT EXISTS result_deliveries_chat_created ON result_deliveries(chat_id, created_at DESC)");
  await client.query(`CREATE INDEX IF NOT EXISTS result_deliveries_maintenance ON result_deliveries(chat_id,id)
    WHERE data->>'status' IN ('preparing','waiting_for_user')`);
  await client.query(`CREATE TABLE IF NOT EXISTS result_resume_receipts (
    chat_id TEXT NOT NULL, generation TEXT NOT NULL, resumed INTEGER NOT NULL,
    PRIMARY KEY(chat_id,generation)
  )`);
}

export class PostgresDeliveryRepository implements DeliveryRepository {
  constructor(private readonly pool: pg.Pool) {}
  private async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "Delivery transaction and rollback failed"); }
      throw error;
    } finally { client.release(); }
  }
  async createIfAbsent(plan: DeliveryPlan, artifact: StoredResultArtifact, now = Date.now()): Promise<DeliveryPlan> {
    return this.transaction(async client => {
      const locks = [`key:${plan.key}`, `source:${plan.chatId}:${plan.source.type}:${plan.source.id}`,
        ...(plan.business?.supersedes ? [`business:${plan.chatId}:${plan.business.supersedes}`] : []),
        ...(plan.resumeGeneration ? [`resume:${plan.chatId}:${plan.resumeGeneration}`] : [])].sort();
      for (const lock of locks) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [lock]);
      if (plan.resumeGeneration) {
        const resumed = await client.query("SELECT resumed FROM result_resume_receipts WHERE chat_id=$1 AND generation=$2", [plan.chatId, plan.resumeGeneration]);
        if (resumed.rows.length) throw new CatchupConflictError();
      }
      const found = await client.query<PlanRow>("SELECT data FROM result_deliveries WHERE result_key=$1", [plan.key]);
      if (found.rows[0]) {
        assertSameResult(found.rows[0].data, plan);
        if (plan.resumeGeneration) await client.query("INSERT INTO result_resume_receipts(chat_id,generation,resumed) VALUES($1,$2,1)", [plan.chatId, plan.resumeGeneration]);
        return found.rows[0].data;
      }
      if (plan.catchupSourceIds) {
        const sources = await client.query<PlanRow>("SELECT data FROM result_deliveries WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [plan.catchupSourceIds]);
        if (!catchupSourcesValid(plan, sources.rows.map(row => row.data), now, false)) throw new CatchupConflictError();
        plan.status = "preparing";
        await client.query("UPDATE result_deliveries SET data=jsonb_set(data,'{catchupId}',to_jsonb($2::text)) WHERE id=ANY($1::uuid[])", [plan.catchupSourceIds, plan.id]);
      }
      const others = await client.query<PlanRow>(`SELECT data FROM result_deliveries WHERE chat_id=$1 AND
        ((data->'source'->>'type'=$2 AND data->'source'->>'id'=$3) OR ($4::text IS NOT NULL AND data->'business'->>'supersedes'=$4))
        ORDER BY id FOR UPDATE`, [plan.chatId, plan.source.type, plan.source.id, plan.business?.supersedes ?? null]);
      plan = structuredClone(plan);
      for (const { data: older } of others.rows) {
        if (canSupersede(older, plan)) await client.query("UPDATE result_deliveries SET data=jsonb_set(data,'{status}','\"superseded\"'::jsonb) WHERE id=$1", [older.id]);
        else if (canSupersede(plan, older)) plan.status = "superseded";
      }
      const { bytes, ...metadata } = artifact;
      await client.query("INSERT INTO result_artifacts(id,chat_id,expires_at,metadata,bytes) VALUES($1,$2,$3,$4::jsonb,$5)",
        [artifact.id, artifact.chatId, artifact.expiresAt, JSON.stringify(metadata), bytes]);
      await client.query(`INSERT INTO result_deliveries(id,result_key,chat_id,artifact_id,created_at,retained_until,data)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [plan.id, plan.key, plan.chatId, artifact.id, plan.createdAt, plan.retainedUntil, JSON.stringify(plan)]);
      if (plan.resumeGeneration) await client.query("INSERT INTO result_resume_receipts(chat_id,generation,resumed) VALUES($1,$2,1)", [plan.chatId, plan.resumeGeneration]);
      return plan;
    });
  }
  async get(id: string, now = Date.now()): Promise<DeliveryPlan | null> {
    const expired = await this.pool.query<PlanRow>(`UPDATE result_deliveries SET data=jsonb_set(data,'{status}','"uncertain"'::jsonb)
      WHERE id=$1 AND data->>'status'='claimed' AND (data->>'attemptExpiresAt')::bigint <= $2 RETURNING data`, [id, now]);
    if (expired.rows[0]) return expired.rows[0].data;
    const result = await this.pool.query<PlanRow>("SELECT data FROM result_deliveries WHERE id=$1", [id]);
    return result.rows[0]?.data ?? null;
  }
  async getByKey(key: string): Promise<DeliveryPlan | null> {
    const result = await this.pool.query<PlanRow>("SELECT data FROM result_deliveries WHERE result_key=$1", [key]);
    return result.rows[0]?.data ?? null;
  }
  async list(chatIds: readonly string[], limit = 100): Promise<DeliveryPlan[]> {
    const result = await this.pool.query<PlanRow>(`SELECT data FROM result_deliveries WHERE chat_id=ANY($1::text[])
      ORDER BY created_at DESC,id LIMIT $2`, [chatIds, Math.min(100, Math.max(0, limit))]);
    return result.rows.map(row => row.data);
  }
  async listMaintenance(chatIds: readonly string[], now: number, afterId?: string, limit = 20): Promise<DeliveryPlan[]> {
    const result = await this.pool.query<PlanRow>(`SELECT data FROM result_deliveries WHERE chat_id=ANY($1::text[])
      AND data->>'status' IN ('preparing','waiting_for_user') AND (data->>'expiresAt')::bigint > $2 AND retained_until > $2
      AND ($3::uuid IS NULL OR id > $3::uuid) ORDER BY id LIMIT $4`, [chatIds, now, afterId ?? null, Math.min(100, Math.max(0, limit))]);
    return result.rows.map(row => row.data);
  }
  async getArtifact(id: string): Promise<StoredResultArtifact | null> {
    const result = await this.pool.query<{ metadata: Omit<StoredResultArtifact, "bytes">; bytes: Buffer }>(
      "SELECT metadata,bytes FROM result_artifacts WHERE id=$1", [id]);
    return result.rows[0] ? { ...result.rows[0].metadata, bytes: result.rows[0].bytes } : null;
  }
  async listCatchupCandidates(chatId: string, now: number, limit = MAX_CATCHUP_SOURCES): Promise<DeliveryPlan[]> {
    const result = await this.pool.query<PlanRow>(`SELECT data FROM result_deliveries WHERE chat_id=$1 AND
      data->>'status'='waiting_for_user' AND data->>'kind'<>'progress' AND COALESCE((data->>'submittedMessages')::int,0)=0
      AND NOT data ? 'catchupId' AND (data->>'expiresAt')::bigint > $2 AND retained_until > $2 ORDER BY id LIMIT $3`,
      [chatId, now, Math.max(0, Math.min(MAX_CATCHUP_SOURCES, limit))]);
    return result.rows.map(row => row.data);
  }
  async listResumeCandidates(chatId: string, now: number, limit = MAX_CATCHUP_SOURCES): Promise<DeliveryPlan[]> {
    const result = await this.pool.query<PlanRow>(`SELECT data FROM result_deliveries WHERE chat_id=$1 AND
      data->>'status'='waiting_for_user' AND NOT data ? 'catchupId' AND (data->>'expiresAt')::bigint > $2 AND retained_until > $2 ORDER BY id LIMIT $3`,
      [chatId, now, Math.max(0, Math.min(MAX_CATCHUP_SOURCES, limit))]);
    return result.rows.map(row => row.data);
  }
  async getResumeRecord(chatId: string, generation: string): Promise<{ resumed: number } | null> {
    const result = await this.pool.query<{ resumed: number }>("SELECT resumed FROM result_resume_receipts WHERE chat_id=$1 AND generation=$2", [chatId, generation]);
    return result.rows[0] ?? null;
  }
  private async update(id: string, mutate: (plan: DeliveryPlan) => DeliveryPlan | null): Promise<DeliveryPlan | null> {
    return this.transaction(async client => {
      const result = await client.query<PlanRow>("SELECT data FROM result_deliveries WHERE id=$1 FOR UPDATE", [id]);
      if (!result.rows[0]) return null;
      const next = mutate(result.rows[0].data);
      if (!next) return null;
      await client.query("UPDATE result_deliveries SET data=$2::jsonb WHERE id=$1", [id, JSON.stringify(next)]);
      return next;
    });
  }
  async claimPreparation(id: string, token: string, now: number): Promise<DeliveryPlan | null> {
    return this.update(id, plan => {
      if (plan.status !== "preparing" || plan.retainedUntil <= now || (plan.preparation?.until ?? 0) > now) return null;
      delete plan.error;
      return { ...plan, preparation: { token, until: now + PREPARATION_LEASE_MS } };
    });
  }
  async finishPreparation(id: string, token: string, messages: string[], error?: string, now = Date.now()): Promise<DeliveryPlan | null> {
    return this.transaction(async client => {
      const result = await client.query<PlanRow>("SELECT data FROM result_deliveries WHERE id=$1 FOR UPDATE", [id]);
      const plan = result.rows[0]?.data;
      if (!plan) return null;
      if (plan.status !== "preparing" || plan.preparation?.token !== token) return null;
      delete plan.preparation;
      if (error) plan.error = error;
      else {
        let valid = true;
        if (plan.catchupSourceIds) {
          const sources = await client.query<PlanRow>("SELECT data FROM result_deliveries WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE", [plan.catchupSourceIds]);
          valid = catchupSourcesValid(plan, sources.rows.map(row => row.data), now, true);
          if (valid) await client.query("UPDATE result_deliveries SET data=jsonb_set(data,'{status}','\"superseded\"'::jsonb) WHERE id=ANY($1::uuid[])", [plan.catchupSourceIds]);
          else await client.query("UPDATE result_deliveries SET data=data-'catchupId' WHERE id=ANY($1::uuid[]) AND data->>'catchupId'=$2", [plan.catchupSourceIds, plan.id]);
        }
        if (valid) { plan.messages = messages; plan.status = "ready"; delete plan.error; }
        else { plan.status = "superseded"; plan.error = "catchup_sources_changed"; }
      }
      await client.query("UPDATE result_deliveries SET data=$2::jsonb WHERE id=$1", [id, JSON.stringify(plan)]);
      return plan;
    });
  }
  async listPending(chatIds: readonly string[], now: number, limit = 20): Promise<DeliveryPlan[]> {
    await this.pool.query(`UPDATE result_deliveries SET data=jsonb_set(data,'{status}','"uncertain"'::jsonb)
      WHERE chat_id=ANY($1::text[]) AND data->>'status'='claimed' AND (data->>'attemptExpiresAt')::bigint <= $2`, [chatIds, now]);
    const result = await this.pool.query<PlanRow>(`SELECT data FROM result_deliveries WHERE chat_id=ANY($1::text[]) AND
      data->>'status'='ready' AND (data->>'expiresAt')::bigint > $2 AND retained_until > $2 AND created_at <= $2
      ORDER BY CASE WHEN data->>'kind'='progress' THEN 1 ELSE 0 END,created_at,id LIMIT $3`, [chatIds, now, Math.min(100, Math.max(0, limit))]);
    return result.rows.map(row => row.data);
  }
  async claim(id: string, attemptId: string, now: number): Promise<DeliveryPlan | null> {
    await this.get(id, now);
    return this.update(id, plan => claimDelivery(plan, attemptId, now));
  }
  async defer(id: string, attemptId: string, reason: string, now: number, submittedMessages = 0): Promise<DeliveryPlan | null> {
    return this.update(id, plan => deferDelivery(plan, attemptId, reason, now, submittedMessages));
  }
  async resumeChat(chatId: string, now: number, generation?: string, sourceIds?: readonly string[]): Promise<number> {
    return this.transaction(async client => {
      if (generation) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`resume:${chatId}:${generation}`]);
        const existing = await client.query<{ resumed: number }>("SELECT resumed FROM result_resume_receipts WHERE chat_id=$1 AND generation=$2", [chatId, generation]);
        if (existing.rows[0]) return existing.rows[0].resumed;
      }
      const result = await client.query(`UPDATE result_deliveries SET data=jsonb_set(data - 'deferReason','{status}','"ready"'::jsonb)
        WHERE chat_id=$1 AND data->>'status'='waiting_for_user' AND NOT data ? 'catchupId' AND
        (data->>'expiresAt')::bigint > $2 AND retained_until > $2 AND ($3::uuid[] IS NULL OR id=ANY($3::uuid[]))`, [chatId, now, sourceIds ?? null]);
      const resumed = result.rowCount ?? 0;
      if (generation) await client.query("INSERT INTO result_resume_receipts(chat_id,generation,resumed) VALUES($1,$2,$3)", [chatId, generation, resumed]);
      return resumed;
    });
  }
  async markChatWaiting(chatId: string, reason: string, now: number): Promise<number> {
    const result = await this.pool.query(`UPDATE result_deliveries SET data=jsonb_set(
      jsonb_set(data,'{status}','"waiting_for_user"'::jsonb),'{deferReason}',to_jsonb($2::text))
      WHERE chat_id=$1 AND data->>'status'='ready' AND COALESCE((data->>'submittedMessages')::int,0)=0
      AND created_at <= $3 AND (data->>'expiresAt')::bigint > $3 AND retained_until > $3`, [chatId, reason, now]);
    return result.rowCount ?? 0;
  }
  async recordReceipt(id: string, status: "accepted" | "uncertain", attemptId: string): Promise<DeliveryPlan | null> {
    return this.update(id, plan => {
      return receiptDelivery(plan, status, attemptId);
    });
  }
  async prune(now: number): Promise<number> {
    return this.transaction(async client => {
      const removed = await client.query<{ artifact_id: string }>("DELETE FROM result_deliveries WHERE retained_until <= $1 RETURNING artifact_id", [now]);
      if (removed.rows.length) await client.query("DELETE FROM result_artifacts WHERE id=ANY($1::uuid[])", [removed.rows.map(row => row.artifact_id)]);
      return removed.rows.length;
    });
  }
}
