import type pg from "pg";
import type { CommandAuthority, CommandRecord, SendRoute } from "../types.js";
import { inspectionLimit } from "./command-state.js";
import { sameAuthority } from "../commands/queue.js";

type Mapper = (row: any) => CommandRecord;
export async function pgListQueuedCommands(pool: pg.Pool, map: Mapper, limit = 64, after = ""): Promise<CommandRecord[]> {
  const result = await pool.query(`SELECT c.* FROM commands c WHERE c.status='queued' AND c.command_id>$1
    AND (c.delivery_mode='steer' OR NOT EXISTS (SELECT 1 FROM commands earlier WHERE earlier.node_id=c.node_id AND earlier.session_id=c.session_id
      AND earlier.action='send' AND (earlier.status IN ('pending','accepted','uncertain') OR
        earlier.status IN ('admitting','queued') AND earlier.queue_order<c.queue_order)))
    ORDER BY c.command_id LIMIT $2`, [after, inspectionLimit(limit)]);
  return result.rows.map(map);
}

export async function pgClaimQueuedCommand(pool: pg.Pool, map: Mapper, id: string, route: SendRoute): Promise<CommandRecord | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const target = await client.query("SELECT node_id,session_id FROM commands WHERE command_id=$1", [id]);
    if (!target.rows[0]) { await client.query("COMMIT"); return null; }
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([target.rows[0].node_id, target.rows[0].session_id])]);
    const result = await client.query(`UPDATE commands c SET status='pending',send_route=$2,updated_at=NOW()
      WHERE command_id=$1 AND status='queued' AND expires_at>NOW()
      AND (c.delivery_mode='steer' OR NOT EXISTS (SELECT 1 FROM commands earlier WHERE earlier.node_id=c.node_id AND earlier.session_id=c.session_id
        AND earlier.action='send' AND (earlier.status IN ('pending','accepted','uncertain') OR
          earlier.status IN ('admitting','queued') AND earlier.queue_order<c.queue_order))) RETURNING c.*`, [id, route]);
    await client.query("COMMIT");
    return result.rows[0] ? map(result.rows[0]) : null;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

/** Atomic row update retains FIFO order and cannot revive expired, accepted, or uncertain work. */
export function pgAdmitCommand(pool: pg.Pool, map: Mapper, id: string): Promise<CommandRecord | null> {
  return pgQueueUnsentCommand(pool,map,id,"admitting");
}
export function pgRequeueClaimedCommand(pool: pg.Pool, map: Mapper, id: string): Promise<CommandRecord | null> {
  return pgQueueUnsentCommand(pool,map,id,"pending");
}
async function pgQueueUnsentCommand(pool: pg.Pool, map: Mapper, id: string, status: "admitting" | "pending"): Promise<CommandRecord | null> {
  const result = await pool.query(`UPDATE commands SET status='queued',updated_at=NOW()
    WHERE command_id=$1 AND status=$2 AND action='send' AND authority IS NOT NULL
      AND ($2='admitting' OR authority->>'type' IN ('automation','plan'))
      AND send_route IN ('control-socket','app-server-resume','desktop-owner')
      AND turn_id IS NULL AND input_receipt IS NULL AND expires_at>NOW() RETURNING *`, [id,status]);
  return result.rows[0] ? map(result.rows[0]) : null;
}

export async function pgCancelQueuedCommand(pool: pg.Pool, map: Mapper, id: string, authority?: CommandAuthority): Promise<CommandRecord | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query("SELECT * FROM commands WHERE command_id=$1 FOR UPDATE", [id]);
    const command = result.rows[0] && map(result.rows[0]);
    if (!command || authority?.type !== "admin" && authority !== undefined && !sameAuthority(command.authority, authority) ||
        !["queued", "cancelled"].includes(command.status)) { await client.query("COMMIT"); return null; }
    if (command.status === "cancelled") { await client.query("COMMIT"); return command; }
    const saved = await client.query("UPDATE commands SET status='cancelled',updated_at=NOW() WHERE command_id=$1 RETURNING *", [id]);
    await client.query("COMMIT"); return map(saved.rows[0]);
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
