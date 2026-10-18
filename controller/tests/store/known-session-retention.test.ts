import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "../../src/store/memory.js";
import { createExecution } from "../../src/leader/plans/execution.js";
import { createGoal } from "../../src/leader/goals/goal.js";
import { authorize, proposal } from "../fixtures/goals.js";
import type { CommandRecord, Session } from "../../src/types.js";

const RETENTION_MS = 24 * 60 * 60 * 1000;
const RECENT_LIMIT = 4096;
const NODE = "node";
const START = Date.UTC(2026, 9, 18);
type Pressure = "TTL" | "capacity";

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
async function applyPressure(store: MemoryStore, pressure: Pressure): Promise<void> {
  if (pressure === "TTL") vi.setSystemTime(Date.now() + RETENTION_MS + 1);
  else await store.upsertNodeSessions("pressure-node", Array.from({ length: RECENT_LIMIT }, (_, index) => session(`recent-${index}`)));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(() => vi.useRealTimers());

describe("MemoryStore known-session retention", () => {
  it("retains disconnected history for 24 hours and removes it once the TTL passes", async () => {
    const store = new MemoryStore(), original = session("original");
    await store.upsertNodeSessions(NODE, [original]);
    await store.removeNodeSessions(NODE);
    expect(await store.getNodeSessions(NODE)).toEqual([]);
    vi.setSystemTime(START + RETENTION_MS);
    expect(await store.getKnownSession(NODE, original.id)).toEqual(original);
    vi.setSystemTime(START + RETENTION_MS + 1);
    expect(await store.getKnownSession(NODE, original.id)).toBeNull();
  });

  it("refreshes retention when a session is observed again and isolates returned snapshots", async () => {
    const store = new MemoryStore(), original = session("original");
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

  it("keeps the most recent 4096 identities from one oversized inventory", async () => {
    const store = new MemoryStore();
    await store.upsertNodeSessions(NODE, Array.from({ length: RECENT_LIMIT + 1 }, (_, index) => session(`session-${index}`)));
    await store.removeNodeSessions(NODE);
    expect(await store.getKnownSession(NODE, "session-0")).toBeNull();
    expect((await store.getKnownSession(NODE, "session-1"))?.id).toBe("session-1");
    expect((await store.getKnownSession(NODE, `session-${RECENT_LIMIT}`))?.id).toBe(`session-${RECENT_LIMIT}`);
  });

  it("moves a refreshed identity to the recent end before enforcing capacity", async () => {
    const store = new MemoryStore();
    await store.upsertNodeSessions(NODE, Array.from({ length: RECENT_LIMIT }, (_, index) => session(`session-${index}`)));
    await store.upsertNodeSessions(NODE, [session("session-0"), session("newest")]);
    expect((await store.getKnownSession(NODE, "session-0"))?.id).toBe("session-0");
    expect(await store.getKnownSession(NODE, "session-1")).toBeNull();
    expect((await store.getKnownSession(NODE, "newest"))?.id).toBe("newest");
  });

  for (const pressure of ["TTL", "capacity"] as const) {
    it.each(["queued", "pending", "accepted", "uncertain"] as const)(`preserves a %s command target under ${pressure} pressure`, async status => {
      const store = new MemoryStore(), original = session("pinned");
      await store.upsertNodeSessions(NODE, [original]);
      await store.createCommandIfAbsent(command(original.id, status));
      await store.removeNodeSessions(NODE);
      await applyPressure(store, pressure);
      expect(await store.getKnownSession(NODE, original.id)).toEqual(original);
      expect((await store.getCommand(`command-${original.id}`))?.status).toBe(status);
    });

    it(`preserves every target of an active execution under ${pressure} pressure`, async () => {
      const store = new MemoryStore(), originals = [session("first"), session("second")];
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
      const store = new MemoryStore(), originals = [session("first"), session("second")];
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

  it("allows pinned targets to exceed capacity and evicts an unreferenced newcomer", async () => {
    const store = new MemoryStore();
    const originals = Array.from({ length: RECENT_LIMIT + 1 }, (_, index) => session(`pinned-${index}`));
    await Promise.all(originals.map(original => store.createCommandIfAbsent(command(original.id, "queued"))));
    await store.upsertNodeSessions(NODE, originals);
    await store.upsertNodeSessions(NODE, [session("unreferenced")]);
    expect(await store.getKnownSession(NODE, "pinned-0")).toEqual(originals[0]);
    expect(await store.getKnownSession(NODE, `pinned-${RECENT_LIMIT}`)).toEqual(originals[RECENT_LIMIT]);
    expect(await store.getKnownSession(NODE, "unreferenced")).toBeNull();
  });

  it("pins the exact node/session identity rather than the same session ID on another node", async () => {
    const store = new MemoryStore(), original = session("same-id");
    await store.upsertNodeSessions(NODE, [original]);
    await store.upsertNodeSessions("other-node", [original]);
    await store.createCommandIfAbsent(command(original.id, "queued"));
    await applyPressure(store, "TTL");
    expect(await store.getKnownSession(NODE, original.id)).toEqual(original);
    expect(await store.getKnownSession("other-node", original.id)).toBeNull();
  });

  it.each(["completed", "failed", "cancelled", "expired"] as const)("does not pin a %s command target", async status => {
    const store = new MemoryStore(), original = session("terminal");
    await store.upsertNodeSessions(NODE, [original]);
    await store.createCommandIfAbsent(command(original.id, status));
    await applyPressure(store, "TTL");
    expect(await store.getKnownSession(NODE, original.id)).toBeNull();
  });

  it("releases a command pin when the queued command is cancelled", async () => {
    const store = new MemoryStore(), original = session("queued");
    await store.upsertNodeSessions(NODE, [original]);
    const queued = command(original.id, "queued");
    await store.createCommandIfAbsent(queued);
    await applyPressure(store, "TTL");
    expect(await store.getKnownSession(NODE, original.id)).toEqual(original);
    expect(await store.cancelQueuedCommand(queued.commandId)).toMatchObject({ status: "cancelled" });
    expect(await store.getKnownSession(NODE, original.id)).toBeNull();
  });
});
