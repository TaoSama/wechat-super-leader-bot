import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { CLEARED_FALLBACK_TITLE, MemoryFallbackRepository, PostgresFallbackRepository, type FallbackInput, type FallbackRepository } from "../../src/fallback/index.js";

const input: FallbackInput = {
  key: "retention-result", chatId: "synthetic-retention", kind: "completed", title: "Sensitive title", text: "Sensitive body",
  resultId: "retained-result", resultStatus: "completed", expiresAt: 9_000,
};
type Fixture = { repository: FallbackRepository; close(): Promise<void> };

function retentionCases(name: string, fixture: () => Promise<Fixture>, enabled = true): void {
  describe.skipIf(!enabled)(name, () => {
    it("clears terminal bodies at the boundary while preserving immutable metadata and deduplication", async () => {
      const { repository, close } = await fixture();
      try {
        for (const status of ["sent", "failed"] as const) {
          const record = await repository.enqueue({ ...input, key: status }, 1_000);
          const claim = await repository.claim(1_000);
          await repository.settle(record.id, claim!.claimToken!, { status, outcome: "Sensitive response body" }, 1_100);
        }
        const before = await repository.list(input.chatId);
        expect(await repository.cleanupBodies(2_099, 1_000)).toBe(0);
        expect(await repository.cleanupBodies(2_100, 1_000)).toBe(2);
        for (const original of before) {
          const cleaned = await repository.get(original.id);
          const { outcome: _outcome, ...metadata } = original;
          expect(cleaned).toEqual({ ...metadata, text: "", title: CLEARED_FALLBACK_TITLE, bodyClearedAt: 2_100 });
          expect(await repository.enqueue({ ...input, key: original.key, text: "Resurrected body" }, 5_000)).toEqual(cleaned);
        }
        expect(await repository.cleanupBodies(10_000, 0)).toBe(0);
        expect(await repository.claim(10_000)).toBeUndefined();
        expect((await repository.list(input.chatId)).map((record) => record.bodyClearedAt)).toEqual([2_100, 2_100]);
      } finally { await close(); }
    });

    it("protects pending, active sending, and unknown records regardless of age", async () => {
      const { repository, close } = await fixture();
      try {
        const unknown = await repository.enqueue({ ...input, key: "unknown" }, 1_000);
        const uncertainClaim = await repository.claim(1_000);
        await repository.settle(unknown.id, uncertainClaim!.claimToken!, { status: "unknown", outcome: "Uncertain response body" }, 1_100);
        const sending = await repository.enqueue({ ...input, key: "sending" }, 1_200);
        await repository.claim(1_200);
        const pending = await repository.enqueue({ ...input, key: "pending" }, 1_300);
        const before = await Promise.all([unknown, sending, pending].map((record) => repository.get(record.id)));
        expect(await repository.cleanupBodies(1_000_000, 0)).toBe(0);
        expect(await Promise.all([unknown, sending, pending].map((record) => repository.get(record.id)))).toEqual(before);
      } finally { await close(); }
    });

    it("atomically counts concurrent cleanup once and rejects invalid retention arguments", async () => {
      const { repository, close } = await fixture();
      try {
        const record = await repository.enqueue(input, 1_000);
        const claim = await repository.claim(1_000);
        await repository.settle(record.id, claim!.claimToken!, { status: "sent", outcome: "accepted" }, 1_100);
        const counts = await Promise.all(Array.from({ length: 8 }, () => repository.cleanupBodies(2_100, 1_000)));
        expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1);
        for (const [now, retention] of [[NaN, 1_000], [-1, 1_000], [1_000, -1], [1_000, Infinity], [1_000, 0.5]]) {
          await expect(repository.cleanupBodies(now, retention)).rejects.toThrow("Invalid fallback body retention");
        }
        expect(await repository.get(record.id)).toMatchObject({ updatedAt: 1_100, bodyClearedAt: 2_100 });
      } finally { await close(); }
    });
  });
}

retentionCases("fallback Memory body retention", async () => ({ repository: new MemoryFallbackRepository(), close: async () => {} }));

// Every test creates and drops its own schema. No application tables are accessed.
const databaseUrl = process.env.FALLBACK_RETENTION_TEST_DATABASE_URL;
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  const localSocket = parsed.hostname === "" && parsed.searchParams.get("host") === "/tmp";
  const disposableDatabase = parsed.hostname === "127.0.0.1" && parsed.pathname === "/fallback_test";
  if (!localSocket && !disposableDatabase) throw new Error("Fallback retention tests require a local Unix socket or disposable loopback fallback_test database");
}
retentionCases("fallback PostgreSQL body retention", async () => {
  const schema = `fallback_retention_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl });
  let pool: pg.Pool | undefined;
  const close = async () => {
    try { await pool?.end(); }
    finally {
      try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
      finally { await admin.end(); }
    }
  };
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    const repository = new PostgresFallbackRepository(pool);
    await repository.init(1_000);
    return { repository, close };
  } catch (error) {
    await close();
    throw error;
  }
}, Boolean(databaseUrl));
