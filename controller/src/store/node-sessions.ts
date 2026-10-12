import type { Session } from "../types.js";
import type pg from "pg";

export class InvalidSessionInventoryError extends Error {
  constructor() {
    super("Duplicate session IDs in node inventory");
    this.name = "InvalidSessionInventoryError";
  }
}

/** Conflicting identities cannot be deduplicated without inventing authority. */
export function validateNodeSessionInventory(sessions: readonly Session[]): void {
  const ids = new Set<string>();
  for (const session of sessions) {
    if (ids.has(session.id)) throw new InvalidSessionInventoryError();
    ids.add(session.id);
  }
}

/** Serialize whole-node replacements, including initially empty inventories. */
export async function withNodeSessionsLock(pool: pg.Pool, nodeId: string,
  operation: (client: pg.PoolClient) => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // A namespaced transaction lock works across pool clients and Store instances.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify(["node_sessions", nodeId])]);
    await operation(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
