import { describe, expect, it, vi } from "vitest";
import pg from "pg";
import { MemoryStore } from "../src/store/memory.js";
import { PostgresStore } from "../src/store/postgres.js";
import { InputReceiptSchema, sameInputReceipt, type InputReceipt } from "../src/input-receipt.js";
import { ControllerCommandMessageSchema, DaemonResultMessageSchema, SendAvailabilitySchema, type CommandRecord } from "../src/types.js";
import { selectSendRoute } from "../src/send-eligibility.js";

vi.mock("pg", () => ({ default: { Pool: vi.fn() } }));
const sessionId = `terminal:${"a".repeat(43)}`;
const proof: InputReceipt = { kind: "terminal-input-written", sessionId,
  requestId: "e09a35c8-7290-41f0-8fc5-9701183d82a6", promptSHA256: "a".repeat(64), responseRevision: 0, observedRevision: 1 };
const command = (overrides: Partial<CommandRecord> = {}): CommandRecord => ({ commandId: "cmd", requestId: "http-arbitrary-request",
  nodeId: "node", sessionId, action: "send", prompt: "fixture", sendRoute: "terminal-pane", status: "pending",
  createdAt: "2026-10-12T00:00:00Z", updatedAt: "2026-10-12T00:00:00Z", expiresAt: "2026-10-12T00:01:00Z", ...overrides });

class CommandPool {
  rows = new Map<string, Record<string, unknown>>();
  statements: string[] = [];
  async query(raw: string, params: unknown[] = []) {
    const sql = raw.replace(/\s+/g, " ").trim();
    this.statements.push(sql);
    if (sql.startsWith("INSERT INTO commands")) {
      if ([...this.rows.values()].some(row => row.request_id === params[1])) return { rows: [] };
      const fields = ["command_id", "request_id", "node_id", "session_id", "action", "prompt", "status", "output", "error",
        "expires_at", "created_at", "updated_at", "skills", "turn_id", "send_route", "input_receipt"];
      const row = Object.fromEntries(fields.map((key, index) => [key, params[index]]));
      row.skills = JSON.parse(row.skills as string);
      row.input_receipt = row.input_receipt === null ? null : JSON.parse(row.input_receipt as string);
      this.rows.set(row.command_id as string, row);
      return { rows: [structuredClone(row)] };
    }
    if (sql.startsWith("SELECT * FROM commands WHERE command_id") || sql.startsWith("SELECT * FROM commands WHERE request_id")) {
      const row = sql.includes("request_id") ? [...this.rows.values()].find(row => row.request_id === params[0]) : this.rows.get(params[0] as string);
      return { rows: row ? [structuredClone(row)] : [] };
    }
    if (sql.startsWith("UPDATE commands SET status=$1")) {
      const row = this.rows.get(params[5] as string)!;
      Object.assign(row, { status: params[0], output: params[1], error: params[2], turn_id: params[3], updated_at: params[4],
        input_receipt: params[6] === null ? null : JSON.parse(params[6] as string) });
      return { rows: [] };
    }
    if (sql.startsWith("SELECT * FROM commands WHERE node_id")) {
      expect(sql).toContain("send_route IS DISTINCT FROM 'terminal-pane'");
      expect(sql).toContain("session_id NOT LIKE 'terminal:%'");
      expect(sql).toContain("input_receipt IS NULL");
      return { rows: [] };
    }
    if (sql.startsWith("SELECT * FROM commands ORDER BY")) return { rows: [...this.rows.values()].map(row => structuredClone(row)) };
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || /^(CREATE|ALTER|DELETE FROM node_sessions|UPDATE commands)/.test(sql)) return { rows: [] };
    throw new Error(`Unexpected fixture SQL: ${sql}`);
  }
  async connect() { return { query: this.query.bind(this), release: () => {} }; }
  async end() {}
}
function fixture(kind: string) {
  const pool = new CommandPool();
  vi.mocked(pg.Pool).mockImplementation(function () { return pool as unknown as pg.Pool; });
  return { pool, store: kind === "memory" ? new MemoryStore() : new PostgresStore("postgresql://unused/test") };
}

