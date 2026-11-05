import type pg from "pg";
import { MediaError } from "../sessions/media-contracts.js";
import {
  MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_NAME_CHARS, MAX_INBOUND_FILE_BYTES, MAX_STORED_ATTACHMENT_BYTES, MAX_STORED_ATTACHMENTS,
  attachmentRef, sameAttachmentContent, validateStoredAttachment,
  type AttachmentListing, type AttachmentRef, type StoredInboundAttachment,
} from "../sessions/inbound-attachments.js";

export async function initInboundAttachmentTables(client: pg.PoolClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS inbound_attachments (
    attachment_id UUID PRIMARY KEY, chat_id VARCHAR(64) NOT NULL, message_id VARCHAR(128) NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND ${MAX_ATTACHMENTS_PER_MESSAGE - 1}), kind VARCHAR(8) NOT NULL CHECK(kind IN ('image','file')),
    name VARCHAR(${MAX_ATTACHMENT_NAME_CHARS}) NOT NULL, mime VARCHAR(128) NOT NULL, size INTEGER NOT NULL CHECK(size BETWEEN 1 AND ${MAX_INBOUND_FILE_BYTES}),
    sha256 VARCHAR(64) NOT NULL, data BYTEA NOT NULL, received_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
    UNIQUE(chat_id,message_id,ordinal))`);
  await client.query("CREATE INDEX IF NOT EXISTS inbound_attachments_chat_idx ON inbound_attachments(chat_id, received_at DESC)");
  await client.query("CREATE INDEX IF NOT EXISTS inbound_attachments_expiry_idx ON inbound_attachments(expires_at)");
}

type Row = { attachment_id: string; chat_id: string; message_id: string; ordinal: number; kind: "image" | "file"; name: string;
  mime: string; size: number; sha256: string; data?: Buffer; received_at: Date; expires_at: Date };
const reference = (row: Row): AttachmentRef => ({ id: row.attachment_id, kind: row.kind, name: row.name, mime: row.mime, size: row.size, sha256: row.sha256 });

export async function recordInboundAttachment(pool: pg.Pool, attachment: StoredInboundAttachment): Promise<AttachmentRef> {
  validateStoredAttachment(attachment);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // One bounded global attachment budget; the lock also serializes same-slot retries.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('inbound_attachments',0))");
    await client.query("DELETE FROM inbound_attachments WHERE expires_at <= NOW()");
    const existing = await client.query<Row>(
      "SELECT attachment_id,chat_id,message_id,ordinal,kind,name,mime,size,sha256,received_at,expires_at FROM inbound_attachments WHERE chat_id=$1 AND message_id=$2 AND ordinal=$3",
      [attachment.chatId, attachment.messageId, attachment.ordinal]);
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (!sameAttachmentContent(reference(row), attachment)) throw new MediaError(409, "attachment_conflict");
      await client.query("COMMIT");
      return reference(row);
    }
    const used = await client.query<{ used: string; count: string }>(
      "SELECT COALESCE(SUM(size),0)::text AS used, COUNT(*)::text AS count FROM inbound_attachments");
    if (Number(used.rows[0].count) >= MAX_STORED_ATTACHMENTS || Number(used.rows[0].used) + attachment.size > MAX_STORED_ATTACHMENT_BYTES) {
      throw new MediaError(429, "attachment_storage_full");
    }
    await client.query(
      "INSERT INTO inbound_attachments(attachment_id,chat_id,message_id,ordinal,kind,name,mime,size,sha256,data,received_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [attachment.id, attachment.chatId, attachment.messageId, attachment.ordinal, attachment.kind, attachment.name, attachment.mime,
        attachment.size, attachment.sha256, attachment.data, new Date(attachment.receivedAt), new Date(attachment.expiresAt)]);
    await client.query("COMMIT");
    return attachmentRef(attachment);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function listInboundAttachments(pool: pg.Pool, chatId: string, receivedAfter: number, now: number,
  limit: number): Promise<AttachmentListing[]> {
  const result = await pool.query<Row>(
    `SELECT attachment_id,chat_id,message_id,ordinal,kind,name,mime,size,sha256,received_at,expires_at FROM inbound_attachments
     WHERE chat_id=$1 AND received_at>=$2 AND expires_at>$3 ORDER BY received_at DESC, ordinal DESC LIMIT $4`,
    [chatId, new Date(receivedAfter), new Date(now), limit]);
  return result.rows.map(row => ({ ...reference(row), receivedAt: row.received_at.getTime() }));
}

export async function getInboundAttachment(pool: pg.Pool, chatId: string, attachmentId: string,
  now: number): Promise<StoredInboundAttachment | null> {
  const result = await pool.query<Row>(
    "SELECT * FROM inbound_attachments WHERE attachment_id=$1 AND chat_id=$2 AND expires_at>$3", [attachmentId, chatId, new Date(now)]);
  const row = result.rows[0];
  return row && row.data ? { ...reference(row), chatId: row.chat_id, messageId: row.message_id, ordinal: row.ordinal,
    receivedAt: row.received_at.getTime(), expiresAt: row.expires_at.getTime(), data: row.data } : null;
}
