import { randomUUID } from "node:crypto";
import type pg from "pg";
import { CLEARED_FALLBACK_TITLE, DEFAULT_FALLBACK_CLAIM_LEASE_MS, validateFallbackCleanup, validateFallbackLease, FallbackInputSchema, type FallbackInput, type FallbackRecord, type FallbackRepository, type FallbackSettlement } from "./contracts.js";

interface Row {
  id: string; chat_id: string; dedup_key: string; status: FallbackRecord["status"];
  created_at: string | number; updated_at: string | number; next_attempt_at: string | number;
  attempts: number; claim_token: string | null; claim_expires_at: string | number | null; outcome: string | null; input: FallbackInput;
  body_cleared_at: string | number | null;
}
function read(row: Row): FallbackRecord {
  const input = FallbackInputSchema.parse(row.input);
  if (input.chatId !== row.chat_id || input.key !== row.dedup_key) throw new Error("Fallback row identity mismatch");
  return { ...input, id: row.id, status: row.status, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    nextAttemptAt: Number(row.next_attempt_at), attempts: row.attempts,
    ...(row.claim_token ? { claimToken: row.claim_token } : {}),
    ...(row.claim_expires_at !== null ? { claimExpiresAt: Number(row.claim_expires_at) } : {}),
    ...(row.body_cleared_at != null ? { bodyClearedAt: Number(row.body_cleared_at) } : {}),
    ...(row.outcome ? { outcome: row.outcome } : {}) };
}

export class PostgresFallbackRepository implements FallbackRepository {
  constructor(private readonly pool: Pick<pg.Pool, "query">) {}
  /** Call once on service startup, before starting drain workers. */
  async init(now = Date.now()): Promise<void> {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS leader_fallback_deliveries (
      id UUID PRIMARY KEY, chat_id TEXT NOT NULL, dedup_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','sending','sent','failed','unknown')),
      created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, next_attempt_at BIGINT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, claim_token UUID, claim_expires_at BIGINT, outcome TEXT, input JSONB NOT NULL,
      UNIQUE(chat_id, dedup_key)
    )`);
    await this.pool.query("ALTER TABLE leader_fallback_deliveries ADD COLUMN IF NOT EXISTS claim_expires_at BIGINT");
    await this.pool.query("ALTER TABLE leader_fallback_deliveries ADD COLUMN IF NOT EXISTS body_cleared_at BIGINT");
    await this.pool.query("CREATE INDEX IF NOT EXISTS leader_fallback_pending_idx ON leader_fallback_deliveries(next_attempt_at,created_at) WHERE status='pending'");
    await this.recoverExpired(now);
  }
  private async recoverExpired(now: number): Promise<void> {
    await this.pool.query(`UPDATE leader_fallback_deliveries SET status='unknown',claim_token=NULL,claim_expires_at=NULL,
      updated_at=$1,outcome='submission_lease_expired' WHERE status='sending'
      AND COALESCE(claim_expires_at,updated_at+$2) <= $1`, [now, DEFAULT_FALLBACK_CLAIM_LEASE_MS]);
  }
  async enqueue(input: FallbackInput, now: number): Promise<FallbackRecord> {
    const valid = FallbackInputSchema.parse(input);
    // A no-op conflict update returns the original immutable payload in one atomic statement.
    const result = await this.pool.query<Row>(`INSERT INTO leader_fallback_deliveries
      (id,chat_id,dedup_key,status,created_at,updated_at,next_attempt_at,input)
      VALUES ($1,$2,$3,'pending',$4,$4,$4,$5::jsonb)
      ON CONFLICT(chat_id,dedup_key) DO UPDATE SET dedup_key=EXCLUDED.dedup_key RETURNING *`,
    [randomUUID(), valid.chatId, valid.key, now, JSON.stringify(valid)]);
    return read(result.rows[0]);
  }
  async claim(now: number, leaseMs = DEFAULT_FALLBACK_CLAIM_LEASE_MS): Promise<FallbackRecord | undefined> {
    validateFallbackLease(leaseMs);
    await this.recoverExpired(now);
    await this.pool.query(`UPDATE leader_fallback_deliveries SET status='failed',updated_at=$1,outcome='expired_before_submission'
      WHERE status='pending' AND input->>'expiresAt' IS NOT NULL AND (input->>'expiresAt')::bigint <= $1`, [now]);
    const result = await this.pool.query<Row>(`WITH candidate AS (
      SELECT id FROM leader_fallback_deliveries WHERE status='pending' AND next_attempt_at <= $1
      ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE leader_fallback_deliveries d SET status='sending',updated_at=$1,attempts=attempts+1,claim_token=$2,claim_expires_at=$3
      FROM candidate WHERE d.id=candidate.id RETURNING d.*`, [now, randomUUID(), now + leaseMs]);
    return result.rows[0] && read(result.rows[0]);
  }
  async settle(id: string, claimToken: string, settlement: FallbackSettlement, now: number): Promise<void> {
    await this.recoverExpired(now);
    const result = await this.pool.query(`UPDATE leader_fallback_deliveries SET status=$3,outcome=$4,updated_at=$5,
      next_attempt_at=COALESCE($6,next_attempt_at),claim_token=NULL,claim_expires_at=NULL
      WHERE id=$1 AND status='sending' AND claim_token=$2 AND claim_expires_at > $5`,
    [id, claimToken, settlement.status, settlement.outcome, now, settlement.nextAttemptAt ?? null]);
    if (result.rowCount !== 1) throw new Error("Fallback claim no longer owned");
  }
  async get(id: string): Promise<FallbackRecord | undefined> {
    const result = await this.pool.query<Row>("SELECT * FROM leader_fallback_deliveries WHERE id=$1", [id]);
    return result.rows[0] && read(result.rows[0]);
  }
  async list(chatId: string, limit = 100): Promise<FallbackRecord[]> {
    const result = await this.pool.query<Row>("SELECT * FROM leader_fallback_deliveries WHERE chat_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2", [chatId, limit]);
    return result.rows.map(read);
  }
  async cleanupBodies(now: number, retentionMs: number): Promise<number> {
    validateFallbackCleanup(now, retentionMs);
    const result = await this.pool.query(`UPDATE leader_fallback_deliveries
      SET input=jsonb_set(jsonb_set(input,'{text}','""'::jsonb),'{title}',to_jsonb($3::text)),
        outcome=NULL,body_cleared_at=$1
      WHERE status IN ('sent','failed') AND body_cleared_at IS NULL AND updated_at <= $2`,
    [now, now - retentionMs, CLEARED_FALLBACK_TITLE]);
    return result.rowCount ?? 0;
  }
}
