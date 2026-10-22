import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../../src/store/memory.js";
import { PostgresStore } from "../../src/store/postgres.js";
import type { IStore } from "../../src/store/interface.js";
import type { CommandRecord } from "../../src/types.js";

const databaseUrl = process.env.COMMAND_TEST_DATABASE_URL;
const TTL_MS = 300_000;
if (databaseUrl) {
  const url = new URL(databaseUrl);
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/command_admission_test") {
    throw new Error("COMMAND_TEST_DATABASE_URL requires a disposable loopback command_admission_test database");
  }
}

function command(overrides: Partial<CommandRecord> = {}): CommandRecord {
  const now = Date.now();
  return { commandId: randomUUID(), requestId: randomUUID(), nodeId: "synthetic-node", sessionId: "synthetic-session",
    action: "send", prompt: "Synthetic durable admission", sendRoute: "control-socket", status: "admitting",
    authority: { type: "chat", chatId: "synthetic-chat" }, createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(), expiresAt: new Date(now + TTL_MS).toISOString(), ...overrides };
}

for (const kind of ["memory", "postgres"] as const) {
  describe.skipIf(kind === "postgres" && !databaseUrl)(`${kind} prepared command admission`, () => {
    let store: IStore;
    let admin: pg.Pool | undefined;
    let schema: string | undefined;
    beforeEach(async () => {
      if (kind === "memory") store = new MemoryStore();
      else {
        admin = new pg.Pool({ connectionString: databaseUrl });
        schema = `command_authorization_${randomUUID().replaceAll("-", "")}`;
        await admin.query(`CREATE SCHEMA ${schema}`);
        const scoped = new URL(databaseUrl!);
        scoped.searchParams.set("options", `-c search_path=${schema}`);
        store = new PostgresStore(scoped.toString());
      }
      await store.init();
    });
    afterEach(async () => {
      await store?.close();
      if (admin) {
        try { if (schema) await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
        finally { await admin.end(); }
      }
      admin = undefined;
      schema = undefined;
    });

    it("excludes admitting work from queue and receipt admission, then atomically publishes and claims once", async () => {
      const prepared = (await store.createCommandIfAbsent(command())).command;
      expect(await store.listQueuedCommands()).toEqual([]);
      expect(await store.claimQueuedCommand(prepared.commandId, "control-socket")).toBeNull();
      await expect(store.updateCommandStatus(prepared.commandId, "accepted", undefined, undefined, "synthetic-turn"))
        .rejects.toThrow("admission has not completed");
      const published = await Promise.all([store.admitCommand(prepared.commandId), store.admitCommand(prepared.commandId)]);
      expect(published.filter(Boolean)).toHaveLength(1);
      expect(published.find(Boolean)).toMatchObject({ status: "queued", queueOrder: prepared.queueOrder });
      const claimed = await Promise.all([store.claimQueuedCommand(prepared.commandId, "control-socket"),
        store.claimQueuedCommand(prepared.commandId, "control-socket")]);
      expect(claimed.filter(Boolean)).toHaveLength(1);
      expect(claimed.find(Boolean)?.status).toBe("pending");
    });

    it("retains a failed guard's request identity and never publishes it", async () => {
      const prepared = (await store.createCommandIfAbsent(command())).command;
      await store.updateCommandStatus(prepared.commandId, "failed", undefined, "Synthetic rejected guard");
      expect(await store.admitCommand(prepared.commandId)).toBeNull();
      const duplicate = await store.createCommandIfAbsent({ ...prepared, commandId: randomUUID() });
      expect(duplicate).toMatchObject({ created: false, command: { commandId: prepared.commandId, status: "failed" } });
      expect(await store.listQueuedCommands()).toEqual([]);
    });

    it("expires unsent preparation and cannot publish it after the deadline", async () => {
      const prepared = (await store.createCommandIfAbsent(command({ expiresAt: new Date(Date.now() - 1).toISOString() }))).command;
      expect(await store.admitCommand(prepared.commandId)).toBeNull();
      await store.markExpiredActiveCommandsUncertain();
      expect((await store.getCommand(prepared.commandId))?.status).toBe("expired");
      expect(await store.admitCommand(prepared.commandId)).toBeNull();
    });

    it("retains abandoned admission and approved queue work distinctly after startup", async () => {
      const prepared = (await store.createCommandIfAbsent(command())).command;
      const approved = (await store.createCommandIfAbsent(command({ sessionId: "another-session", status: "queued" }))).command;
      await store.init();
      expect(await store.getCommand(prepared.commandId)).toEqual(prepared);
      expect((await store.getCommand(approved.commandId))?.status).toBe("queued");
      expect((await store.listQueuedCommands()).map(item => item.commandId)).toEqual([approved.commandId]);
      expect((await store.findCommandByRequestId(prepared.requestId))?.commandId).toBe(prepared.commandId);
    });

    it("preserves FIFO behind an earlier preparation until it fails", async () => {
      const prepared = (await store.createCommandIfAbsent(command())).command;
      const later = (await store.createCommandIfAbsent(command({ status: "queued" }))).command;
      expect(await store.listQueuedCommands()).toEqual([]);
      expect(await store.claimQueuedCommand(later.commandId, "control-socket")).toBeNull();
      await store.updateCommandStatus(prepared.commandId, "failed", undefined, "Synthetic denied preparation");
      expect((await store.listQueuedCommands()).map(item => item.commandId)).toEqual([later.commandId]);
      expect((await store.claimQueuedCommand(later.commandId, "control-socket"))?.status).toBe("pending");
    });

    it("releases only an untransmitted plan claim and preserves FIFO for resumed authorization", async () => {
      const prepared = (await store.createCommandIfAbsent(command({ authority: { type: "plan", id: randomUUID(), chatId: "synthetic-chat" } }))).command;
      await store.admitCommand(prepared.commandId);
      await store.claimQueuedCommand(prepared.commandId, "control-socket");
      expect(await store.requeueClaimedCommand(prepared.commandId)).toMatchObject({ status: "queued", queueOrder: prepared.queueOrder });
      await store.claimQueuedCommand(prepared.commandId, "control-socket");
      await store.updateCommandStatus(prepared.commandId, "accepted", undefined, undefined, "synthetic-turn");
      expect(await store.requeueClaimedCommand(prepared.commandId)).toBeNull();
      expect((await store.getCommand(prepared.commandId))?.status).toBe("accepted");
    });
  });
}
