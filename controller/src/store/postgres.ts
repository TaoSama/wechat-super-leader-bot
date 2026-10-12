import pg from "pg";
import { CommandRecord, InputReceipt, InputReceiptSchema, MessageRecord, ScopedSession, Session, SendRouteSchema, validateCommandSendRoute } from "../types.js";
import { IStore, CreateCommandResult, ConflictError } from "./interface.js";
import { sameSkillRefs, SkillRefsSchema } from "../skills.js";
import { nextCommandState, inspectionLimit, validateStoredCommandInput } from "./command-state.js";
import { validateNodeSessionInventory, withNodeSessionsLock } from "./node-sessions.js";
import type { CreateExecutionResult, ExecutionRecord } from "../leader/execution.js";
import type { ExecutionConfirmationAuthority } from "../leader/execution-confirmation.js";
import type { Notification, NotificationReceiptStatus } from "../notifications.js";
import { pgListPendingNotifications, pgGetNotification, pgClaimNotification, pgRecordNotificationReceipt } from "./notification-postgres.js";
import { initExecutionTables, pgCreateExecutionIfAbsent, pgGetExecution, pgGetLatestExecution,
  pgCompareAndSetExecution, pgListActiveExecutions, pgConfirmExecution, pgListRecentExecutions } from "./execution-postgres.js";
import {
  LeaderState,
  cloneLeaderState,
  serializeAndValidateLeaderData,
  validateChatId,
  validateExpectedRevision,
} from "../leader/state.js";
import {
  ConsoleLinkRecord,
  ConsoleSessionRecord,
} from "../console/types.js";
import {
  initConsoleAuthTables,
  pgCreateConsoleLinkIfAbsent,
  pgConsumeConsoleLink,
  pgGetConsoleSession,
  pgDeleteConsoleSession,
} from "./console-postgres.js";

const { Pool } = pg;

