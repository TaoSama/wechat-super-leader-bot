import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { NodeHub } from "../../src/nodes/hub.js";
import { HistoryError, SessionHistoryRequests } from "../../src/sessions/history.js";
import { MemoryStore } from "../../src/store/memory.js";
import { ControllerCancelHistoryMessageSchema, DaemonMessageSchema, HistoryReadOptionsSchema, SessionHistorySchema, SessionSchema } from "../../src/types.js";

class Socket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: Record<string, unknown>[] = [];
  failure?: "callback" | "throw";
  onSend?: (frame: Record<string, unknown>) => void;
  send(raw: string, callback?: (error?: Error) => void) {
    if (this.failure === "throw") throw new Error("private transport detail");
    this.sent.push(JSON.parse(raw));
    this.onSend?.(this.sent.at(-1)!);
    callback?.(this.failure === "callback" ? new Error("private transport detail") : undefined);
  }
  close() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
  receive(value: unknown) { this.emit("message", JSON.stringify(value)); }
  request() { return this.sent.filter(value => value.type === "read_history").at(-1)!; }
}
const session = SessionSchema.parse({ id: "session", observedAt: "2026-10-11T01:00:00Z",
  capabilities: ["read"],
  model: "actual-model", modelProvider: "actual-provider", reasoningEffort: "high",
  updatedAt: "2026-10-11T01:00:00Z", preview: "preview", loaded: false });
const history = { session, items: [{ id: "item", turnId: "turn", kind: "assistant", type: "agentMessage", text: "answer" }],
  historyContext: "cf7e282f-d6d2-4a98-a517-9fb753f2549b", source: "control-socket",
  nextCursor: "older-cursor", fetchedAt: "2026-10-11T01:00:00Z", truncated: false };
