import { describe, it, expect, vi } from "vitest";
import pg from "pg";
import { MemoryStore } from "../../src/store/memory.js";
import { PostgresStore } from "../../src/store/postgres.js";
import { MAX_CHAT_ID_LENGTH, MAX_LEADER_DATA_BYTES } from "../../src/leader/state.js";

vi.mock("pg", () => ({ default: { Pool: vi.fn() } }));

function createPostgresStoreWithFakePool() {
  const fakePool = new FakePgPool();
  vi.mocked(pg.Pool).mockImplementation(function () { return fakePool as unknown as pg.Pool; });
  return { store: new PostgresStore("postgresql://unused/test"), fakePool };
}

class FakePgPool {
  on = vi.fn();
  public rows = new Map<string, { chat_id: string; revision: number; data: Record<string, unknown>; updated_at: string }>();
  public nodeSessionsClearedCount = 0;
  public versions = new Set<number>();
  public leaderStatesCreated = false;
  public queries: { sql: string; params?: unknown[] }[] = [];

  async connect() {
    return {
      query: async (sql: string, params?: unknown[]) => this.query(sql, params),
      release: () => {},
    };
  }

  async end() {}

  async query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> {
    this.queries.push({ sql, params });
    const normalized = sql.replace(/\s+/g, " ").trim();

    if (normalized === "SELECT version FROM controller_schema_migrations") {
      return { rows: [...this.versions].map(version => ({ version })) };
    }
    if (normalized === "INSERT INTO controller_schema_migrations(version) VALUES($1)") {
      this.versions.add(Number(params?.[0])); return { rows: [] };
    }

    if (normalized.includes("CREATE TABLE IF NOT EXISTS leader_states")) {
      this.leaderStatesCreated = true;
      return { rows: [] };
    }

    if (normalized.startsWith("DELETE FROM node_sessions")) {
      this.nodeSessionsClearedCount += 1;
      return { rows: [] };
    }

    if (
      normalized === "BEGIN" ||
      normalized === "COMMIT" ||
      normalized === "ROLLBACK" ||
      normalized.startsWith("CREATE TABLE IF NOT EXISTS") ||
      normalized.startsWith("UPDATE commands")
    ) {
      return { rows: [] };
    }

    if (normalized.startsWith("SELECT chat_id, revision, data, updated_at FROM leader_states WHERE chat_id = $1")) {
      const chatId = params?.[0] as string;
      const row = this.rows.get(chatId);
      if (!row) return { rows: [] };
      return {
        rows: [
          {
            chat_id: row.chat_id,
            revision: row.revision,
            data: JSON.parse(JSON.stringify(row.data)),
            updated_at: row.updated_at,
          },
        ],
      };
    }

    if (normalized.startsWith("INSERT INTO leader_states") || normalized.startsWith("UPDATE leader_states")) {
      const inserting = normalized.startsWith("INSERT");
      const chatId = params?.[0] as string;
      const expectedRevision = inserting ? 0 : params?.[1] as number;
      const jsonStr = params?.[inserting ? 1 : 2] as string;
      const updatedAt = params?.[inserting ? 2 : 3] as string;
      const parsedData = JSON.parse(jsonStr);

      const existing = this.rows.get(chatId);
      if (!existing) {
        if (expectedRevision !== 0) {
          return { rows: [] };
        }
        const created = {
          chat_id: chatId,
          revision: 1,
          data: parsedData,
          updated_at: updatedAt,
        };
        this.rows.set(chatId, created);
        return {
          rows: [
            {
              chat_id: created.chat_id,
              revision: created.revision,
              data: JSON.parse(JSON.stringify(created.data)),
              updated_at: created.updated_at,
            },
          ],
        };
      }

      if (existing.revision !== expectedRevision) {
        return { rows: [] };
      }

      const updated = {
        chat_id: chatId,
        revision: existing.revision + 1,
        data: parsedData,
        updated_at: updatedAt,
      };
      this.rows.set(chatId, updated);
      return {
        rows: [
          {
            chat_id: updated.chat_id,
            revision: updated.revision,
            data: JSON.parse(JSON.stringify(updated.data)),
            updated_at: updated.updated_at,
          },
        ],
      };
    }

    return { rows: [] };
  }
}


