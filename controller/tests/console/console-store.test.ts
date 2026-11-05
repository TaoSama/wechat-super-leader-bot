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
  public links = new Map<string, { token_hash: string; created_at: string; expires_at: string; consumed_at?: string; chat_id: string | null }>();
  public sessions = new Map<string, { token_hash: string; created_at: string; expires_at: string; chat_id: string | null }>();
  public queries: { sql: string; params?: unknown[] }[] = [];
  public consoleLinksCreated = false;
  public consoleSessionsCreated = false;
  public failNextSessionInsert = false;

  async connect() {
    let inTx = false;
    // Stage mutations during a transaction
    let stagedLinkUpdates = new Map<string, string>(); // tokenHash -> consumed_at
    let stagedSessionInserts = new Map<string, { token_hash: string; created_at: string; expires_at: string; chat_id: string | null }>();

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
              if (link) link.consumed_at ??= consumedAt;
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

        if (normalized.startsWith("UPDATE console_links SET consumed_at = COALESCE(consumed_at, $2::timestamptz)")) {
          const tokenHash = params?.[0] as string;
          const nowIso = params?.[1] as string;
          const nowMs = Date.parse(nowIso);
          const link = this.links.get(tokenHash);

          if (link && Date.parse(link.expires_at) > nowMs) {
            const firstLoginAt = link.consumed_at ?? nowIso;
            if (inTx) {
              stagedLinkUpdates.set(tokenHash, firstLoginAt);
            } else {
              link.consumed_at = firstLoginAt;
            }
            return { rows: [{ token_hash: tokenHash, chat_id: link.chat_id }] };
          }
          return { rows: [] };
        }

        // INSERT INTO console_sessions (token_hash, created_at, expires_at) VALUES ($1, $2::timestamptz, $3::timestamptz);
        if (normalized.startsWith("INSERT INTO console_sessions")) {
          if (this.failNextSessionInsert) {
            this.failNextSessionInsert = false;
            throw new Error("Simulated session insert failure");
          }
          const tokenHash = params?.[0] as string;
          const createdAt = params?.[1] as string;
          const expiresAt = params?.[2] as string;
          const sessionRow = {
            token_hash: tokenHash,
            created_at: createdAt,
            expires_at: expiresAt,
            chat_id: (params?.[3] as string | null) ?? null,
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
              chat_id: (params?.[4] as string | null) ?? null,
            };
            this.links.set(tokenHash, row);
            return { rows: [row] };
          }
          return { rows: [] };
        }

        // SELECT token_hash, created_at, expires_at, consumed_at FROM console_links WHERE token_hash = $1
        if (normalized.startsWith("SELECT token_hash, created_at, expires_at, consumed_at, chat_id FROM console_links")) {
          const tokenHash = params?.[0] as string;
          const row = this.links.get(tokenHash);
          return row ? { rows: [{ ...row }] } : { rows: [] };
        }

        // SELECT token_hash, created_at, expires_at FROM console_sessions WHERE token_hash = $1 AND expires_at > $2::timestamptz
        if (normalized.startsWith("SELECT token_hash, created_at, expires_at, chat_id FROM console_sessions")) {
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
      it("reads an existing link without creating or changing it and returns an isolated record", async () => {
        const { store, fakePool } = await backend.create();
        const tokenHash = hashConsoleToken("read-only-link");
        expect(await store.getConsoleLink(tokenHash)).toBeNull();
        const record = { tokenHash, createdAt: "2026-10-11T12:00:00.000Z", expiresAt: "2026-10-11T13:00:00.000Z" };
        await store.createConsoleLinkIfAbsent(record);
        const queryCount = fakePool?.queries.length;
        const found = await store.getConsoleLink(tokenHash);
        expect(found).toEqual(record);
        found!.expiresAt = "2026-10-11T14:00:00.000Z";
        expect(await store.getConsoleLink(tokenHash)).toEqual(record);
        for (const query of fakePool?.queries.slice(queryCount) ?? []) expect(query.sql.trim()).toMatch(/^SELECT /);
        await expect(store.getConsoleLink("raw-token")).rejects.toThrow(/64-character lowercase hexadecimal/i);
      });

      it("binds sessions to the chat recorded on the consumed link", async () => {
        const { store } = await backend.create();
        const now = "2026-10-11T12:00:00.000Z", expiresAt = "2026-10-11T13:00:00.000Z";
        const bound = hashConsoleToken("chat-bound-link"), unbound = hashConsoleToken("unbound-link");
        await store.createConsoleLinkIfAbsent({ tokenHash: bound, createdAt: now, expiresAt, chatId: "chat-a" });
        await store.createConsoleLinkIfAbsent({ tokenHash: unbound, createdAt: now, expiresAt });
        expect((await store.getConsoleLink(bound))?.chatId).toBe("chat-a");
        const boundSession = hashConsoleToken("bound-session"), unboundSession = hashConsoleToken("unbound-session");
        // The link, never the caller, decides the chat scope.
        expect(await store.consumeConsoleLink(bound, { tokenHash: boundSession, createdAt: now, expiresAt, chatId: "chat-b" }, now)).toBe(true);
        expect(await store.consumeConsoleLink(unbound, { tokenHash: unboundSession, createdAt: now, expiresAt }, now)).toBe(true);
        expect((await store.getConsoleSession(boundSession, now))?.chatId).toBe("chat-a");
        expect((await store.getConsoleSession(unboundSession, now))?.chatId).toBeUndefined();
      });

      it("creates a login link and does not overwrite or revive the existing link", async () => {
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

      it("creates independent sessions on repeat login without changing expiry or first-login audit", async () => {
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

        const nextLoginTime = new Date(t0.getTime() + 120_000).toISOString();
        const sessionHash2 = hashConsoleToken("raw_session_token_2");
        const success2 = await store.consumeConsoleLink(
          linkHash,
          {
            tokenHash: sessionHash2,
            createdAt: nextLoginTime,
            expiresAt: sessionExp,
          },
          nextLoginTime
        );
        expect(success2).toBe(true);
        expect(await store.getConsoleSession(sessionHash2, nextLoginTime)).not.toBeNull();

        const unchangedLink = await store.createConsoleLinkIfAbsent({
          tokenHash: linkHash,
          createdAt: nextLoginTime,
          expiresAt: sessionExp,
        });
        expect(unchangedLink).toEqual({
          tokenHash: linkHash,
          createdAt: t0.toISOString(),
          expiresAt: linkExp,
          consumedAt: consumeTime,
        });
      });

      it.each([0, 1])("rejects login at the original link expiry plus %i ms without creating a session", async offset => {
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
        const afterExp = new Date(Date.parse(linkExp) + offset).toISOString();
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

      it("allows concurrent login attempts with independent sessions", async () => {
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
        expect(successes).toHaveLength(candidateSessions.length);
        expect(failures).toHaveLength(0);

        const activeSessions = await Promise.all(
          candidateSessions.map((s) => store.getConsoleSession(s.tokenHash, t0.toISOString()))
        );
        expect(activeSessions.filter((s) => s !== null)).toHaveLength(candidateSessions.length);
      });

      it("allows an already-used unexpired link while preserving its stored first-login time", async () => {
        const { store } = await backend.create();
        const createdAt = "2026-10-11T12:00:00.000Z";
        const consumedAt = "2026-10-11T12:01:00.000Z";
        const expiresAt = "2026-10-11T13:00:00.000Z";
        const tokenHash = hashConsoleToken("previously_used_link");
        const link = { tokenHash, createdAt, expiresAt, consumedAt };
        await store.createConsoleLinkIfAbsent(link);
        const now = "2026-10-11T12:30:00.000Z";
        expect(await store.consumeConsoleLink(tokenHash, {
          tokenHash: hashConsoleToken("new_session_for_used_link"),
          createdAt: now,
          expiresAt,
        }, now)).toBe(true);
        expect(await store.createConsoleLinkIfAbsent(link)).toEqual(link);
      });
    });
  }

  it.each([undefined, "2026-10-11T11:59:00.000Z"])("preserves first-login audit %s on Postgres session insertion failure", async consumedAt => {
    const { store, fakePool } = createPostgresStoreWithFakePool();
    await store.init();

    const linkHash = hashConsoleToken("rollback_link");
    const sessionHash = hashConsoleToken("rollback_session");
    const t0 = new Date("2026-10-11T12:00:00.000Z");

    await store.createConsoleLinkIfAbsent({
      tokenHash: linkHash,
      createdAt: new Date(t0.getTime() - 600_000).toISOString(),
      expiresAt: new Date(t0.getTime() + 3600_000).toISOString(),
      consumedAt,
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

    const linkRow = fakePool.links.get(linkHash);
    expect(linkRow?.consumed_at).toBe(consumedAt);
    expect(await store.getConsoleSession(sessionHash, t0.toISOString())).toBeNull();

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
    expect(fakePool.links.get(linkHash)?.consumed_at).toBe(consumedAt ?? t0.toISOString());
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