const response = (request: Record<string, unknown>, extra = {}) => ({
  type: "history", requestId: request.requestId, sessionId: request.sessionId, history, ...extra,
});
const hubs: NodeHub[] = [];
async function connected(hub: NodeHub, nodeId: string, current = session): Promise<Socket> {
  const ws = new Socket();
  hub.handleConnection(ws as unknown as WebSocket, nodeId);
  ws.receive({ type: "hello", version: 1, nodeId, sessions: [current], skills: [] });
  await Promise.resolve();
  await Promise.resolve();
  return ws;
}
function fixture() {
  const store = new MemoryStore();
  const hub = new NodeHub(store, new Map());
  hubs.push(hub);
  return { hub, store };
}
afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.closeAll();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("session history hub", () => {
  it.each([{ capabilities: undefined }, { capabilities: [] }, { capabilities: ["send"] }])(
    "requires an advertised read capability before dispatch: $capabilities", async ({ capabilities }) => {
      const { hub } = fixture();
      const ws = await connected(hub, "node", SessionSchema.parse({ ...session, capabilities }));
      ws.onSend = frame => { if (frame.type === "read_history") ws.receive(response(frame)); };
      await expect(hub.readHistory("node", "session")).rejects.toMatchObject({
        httpStatus: 403, code: "history_forbidden", message: "Session does not provide history reading capability",
      });
      expect(ws.sent).toEqual([]);
    });

  it("retains exact native turn statuses while rejecting unbounded or unknown metadata", () => {
    const parsed = SessionHistorySchema.parse({ ...history, items: [{ ...history.items[0], turnStatus: "inProgress" }],
      turnStatuses: { turn: "inProgress", old: "completed" } });
    expect(parsed.items[0].turnStatus).toBe("inProgress");
    expect(parsed.turnStatuses).toEqual({ turn: "inProgress", old: "completed" });
    for (const turnStatuses of [{ turn: "done" }, { "": "completed" }, { ["t".repeat(129)]: "completed" },
      Object.fromEntries(Array.from({ length: 2049 }, (_, index) => [String(index), "completed"]))]) {
      expect(SessionHistorySchema.safeParse({ ...history, turnStatuses }).success).toBe(false);
    }
    expect(SessionHistorySchema.safeParse({ ...history, items: [{ ...history.items[0], turnStatus: "done" }] }).success).toBe(false);
  });
  it("forwards an explicit paginated source and refuses a daemon source mismatch", async () => {
    const { hub } = fixture();
    const ws = await connected(hub, "node");
    const read = hub.readHistory("node", "session", { source: "control-socket" });
    expect(ws.request().source).toBe("control-socket");
    ws.receive(response(ws.request(), { history: { ...history, source: "codex-desktop" } }));
    await expect(read).rejects.toMatchObject({ code: "history_invalid_response" });
    for (const source of ["", "codex-desktop", "terminal-transcript", "unknown"]) {
      expect(HistoryReadOptionsSchema.safeParse({ source }).success).toBe(false);
    }
  });
  it("requires UUID contexts and rejects legacy history and cursor-only inputs", () => {
    for (const value of [undefined, "", "not-uuid", "x".repeat(129)]) {
      expect(SessionHistorySchema.safeParse({ ...history, historyContext: value }).success).toBe(false);
    }
    for (const source of [undefined, "desktop-owner", "unknown"]) {
      expect(SessionHistorySchema.safeParse({ ...history, source }).success).toBe(false);
    }
    expect(HistoryReadOptionsSchema.safeParse({ cursor: "opaque" }).success).toBe(false);
    expect(HistoryReadOptionsSchema.safeParse({ historyContext: "bad" }).success).toBe(false);
    expect(HistoryReadOptionsSchema.safeParse({ historyContext: history.historyContext }).success).toBe(true);
  });

  it.each([
    ["History context expired", 409, "history_context_expired"],
    ["History incomplete", 502, "history_incomplete"],
    ["History response too large", 413, "history_too_large"],
  ])("maps %s to a static HTTP error", async (message, httpStatus, code) => {
    const { hub } = fixture();
    const ws = await connected(hub, "node");
    const read = hub.readHistory("node", "session");
    ws.receive(response(ws.request(), { history: undefined, error: message }));
    await expect(read).rejects.toMatchObject({ httpStatus, code, message });
  });

  it("rejects a response which changes the requested context", async () => {
    const { hub } = fixture();
    const ws = await connected(hub, "node");
    const read = hub.readHistory("node", "session", { historyContext: history.historyContext });
    ws.receive(response(ws.request(), { history: { ...history, historyContext: "15c9ef38-59cc-410c-a0f0-6a54bcd7f41a" } }));
    await expect(read).rejects.toMatchObject({ code: "history_invalid_response" });
  });

  it.each(["abort", "timeout"])("%s removes pending before cancellation and ignores synchronous/late replies", async reason => {
    vi.useFakeTimers();
    const requests = new SessionHistoryRequests();
    const socket = new Socket();
    const ws = socket as unknown as WebSocket;
    const abort = new AbortController();
    const read = requests.read("node", "session", ws, {}, abort.signal);
    const request = socket.request();
    let acceptedLateReply: boolean | undefined;
    socket.onSend = frame => {
      if (frame.type === "cancel_history") acceptedLateReply = requests.receive("node", ws, response(request));
    };
    const expected = expect(read).rejects.toMatchObject({ code: reason === "abort" ? "history_aborted" : "history_timeout" });
    if (reason === "abort") abort.abort(); else await vi.advanceTimersByTimeAsync(15000);
    await expected;
    expect(socket.sent.at(-1)).toEqual({ type: "cancel_history", requestId: request.requestId, nodeId: "node", sessionId: "session" });
    expect(ControllerCancelHistoryMessageSchema.safeParse(socket.sent.at(-1)).success).toBe(true);
    expect(acceptedLateReply).toBe(false);
    expect(requests.receive("node", ws, response(request))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    const next = requests.read("node", "session", ws, {});
    expect(requests.receive("node", ws, response(socket.request()))).toBe(true);
    await expect(next).resolves.toEqual(history);
    expect(socket.sent.filter(frame => frame.type === "cancel_history")).toHaveLength(1);
  });

  it.each([
    ["abort", "callback"], ["abort", "throw"], ["timeout", "callback"], ["timeout", "throw"],
  ] as const)("handles %s/%s cancellation failure without replacing the original error", async (reason, failure) => {
    vi.useFakeTimers();
    const requests = new SessionHistoryRequests();
    const socket = new Socket();
    const ws = socket as unknown as WebSocket;
    const abort = new AbortController();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const read = requests.read("node", "session", ws, {}, abort.signal);
    const expected = expect(read).rejects.toMatchObject({ code: reason === "abort" ? "history_aborted" : "history_timeout" });
    socket.failure = failure;
    if (reason === "abort") abort.abort(); else await vi.advanceTimersByTimeAsync(15000);
    await expected;
    expect(warning).toHaveBeenCalledExactlyOnceWith("[history] cancellation transport failed");
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private transport detail");
    expect(requests.receive("node", ws, response(socket.request()))).toBe(false);
  });

  it("never sends cancellation to a closed socket or after successful completion", async () => {
    const requests = new SessionHistoryRequests();
    const socket = new Socket();
    const ws = socket as unknown as WebSocket;
    const completed = new AbortController();
    const read = requests.read("node", "session", ws, {}, completed.signal);
    requests.receive("node", ws, response(socket.request()));
    await read;
    completed.abort();
    const closed = new AbortController();
    const pending = requests.read("node", "session", ws, {}, closed.signal);
    const expected = expect(pending).rejects.toMatchObject({ code: "history_aborted" });
    socket.readyState = WebSocket.CLOSED;
    closed.abort();
    await expected;
    expect(socket.sent.filter(frame => frame.type === "cancel_history")).toHaveLength(0);
  });

  it("preserves reported metadata without fabricating defaults and validates history wire messages", () => {
    expect(session).toMatchObject({ model: "actual-model", modelProvider: "actual-provider", loaded: false });
    expect(SessionSchema.parse({ id: "unknown", observedAt: "now" })).not.toHaveProperty("model");
    expect(SessionHistorySchema.safeParse(history).success).toBe(true);
    const wire = response({ requestId: "90236f44-0d1d-4655-96b7-0f632b27026d", sessionId: "session" });
    expect(DaemonMessageSchema.safeParse(wire).success).toBe(true);
    expect(DaemonMessageSchema.safeParse({ ...wire, error: "failure" }).success).toBe(false);
    expect(DaemonMessageSchema.safeParse({ ...wire, history: undefined }).success).toBe(false);
    expect(SessionHistorySchema.safeParse({ ...history, items: [{ ...history.items[0], text: "x".repeat(16001) }] }).success).toBe(false);
  });

  it("reads an unloaded original session with scoped UUID request and never creates or reads commands", async () => {
    const { hub, store } = fixture();
    const ws = await connected(hub, "macair");
    const get = vi.spyOn(store, "getCommand");
    const create = vi.spyOn(store, "createCommandIfAbsent");
    const update = vi.spyOn(store, "updateCommandStatus");
    const pending = hub.readHistory("macair", "session", { cursor: "opaque", historyContext: history.historyContext, limit: 2 });
    expect(ws.request()).toMatchObject({ type: "read_history", nodeId: "macair", sessionId: "session", cursor: "opaque", historyContext: history.historyContext, limit: 2 });
    expect(ws.request().requestId).toMatch(/^[0-9a-f-]{36}$/);
    ws.receive(response(ws.request(), { history: { ...history, internalSecret: "not projected",
      items: [{ ...history.items[0], rawPayload: "not projected" }] } }));
    expect(await pending).toEqual(history);
    expect(get).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("isolates concurrent requests by node, session and request ID", async () => {
    const { hub } = fixture();
    const a = await connected(hub, "a");
    const b = await connected(hub, "b");
    const first = hub.readHistory("a", "session");
    const firstRequest = a.request();
    const second = hub.readHistory("a", "session");
    const secondRequest = a.request();
    let done = false;
    void first.then(() => { done = true; });
    b.receive(response(firstRequest));
    a.receive(response(firstRequest, { sessionId: "wrong" }));
    a.receive(response(firstRequest, { requestId: "90236f44-0d1d-4655-96b7-0f632b27026d" }));
    a.receive(response(secondRequest));
    await second;
    expect(done).toBe(false);
    a.receive(response(firstRequest));
    expect(await first).toEqual(history);
    expect(a.request().limit).toBe(30);
  });

  it("rejects metadata/session mismatch and malformed payload with static errors", async () => {
    const { hub } = fixture();
    const ws = await connected(hub, "node");
    const mismatch = hub.readHistory("node", "session");
    ws.receive(response(ws.request(), { history: { ...history, session: { ...session, id: "wrong" } } }));
    await expect(mismatch).rejects.toMatchObject({ httpStatus: 502, code: "history_invalid_response" });
    const malformed = hub.readHistory("node", "session");
    ws.receive(response(ws.request(), { history: { secret: "private" } }));
    await expect(malformed).rejects.toMatchObject({ message: "Invalid history response" });
    const failure = hub.readHistory("node", "session");
    ws.receive({ ...response(ws.request()), history: undefined, error: "provider /secret credential" });
    await expect(failure).rejects.toMatchObject({ code: "history_failed", message: "History request failed" });
  });

  it("enforces input, offline, missing-session and transport failures", async () => {
    const { hub } = fixture();
    await expect(hub.readHistory("missing", "session")).rejects.toMatchObject({ httpStatus: 503 });
    const ws = await connected(hub, "node");
    await expect(hub.readHistory("node", "missing")).rejects.toMatchObject({ httpStatus: 404 });
    for (const options of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { cursor: "x".repeat(4097) }]) {
      await expect(hub.readHistory("node", "session", options)).rejects.toMatchObject({ httpStatus: 400 });
    }
    for (const failure of ["throw", "callback"] as const) {
      ws.failure = failure;
      await expect(hub.readHistory("node", "session")).rejects.toMatchObject({ message: "History node disconnected" });
    }
  });

  it("cleans timers and abort handlers on completion, cancellation, timeout and shutdown", async () => {
    vi.useFakeTimers();
    const { hub } = fixture();
    const ws = await connected(hub, "node");
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const success = hub.readHistory("node", "session", {}, controller.signal);
    ws.receive(response(ws.request()));
    await success;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(1);
    const cancellation = hub.readHistory("node", "session", {}, controller.signal);
    const cancelled = expect(cancellation).rejects.toMatchObject({ code: "history_aborted" });
    controller.abort();
    await cancelled;
    await expect(hub.readHistory("node", "session", {}, controller.signal)).rejects.toBeInstanceOf(HistoryError);
    expect(vi.getTimerCount()).toBe(1);
    const expiry = expect(hub.readHistory("node", "session")).rejects.toMatchObject({ httpStatus: 504 });
    await vi.advanceTimersByTimeAsync(15000);
    await expiry;
    expect(vi.getTimerCount()).toBe(1);
    const shutdown = expect(hub.readHistory("node", "session")).rejects.toMatchObject({ code: "history_disconnected" });
    await hub.closeAll();
    await shutdown;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disconnects only the old socket across reconnect and ignores late responses", async () => {
    const { hub } = fixture();
    const old = await connected(hub, "node");
    const first = expect(hub.readHistory("node", "session")).rejects.toMatchObject({ code: "history_disconnected" });
    const oldRequest = old.request();
    old.readyState = WebSocket.CLOSED;
    const current = await connected(hub, "node");
    const next = hub.readHistory("node", "session");
    current.receive(response(oldRequest));
    old.receive(response(current.request()));
    old.emit("close");
    await first;
    current.receive(response(current.request()));
    expect(await next).toEqual(history);
  });

  it("bounds node and global concurrency, and cancellation immediately frees a slot", async () => {
    const { hub } = fixture();
    const controllers: AbortController[] = [];
    const pending: Promise<unknown>[] = [];
    for (let nodeIndex = 0; nodeIndex < 4; nodeIndex++) {
      const nodeId = `node-${nodeIndex}`;
      await connected(hub, nodeId);
      for (let index = 0; index < 8; index++) {
        const controller = new AbortController();
        controllers.push(controller);
        pending.push(hub.readHistory(nodeId, "session", {}, controller.signal).catch(error => error));
      }
      await expect(hub.readHistory(nodeId, "session")).rejects.toMatchObject({ httpStatus: 429 });
    }
    const fifth = await connected(hub, "fifth");
    await expect(hub.readHistory("fifth", "session")).rejects.toMatchObject({ code: "history_busy" });
    controllers[0].abort();
    const freed = hub.readHistory("fifth", "session");
    fifth.receive(response(fifth.request()));
    expect(await freed).toEqual(history);
    controllers.forEach(controller => controller.abort());
    expect((await Promise.all(pending)).every(error => error instanceof HistoryError)).toBe(true);
  });
});
