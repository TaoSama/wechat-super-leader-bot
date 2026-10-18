import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { getMessageImage, initMessageImageTables, recordMessageImages } from "../../src/store/message-images-postgres.js";
import { MAX_STORED_IMAGE_BYTES, MAX_STORED_MESSAGE_IMAGES, type StoredMessageImage } from "../../src/sessions/message-images.js";

const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const makeImage = (): StoredMessageImage => ({ id: randomUUID(), mime: "image/png", size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"), data: bytes });
function database() {
  const rows: any[] = []; const statements: string[] = []; let pending: any[] = [];
  let failedInsert = false, used = 0, count = 0;
  const query = vi.fn(async (sql: string, args: any[] = []): Promise<any> => {
    statements.push(sql);
    if (sql === "BEGIN") pending = [];
    if (sql === "COMMIT") rows.push(...pending);
    if (sql === "ROLLBACK") pending = [];
    if (sql.startsWith("SELECT * FROM message_images") && sql.includes("ORDER BY")) {
      return { rows: rows.filter(row => row.chat_id === args[0] && row.message_id === args[1]).sort((a, b) => a.ordinal - b.ordinal) };
    }
    if (sql.startsWith("SELECT * FROM message_images")) return { rows: rows.filter(row =>
      row.chat_id === args[0] && row.message_id === args[1] && row.image_id === args[2] && row.expires_at > args[3]) };
    if (sql.startsWith("SELECT COALESCE(SUM(size)")) return { rows: [{ used: String(used), count: String(count) }] };
    if (sql.startsWith("INSERT INTO message_images")) {
      if (failedInsert) throw new Error("synthetic storage failure");
      const [chat_id, message_id, image_id, ordinal, mime, size, sha256, data, expires_at] = args;
      pending.push({ chat_id, message_id, image_id, ordinal, mime, size, sha256, data, expires_at });
    }
    return { rows: [] };
  });
  const release = vi.fn(); const pool = { query, connect: async () => ({ query, release }) } as unknown as pg.Pool;
  return { pool, rows, statements, release, fail: () => { failedInsert = true; }, full: () => { used = MAX_STORED_IMAGE_BYTES; }, maxCount: () => { count = MAX_STORED_MESSAGE_IMAGES; } };
}

describe("PostgreSQL frozen message images", () => {
  it("migrates immutable tuple, ordinal and size constraints", async () => {
    const f = database(); const client = await f.pool.connect(); await initMessageImageTables(client);
    expect(f.statements.join("\n")).toContain("PRIMARY KEY(chat_id,message_id,image_id)");
    expect(f.statements.join("\n")).toContain("UNIQUE(chat_id,message_id,ordinal)");
    expect(f.statements.join("\n")).toContain("size BETWEEN 1 AND 8388608");
  });
  it("commits bytes with exact scoping and returns stable IDs after retry", async () => {
    const f = database(); const image = makeImage(); const expiresAt = Date.now() + 10000;
    const first = await recordMessageImages(f.pool, "chat", "message", [image], expiresAt);
    expect(f.rows).toHaveLength(1); expect(first).toEqual([{ id: image.id, mime: image.mime, size: image.size, sha256: image.sha256 }]);
    expect(await recordMessageImages(f.pool, "chat", "message", [makeImage()], expiresAt)).toEqual(first);
    expect(f.rows).toHaveLength(1);
    expect((await getMessageImage(f.pool, "chat", "message", image.id, Date.now()))?.data).toEqual(bytes);
    expect(await getMessageImage(f.pool, "other", "message", image.id, Date.now())).toBeNull();
    expect(await getMessageImage(f.pool, "chat", "message", image.id, expiresAt)).toBeNull();
    expect(f.release).toHaveBeenCalledTimes(2);
  });
  it("rolls back storage failure and preserves the original failure", async () => {
    const f = database(); f.fail();
    await expect(recordMessageImages(f.pool, "chat", "message", [makeImage()], Date.now() + 10000)).rejects.toThrow("synthetic storage failure");
    expect(f.rows).toHaveLength(0); expect(f.statements.at(-1)).toBe("ROLLBACK"); expect(f.release).toHaveBeenCalledOnce();
  });
  it("refuses the bounded global media budget before inserting", async () => {
    const f = database(); f.full();
    await expect(recordMessageImages(f.pool, "chat", "message", [makeImage()], Date.now() + 10000)).rejects.toMatchObject({ code: "media_storage_full" });
    expect(f.rows).toHaveLength(0); expect(f.statements.some(sql => sql.startsWith("INSERT INTO"))).toBe(false);
  });
  it("bounds metadata count independently of the byte budget", async () => {
    const f = database(); f.maxCount();
    await expect(recordMessageImages(f.pool, "chat", "message", [makeImage()], Date.now() + 10000)).rejects.toMatchObject({ code: "media_storage_full" });
    expect(f.rows).toHaveLength(0);
  });
});
