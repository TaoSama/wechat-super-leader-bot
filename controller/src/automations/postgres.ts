import type pg from "pg";
import { CLAIM_LEASE_MS, type AutomationOutbox, type AutomationRepository, type AutomationRun, type AutomationSupplement, type RunnerOutcome, type Schedule } from "./contracts.js";
import { assertSameCreation } from "./identity.js";
import { finishRun, newRun } from "./state.js";
import { supplementOutbox, assertSameSupplement } from "./supplements.js";
import { dueOccurrence } from "./timing.js";
import { validateBodyRetention } from "./retention.js";
import { AutomationConflictError } from "./errors.js";

type Queryable = Pick<pg.PoolClient, "query">;
export async function initAutomationTables(client: Queryable): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS automation_schedules (
    id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, state TEXT NOT NULL,
    next_at BIGINT, active_run_id TEXT, data JSONB NOT NULL);
    CREATE INDEX IF NOT EXISTS automation_schedules_due ON automation_schedules(next_at) WHERE state = 'active';
    CREATE INDEX IF NOT EXISTS automation_schedules_chat ON automation_schedules(chat_id);
    CREATE TABLE IF NOT EXISTS automation_runs (
      id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES automation_schedules(id), scheduled_at BIGINT NOT NULL,
      state TEXT NOT NULL, claim_until BIGINT NOT NULL, data JSONB NOT NULL, UNIQUE(schedule_id,scheduled_at));
    CREATE INDEX IF NOT EXISTS automation_runs_active ON automation_runs(claim_until) WHERE state IN ('dispatching','running');
    CREATE TABLE IF NOT EXISTS automation_outbox (
      id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES automation_schedules(id), state TEXT NOT NULL,
      expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL, data JSONB NOT NULL);
    CREATE INDEX IF NOT EXISTS automation_outbox_pending ON automation_outbox(created_at) WHERE state = 'pending'`);
}
async function saveSchedule(client: Queryable, schedule: Schedule): Promise<void> {
  await client.query(`UPDATE automation_schedules SET state=$2,next_at=$3,active_run_id=$4,data=$5 WHERE id=$1`,
    [schedule.id, schedule.status, schedule.nextAt, schedule.activeRunId ?? null, schedule]);
}
async function saveRun(client: Queryable, run: AutomationRun): Promise<void> {
  await client.query(`INSERT INTO automation_runs(id,schedule_id,scheduled_at,state,claim_until,data)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET state=EXCLUDED.state,claim_until=EXCLUDED.claim_until,data=EXCLUDED.data`,
    [run.id, run.scheduleId, run.scheduledAt, run.status, run.claimUntil, run]);
}
export class PostgresAutomationRepository implements AutomationRepository {
  constructor(private readonly pool: pg.Pool) {}
  private async transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
  async create(schedule: Schedule): Promise<Schedule> {
    await this.pool.query(`INSERT INTO automation_schedules(id,chat_id,state,next_at,active_run_id,data) VALUES($1,$2,$3,$4,NULL,$5) ON CONFLICT(id) DO NOTHING`,
      [schedule.id, schedule.chatId, schedule.status, schedule.nextAt, schedule]);
    const selected = await this.pool.query<{data: Schedule}>("SELECT data FROM automation_schedules WHERE id=$1", [schedule.id]);
    const persisted = selected.rows[0]?.data;
    if (!persisted) throw new Error("Schedule creation did not persist");
    assertSameCreation(persisted, schedule);
    return persisted;
  }
  async get(id: string, chatId: string): Promise<Schedule | null> {
    const result = await this.pool.query<{ data: Schedule }>("SELECT data FROM automation_schedules WHERE id=$1 AND chat_id=$2", [id, chatId]);
    return result.rows[0]?.data ?? null;
  }
  async list(chatId: string): Promise<Schedule[]> {
    const result = await this.pool.query<{ data: Schedule }>("SELECT data FROM automation_schedules WHERE chat_id=$1 ORDER BY (data->>'createdAt')::bigint DESC", [chatId]);
    return result.rows.map(row => row.data);
  }
  async setStatus(id: string, chatId: string, status: "active" | "paused" | "cancelled", now: number): Promise<Schedule | null> {
    return this.transaction(async client => {
      const result = await client.query<{ data: Schedule }>("SELECT data FROM automation_schedules WHERE id=$1 AND chat_id=$2 FOR UPDATE", [id, chatId]);
      const schedule = result.rows[0]?.data;
      if (!schedule) return null;
      // A completed background occurrence can still have live follow-ups; cancellation is terminal.
      const cancellingRetainedBackground = schedule.kind === "background" && schedule.status === "completed" && status === "cancelled";
      if (schedule.status === "cancelled" || (schedule.status === "completed" && !cancellingRetainedBackground)) throw new AutomationConflictError("Finished schedules cannot be resumed or modified");
      schedule.status = status; schedule.updatedAt = now;
      await saveSchedule(client, schedule);
      if (status === "cancelled") await client.query("UPDATE automation_outbox SET state='superseded',data=jsonb_set(data,'{status}','\"superseded\"') WHERE schedule_id=$1 AND state='pending'", [id]);
      return schedule;
    });
  }
  async listRuns(id: string, chatId: string, limit = 50): Promise<AutomationRun[]> {
    const result = await this.pool.query<{ data: AutomationRun }>(`SELECT r.data FROM automation_runs r
      JOIN automation_schedules s ON s.id=r.schedule_id WHERE s.id=$1 AND s.chat_id=$2 ORDER BY scheduled_at DESC LIMIT $3`, [id, chatId, limit]);
    return result.rows.map(row => row.data);
  }
  async claimDue(now: number, owner: string, limit: number): Promise<{ schedule: Schedule; run: AutomationRun }[]> {
    return this.transaction(async client => {
      const due = await client.query<{ data: Schedule }>(`SELECT data FROM automation_schedules WHERE state='active' AND next_at <= $1
        AND active_run_id IS NULL ORDER BY next_at LIMIT $2 FOR UPDATE SKIP LOCKED`, [now, limit]);
      const claimed: { schedule: Schedule; run: AutomationRun }[] = [];
      for (const { data: schedule } of due.rows) {
        const candidate = dueOccurrence(schedule, now);
        const previous = await client.query<{data: AutomationRun}>("SELECT data FROM automation_runs WHERE schedule_id=$1 AND scheduled_at=$2", [schedule.id, candidate.scheduledAt]);
        const skipped = previous.rows[0]?.data;
        if (skipped && skipped.status !== "skipped") throw new Error("Occurrence was already executed");
        const run = newRun(schedule, now, owner, skipped);
        await saveRun(client, run);
        await saveSchedule(client, schedule);
        if (run.status === "dispatching") claimed.push({ schedule, run });
      }
      return claimed;
    });
  }
  async claimRunning(now: number, owner: string, limit: number): Promise<{ schedule: Schedule; run: AutomationRun }[]> {
    return this.transaction(async client => {
      // All writers lock schedule before run so finishing and claiming cannot deadlock.
      const rows = await client.query<{ schedule: Schedule; run: AutomationRun }>(`SELECT s.data AS schedule,r.data AS run
        FROM automation_schedules s JOIN automation_runs r ON r.id=s.active_run_id
        WHERE r.state IN ('dispatching','running') AND r.claim_until <= $1 ORDER BY r.claim_until LIMIT $2
        FOR UPDATE OF s SKIP LOCKED`, [now, limit]);
      const claimed: { schedule: Schedule; run: AutomationRun }[] = [];
      for (const { schedule, run } of rows.rows) {
        // A durable request may already exist even if the original worker never saved its receipt.
        run.claimOwner = owner; run.claimUntil = now + CLAIM_LEASE_MS;
        claimed.push({ schedule, run });
        await saveRun(client, run);
      }
      return claimed;
    });
  }
  async finish(runId: string, owner: string, outcome: RunnerOutcome, now: number): Promise<boolean> {
    return this.transaction(async client => {
      const found = await client.query<{ data: Schedule }>(`SELECT s.data FROM automation_schedules s
        JOIN automation_runs r ON r.schedule_id=s.id WHERE r.id=$1 FOR UPDATE OF s`, [runId]);
      const schedule = found.rows[0]?.data;
      if (!schedule) return false;
      const selected = await client.query<{ data: AutomationRun }>("SELECT data FROM automation_runs WHERE id=$1 FOR UPDATE", [runId]);
      const run = selected.rows[0]?.data;
      if (!run || run.claimOwner !== owner || run.claimUntil <= now || !["dispatching", "running"].includes(run.status)) return false;
      const item = finishRun(schedule, run, outcome, now);
      await saveRun(client, run);
      await saveSchedule(client, schedule);
      if (item && schedule.status !== "cancelled") {
        if (schedule.retention === "latest") await client.query(`UPDATE automation_outbox SET state='superseded',
          data=jsonb_set(data,'{status}','"superseded"') WHERE schedule_id=$1 AND state='pending' AND NOT (data ? 'supplement')`, [schedule.id]);
        await client.query(`INSERT INTO automation_outbox(id,schedule_id,state,expires_at,created_at,data) VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT(id) DO NOTHING`, [item.id, item.scheduleId, item.status, item.expiresAt, item.createdAt, item]);
      }
      return true;
    });
  }
  async publishSupplement(input: AutomationSupplement): Promise<AutomationOutbox> {
    return this.transaction(async client => {
      const selected = await client.query<{ data: Schedule }>("SELECT data FROM automation_schedules WHERE id=$1 FOR UPDATE", [input.scheduleId]);
      const schedule = selected.rows[0]?.data;
      const runs = await client.query<{ data: AutomationRun }>("SELECT data FROM automation_runs WHERE id=$1", [input.runId]);
      const incoming = supplementOutbox(input, schedule, runs.rows[0]?.data);
      const existing = await client.query<{ data: AutomationOutbox }>("SELECT data FROM automation_outbox WHERE id=$1", [incoming.id]);
      if (existing.rows[0]) { assertSameSupplement(existing.rows[0].data, incoming); return existing.rows[0].data; }
      if (schedule!.status === "cancelled") throw new Error("Cancelled background schedule cannot publish new supplements");
      await client.query(`INSERT INTO automation_outbox(id,schedule_id,state,expires_at,created_at,data) VALUES($1,$2,$3,$4,$5,$6)`,
        [incoming.id, incoming.scheduleId, incoming.status, incoming.expiresAt, incoming.createdAt, incoming]);
      return incoming;
    });
  }
  async pendingOutbox(now: number, limit = 100, excludeIds: readonly string[] = []): Promise<AutomationOutbox[]> {
    await this.pool.query(`UPDATE automation_outbox SET state='expired',data=jsonb_set(data,'{status}','"expired"')
      WHERE state='pending' AND expires_at <= $1`, [now]);
    const result = await this.pool.query<{ data: AutomationOutbox }>("SELECT data FROM automation_outbox WHERE state='pending' AND expires_at > $1 AND NOT(id = ANY($3::text[])) ORDER BY created_at LIMIT $2", [now, limit, [...excludeIds]]);
    return result.rows.map(row => row.data);
  }
  async markPublished(id: string): Promise<void> {
    await this.pool.query(`UPDATE automation_outbox SET state='published',data=jsonb_set(data,'{status}','"published"') WHERE id=$1 AND state='pending'`, [id]);
  }
  async cleanupBodies(now: number, retentionMs: number): Promise<{ runs: number; outbox: number }> {
    validateBodyRetention(now, retentionMs);
    return this.transaction(async client => {
      await client.query(`UPDATE automation_outbox SET state='expired',data=jsonb_set(data,'{status}','"expired"')
        WHERE state='pending' AND expires_at <= $1`, [now]);
      const runs = await client.query(`UPDATE automation_runs r SET data =
        jsonb_set(CASE WHEN data ? 'result' THEN jsonb_set(data - 'error','{result}',
          jsonb_set((data->'result') - 'error','{text}','""')) ELSE data - 'error' END,
          '{bodyClearedAt}',to_jsonb($1::bigint))
        WHERE r.state IN ('completed','failed','expired','skipped') AND NOT (r.data ? 'bodyClearedAt')
          AND (r.data->>'updatedAt')::bigint <= $2
          AND NOT EXISTS (SELECT 1 FROM automation_schedules s WHERE s.id=r.schedule_id AND s.active_run_id=r.id)
          AND NOT EXISTS (SELECT 1 FROM automation_outbox o WHERE o.data->>'runId'=r.id AND o.state='pending')`, [now, now - retentionMs]);
      const outbox = await client.query(`UPDATE automation_outbox o SET data = jsonb_set(
        jsonb_set(o.data,'{text}','""'),'{bodyClearedAt}',to_jsonb($1::bigint))
        WHERE o.state IN ('published','superseded','expired') AND NOT (o.data ? 'bodyClearedAt') AND o.created_at <= $2
          AND NOT EXISTS (SELECT 1 FROM automation_runs r WHERE r.id=o.data->>'runId' AND r.state IN ('dispatching','running','unknown'))
          AND NOT EXISTS (SELECT 1 FROM automation_schedules s WHERE s.id=o.schedule_id AND s.active_run_id=o.data->>'runId')`, [now, now - retentionMs]);
      return { runs: runs.rowCount ?? 0, outbox: outbox.rowCount ?? 0 };
    });
  }

}
