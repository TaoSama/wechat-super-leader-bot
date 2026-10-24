import type pg from "pg";
import { initGoalTables } from "./goal-postgres.js";
import { initNotificationTables } from "./notification-postgres.js";
import { initExecutionTables } from "./execution-postgres.js";
import { initConsoleAuthTables } from "./console-postgres.js";
import { initMessageImageTables } from "./message-images-postgres.js";
import { initNotificationCandidateState } from "./notification-candidates-postgres.js";

const INITIAL_SCHEMA_VERSION = 1;
const KNOWN_SESSION_OBSERVATION_VERSION = 2;
const SCHEMA_MIGRATION_LOCK = "controller-schema-migrations";
const SCHEMA_MIGRATIONS = [
  { version: INITIAL_SCHEMA_VERSION, apply: migrateInitialSchema },
  { version: KNOWN_SESSION_OBSERVATION_VERSION, apply: migrateKnownSessionObservations },
];

export async function initializeDatabase(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize the version check and schema work, including first-time creation
    // of the ledger. PostgreSQL releases this lock on commit or rollback.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [SCHEMA_MIGRATION_LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS controller_schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0), applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const applied = await client.query<{ version: number }>("SELECT version FROM controller_schema_migrations");
    const appliedVersions = new Set(applied.rows.map(row => row.version));
    for (const migration of SCHEMA_MIGRATIONS) {
      if (appliedVersions.has(migration.version)) continue;
      await migration.apply(client);
      await client.query("INSERT INTO controller_schema_migrations(version) VALUES($1)", [migration.version]);
    }

    // Retain restart recovery even when no schema migration is needed.
    await client.query(`
      UPDATE commands
      SET status = 'uncertain',
          error = 'Controller restarted while command was pending or accepted',
          updated_at = NOW()
      WHERE status IN ('pending', 'accepted');
    `);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// This is the baseline for both empty databases and installations that predate
// the ledger. Future schema changes must use a new migration version.
async function migrateInitialSchema(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS commands (
      command_id VARCHAR(64) PRIMARY KEY,
      request_id VARCHAR(128) UNIQUE,
      node_id VARCHAR(64) NOT NULL,
      session_id VARCHAR(64) NOT NULL,
      action VARCHAR(32) NOT NULL,
      prompt TEXT,
      status VARCHAR(32) NOT NULL,
      output TEXT,
      error TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS messages (
      chat_id VARCHAR(64) NOT NULL,
      message_id VARCHAR(128) NOT NULL,
      text TEXT NOT NULL,
      reply_text TEXT NOT NULL,
      command_id VARCHAR(64),
      created_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (chat_id, message_id)
    );
  `);
  await client.query("ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_images JSONB");
  await initMessageImageTables(client);
  await client.query("ALTER TABLE commands ADD COLUMN IF NOT EXISTS skills JSONB NOT NULL DEFAULT '[]'::jsonb");
  await client.query("ALTER TABLE commands ADD COLUMN IF NOT EXISTS turn_id VARCHAR(128)");
  await client.query("ALTER TABLE commands ADD COLUMN IF NOT EXISTS send_route VARCHAR(32)");
  await client.query("ALTER TABLE commands ADD COLUMN IF NOT EXISTS input_receipt JSONB");
  await client.query("ALTER TABLE commands ADD COLUMN IF NOT EXISTS delivery_mode VARCHAR(16)");
  await client.query("ALTER TABLE commands ADD COLUMN IF NOT EXISTS expected_turn_id VARCHAR(128)");
  await client.query("ALTER TABLE commands ADD COLUMN IF NOT EXISTS authority JSONB");
  await client.query("ALTER TABLE commands ADD COLUMN IF NOT EXISTS console_hidden_at TIMESTAMPTZ");
  await client.query("ALTER TABLE commands ADD COLUMN IF NOT EXISTS queue_order BIGSERIAL");
  await client.query("DROP INDEX IF EXISTS commands_queue_idx");
  await client.query("CREATE INDEX commands_queue_idx ON commands (node_id, session_id, queue_order) WHERE status IN ('admitting','queued','pending','accepted','uncertain')");
  await client.query("DROP INDEX IF EXISTS commands_inspection_idx");
  await client.query("CREATE INDEX commands_inspection_idx ON commands (node_id, command_id) WHERE action = 'send' AND status IN ('pending', 'accepted', 'uncertain')");

  await client.query(`
    CREATE TABLE IF NOT EXISTS node_sessions (
      node_id VARCHAR(64) NOT NULL,
      session_id VARCHAR(64) NOT NULL,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY (node_id, session_id)
    );
  `);
  await client.query(`CREATE TABLE IF NOT EXISTS known_sessions (
    node_id VARCHAR(64) NOT NULL, session_id VARCHAR(64) NOT NULL, data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(node_id,session_id))`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS leader_states (
      chat_id VARCHAR(64) PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    );
  `);

  // Additive console auth tables
  await initConsoleAuthTables(client);
  await initExecutionTables(client);
  await initGoalTables(client);
  await initNotificationTables(client);
  await initNotificationCandidateState(client);
}

async function migrateKnownSessionObservations(client: pg.PoolClient): Promise<void> {
  await client.query("ALTER TABLE known_sessions ADD COLUMN IF NOT EXISTS observed_order BIGSERIAL");
  await client.query(`INSERT INTO known_sessions (node_id,session_id,data,updated_at)
    SELECT node_id,session_id,data,updated_at FROM node_sessions ON CONFLICT(node_id,session_id) DO NOTHING`);
  await client.query("DELETE FROM node_sessions;");
}