describe("LeaderState Persistence & CAS Contract", () => {
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
      it("returns null for unknown chatId and creates revision 1 only when expectedRevision=0", async () => {
        const { store } = await backend.create();

        expect(await store.getLeaderState("chat-init")).toBeNull();

        // expectedRevision > 0 on missing record must fail and return null
        expect(
          await store.compareAndSetLeaderState("chat-init", 1, { step: "should-not-create" })
        ).toBeNull();
        expect(await store.getLeaderState("chat-init")).toBeNull();

        // expectedRevision = 0 inserts with revision = 1
        const created = await store.compareAndSetLeaderState("chat-init", 0, {
          memories: { lang: "zh" },
          pending: undefined,
        });
        expect(created).not.toBeNull();
        expect(created!.chatId).toBe("chat-init");
        expect(created!.revision).toBe(1);
        expect(created!.data).toEqual({ memories: { lang: "zh" } });
        expect(Object.prototype.hasOwnProperty.call(created!.data, "pending")).toBe(false);
        expect(typeof created!.updatedAt).toBe("string");

        // Second insert with expectedRevision = 0 must fail
        expect(
          await store.compareAndSetLeaderState("chat-init", 0, { memories: { lang: "en" } })
        ).toBeNull();
      });

      it("increments revision on matching expectedRevision and returns null on stale/competing CAS", async () => {
        const { store } = await backend.create();

        const s1 = await store.compareAndSetLeaderState("chat-cas", 0, { count: 1 });
        expect(s1?.revision).toBe(1);

        // Concurrent competing updates against revision 1
        const [rA, rB] = await Promise.all([
          store.compareAndSetLeaderState("chat-cas", 1, { count: 2, winner: "A" }),
          store.compareAndSetLeaderState("chat-cas", 1, { count: 2, winner: "B" }),
        ]);

        const successes = [rA, rB].filter((r) => r !== null);
        const failures = [rA, rB].filter((r) => r === null);
        expect(successes).toHaveLength(1);
        expect(failures).toHaveLength(1);
        expect(successes[0]!.revision).toBe(2);

        // Stale revision 1 or ahead revision 3 returns null
        expect(await store.compareAndSetLeaderState("chat-cas", 1, { count: 99 })).toBeNull();
        expect(await store.compareAndSetLeaderState("chat-cas", 3, { count: 99 })).toBeNull();

        // Subsequent update with revision 2 succeeds and increments to 3
        const s3 = await store.compareAndSetLeaderState("chat-cas", 2, { count: 3 });
        expect(s3?.revision).toBe(3);
        expect(s3?.data).toEqual({ count: 3 });
      });

      it("isolates state across different chatIds", async () => {
        const { store } = await backend.create();

        await store.compareAndSetLeaderState("chat-alpha", 0, { owner: "alpha", items: [1, 2] });
        await store.compareAndSetLeaderState("chat-beta", 0, { owner: "beta", items: [3, 4] });

        const alpha = await store.getLeaderState("chat-alpha");
        const beta = await store.getLeaderState("chat-beta");

        expect(alpha?.data).toEqual({ owner: "alpha", items: [1, 2] });
        expect(beta?.data).toEqual({ owner: "beta", items: [3, 4] });

        await store.compareAndSetLeaderState("chat-alpha", 1, { owner: "alpha-updated" });
        expect((await store.getLeaderState("chat-alpha"))?.revision).toBe(2);
        expect((await store.getLeaderState("chat-beta"))?.revision).toBe(1);
        expect((await store.getLeaderState("chat-beta"))?.data).toEqual({ owner: "beta", items: [3, 4] });
      });

      it("enforces deep clone isolation against external mutation on input and output", async () => {
        const { store } = await backend.create();

        const inputData: Record<string, unknown> = {
          nested: { arr: ["a", "b"], flag: true },
          optionalCleared: undefined,
        };

        const created = await store.compareAndSetLeaderState("chat-clone", 0, inputData);
        expect(created).not.toBeNull();

        // Mutate original input object after save
        (inputData.nested as any).arr.push("mutated-input");
        (inputData.nested as any).flag = false;

        // Mutate returned state object from compareAndSetLeaderState
        (created!.data.nested as any).arr.push("mutated-created");

        const fetched1 = await store.getLeaderState("chat-clone");
        expect(fetched1?.data).toEqual({
          nested: { arr: ["a", "b"], flag: true },
        });

        // Mutate returned state object from getLeaderState
        (fetched1!.data.nested as any).arr.push("mutated-fetched");

        const fetched2 = await store.getLeaderState("chat-clone");
        expect(fetched2?.data).toEqual({
          nested: { arr: ["a", "b"], flag: true },
        });
      });

      it("validates chatId, expectedRevision, JSON serializability, and 256KiB size boundary", async () => {
        const { store } = await backend.create();

        // Invalid chatIds
        for (const badChatId of [
          "",
          "   ",
          " leading",
          "trailing ",
          "line\nbreak",
          "null\x00char",
          "a".repeat(MAX_CHAT_ID_LENGTH + 1),
        ]) {
          await expect(store.getLeaderState(badChatId)).rejects.toThrow(/chatId/i);
          await expect(store.compareAndSetLeaderState(badChatId, 0, {})).rejects.toThrow(/chatId/i);
        }

        // Exact 64-char chatId is allowed
        const maxChatId = "c".repeat(MAX_CHAT_ID_LENGTH);
        const okMaxChat = await store.compareAndSetLeaderState(maxChatId, 0, { ok: true });
        expect(okMaxChat?.chatId).toBe(maxChatId);

        // Invalid expectedRevision
        for (const badRev of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
          await expect(store.compareAndSetLeaderState("chat-valid", badRev, {})).rejects.toThrow(
            /expectedRevision/i
          );
        }

        // Non-plain root or non-JSON values
        await expect(
          store.compareAndSetLeaderState("chat-valid", 0, null as unknown as Record<string, unknown>)
        ).rejects.toThrow();
        await expect(
          store.compareAndSetLeaderState("chat-valid", 0, [] as unknown as Record<string, unknown>)
        ).rejects.toThrow();
        await expect(
          store.compareAndSetLeaderState("chat-valid", 0, { bad: Number.NaN })
        ).rejects.toThrow();
        await expect(
          store.compareAndSetLeaderState("chat-valid", 0, { bad: Number.POSITIVE_INFINITY })
        ).rejects.toThrow();
        await expect(
          store.compareAndSetLeaderState("chat-valid", 0, { bad: BigInt(10) })
        ).rejects.toThrow();
        await expect(
          store.compareAndSetLeaderState("chat-valid", 0, { bad: () => {} })
        ).rejects.toThrow();
        await expect(
          store.compareAndSetLeaderState("chat-valid", 0, { arrWithUndefined: [undefined] })
        ).rejects.toThrow();

        // Circular reference
        const circular: Record<string, unknown> = { a: 1 };
        circular.self = circular;
        await expect(store.compareAndSetLeaderState("chat-valid", 0, circular)).rejects.toThrow(
          /circular/i
        );

        // Size boundary <= 256KiB allowed, > 256KiB rejected
        const exactPayloadSize = MAX_LEADER_DATA_BYTES - '{"blob":""}'.length;
        const exactData = { blob: "x".repeat(exactPayloadSize) };
        expect(Buffer.byteLength(JSON.stringify(exactData), "utf8")).toBe(MAX_LEADER_DATA_BYTES);

        const exactSaved = await store.compareAndSetLeaderState("chat-size", 0, exactData);
        expect(exactSaved?.revision).toBe(1);

        const overData = { blob: "x".repeat(exactPayloadSize + 1) };
        expect(Buffer.byteLength(JSON.stringify(overData), "utf8")).toBe(MAX_LEADER_DATA_BYTES + 1);
        await expect(store.compareAndSetLeaderState("chat-size", 1, overData)).rejects.toThrow(
          /exceeds limit/i
        );
      });
    });
  }

  it("prevents colon collision in MemoryStore message composite keys", async () => {
    const store = new MemoryStore();
    await store.init();

    const now = new Date().toISOString();
    await store.recordMessage({
      chatId: "a:b",
      messageId: "c",
      text: "first",
      replyText: "reply-first",
      createdAt: now,
    });
    await store.recordMessage({
      chatId: "a",
      messageId: "b:c",
      text: "second",
      replyText: "reply-second",
      createdAt: now,
    });

    const m1 = await store.getMessage("a:b", "c");
    const m2 = await store.getMessage("a", "b:c");

    expect(m1?.text).toBe("first");
    expect(m1?.replyText).toBe("reply-first");
    expect(m2?.text).toBe("second");
    expect(m2?.replyText).toBe("reply-second");
  });

  it("preserves leader_states across PostgresStore.init() and migrates stale node_sessions once", async () => {
    const { store, fakePool } = createPostgresStoreWithFakePool();
    await store.init();
    expect(fakePool.leaderStatesCreated).toBe(true);
    expect(fakePool.nodeSessionsClearedCount).toBe(1);

    const saved = await store.compareAndSetLeaderState("chat-persist", 0, {
      memories: { host: "macmini" },
    });
    expect(saved?.revision).toBe(1);

    // Re-running init() on controller restart must NOT delete leader_states
    await store.init();
    expect(fakePool.nodeSessionsClearedCount).toBe(1);

    const afterRestart = await store.getLeaderState("chat-persist");
    expect(afterRestart).not.toBeNull();
    expect(afterRestart?.revision).toBe(1);
    expect(afterRestart?.data).toEqual({ memories: { host: "macmini" } });
  });
});
