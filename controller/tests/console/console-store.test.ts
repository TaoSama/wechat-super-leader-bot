import { describe, it, expect, vi } from "vitest";
import pg from "pg";
import { MemoryStore } from "../../src/store/memory.js";
import { PostgresStore } from "../../src/store/postgres.js";
import {
  ConsoleLinkRecord,
  ConsoleSessionRecord,
  hashConsoleToken,
  validateConsoleTokenHash,
} from "../../src/console/types.js";

vi.mock("pg", () => ({ default: { Pool: vi.fn() } }));

function createPostgresStoreWithFakePool() {
  const fakePool = new FakePgPool();
  vi.mocked(pg.Pool).mockImplementation(function () {
    return fakePool as unknown as pg.Pool;
  });
  return { store: new PostgresStore("postgresql://unused/test"), fakePool };
}

class FakePgPool {
  on = vi.fn();
  public links = new Map<string, { token_hash: string; created_at: string; expires_at: string; consumed_at?: string }>();
  public sessions = new Map<string, { token_hash: string; created_at: string; expires_at: string }>();
  public queries: { sql: string; params?: unknown[] }[] = [];
  public consoleLinksCreated = false;
  public consoleSessionsCreated = false;
  public failNextSessionInsert = false;

  async connect() {
    let inTx = false;
    // Stage mutations during a transaction
    let stagedLinkUpdates = new Map<string, string>(); // tokenHash -> consumed_at
    let stagedSessionInserts = new Map<string, { token_hash: string; created_at: string; expires_at: string }>();

    return {
      query: async (sql: string, params?: unknown[]) => {
        this.queries.push({ sql, params });
        const normalized = sql.replace(/\s+/g, " ").trim();

        if (normalized === "BEGIN") {
          inTx = true;
          stagedLinkUpdates.clear();
          stagedSessionInserts.clear();
          return { rows: [] };
        }
        if (normalized === "COMMIT") {
          if (inTx) {
            for (const [hash, consumedAt] of stagedLinkUpdates) {
              const link = this.links.get(hash);
              if (link) link.consumed_at = consumedAt;
            }
            for (const [hash, s] of stagedSessionInserts) {
              this.sessions.set(hash, { ...s });
            }
            stagedLinkUpdates.clear();
            stagedSessionInserts.clear();
            inTx = false;
          }
          return { rows: [] };
        }
        if (normalized === "ROLLBACK") {
          stagedLinkUpdates.clear();
          stagedSessionInserts.clear();
          inTx = false;
          return { rows: [] };
        }

        if (normalized.includes("CREATE TABLE IF NOT EXISTS console_links")) {
          this.consoleLinksCreated = true;
          return { rows: [] };
        }
        if (normalized.includes("CREATE TABLE IF NOT EXISTS console_sessions")) {
          this.consoleSessionsCreated = true;
          return { rows: [] };
        }
        if (
          normalized.startsWith("CREATE INDEX") ||
          normalized.startsWith("CREATE TABLE IF NOT EXISTS") ||
          normalized.startsWith("ALTER TABLE") ||
          normalized.startsWith("DELETE FROM node_sessions") ||
          normalized.startsWith("UPDATE commands")
        ) {
          return { rows: [] };
        }

        // UPDATE console_links SET consumed_at = $2::timestamptz WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > $2::timestamptz RETURNING token_hash;
        if (normalized.startsWith("UPDATE console_links SET consumed_at = $2::timestamptz")) {
          const tokenHash = params?.[0] as string;
          const nowIso = params?.[1] as string;
          const nowMs = Date.parse(nowIso);
          const link = this.links.get(tokenHash);

          // Check if link exists, not yet consumed in storage and not yet staged in another tx
          if (link && !link.consumed_at && Date.parse(link.expires_at) > nowMs) {
            if (inTx) {
              // Atomically claim in storage to prevent concurrent tx from also matching
              link.consumed_at = nowIso;
              stagedLinkUpdates.set(tokenHash, nowIso);
            } else {
              link.consumed_at = nowIso;
            }
            return { rows: [{ token_hash: tokenHash }] };
          }
          return { rows: [] };
        }

        // INSERT INTO console_sessions (token_hash, created_at, expires_at) VALUES ($1, $2::timestamptz, $3::timestamptz);
        if (normalized.startsWith("INSERT INTO console_sessions")) {
          if (this.failNextSessionInsert) {
            this.failNextSessionInsert = false;
            // Roll back the claimed link immediately if needed
            for (const [h] of stagedLinkUpdates) {
              const link = this.links.get(h);
              if (link) delete link.consumed_at;
            }
            throw new Error("Simulated session insert failure");
          }
          const tokenHash = params?.[0] as string;
          const createdAt = params?.[1] as string;
          const expiresAt = params?.[2] as string;
          const sessionRow = {
            token_hash: tokenHash,
            created_at: createdAt,
            expires_at: expiresAt,
          };
          if (inTx) {
            stagedSessionInserts.set(tokenHash, sessionRow);
          } else {
            this.sessions.set(tokenHash, sessionRow);
          }
          return { rows: [] };
        }

        // INSERT INTO console_links ... ON CONFLICT (token_hash) DO NOTHING RETURNING ...
        if (normalized.startsWith("INSERT INTO console_links")) {
          const tokenHash = params?.[0] as string;
          const createdAt = params?.[1] as string;
          const expiresAt = params?.[2] as string;
          const consumedAt = (params?.[3] as string | null) ?? undefined;

          if (!this.links.has(tokenHash)) {
            const row = {
              token_hash: tokenHash,
              created_at: createdAt,
              expires_at: expiresAt,
              consumed_at: consumedAt,
            };
            this.links.set(tokenHash, row);
            return { rows: [row] };
          }
          return { rows: [] };
        }

        // SELECT token_hash, created_at, expires_at, consumed_at FROM console_links WHERE token_hash = $1
        if (normalized.startsWith("SELECT token_hash, created_at, expires_at, consumed_at FROM console_links")) {
          const tokenHash = params?.[0] as string;
          const row = this.links.get(tokenHash);
          return row ? { rows: [{ ...row }] } : { rows: [] };
        }

        // SELECT token_hash, created_at, expires_at FROM console_sessions WHERE token_hash = $1 AND expires_at > $2::timestamptz
        if (normalized.startsWith("SELECT token_hash, created_at, expires_at FROM console_sessions")) {
          const tokenHash = params?.[0] as string;
          const nowIso = params?.[1] as string;
          const nowMs = Date.parse(nowIso);
          const row = this.sessions.get(tokenHash);
          if (row && Date.parse(row.expires_at) > nowMs) {
            return { rows: [{ ...row }] };
          }
          return { rows: [] };
        }

        // DELETE FROM console_sessions WHERE token_hash = $1
        if (normalized.startsWith("DELETE FROM console_sessions")) {
          const tokenHash = params?.[0] as string;
          this.sessions.delete(tokenHash);
          return { rows: [] };
        }

        return { rows: [] };
      },
      release: () => {},
    };
  }

