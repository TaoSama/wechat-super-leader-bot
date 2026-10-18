import type pg from "pg";
import { MediaError, type ReplyImage } from "../sessions/media-contracts.js";
import {
  MAX_STORED_IMAGE_BYTES, MAX_STORED_MESSAGE_IMAGES, validateStoredImages, type StoredMessageImage,
} from "../sessions/message-images.js";

export async function initMessageImageTables(client: pg.PoolClient): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS message_images (
    chat_id VARCHAR(64) NOT NULL, message_id VARCHAR(128) NOT NULL,
    image_id UUID NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 2),
    mime VARCHAR(32) NOT NULL, size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 8388608),
    sha256 VARCHAR(64) NOT NULL, data BYTEA NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY(chat_id,message_id,image_id), UNIQUE(chat_id,message_id,ordinal))`);
  await client.query("CREATE INDEX IF NOT EXISTS message_images_expiry_idx ON message_images(expires_at)");
}

type ImageRow = { image_id: string; mime: ReplyImage["mime"]; size: number; sha256: string; data: Buffer; expires_at: Date };
const reference = (row: ImageRow): ReplyImage => ({ id: row.image_id, mime: row.mime, size: row.size, sha256: row.sha256 });

export async function recordMessageImages(pool: pg.Pool, chatId: string, messageId: string,
  images: StoredMessageImage[], expiresAt: number): Promise<ReplyImage[]> {
  validateStoredImages(images);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // One bounded global media budget; this lock also serializes same-message freezing.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('message_images',0))");
    const existing = await client.query<ImageRow>("SELECT * FROM message_images WHERE chat_id=$1 AND message_id=$2 ORDER BY ordinal", [chatId, messageId]);
    if (existing.rows.length) {
      if (existing.rows.some(row => row.expires_at.getTime() <= Date.now())) throw new MediaError(410, "media_expired");
      const prior = existing.rows.map(row => ({ mime: row.mime, size: row.size, sha256: row.sha256 }));
      const next = images.map(image => ({ mime: image.mime, size: image.size, sha256: image.sha256 }));
      if (JSON.stringify(prior) !== JSON.stringify(next)) throw new MediaError(409, "media_message_conflict");
      await client.query("COMMIT");
      return existing.rows.map(reference);
    }
    await client.query("DELETE FROM message_images WHERE expires_at <= NOW()");
    const used = await client.query<{ used: string; count: string }>("SELECT COALESCE(SUM(size),0)::text AS used, COUNT(*)::text AS count FROM message_images");
    if (Number(used.rows[0].count) + images.length > MAX_STORED_MESSAGE_IMAGES ||
        Number(used.rows[0].used) + images.reduce((sum, image) => sum + image.size, 0) > MAX_STORED_IMAGE_BYTES) {
      throw new MediaError(429, "media_storage_full");
    }
    for (const [ordinal, image] of images.entries()) await client.query(
      "INSERT INTO message_images(chat_id,message_id,image_id,ordinal,mime,size,sha256,data,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [chatId, messageId, image.id, ordinal, image.mime, image.size, image.sha256, image.data, new Date(expiresAt)]);
    await client.query("COMMIT");
    return images.map(({ data: _data, ...image }) => image);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function getMessageImage(pool: pg.Pool, chatId: string, messageId: string, imageId: string,
  now: number): Promise<StoredMessageImage | null> {
  const result = await pool.query<ImageRow>(
    "SELECT * FROM message_images WHERE chat_id=$1 AND message_id=$2 AND image_id=$3 AND expires_at>$4",
    [chatId, messageId, imageId, new Date(now)]);
  const row = result.rows[0];
  return row ? { ...reference(row), data: row.data } : null;
}
