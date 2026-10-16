import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { NodeHub } from "../../src/nodes/hub.js";
import { SessionHistoryRequests } from "../../src/sessions/history.js";
import { MemoryStore } from "../../src/store/memory.js";
import { SessionHistorySchema, SessionSchema } from "../../src/types.js";

const SESSION_ID = "terminal:" + Buffer.alloc(32, 7).toString("base64url");
const CONTEXT = "cf7e282f-d6d2-4a98-a517-9fb753f2549b";
const session = { id: SESSION_ID, provider: "terminal/codex", status: "active", loaded: false,
  capabilities: ["read"], observedAt: "2026-10-12T12:00:00Z", historySource: "terminal-transcript" };
const history = { session, historyContext: CONTEXT, source: "terminal-transcript", nextCursor: null,
  fetchedAt: session.observedAt, truncated: false,
  items: [{ id: "cli-item", turnId: "", kind: "assistant", type: "transcript_message", text: "可见文本" }] };

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: Record<string, unknown>[] = [];
  send(raw: string, callback?: (error?: Error) => void) { this.sent.push(JSON.parse(raw)); callback?.(); }
  close() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
  receive(value: unknown) { this.emit("message", JSON.stringify(value)); }
  request() { return this.sent.filter(value => value.type === "read_history").at(-1)!; }
}

describe("terminal transcript contract", () => {
  it.each(["codex", "claude", "grok"])("preserves only explicit supported %s history markers without granting control", provider => {
    const parsed = SessionSchema.parse({ ...session, provider: `terminal/${provider}` });
    expect(parsed.historySource).toBe("terminal-transcript");
    expect(parsed.loaded).toBe(false);
    expect(parsed.capabilities).toEqual(["read"]);
    expect(parsed.sendAvailability).toBeUndefined();
    expect(SessionSchema.parse({ ...session, historySource: undefined }).historySource).toBeUndefined();
  });

  it.each([
    { id: "native" }, { id: "terminal:short" }, { id: `terminal:${"a".repeat(43)}` }, { id: SESSION_ID + "\n" },
    { provider: "codex-app" }, { provider: "terminal/unknown" }, { historySource: "codex-desktop" },
  ])("rejects an invalid marker identity %#", change => {
    expect(SessionSchema.safeParse({ ...session, ...change }).success).toBe(false);
  });

  it("accepts visible CLI items and empty turn IDs but rejects snapshots and native/terminal source crossing", () => {
    expect(SessionHistorySchema.safeParse(history).success).toBe(true);
    for (const source of ["control-socket", "codex-desktop"]) {
      expect(SessionHistorySchema.safeParse({ ...history, source }).success).toBe(false);
      expect(SessionHistorySchema.safeParse({ ...history, source,
        session: { ...session, id: "native", provider: "codex-app", historySource: undefined } }).success).toBe(true);
    }
    for (const target of [{ ...session, historySource: undefined },
      { ...session, id: "native", provider: "codex-app", historySource: undefined }]) {
      expect(SessionHistorySchema.safeParse({ ...history, session: target }).success).toBe(false);
    }
    for (const kind of ["tool", "system"]) {
      expect(SessionHistorySchema.safeParse({ ...history, items: [{ ...history.items[0], kind, type: "terminalSnapshot" }] }).success).toBe(false);
    }
    expect(SessionHistorySchema.safeParse({ ...history, items: [{ ...history.items[0], type: "terminalSnapshot" }] }).success).toBe(false);
    expect(SessionHistorySchema.safeParse({ ...history, items: [{ ...history.items[0], type: "transcript_chunk" }] }).success).toBe(true);
  });

  it.each(["control-socket", "codex-desktop"])("rejects %s from a terminal request before projecting it", async source => {
    const requests = new SessionHistoryRequests();
    const socket = new Socket();
    const ws = socket as unknown as WebSocket;
    const pending = requests.read("node", SESSION_ID, ws, {});
    const rejected = expect(pending).rejects.toMatchObject({ code: "history_invalid_response" });
    requests.receive("node", ws, { type: "history", requestId: socket.request().requestId,
      sessionId: SESSION_ID, history: { ...history, source } });
    await rejected;
  });

  it.each(["active", "blocked", "unknown"])("reads %s observations independently of send qualification and writes no commands", async status => {
    const store = new MemoryStore();
    const hub = new NodeHub(store, new Map());
    const socket = new Socket();
    hub.handleConnection(socket as unknown as WebSocket, "node");
    try {
      socket.receive({ type: "hello", version: 1, nodeId: "node", sessions: [{ ...session, status }], skills: [] });
      await Promise.resolve();
      await Promise.resolve();
      const create = vi.spyOn(store, "createCommandIfAbsent");
      const update = vi.spyOn(store, "updateCommandStatus");
      const read = hub.readHistory("node", SESSION_ID);
      socket.receive({ type: "history", requestId: socket.request().requestId, sessionId: SESSION_ID,
        history: { ...history, session: { ...session, status } } });
      expect(await read).toMatchObject({ source: "terminal-transcript", session: { loaded: false, status } });
      expect(create).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(socket.sent.some(frame => frame.type === "command" || frame.type === "inspect_turn")).toBe(false);
      create.mockRestore();
      update.mockRestore();
    } finally { await hub.closeAll(); }
  });

  it("pins a terminal request to the provider from the current inventory", async () => {
    const store = new MemoryStore();
    const hub = new NodeHub(store, new Map());
    const socket = new Socket();
    hub.handleConnection(socket as unknown as WebSocket, "node");
    try {
      socket.receive({ type: "hello", version: 1, nodeId: "node", sessions: [session], skills: [] });
      await Promise.resolve(); await Promise.resolve();
      const pending = hub.readHistory("node", SESSION_ID);
      const rejected = expect(pending).rejects.toMatchObject({ code: "history_invalid_response" });
      socket.receive({ type: "history", requestId: socket.request().requestId, sessionId: SESSION_ID,
        history: { ...history, session: { ...session, provider: "terminal/grok" } } });
      await rejected;
    } finally { await hub.closeAll(); }
  });
});