describe("terminal input wire contract", () => {
  it("requires only six exact safe proof fields and compares scalar identity independent of field order", () => {
    expect(InputReceiptSchema.parse(proof)).toEqual(proof);
    expect(sameInputReceipt(proof, { observedRevision: 1, responseRevision: 0, promptSHA256: proof.promptSHA256,
      requestId: proof.requestId, sessionId, kind: proof.kind })).toBe(true);
    for (const changes of [{ socket: "/private/socket" }, { prompt: "private" }, { requestId: "http-request" },
      { requestId: "e09a35c8-7290-11f0-8fc5-9701183d82a6" }, { promptSHA256: "A".repeat(64) },
      { responseRevision: -1 }, { observedRevision: -1 }, { responseRevision: 2, observedRevision: 1 },
      { observedRevision: Number.MAX_SAFE_INTEGER + 1 }, { sessionId: "terminal:short" }]) {
      expect(InputReceiptSchema.safeParse({ ...proof, ...changes }).success).toBe(false);
    }
    const result = { type: "result", commandId: "cmd", status: "input-written", output: "", inputReceipt: proof };
    expect(DaemonResultMessageSchema.safeParse(result).success).toBe(true);
    for (const changes of [{ output: "fake output" }, { error: "failed" }, { turnId: "turn" }, { inputReceipt: undefined },
      { status: "completed" }, { status: "failed" }, { status: "accepted" }]) {
      expect(DaemonResultMessageSchema.safeParse({ ...result, ...changes }).success).toBe(false);
    }
    const wire = { type: "command", commandId: "cmd", nodeId: "node", sessionId, action: "send", expiresAt: command().expiresAt };
    expect(ControllerCommandMessageSchema.safeParse({ ...wire, sendRoute: "terminal-pane" }).success).toBe(true);
    expect(ControllerCommandMessageSchema.safeParse({ ...wire, sendRoute: "desktop-owner" }).success).toBe(false);
    expect(ControllerCommandMessageSchema.safeParse({ ...wire, sessionId: "native", sendRoute: "terminal-pane" }).success).toBe(false);
  });

  it("authorizes only strict fresh non-atomic qualification, keeping default read-only and native routes unchanged", () => {
    const now = Date.now();
    const session = { id: sessionId, provider: "terminal/codex", title: "fixture", cwd: "", status: "idle",
      capabilities: ["read" as const], observedAt: new Date(now).toISOString(), loaded: false };
    const ready = { route: "terminal-pane" as const, mode: "non-atomic" as const, state: "ready" as const,
      observedAt: new Date(now).toISOString(), validUntil: new Date(now + 45000).toISOString() };
    expect(selectSendRoute(session, now).ready).toBe(false);
    expect(selectSendRoute({ ...session, sendAvailability: ready }, now)).toEqual({ ready: true, route: "terminal-pane" });
    for (const changes of [{ mode: undefined }, { mode: "atomic" }, { socket: "/private" }]) {
      expect(SendAvailabilitySchema.safeParse({ ...ready, ...changes }).success).toBe(false);
    }
    expect(selectSendRoute({ ...session, sendAvailability: ready }, now + 45000).ready).toBe(false);
    expect(selectSendRoute({ ...session, id: "native", provider: "codex-app", sendAvailability: ready }, now).ready).toBe(false);
    expect(selectSendRoute({ ...session, sendAvailability: { ...ready, route: "desktop-owner", mode: undefined } } as never, now).ready).toBe(false);
  });
});

describe.each(["memory", "postgres"])("%s immutable input proof", kind => {
  it("binds first exact proof independently of HTTP request ID, clones it, replays it, never inspects or downgrades it", async () => {
    const { store } = fixture(kind);
    await store.createCommandIfAbsent(command());
    await store.updateCommandStatus("cmd", "uncertain", "", "transport unclear");
    await store.updateCommandStatus("cmd", "input-written", "", undefined, undefined, proof);
    expect((await store.getCommand("cmd"))?.inputReceipt).toEqual(proof);
    expect((await store.getCommand("cmd"))?.error).toBeUndefined();
    const cloned = (await store.getCommand("cmd"))!;
    cloned.inputReceipt!.observedRevision = 10;
    expect((await store.listRecentCommands())[0].inputReceipt).toEqual(proof);
    await store.updateCommandStatus("cmd", "input-written", "", undefined, undefined, { ...proof });
    for (const status of ["accepted", "completed", "failed", "uncertain"] as const) {
      await expect(store.updateCommandStatus("cmd", status, "", undefined, "native-turn")).rejects.toThrow();
    }
    await expect(store.updateCommandStatus("cmd", "input-written", "", undefined, undefined, { ...proof, observedRevision: 2 })).rejects.toThrow();
    expect(await store.listInspectableCommands("node")).toEqual([]);
    await store.markNodeActiveCommandsUncertain("node", "restart");
    await store.markExpiredActiveCommandsUncertain();
    expect((await store.getCommand("cmd"))?.status).toBe("input-written");
  });

  it("rejects proof on read/native, terminal completion, changed session, fake output and failed-to-written transitions", async () => {
    const { store } = fixture(kind);
    await store.createCommandIfAbsent(command());
    for (const [status, output, error, turnId, receipt] of [
      ["input-written", "fake", undefined, undefined, proof], ["input-written", "", "error", undefined, proof],
      ["input-written", "", undefined, "turn", proof], ["input-written", "", undefined, undefined, { ...proof, sessionId: `terminal:${"b".repeat(43)}` }],
      ["completed", "", undefined, "turn", undefined], ["accepted", "", undefined, "turn", undefined],
    ] as const) await expect(store.updateCommandStatus("cmd", status, output, error, turnId, receipt)).rejects.toThrow();
    for (const changes of [{ action: "read" as const, sendRoute: undefined }, { sessionId: "native", sendRoute: "control-socket" as const }]) {
      await expect(store.createCommandIfAbsent(command({ ...changes, commandId: "bad", requestId: "bad", status: "input-written", inputReceipt: proof }))).rejects.toThrow();
    }
    await store.updateCommandStatus("cmd", "failed", "", "statically rejected");
    await expect(store.updateCommandStatus("cmd", "input-written", "", undefined, undefined, proof)).rejects.toThrow();
  });
});

it("adds a nullable JSONB proof migration and rejects malicious persisted proof", async () => {
  const { store, pool } = fixture("postgres");
  await store.init();
  expect(pool.statements).toContain("ALTER TABLE commands ADD COLUMN IF NOT EXISTS input_receipt JSONB");
  await store.createCommandIfAbsent(command());
  pool.rows.get("cmd")!.input_receipt = { ...proof, socket: "/private" };
  await expect(store.getCommand("cmd")).rejects.toThrow();
});
