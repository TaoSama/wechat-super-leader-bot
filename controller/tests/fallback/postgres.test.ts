import pg from "pg";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { FallbackService, PostgresFallbackRepository } from "../../src/fallback/index.js";

// Opt-in synthetic database only; ordinary unit runs never access a user's database.
const databaseUrl = process.env.FALLBACK_TEST_DATABASE_URL;
if (databaseUrl) {
  const parsed = new URL(databaseUrl);
  if (parsed.hostname !== "127.0.0.1" || parsed.pathname !== "/fallback_test") {
    throw new Error("FALLBACK_TEST_DATABASE_URL must point to a disposable loopback fallback_test database");
  }
}

describe.skipIf(!databaseUrl)("fallback PostgreSQL persistence", () => {
  it("atomically deduplicates, claims once, and recovers crash state across repository instances", async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const repository = new PostgresFallbackRepository(pool);
    try {
      await repository.init(1_000);
      const input = { key: "postgres-dedupe", chatId: `synthetic-${randomUUID()}`, kind: "completed" as const, title: "Synthetic task", text: "Persisted full result reference", resultId: "result-123" };
      const records = await Promise.all(Array.from({ length: 8 }, () => repository.enqueue(input, 1_000)));
      expect(new Set(records.map((record) => record.id)).size).toBe(1);
      const claims = await Promise.all(Array.from({ length: 8 }, () => repository.claim(1_000)));
      const claimed = claims.filter((record) => record !== undefined);
      expect(claimed).toHaveLength(1);
      const resumed = new PostgresFallbackRepository(pool);
      await Promise.all([repository.init(1_500), resumed.init(1_500)]);
      expect(await resumed.get(records[0].id)).toMatchObject({ status: "sending", attempts: 1, resultId: "result-123", claimExpiresAt: 61_000 });
      await repository.settle(records[0].id, claimed[0].claimToken!, { status: "sent", outcome: "endpoint_accepted_http_202" }, 2_000);
      expect(await resumed.get(records[0].id)).toMatchObject({ status: "sent", updatedAt: 2_000 });
      const second = await resumed.enqueue({ ...input, key: "expired-sender" }, 2_000);
      const secondClaim = await resumed.claim(2_000);
      await repository.init(61_999);
      expect(await resumed.get(second.id)).toMatchObject({ status: "sending" });
      await resumed.init(62_000);
      expect(await repository.get(second.id)).toMatchObject({ status: "unknown", updatedAt: 62_000, outcome: "submission_lease_expired" });
      await expect(repository.settle(second.id, secondClaim!.claimToken!, { status: "sent", outcome: "stale-worker" }, 62_001)).rejects.toThrow();
      const expired = await resumed.enqueue({ ...input, key: "expired-before-send", expiresAt: 64_000 }, 63_000);
      expect(await resumed.claim(64_000)).toBeUndefined();
      expect(await resumed.get(expired.id)).toMatchObject({ status: "failed", outcome: "expired_before_submission" });
      const polled = await resumed.enqueue({ ...input, key: "expired-during-polling" }, 65_000);
      await repository.claim(65_000, 1_000);
      expect(await resumed.claim(66_000)).toBeUndefined();
      expect(await repository.get(polled.id)).toMatchObject({ status: "unknown", outcome: "submission_lease_expired" });
      expect(await resumed.list(input.chatId)).toHaveLength(4);
    } finally {
      await pool.end();
    }
  });
  it("persists eligibility skip after a queued 429 without submitting again", async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    const repository = new PostgresFallbackRepository(pool);
    let now = 100_000;
    let superseded = false;
    const chatId = `synthetic-${randomUUID()}`;
    const fetcher = vi.fn(async () => new Response(null, { status: 429 }));
    try {
      await repository.init(now);
      const service = new FallbackService(repository, { endpoints: new Map([[chatId, "https://example.test/webhook"]]),
        now: () => now, fetch: fetcher as typeof fetch,
        materialize: async () => superseded ? { skip: "result_superseded" } : {} });
      const record = await service.enqueue({ key: "old-result", chatId, kind: "completed", title: "Synthetic", text: "Stale result" });
      await service.drain();
      expect(await repository.get(record!.id)).toMatchObject({ status: "pending", outcome: "endpoint_rate_limited_http_429" });
      superseded = true;
      now += 30_000;
      await service.drain();
      const resumed = new PostgresFallbackRepository(pool);
      await resumed.init(now);
      expect(await resumed.get(record!.id)).toMatchObject({ status: "failed", outcome: "skipped_result_superseded", attempts: 2 });
      expect(await resumed.claim(now + 1_000_000)).toBeUndefined();
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      await pool.end();
    }
  });
});
