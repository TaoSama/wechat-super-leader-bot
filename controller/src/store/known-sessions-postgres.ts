import type pg from "pg";
import type { Session } from "../types.js";
import { KNOWN_SESSION_TTL_MS, KNOWN_SESSION_LIMIT, KNOWN_SESSION_COMMAND_STATUSES,
  KNOWN_SESSION_CLEANUP_BATCH_SIZE, type LiveSessionIds } from "./known-sessions.js";

type QueryClient = Pick<pg.Pool, "query">;

// Rank protected identities first so every pin counts against the soft total limit.
const RETENTION = `WITH pinned AS (
  SELECT node_id,session_id FROM commands WHERE status=ANY($1::text[])
  UNION ALL
  SELECT action->>'nodeId',action->>'sessionId' FROM leader_executions,
    LATERAL jsonb_array_elements(data->'plan'->'actions') action WHERE status='active'
  UNION ALL
  SELECT target->>'nodeId',target->>'sessionId' FROM leader_goals,
    LATERAL jsonb_array_elements(data->'proposal'->'targets') target WHERE status IN ('active','blocked')
  UNION ALL
  SELECT node_id,session_id FROM jsonb_to_recordset($2::jsonb) AS live(node_id text,session_id text)
), identities AS (
  SELECT k.node_id,k.session_id,k.updated_at,k.observed_order,
    EXISTS(SELECT 1 FROM pinned p WHERE p.node_id=k.node_id AND p.session_id=k.session_id) AS protected
  FROM known_sessions k
), ranked AS (
  SELECT *,row_number() OVER(ORDER BY protected DESC,updated_at DESC,observed_order DESC) AS position
  FROM identities
), stale AS (
  SELECT node_id,session_id,observed_order FROM ranked
  WHERE NOT protected AND (updated_at<$3::timestamptz OR position>$4)
  ORDER BY updated_at,observed_order LIMIT $5
)`;
// The observation token prevents a stale cleanup snapshot from deleting a concurrent refresh.
const REMOVE_STALE = `DELETE FROM known_sessions k USING stale s
  WHERE k.node_id=s.node_id AND k.session_id=s.session_id AND k.observed_order=s.observed_order`;

function parameters(live: LiveSessionIds, now: number, batchSize = KNOWN_SESSION_CLEANUP_BATCH_SIZE): unknown[] {
  const identities = [...live].flatMap(([node_id, sessions]) => [...sessions].map(session_id => ({ node_id, session_id })));
  return [KNOWN_SESSION_COMMAND_STATUSES, JSON.stringify(identities),
    new Date(now - KNOWN_SESSION_TTL_MS).toISOString(), KNOWN_SESSION_LIMIT, batchSize];
}

/** Reclaim a bounded budget on cache activity; retained business records are never deleted. */
export async function pgPruneKnownSessions(client: QueryClient, live: LiveSessionIds, now = Date.now(),
  budget = KNOWN_SESSION_CLEANUP_BATCH_SIZE): Promise<void> {
  // Writes fund enough cleanup to keep up with incoming identities, plus one batch
  // for pre-existing history. Reads still reclaim only one batch.
  for (let remaining = budget; remaining > 0; remaining -= KNOWN_SESSION_CLEANUP_BATCH_SIZE) {
    const batchSize = Math.min(remaining, KNOWN_SESSION_CLEANUP_BATCH_SIZE);
    const result = await client.query(`${RETENTION} ${REMOVE_STALE}`, parameters(live, now, batchSize));
    if (result.rowCount !== batchSize) break;
  }
}

export async function pgGetKnownSession(client: QueryClient, live: LiveSessionIds,
  nodeId: string, sessionId: string, now = Date.now()): Promise<Session | null> {
  const result = await client.query<{ data: Session | string }>(`${RETENTION}, removed AS (${REMOVE_STALE})
    SELECT k.data FROM known_sessions k JOIN ranked r USING(node_id,session_id,observed_order)
    WHERE k.node_id=$6 AND k.session_id=$7
      AND (r.protected OR (r.updated_at>=$3::timestamptz AND r.position<=$4))`,
  [...parameters(live, now), nodeId, sessionId]);
  // Logical retention also hides stale rows beyond this cleanup batch.
  const data = result.rows[0]?.data;
  return data ? (typeof data === "string" ? JSON.parse(data) : data) : null;
}