export class PostgresStore implements IStore {
  private pool: pg.Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async init(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

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
      await client.query("ALTER TABLE commands ADD COLUMN IF NOT EXISTS skills JSONB NOT NULL DEFAULT '[]'::jsonb");
      await client.query("ALTER TABLE commands ADD COLUMN IF NOT EXISTS turn_id VARCHAR(128)");
      await client.query("ALTER TABLE commands ADD COLUMN IF NOT EXISTS send_route VARCHAR(32)");
      await client.query("ALTER TABLE commands ADD COLUMN IF NOT EXISTS input_receipt JSONB");
      await client.query("CREATE INDEX IF NOT EXISTS commands_inspection_idx ON commands (node_id, command_id) WHERE turn_id IS NOT NULL AND action = 'send' AND status IN ('accepted', 'uncertain')");

      await client.query(`
        CREATE TABLE IF NOT EXISTS node_sessions (
          node_id VARCHAR(64) NOT NULL,
          session_id VARCHAR(64) NOT NULL,
          data JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (node_id, session_id)
        );
      `);

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

      // At controller startup: clear stale node_sessions from previous instance
      await client.query(`DELETE FROM node_sessions;`);

      // At controller startup: mark lingering pending/accepted commands from before restart as uncertain
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

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createCommandIfAbsent(cmd: CommandRecord): Promise<CreateCommandResult> {
    validateCommandSendRoute(cmd);
    validateStoredCommandInput(cmd);
    const insertRes = await this.pool.query(
      `
      INSERT INTO commands (
        command_id, request_id, node_id, session_id, action, prompt,
        status, output, error, expires_at, created_at, updated_at, skills, turn_id, send_route, input_receipt
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16::jsonb)
      ON CONFLICT (request_id) DO NOTHING
      RETURNING *;
      `,
      [
        cmd.commandId,
        cmd.requestId,
        cmd.nodeId,
        cmd.sessionId,
        cmd.action,
        cmd.prompt || null,
        cmd.status,
        cmd.output ?? null,
        cmd.error || null,
        cmd.expiresAt,
        cmd.createdAt,
        cmd.updatedAt,
        JSON.stringify(cmd.skills ?? []),
        cmd.turnId ?? null,
        cmd.sendRoute ?? null,
        cmd.inputReceipt ? JSON.stringify(cmd.inputReceipt) : null,
      ]
    );

    if (insertRes.rows.length > 0) {
      return { created: true, command: this.mapCommandRow(insertRes.rows[0]) };
    }

    const existing = await this.findCommandByRequestId(cmd.requestId);
    if (!existing) {
      throw new Error(
        `Unexpected state: command with request_id '${cmd.requestId}' was not inserted and could not be fetched`
      );
    }

    if (
      existing.nodeId !== cmd.nodeId ||
      existing.sessionId !== cmd.sessionId ||
      existing.action !== cmd.action ||
      (existing.prompt || "") !== (cmd.prompt || "") || !sameSkillRefs(existing.skills, cmd.skills)
    ) {
      throw new ConflictError(
        `requestId '${cmd.requestId}' was already used with different payload`
      );
    }

    return { created: false, command: existing };
  }

  async getCommand(commandId: string): Promise<CommandRecord | null> {
    const res = await this.pool.query(
      "SELECT * FROM commands WHERE command_id = $1",
      [commandId]
    );
    if (res.rows.length === 0) return null;
    return this.mapCommandRow(res.rows[0]);
  }

  async findCommandByRequestId(requestId: string): Promise<CommandRecord | null> {
    const res = await this.pool.query(
      "SELECT * FROM commands WHERE request_id = $1",
      [requestId]
    );
    if (res.rows.length === 0) return null;
    return this.mapCommandRow(res.rows[0]);
  }

  async updateCommandStatus(
    commandId: string,
    status: CommandRecord["status"],
    output?: string,
    error?: string,
    turnId?: string,
    inputReceipt?: InputReceipt
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query("SELECT * FROM commands WHERE command_id = $1 FOR UPDATE", [commandId]);
      if (result.rows.length) {
        const current = this.mapCommandRow(result.rows[0]);
        const next = nextCommandState(current, status, output, error, turnId, inputReceipt);
        if (next !== current) {
          await client.query(`UPDATE commands SET status=$1, output=$2, error=$3, turn_id=$4, updated_at=$5, input_receipt=$7::jsonb WHERE command_id=$6`,
            [next.status, next.output ?? null, next.error ?? null, next.turnId ?? null, next.updatedAt, commandId,
              next.inputReceipt ? JSON.stringify(next.inputReceipt) : null]);
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async markNodeActiveCommandsUncertain(nodeId: string, reason: string): Promise<void> {
    const now = new Date().toISOString();
    await this.pool.query(
      `
      UPDATE commands
      SET status = 'uncertain',
          error = $1,
          updated_at = $2
      WHERE node_id = $3 AND status IN ('pending', 'accepted');
      `,
      [reason, now, nodeId]
    );
  }

  async markExpiredActiveCommandsUncertain(): Promise<void> {
    const now = new Date().toISOString();
    await this.pool.query(
      `
      UPDATE commands
      SET status = 'uncertain',
          error = 'Command expired without terminal result from daemon',
          updated_at = $1
      WHERE (status = 'pending' OR (status = 'accepted' AND turn_id IS NULL)) AND expires_at <= $1;
      `,
      [now]
    );
  }

  async listRecentCommands(limit = 50): Promise<CommandRecord[]> {
    const res = await this.pool.query(
      "SELECT * FROM commands ORDER BY created_at DESC LIMIT $1",
      [limit]
    );
    return res.rows.map((row) => this.mapCommandRow(row));
  }

  async listInspectableCommands(nodeId: string, limit = 50, afterCommandId = ""): Promise<CommandRecord[]> {
    const result = await this.pool.query(`SELECT * FROM commands WHERE node_id=$1 AND action='send'
      AND turn_id IS NOT NULL AND status IN ('accepted','uncertain') AND command_id > $2
      AND send_route IS DISTINCT FROM 'terminal-pane' AND session_id NOT LIKE 'terminal:%' AND input_receipt IS NULL
      ORDER BY command_id ASC LIMIT $3`, [nodeId, afterCommandId, inspectionLimit(limit)]);
    return result.rows.map(row => this.mapCommandRow(row));
  }

  async recordMessage(msg: MessageRecord): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO messages (chat_id, message_id, text, reply_text, command_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (chat_id, message_id) DO NOTHING
      `,
      [msg.chatId, msg.messageId, msg.text, msg.replyText, msg.commandId || null, msg.createdAt]
    );
  }

  async getMessage(chatId: string, messageId: string): Promise<MessageRecord | null> {
    const res = await this.pool.query(
      "SELECT * FROM messages WHERE chat_id = $1 AND message_id = $2",
      [chatId, messageId]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      chatId: r.chat_id,
      messageId: r.message_id,
      text: r.text,
      replyText: r.reply_text,
      commandId: r.command_id || undefined,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }

  async upsertNodeSessions(nodeId: string, sessions: Session[]): Promise<void> {
    validateNodeSessionInventory(sessions);
    await withNodeSessionsLock(this.pool, nodeId, async client => {
      await client.query("DELETE FROM node_sessions WHERE node_id = $1", [nodeId]);
      const now = new Date().toISOString();
      for (const s of sessions) {
        await client.query(
          `
          INSERT INTO node_sessions (node_id, session_id, data, updated_at)
          VALUES ($1, $2, $3, $4)
          `,
          [nodeId, s.id, JSON.stringify(s), now]
        );
      }
    });
  }

  async getNodeSessions(nodeId: string): Promise<ScopedSession[]> {
    const res = await this.pool.query(
      "SELECT data FROM node_sessions WHERE node_id = $1",
      [nodeId]
    );
    return res.rows.map((r) => ({
      ...(typeof r.data === "string" ? JSON.parse(r.data) : r.data),
      nodeId,
    }));
  }

  async getAllSessions(): Promise<ScopedSession[]> {
    const res = await this.pool.query("SELECT node_id, data FROM node_sessions");
    return res.rows.map((r) => ({
      ...(typeof r.data === "string" ? JSON.parse(r.data) : r.data),
      nodeId: r.node_id,
    }));
  }

  async removeNodeSessions(nodeId: string): Promise<void> {
    await withNodeSessionsLock(this.pool, nodeId, async client => {
      await client.query("DELETE FROM node_sessions WHERE node_id = $1", [nodeId]);
    });
  }

  async getLeaderState(chatId: string): Promise<LeaderState | null> {
    validateChatId(chatId);
    const res = await this.pool.query(
      "SELECT chat_id, revision, data, updated_at FROM leader_states WHERE chat_id = $1",
      [chatId]
    );
    if (res.rows.length === 0) return null;
    return this.mapLeaderStateRow(res.rows[0]);
  }

  async compareAndSetLeaderState(
    chatId: string,
    expectedRevision: number,
    data: Record<string, unknown>
  ): Promise<LeaderState | null> {
    validateChatId(chatId);
    validateExpectedRevision(expectedRevision);
    const { json } = serializeAndValidateLeaderData(data);
    const now = new Date().toISOString();

    if (expectedRevision === 0) {
      const insertRes = await this.pool.query(
        `
        INSERT INTO leader_states (chat_id, revision, data, updated_at)
        VALUES ($1, 1, $2::jsonb, $3::timestamptz)
        ON CONFLICT (chat_id) DO NOTHING
        RETURNING chat_id, revision, data, updated_at;
        `,
        [chatId, json, now]
      );
      if (insertRes.rows.length === 0) return null;
      return this.mapLeaderStateRow(insertRes.rows[0]);
    }

    const updateRes = await this.pool.query(
      `
      UPDATE leader_states
      SET revision = revision + 1,
          data = $3::jsonb,
          updated_at = $4::timestamptz
      WHERE chat_id = $1 AND revision = $2
      RETURNING chat_id, revision, data, updated_at;
      `,
      [chatId, expectedRevision, json, now]
    );

    if (updateRes.rows.length === 0) return null;
    return this.mapLeaderStateRow(updateRes.rows[0]);
  }

  async confirmExecution(record: ExecutionRecord, authority: ExecutionConfirmationAuthority, now = Date.now): Promise<CreateExecutionResult> {
    return pgConfirmExecution(this.pool, record, authority, now);
  }

  async createExecutionIfAbsent(record: ExecutionRecord): Promise<CreateExecutionResult> {
    return pgCreateExecutionIfAbsent(this.pool, record);
  }

  async getExecution(id: string): Promise<ExecutionRecord | null> {
    return pgGetExecution(this.pool, id);
  }

  async getLatestExecution(chatId: string): Promise<ExecutionRecord | null> {
    return pgGetLatestExecution(this.pool, chatId);
  }

  async compareAndSetExecution(next: ExecutionRecord, expectedRevision: number, now = Date.now()): Promise<ExecutionRecord | null> {
    return pgCompareAndSetExecution(this.pool, next, expectedRevision, now);
  }

  async listActiveExecutions(limit?: number, afterId?: string): Promise<ExecutionRecord[]> {
    return pgListActiveExecutions(this.pool, limit, afterId);
  }

  async listRecentExecutions(chatIds: readonly string[], limit: number): Promise<ExecutionRecord[]> {
    return pgListRecentExecutions(this.pool, chatIds, limit);
  }

  async listPendingNotifications(chatIds: readonly string[], now: number): Promise<Notification[]> {
    return pgListPendingNotifications(this.pool, chatIds, now);
  }
  async getNotification(id: string, now: number): Promise<Notification | null> {
    return pgGetNotification(this.pool, id, now);
  }
  async claimNotification(id: string, attemptId: string, chatIds: readonly string[], now: number): Promise<Notification | null> {
    return pgClaimNotification(this.pool, id, attemptId, chatIds, now);
  }
  async recordNotificationReceipt(id: string, attemptId: string, status: NotificationReceiptStatus, now: number): Promise<Notification | null> {
    return pgRecordNotificationReceipt(this.pool, id, attemptId, status, now);
  }

  // Console Auth Store
  async createConsoleLinkIfAbsent(record: ConsoleLinkRecord): Promise<ConsoleLinkRecord> {
    return pgCreateConsoleLinkIfAbsent(this.pool, record);
  }

  async consumeConsoleLink(
    tokenHash: string,
    session: ConsoleSessionRecord,
    now: string
  ): Promise<boolean> {
    return pgConsumeConsoleLink(this.pool, tokenHash, session, now);
  }

  async getConsoleSession(tokenHash: string, now: string): Promise<ConsoleSessionRecord | null> {
    return pgGetConsoleSession(this.pool, tokenHash, now);
  }

  async deleteConsoleSession(tokenHash: string): Promise<void> {
    return pgDeleteConsoleSession(this.pool, tokenHash);
  }

  private mapLeaderStateRow(r: any): LeaderState {
    const parsedData = typeof r.data === "string" ? JSON.parse(r.data) : r.data;
    return cloneLeaderState({
      chatId: r.chat_id,
      revision: Number(r.revision),
      data: parsedData,
      updatedAt: new Date(r.updated_at).toISOString(),
    });
  }

  private mapCommandRow(r: any): CommandRecord {
    const command: CommandRecord = {
      commandId: r.command_id,
      requestId: r.request_id,
      nodeId: r.node_id,
      sessionId: r.session_id,
      action: r.action,
      prompt: r.prompt || undefined,
      skills: SkillRefsSchema.parse(r.skills ?? []),
      status: r.status,
      output: r.output ?? undefined,
      error: r.error || undefined,
      turnId: r.turn_id || undefined,
      ...(r.input_receipt == null ? {} : { inputReceipt: InputReceiptSchema.parse(typeof r.input_receipt === "string" ? JSON.parse(r.input_receipt) : r.input_receipt) }),
      ...(r.send_route == null || r.send_route === "" ? {} : { sendRoute: SendRouteSchema.parse(r.send_route) }),
      expiresAt: new Date(r.expires_at).toISOString(),
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
    };
    validateCommandSendRoute(command);
    validateStoredCommandInput(command);
    return command;
  }
}
