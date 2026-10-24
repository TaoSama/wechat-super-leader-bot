import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { MemoryStore } from "../../src/store/memory.js";
import { PostgresStore } from "../../src/store/postgres.js";
import type { IStore } from "../../src/store/interface.js";
import { KNOWN_SESSION_CLEANUP_BATCH_SIZE } from "../../src/store/known-sessions.js";
import { pgPruneKnownSessions } from "../../src/store/known-sessions-postgres.js";
import { createExecution } from "../../src/leader/plans/execution.js";
import { createGoal, type GoalRecord } from "../../src/leader/goals/goal.js";
import { proposal } from "../fixtures/goals.js";
import type { CommandRecord, Session } from "../../src/types.js";

const RETENTION_MS = 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 4096;
const NODE = "node";
const START = Date.UTC(2026, 9, 18);
type Pressure = "TTL" | "capacity";
const databaseUrl = process.env.KNOWN_SESSION_TEST_DATABASE_URL;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (url.hostname !== "127.0.0.1" || !url.pathname.startsWith("/known_session_retention_test"))
    throw new Error("KNOWN_SESSION_TEST_DATABASE_URL requires a disposable loopback known_session_retention_test database");
}

function session(id: string): Session {
  return { id, provider: "codex-app", title: id, cwd: "/fixture", loaded: true, status: "idle",
    capabilities: ["read", "send"], observedAt: new Date().toISOString() };
}
function command(sessionId: string, status: CommandRecord["status"]): CommandRecord {
  const timestamp = new Date().toISOString();
  return { commandId: `command-${sessionId}`, requestId: `request-${sessionId}`, nodeId: NODE, sessionId,
    action: "send", prompt: "retain original session", sendRoute: "control-socket", status,
    authority: { type: "admin" }, deliveryMode: "next-turn",
    ...(status === "accepted" || status === "completed" ? { turnId: `turn-${sessionId}` } : {}),
    createdAt: timestamp, updatedAt: timestamp, expiresAt: new Date(Date.now() + RETENTION_MS).toISOString() };
}
async function applyPressure(store: IStore, pressure: Pressure): Promise<void> {
  if (pressure === "TTL") vi.setSystemTime(Date.now() + RETENTION_MS + 1);
  else await store.upsertNodeSessions("pressure-node", Array.from({ length: RECENT_LIMIT }, (_, index) => session(`recent-${index}`)));
}

async function authorize(store: IStore, goal: GoalRecord) {
  const saved = await store.compareAndSetLeaderState(goal.chatId, 0, {
    inflight: { messageId: "confirm", inputHash: "hash", expiresAt: goal.proposal.expiresAt, goal: goal.proposal } });
  return { revision: saved!.revision, messageId: "confirm", inputHash: "hash" };
}

