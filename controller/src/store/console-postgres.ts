import pg from "pg";
import {
  ConsoleLinkRecord,
  ConsoleSessionRecord,
  cloneConsoleLinkRecord,
  cloneConsoleSessionRecord,
  normalizeConsoleLinkRecord,
  normalizeConsoleSessionRecord,
  validateConsoleTokenHash,
  validateIsoTimestamp,
} from "../console/types.js";

export async function initConsoleAuthTables(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS console_links (
      token_hash VARCHAR(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ
    );
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS console_sessions (
      token_hash VARCHAR(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );
  `);
  await client.query(
    "CREATE INDEX IF NOT EXISTS console_links_expires_at_idx ON console_links (expires_at);"
  );
  await client.query(
    "CREATE INDEX IF NOT EXISTS console_sessions_expires_at_idx ON console_sessions (expires_at);"
  );
}

export async function pgCreateConsoleLinkIfAbsent(
  pool: pg.Pool,
  record: ConsoleLinkRecord
): Promise<ConsoleLinkRecord> {
  const normalized = normalizeConsoleLinkRecord(record);
  const insertRes = await pool.query(
    `
    INSERT INTO console_links (token_hash, created_at, expires_at, consumed_at)
    VALUES ($1, $2::timestamptz, $3::timestamptz, $4::timestamptz)
    ON CONFLICT (token_hash) DO NOTHING
    RETURNING token_hash, created_at, expires_at, consumed_at;
    `,
    [
      normalized.tokenHash,
      normalized.createdAt,
      normalized.expiresAt,
      normalized.consumedAt ?? null,
    ]
  );

  if (insertRes.rows.length > 0) {
    return mapConsoleLinkRow(insertRes.rows[0]);
  }

  const selectRes = await pool.query(
    "SELECT token_hash, created_at, expires_at, consumed_at FROM console_links WHERE token_hash = $1",
    [normalized.tokenHash]
  );
  if (selectRes.rows.length === 0) {
    throw new Error(
      `Unexpected state: console_link with token_hash '${normalized.tokenHash}' was not inserted and could not be fetched`
    );
  }
  return mapConsoleLinkRow(selectRes.rows[0]);
}

export async function pgConsumeConsoleLink(
  pool: pg.Pool,
  tokenHash: string,
  session: ConsoleSessionRecord,
  now: string
): Promise<boolean> {
  const validTokenHash = validateConsoleTokenHash(tokenHash);
  const normalizedSession = normalizeConsoleSessionRecord(session);
  const validNow = validateIsoTimestamp(now, "now");
  if (validTokenHash === normalizedSession.tokenHash) {
    throw new Error("Session tokenHash must be distinct from one-time link tokenHash");
  }
  if (Date.parse(normalizedSession.expiresAt) <= validNow.ms) {
    throw new Error("Invalid ConsoleSessionRecord: session expiresAt must be greater than now");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updateRes = await client.query(
      `
      UPDATE console_links
      SET consumed_at = $2::timestamptz
      WHERE token_hash = $1
        AND consumed_at IS NULL
        AND expires_at > $2::timestamptz
      RETURNING token_hash;
      `,
      [validTokenHash, validNow.iso]
    );

    if (updateRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return false;
    }

    await client.query(
      `
      INSERT INTO console_sessions (token_hash, created_at, expires_at)
      VALUES ($1, $2::timestamptz, $3::timestamptz);
      `,
      [normalizedSession.tokenHash, normalizedSession.createdAt, normalizedSession.expiresAt]
    );

    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function pgGetConsoleSession(
  pool: pg.Pool,
  tokenHash: string,
  now: string
): Promise<ConsoleSessionRecord | null> {
  const validTokenHash = validateConsoleTokenHash(tokenHash);
  const validNow = validateIsoTimestamp(now, "now");
  const res = await pool.query(
    `
    SELECT token_hash, created_at, expires_at
    FROM console_sessions
    WHERE token_hash = $1 AND expires_at > $2::timestamptz
    `,
    [validTokenHash, validNow.iso]
  );
  if (res.rows.length === 0) {
    return null;
  }
  return mapConsoleSessionRow(res.rows[0]);
}

export async function pgDeleteConsoleSession(pool: pg.Pool, tokenHash: string): Promise<void> {
  const validTokenHash = validateConsoleTokenHash(tokenHash);
  await pool.query("DELETE FROM console_sessions WHERE token_hash = $1", [validTokenHash]);
}

function mapConsoleLinkRow(row: any): ConsoleLinkRecord {
  return cloneConsoleLinkRecord({
    tokenHash: row.token_hash,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    consumedAt: row.consumed_at ? new Date(row.consumed_at).toISOString() : undefined,
  });
}

function mapConsoleSessionRow(row: any): ConsoleSessionRecord {
  return cloneConsoleSessionRecord({
    tokenHash: row.token_hash,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
  });
}