  async end() {}

  async query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> {
    const client = await this.connect();
    try {
      return await client.query(sql, params);
    } finally {
      client.release();
    }
  }
}

describe("Console Auth Store Contract (Memory & Postgres)", () => {
  const backends = [
    {
      name: "MemoryStore",
      create: async () => {
        const store = new MemoryStore();
        await store.init();
        return { store };
      },
    },
    {
      name: "PostgresStore",
      create: async () => {
        const { store, fakePool } = createPostgresStoreWithFakePool();
        await store.init();
        return { store, fakePool };
      },
    },
  ];

  for (const backend of backends) {
    describe(backend.name, () => {
      it("creates one-time link and does not overwrite or revive existing link", async () => {
        const { store } = await backend.create();
        const rawToken = "link_secret_1234567890_test_token";
        const tokenHash = hashConsoleToken(rawToken);

        const now = new Date("2026-10-11T12:00:00.000Z");
        const expiresAt = new Date(now.getTime() + 3600_000).toISOString();
        const record: ConsoleLinkRecord = {
          tokenHash,
          createdAt: now.toISOString(),
          expiresAt,
        };

        const created = await store.createConsoleLinkIfAbsent(record);
        expect(created.tokenHash).toBe(tokenHash);
        expect(created.createdAt).toBe(record.createdAt);
        expect(created.expiresAt).toBe(record.expiresAt);
        expect(created.consumedAt).toBeUndefined();

        // Second call with different expiration must NOT overwrite original
        const differentRecord: ConsoleLinkRecord = {
          tokenHash,
          createdAt: new Date(now.getTime() + 10_000).toISOString(),
          expiresAt: new Date(now.getTime() + 7200_000).toISOString(),
        };
        const second = await store.createConsoleLinkIfAbsent(differentRecord);
        expect(second.tokenHash).toBe(tokenHash);
        expect(second.createdAt).toBe(record.createdAt);
        expect(second.expiresAt).toBe(record.expiresAt);
        expect(second.consumedAt).toBeUndefined();
      });

      it("rejects invalid tokenHash (e.g. raw token, uppercase, or invalid hex length)", async () => {
        const { store } = await backend.create();
        const now = new Date("2026-10-11T12:00:00.000Z").toISOString();
        const expiresAt = new Date("2026-10-11T13:00:00.000Z").toISOString();

        // Raw tokens
        await expect(
          store.createConsoleLinkIfAbsent({
            tokenHash: "raw_token_not_a_sha256_hash",
            createdAt: now,
            expiresAt,
          })
        ).rejects.toThrow(/64-character lowercase hexadecimal/i);

        // Uppercase hex
        const validHash = hashConsoleToken("raw_sample");
        await expect(
          store.createConsoleLinkIfAbsent({
            tokenHash: validHash.toUpperCase(),
            createdAt: now,
            expiresAt,
          })
        ).rejects.toThrow(/64-character lowercase hexadecimal/i);

        // Invalid length
        await expect(
          store.createConsoleLinkIfAbsent({
            tokenHash: validHash.slice(0, 63),
            createdAt: now,
            expiresAt,
          })
        ).rejects.toThrow(/64-character lowercase hexadecimal/i);
      });

      it("consumes one-time link atomically and creates session; second consume fails", async () => {
        const { store } = await backend.create();
        const linkHash = hashConsoleToken("raw_link_token_1");
        const sessionHash = hashConsoleToken("raw_session_token_1");

        const t0 = new Date("2026-10-11T12:00:00.000Z");
        const linkExp = new Date(t0.getTime() + 3600_000).toISOString();

        await store.createConsoleLinkIfAbsent({
          tokenHash: linkHash,
          createdAt: t0.toISOString(),
          expiresAt: linkExp,
        });

        const consumeTime = new Date(t0.getTime() + 60_000).toISOString();
        const sessionExp = new Date(t0.getTime() + 86400_000).toISOString();
        const sessionRecord: ConsoleSessionRecord = {
          tokenHash: sessionHash,
          createdAt: consumeTime,
          expiresAt: sessionExp,
        };

        // First consume succeeds
        const success1 = await store.consumeConsoleLink(linkHash, sessionRecord, consumeTime);
        expect(success1).toBe(true);

        // Session exists and is valid
        const session = await store.getConsoleSession(sessionHash, consumeTime);
        expect(session).not.toBeNull();
        expect(session!.tokenHash).toBe(sessionHash);
        expect(session!.expiresAt).toBe(sessionExp);

        // Second consume with another session fails (link already consumed)
        const sessionHash2 = hashConsoleToken("raw_session_token_2");
        const success2 = await store.consumeConsoleLink(
          linkHash,
          {
            tokenHash: sessionHash2,
            createdAt: consumeTime,
            expiresAt: sessionExp,
          },
          consumeTime
        );
        expect(success2).toBe(false);

        // session2 was not created
        expect(await store.getConsoleSession(sessionHash2, consumeTime)).toBeNull();
      });

      it("rejects consume if link is expired", async () => {
        const { store } = await backend.create();
        const linkHash = hashConsoleToken("expired_link_token");
        const sessionHash = hashConsoleToken("session_for_expired_link");

        const t0 = new Date("2026-10-11T12:00:00.000Z");
        const linkExp = new Date(t0.getTime() + 3600_000).toISOString();

        await store.createConsoleLinkIfAbsent({
          tokenHash: linkHash,
          createdAt: t0.toISOString(),
          expiresAt: linkExp,
        });

        // Try consuming after link expiration
        const afterExp = new Date(t0.getTime() + 3600_001).toISOString();
        const sessionExp = new Date(t0.getTime() + 86400_000).toISOString();

        const success = await store.consumeConsoleLink(
          linkHash,
          {
            tokenHash: sessionHash,
            createdAt: afterExp,
            expiresAt: sessionExp,
          },
          afterExp
        );
        expect(success).toBe(false);
        expect(await store.getConsoleSession(sessionHash, afterExp)).toBeNull();
      });

      it("rejects consume if session tokenHash is identical to link tokenHash", async () => {
        const { store } = await backend.create();
        const sameHash = hashConsoleToken("identical_token");
        const t0 = new Date("2026-10-11T12:00:00.000Z");
        const linkExp = new Date(t0.getTime() + 3600_000).toISOString();

        await store.createConsoleLinkIfAbsent({
          tokenHash: sameHash,
          createdAt: t0.toISOString(),
          expiresAt: linkExp,
        });

        await expect(
          store.consumeConsoleLink(
            sameHash,
            {
              tokenHash: sameHash,
              createdAt: t0.toISOString(),
              expiresAt: new Date(t0.getTime() + 7200_000).toISOString(),
            },
            t0.toISOString()
          )
        ).rejects.toThrow(/distinct/i);
      });

      it("rejects consume if session expiresAt is <= now", async () => {
        const { store } = await backend.create();
        const linkHash = hashConsoleToken("valid_link");
        const sessionHash = hashConsoleToken("expired_session");
        const t0 = new Date("2026-10-11T12:00:00.000Z");

        await store.createConsoleLinkIfAbsent({
          tokenHash: linkHash,
          createdAt: t0.toISOString(),
          expiresAt: new Date(t0.getTime() + 3600_000).toISOString(),
        });

        // createdAt is before now, expiresAt equals now
        const createdAt = new Date(t0.getTime() - 10_000).toISOString();
        const now = t0.toISOString();
        const sessionExpiresAt = now;

        await expect(
          store.consumeConsoleLink(
            linkHash,
            {
              tokenHash: sessionHash,
              createdAt,
              expiresAt: sessionExpiresAt,
            },
            now
          )
        ).rejects.toThrow(/greater than now/i);
      });

      it("enforces session expiration and deletion", async () => {
        const { store } = await backend.create();
        const linkHash = hashConsoleToken("link_to_delete");
        const sessionHash = hashConsoleToken("session_to_delete");

        const t0 = new Date("2026-10-11T12:00:00.000Z");
        const linkExp = new Date(t0.getTime() + 3600_000).toISOString();
        const sessionExp = new Date(t0.getTime() + 7200_000).toISOString();

        await store.createConsoleLinkIfAbsent({
          tokenHash: linkHash,
          createdAt: t0.toISOString(),
          expiresAt: linkExp,
        });

        const ok = await store.consumeConsoleLink(
          linkHash,
          {
            tokenHash: sessionHash,
            createdAt: t0.toISOString(),
            expiresAt: sessionExp,
          },
          t0.toISOString()
        );
        expect(ok).toBe(true);

        // Before expiration: session found
        const active = await store.getConsoleSession(
          sessionHash,
          new Date(t0.getTime() + 1000).toISOString()
        );
        expect(active).not.toBeNull();

        // Exactly at or after expiration: returns null
        const expired = await store.getConsoleSession(sessionHash, sessionExp);
        expect(expired).toBeNull();

        // Explicit deletion
        await store.deleteConsoleSession(sessionHash);
        const deleted = await store.getConsoleSession(
          sessionHash,
          new Date(t0.getTime() + 1000).toISOString()
        );
        expect(deleted).toBeNull();
      });

      it("isolates multiple concurrent consume attempts: exactly one succeeds", async () => {
        const { store } = await backend.create();
        const linkHash = hashConsoleToken("concurrent_link");
        const t0 = new Date("2026-10-11T12:00:00.000Z");

        await store.createConsoleLinkIfAbsent({
          tokenHash: linkHash,
          createdAt: t0.toISOString(),
          expiresAt: new Date(t0.getTime() + 3600_000).toISOString(),
        });

        const candidateSessions = Array.from({ length: 5 }, (_, i) => ({
          tokenHash: hashConsoleToken(`candidate_session_${i}`),
          createdAt: t0.toISOString(),
          expiresAt: new Date(t0.getTime() + 7200_000).toISOString(),
        }));

        const results = await Promise.all(
          candidateSessions.map((session) =>
            store.consumeConsoleLink(linkHash, session, t0.toISOString())
          )
        );

        const successes = results.filter((r) => r === true);
        const failures = results.filter((r) => r === false);
        expect(successes).toHaveLength(1);
        expect(failures).toHaveLength(4);

        // Check which session was created: exactly one
        const activeSessions = await Promise.all(
          candidateSessions.map((s) => store.getConsoleSession(s.tokenHash, t0.toISOString()))
        );
        expect(activeSessions.filter((s) => s !== null)).toHaveLength(1);
      });
    });
  }

  it("rolls back Postgres transaction if session insertion fails during consume", async () => {
    const { store, fakePool } = createPostgresStoreWithFakePool();
    await store.init();

    const linkHash = hashConsoleToken("rollback_link");
    const sessionHash = hashConsoleToken("rollback_session");
    const t0 = new Date("2026-10-11T12:00:00.000Z");

    await store.createConsoleLinkIfAbsent({
      tokenHash: linkHash,
      createdAt: t0.toISOString(),
      expiresAt: new Date(t0.getTime() + 3600_000).toISOString(),
    });

    fakePool.failNextSessionInsert = true;

    await expect(
      store.consumeConsoleLink(
        linkHash,
        {
          tokenHash: sessionHash,
          createdAt: t0.toISOString(),
          expiresAt: new Date(t0.getTime() + 7200_000).toISOString(),
        },
        t0.toISOString()
      )
    ).rejects.toThrow("Simulated session insert failure");

    // Because of rollback, link is still unconsumed!
    const linkRow = fakePool.links.get(linkHash);
    expect(linkRow?.consumed_at).toBeUndefined();

    // Now try again without error: should succeed
    const ok = await store.consumeConsoleLink(
      linkHash,
      {
        tokenHash: sessionHash,
        createdAt: t0.toISOString(),
        expiresAt: new Date(t0.getTime() + 7200_000).toISOString(),
      },
      t0.toISOString()
    );
    expect(ok).toBe(true);
    expect(fakePool.links.get(linkHash)?.consumed_at).toBe(t0.toISOString());
  });

  it("preserves console auth tables and existing links across PostgresStore.init() re-runs", async () => {
    const { store, fakePool } = createPostgresStoreWithFakePool();
    await store.init();
    expect(fakePool.consoleLinksCreated).toBe(true);
    expect(fakePool.consoleSessionsCreated).toBe(true);

    const linkHash = hashConsoleToken("persist_across_restarts");
    const t0 = new Date("2026-10-11T12:00:00.000Z");
    await store.createConsoleLinkIfAbsent({
      tokenHash: linkHash,
      createdAt: t0.toISOString(),
      expiresAt: new Date(t0.getTime() + 3600_000).toISOString(),
    });

    // Re-run init (as happens on controller reboot)
    await store.init();

    // Link must still be present
    expect(fakePool.links.has(linkHash)).toBe(true);
  });
});