for (const backend of ["memory", "postgres"] as const) {
const suite = backend === "postgres" && !databaseUrl ? describe.skip : describe;
suite(`${backend} known-session retention`, { timeout: 30_000 }, () => {
  const schema = `known_session_${randomUUID().replaceAll("-", "")}`;
  let store: IStore, admin: pg.Pool | undefined, pool: pg.Pool | undefined, scopedUrl: string;
  beforeAll(async () => {
    if (backend !== "postgres") return;
    admin = new pg.Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(databaseUrl!); url.searchParams.set("options", `-c search_path=${schema}`);
    scopedUrl = url.toString();
    pool = new pg.Pool({ connectionString: scopedUrl });
    const initial = new PostgresStore(scopedUrl);
    try { await initial.init(); } finally { await initial.close(); }
  });
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(START);
    if (pool) await pool.query("TRUNCATE commands,known_sessions,node_sessions,leader_goals,leader_executions,leader_states,leader_notifications CASCADE");
    store = backend === "postgres" ? new PostgresStore(scopedUrl) : new MemoryStore();
  });
  afterEach(async () => { await store?.close(); vi.useRealTimers(); });
  afterAll(async () => {
    await pool?.end();
    if (admin) try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await admin.end(); }
  });

  it("retains disconnected history for 24 hours and removes it once the TTL passes", async () => {
    const original = session("original");
    await store.upsertNodeSessions(NODE, [original]);
    await store.removeNodeSessions(NODE);
    vi.setSystemTime(START + RETENTION_MS);
    expect(await store.getKnownSession(NODE, original.id)).toEqual(original);
    vi.setSystemTime(START + RETENTION_MS + 1);
    expect(await store.getKnownSession(NODE, original.id)).toBeNull();
  });

  it("refreshes retention when a session is observed again and isolates returned snapshots", async () => {
    const original = session("original");
    await store.upsertNodeSessions(NODE, [original]);
    vi.setSystemTime(START + RETENTION_MS - 1);
    const refreshed = { ...session(original.id), title: "latest inventory title" };
    await store.upsertNodeSessions(NODE, [refreshed]);
    await store.upsertNodeSessions(NODE, []);
    refreshed.title = "caller mutation";
    vi.setSystemTime(START + RETENTION_MS + 1);
    const snapshot = (await store.getKnownSession(NODE, original.id))!;
    expect(snapshot.title).toBe("latest inventory title");
    snapshot.title = "reader mutation";
    expect((await store.getKnownSession(NODE, original.id))?.title).toBe("latest inventory title");
    vi.setSystemTime(START + 2 * RETENTION_MS);
    expect(await store.getKnownSession(NODE, original.id)).toBeNull();
  });

  it("preserves an oversized live inventory and keeps the most recent 4096 identities after disconnect", async () => {
    await store.upsertNodeSessions(NODE, Array.from({ length: RECENT_LIMIT + 1 }, (_, index) => session(`session-${index}`)));
    expect((await store.getKnownSession(NODE, "session-0"))?.id).toBe("session-0");
    await store.removeNodeSessions(NODE);
    expect(await store.getKnownSession(NODE, "session-0")).toBeNull();
    expect((await store.getKnownSession(NODE, "session-1"))?.id).toBe("session-1");
    expect((await store.getKnownSession(NODE, `session-${RECENT_LIMIT}`))?.id).toBe(`session-${RECENT_LIMIT}`);
  });

  it("moves a refreshed identity to the recent end before enforcing capacity", async () => {
    await store.upsertNodeSessions(NODE, Array.from({ length: RECENT_LIMIT }, (_, index) => session(`session-${index}`)));
    await store.upsertNodeSessions(NODE, [session("session-0"), session("newest")]);
    expect((await store.getKnownSession(NODE, "session-0"))?.id).toBe("session-0");
    expect(await store.getKnownSession(NODE, "session-1")).toBeNull();
    expect((await store.getKnownSession(NODE, "newest"))?.id).toBe("newest");
  });

  for (const pressure of ["TTL", "capacity"] as const) {
    it.each(["queued", "pending", "accepted", "uncertain"] as const)(`preserves a %s command target under ${pressure} pressure`, async status => {
      const original = session("pinned");
      await store.upsertNodeSessions(NODE, [original]);
      await store.createCommandIfAbsent(command(original.id, status));
      await store.removeNodeSessions(NODE);
      await applyPressure(store, pressure);
      expect(await store.getKnownSession(NODE, original.id)).toEqual(original);
      expect((await store.getCommand(`command-${original.id}`))?.status).toBe(status);
    });

    it(`preserves every target of an active execution under ${pressure} pressure`, async () => {
      const originals = [session("first"), session("second")];
      await store.upsertNodeSessions(NODE, originals);
      const execution = createExecution("plan-chat", { id: randomUUID(), expiresAt: Date.now() + RETENTION_MS,
        actions: originals.map(target => ({ nodeId: NODE, sessionId: target.id, prompt: "work", dependsOn: [], sendRoute: "control-socket" })) }, Date.now());
      await store.createExecutionIfAbsent(execution);
      await store.removeNodeSessions(NODE);
      await applyPressure(store, pressure);
      for (const original of originals) expect(await store.getKnownSession(NODE, original.id)).toEqual(original);
      expect((await store.getExecution(execution.id))?.attempts).toEqual([null, null]);
    });

    it.each(["active", "blocked"] as const)(`preserves every target of an %s goal under ${pressure} pressure`, async status => {
      const originals = [session("first"), session("second")];
      await store.upsertNodeSessions(NODE, originals);
      const goal = createGoal("goal-chat", { ...proposal(), targets: originals.map(target => ({
        nodeId: NODE, sessionId: target.id, sendRoute: "control-socket",
      })) }, Date.now());
      await store.confirmGoal(goal, await authorize(store, goal));
      if (status === "blocked") await store.compareAndSetGoal({ ...goal, revision: goal.revision + 1,
        status: "blocked", blockedReason: "waiting for evidence" }, goal.revision);
      await store.removeNodeSessions(NODE);
      await applyPressure(store, pressure);
      for (const original of originals) expect(await store.getKnownSession(NODE, original.id)).toEqual(original);
      expect((await store.getGoal(goal.id))?.status).toBe(status);
    });
  }

  it("allows protected identities to exceed capacity and evicts a newcomer only after it disconnects", async () => {
    const originals = Array.from({ length: RECENT_LIMIT + 1 }, (_, index) => session(`pinned-${index}`));
    await Promise.all(originals.map(original => store.createCommandIfAbsent(command(original.id, "queued"))));
    await store.upsertNodeSessions(NODE, originals);
    await store.upsertNodeSessions(NODE, [session("unreferenced")]);
    expect(await store.getKnownSession(NODE, "pinned-0")).toEqual(originals[0]);
    expect(await store.getKnownSession(NODE, `pinned-${RECENT_LIMIT}`)).toEqual(originals[RECENT_LIMIT]);
    expect((await store.getKnownSession(NODE, "unreferenced"))?.id).toBe("unreferenced");
    await store.removeNodeSessions(NODE);
    expect(await store.getKnownSession(NODE, "unreferenced")).toBeNull();
  });

  it("pins the exact node/session identity rather than the same session ID on another node", async () => {
    const original = session("same-id");
    await store.upsertNodeSessions(NODE, [original]);
    await store.upsertNodeSessions("other-node", [original]);
    await store.createCommandIfAbsent(command(original.id, "queued"));
    await store.removeNodeSessions(NODE);
    await store.removeNodeSessions("other-node");
    await applyPressure(store, "TTL");
    expect(await store.getKnownSession(NODE, original.id)).toEqual(original);
    expect(await store.getKnownSession("other-node", original.id)).toBeNull();
  });

  it.each(["completed", "failed", "cancelled", "expired"] as const)("does not pin a %s command target", async status => {
    const original = session("terminal");
    await store.upsertNodeSessions(NODE, [original]);
    await store.createCommandIfAbsent(command(original.id, status));
    await store.removeNodeSessions(NODE);
    await applyPressure(store, "TTL");
    expect(await store.getKnownSession(NODE, original.id)).toBeNull();
  });

  it("releases a command pin when the queued command is cancelled", async () => {
    const original = session("queued");
    await store.upsertNodeSessions(NODE, [original]);
    const queued = command(original.id, "queued");
    await store.createCommandIfAbsent(queued);
    await store.removeNodeSessions(NODE);
    await applyPressure(store, "TTL");
    expect(await store.getKnownSession(NODE, original.id)).toEqual(original);
    expect(await store.cancelQueuedCommand(queued.commandId)).toMatchObject({ status: "cancelled" });
    expect(await store.getKnownSession(NODE, original.id)).toBeNull();
  });

  it("pins a current session until it leaves its node inventory even after 24 hours", async () => {
    const original = session("live");
    await store.upsertNodeSessions(NODE, [original]);
    await applyPressure(store, "TTL");
    expect(await store.getKnownSession(NODE, original.id)).toEqual(original);
    await store.upsertNodeSessions(NODE, []);
    expect(await store.getKnownSession(NODE, original.id)).toBeNull();
  });

  it("pins an admitting command and keeps the business record after the pin is released", async () => {
    const original = session("admitting");
    await store.upsertNodeSessions(NODE, [original]);
    const admitting = command(original.id, "admitting");
    await store.createCommandIfAbsent(admitting);
    await store.removeNodeSessions(NODE);
    await applyPressure(store, "TTL");
    expect(await store.getKnownSession(NODE, original.id)).toEqual(original);
    await store.updateCommandStatus(admitting.commandId, "failed", undefined, "synthetic admission rejection");
    expect(await store.getKnownSession(NODE, original.id)).toBeNull();
    expect(await store.getCommand(admitting.commandId)).toMatchObject({ status: "failed", prompt: admitting.prompt });
  });

  if (backend === "postgres") {
    it("completes concurrent identity lookup and inventory update with one PostgreSQL connection", async () => {
      const access = store as unknown as { pool: pg.Pool };
      await access.pool.end();
      const bounded = new pg.Pool({ connectionString: scopedUrl, max: 1 });
      access.pool = bounded;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let completed = false;
      const operations = Promise.all([store.getKnownSession(NODE, "missing"), store.upsertNodeSessions(NODE, [])]);
      const settled = operations.finally(() => { completed = true; });
      try {
        const deadline = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("Session maintenance stalled with a one-client PostgreSQL pool")), 5_000);
        });
        await expect(Promise.race([settled, deadline])).resolves.toEqual([null, undefined]);
        expect(bounded.totalCount).toBe(1);
        expect(bounded.idleCount).toBe(1);
        expect(bounded.waitingCount).toBe(0);
      } finally {
        clearTimeout(timer);
        if (!completed) {
          (bounded as pg.Pool & { options: { max: number } }).options.max = 2;
          const rescue = await bounded.connect(); rescue.release();
          await settled;
        }
      }
    });

    it("keeps cleanup ahead of repeated inventories larger than a single deletion batch", async () => {
      await pool!.query(`INSERT INTO known_sessions(node_id,session_id,data,updated_at)
        SELECT 'historical','seed-'||n,$1::jsonb||jsonb_build_object('id','seed-'||n),$2
        FROM generate_series(1,$3) n`, [JSON.stringify(session("seed")), new Date().toISOString(), RECENT_LIMIT]);
      const inventorySize = KNOWN_SESSION_CLEANUP_BATCH_SIZE + 1;
      for (let round = 0; round < 3; round++) {
        await store.upsertNodeSessions(NODE, Array.from({ length: inventorySize }, (_, index) => session(`round-${round}-${index}`)));
        expect(Number((await pool!.query("SELECT count(*) FROM known_sessions")).rows[0].count)).toBeLessThanOrEqual(RECENT_LIMIT);
        expect((await store.getKnownSession(NODE, `round-${round}-0`))?.id).toBe(`round-${round}-0`);
      }
    });

    it("hides expired identities immediately and reclaims at most one batch on each read", async () => {
      const originals = Array.from({ length: KNOWN_SESSION_CLEANUP_BATCH_SIZE + 7 }, (_, index) => session(`stale-${index}`));
      await store.upsertNodeSessions(NODE, originals);
      await store.removeNodeSessions(NODE);
      await applyPressure(store, "TTL");
      const last = originals.at(-1)!;
      expect(await store.getKnownSession(NODE, last.id)).toBeNull();
      expect((await pool!.query("SELECT count(*) FROM known_sessions")).rows[0].count).toBe("7");
      expect((await pool!.query("SELECT session_id FROM known_sessions WHERE session_id=$1", [last.id])).rowCount).toBe(1);
      expect(await store.getKnownSession(NODE, last.id)).toBeNull();
      expect((await pool!.query("SELECT count(*) FROM known_sessions")).rows[0].count).toBe("0");
    });

    it("retains persisted business pins across restart and releases prior live inventory pins", async () => {
      const original = session("pinned"), oldLive = session("formerly-live");
      await store.upsertNodeSessions(NODE, [original, oldLive]);
      const queued = command(original.id, "queued");
      await store.createCommandIfAbsent(queued);
      await applyPressure(store, "TTL");
      await store.close();
      store = new PostgresStore(scopedUrl); await store.init();
      expect(await store.getKnownSession(NODE, original.id)).toEqual(original);
      expect(await store.getKnownSession(NODE, oldLive.id)).toBeNull();
      expect(await store.getCommand(queued.commandId)).toMatchObject({ status: "queued", prompt: queued.prompt });
    });

    it("adds observation ordering to legacy rows without replacing cached identity or business history", async () => {
      const original = session("legacy-known"), imported = session("legacy-inventory");
      await store.upsertNodeSessions(NODE, [original]);
      const queued = command(original.id, "queued");
      await store.createCommandIfAbsent(queued);
      await store.removeNodeSessions(NODE);
      await pool!.query("ALTER TABLE known_sessions DROP COLUMN observed_order");
      await pool!.query("DELETE FROM controller_schema_migrations WHERE version=2");
      for (const item of [{ ...original, title: "older inventory title" }, imported])
        await pool!.query("INSERT INTO node_sessions(node_id,session_id,data,updated_at) VALUES($1,$2,$3,$4)",
          [NODE, item.id, JSON.stringify(item), new Date(START).toISOString()]);
      await store.close();
      store = new PostgresStore(scopedUrl); await store.init();
      expect(await store.getKnownSession(NODE, original.id)).toEqual(original);
      expect(await store.getKnownSession(NODE, imported.id)).toEqual(imported);
      expect((await pool!.query("SELECT count(*) FROM known_sessions WHERE observed_order>0")).rows[0].count).toBe("2");
      expect(await store.getCommand(queued.commandId)).toMatchObject({ status: "queued", prompt: queued.prompt });
      expect((await pool!.query("SELECT version FROM controller_schema_migrations ORDER BY version")).rows).toEqual([{ version: 1 }, { version: 2 }]);
      expect((await pool!.query("SELECT count(*) FROM node_sessions")).rows[0].count).toBe("0");
      await store.init();
      expect(await store.getKnownSession(NODE, imported.id)).toEqual(imported);
      expect(await store.getCommand(queued.commandId)).toMatchObject({ status: "queued", prompt: queued.prompt });
    });

    it("does not delete an identity refreshed after the cleanup snapshot was taken", async () => {
      const original = session("refresh-race");
      await store.upsertNodeSessions(NODE, [original]); await store.removeNodeSessions(NODE);
      await applyPressure(store, "TTL");
      const client = await pool!.connect();
      let cleanup: Promise<void> | undefined;
      let holding = false;
      try {
        await client.query("BEGIN"); holding = true;
        await client.query(`UPDATE known_sessions SET data=$1,updated_at=$2,
          observed_order=nextval(pg_get_serial_sequence('known_sessions','observed_order')) WHERE node_id=$3 AND session_id=$4`,
        [JSON.stringify({ ...original, title: "refreshed during cleanup" }), new Date().toISOString(), NODE, original.id]);
        const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        cleanup = pgPruneKnownSessions(pool!, new Map());
        await vi.waitFor(async () => {
          const waiting = await pool!.query(`SELECT count(*) FROM pg_stat_activity
            WHERE wait_event_type='Lock' AND $1::integer=ANY(pg_blocking_pids(pid))`, [pid]);
          expect(Number(waiting.rows[0].count)).toBeGreaterThan(0);
        }, { timeout: 5_000 });
        await client.query("COMMIT"); holding = false;
        await cleanup;
        expect((await store.getKnownSession(NODE, original.id))?.title).toBe("refreshed during cleanup");
      } finally {
        try { if (holding) await client.query("ROLLBACK"); } finally { client.release(); }
        await cleanup;
      }
    });

    it("lets another node persist while the first node waits for its inventory transaction lock", async () => {
      const client = await pool!.connect();
      let update: Promise<void> | undefined;
      let holding = false;
      try {
        await client.query("BEGIN"); holding = true;
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify(["node_sessions", NODE])]);
        const pid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        update = store.upsertNodeSessions(NODE, [session("blocked-node")]);
        await vi.waitFor(async () => {
          const waiting = await pool!.query(`SELECT count(*) FROM pg_stat_activity
            WHERE wait_event_type='Lock' AND $1::integer=ANY(pg_blocking_pids(pid))`, [pid]);
          expect(Number(waiting.rows[0].count)).toBeGreaterThan(0);
        });
        await store.upsertNodeSessions("other-node", [session("independent")]);
        expect((await store.getKnownSession("other-node", "independent"))?.id).toBe("independent");
        await client.query("COMMIT"); holding = false; await update;
      } finally {
        try { if (holding) await client.query("ROLLBACK"); } finally { client.release(); }
        await update;
      }
    });
  }
});
}
