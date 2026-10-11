import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { NodeHub } from "../src/hub.js";
import { CommandService } from "../src/commands.js";
import { MemoryStore } from "../src/store/memory.js";

class NodeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  sent: Record<string, unknown>[] = [];
  closeCode?: number;
  send(raw: string, callback?: (error?: Error) => void) { this.sent.push(JSON.parse(raw)); callback?.(); }
  close(code?: number) { this.closeCode = code; this.readyState = WebSocket.CLOSED; this.emit("close"); }
  receive(message: unknown) { this.emit("message", JSON.stringify(message)); }
}

async function fixture() {
  const store = new MemoryStore();
  const hub = new NodeHub(store, new Map([["air-token", "demoair"], ["mini-token", "demomini"]]));
  const sockets = [new NodeSocket(), new NodeSocket()];
  for (const [index, nodeId] of ["demoair", "demomini"].entries()) {
    hub.handleConnection(sockets[index] as unknown as WebSocket, nodeId);
    sockets[index].receive({ type: "hello", version: 1, nodeId, skills: [], sessions: [{
      id: "shared-session", title: "same title", provider: "codex-app", cwd: "/fixture",
      observedAt: new Date().toISOString(), loaded: true, status: "idle", capabilities: ["read", "send"],
    }] });
  }
  await vi.waitFor(async () => expect(await hub.getAllSessions()).toHaveLength(2));
  return { store, hub, air: sockets[0], mini: sockets[1], service: new CommandService(store, hub, 300) };
}

it("routes identical session IDs by node and rejects cross-node receipts", async () => {
  const f = await fixture();
  try {
    expect(f.hub.authenticateToken("air-token")).toBe("demoair");
    expect(f.hub.authenticateToken("unknown")).toBeNull();
    const commands = await Promise.all(["demoair", "demomini"].map(nodeId => f.service.submit({
      nodeId, sessionId: "shared-session", action: "send", prompt: "fixture only", requestId: nodeId,
    }, 0)));
    expect(f.air.sent.filter(m => m.type === "command")).toEqual([expect.objectContaining({ commandId: commands[0].commandId, nodeId: "demoair" })]);
    expect(f.mini.sent.filter(m => m.type === "command")).toEqual([expect.objectContaining({ commandId: commands[1].commandId, nodeId: "demomini" })]);
    f.mini.receive({ type: "result", commandId: commands[0].commandId, status: "accepted", turnId: "foreign-turn" });
    f.air.receive({ type: "result", commandId: commands[0].commandId, status: "accepted", turnId: "air-turn" });
    await vi.waitFor(() => expect(f.air.sent.some(m => m.type === "result_ack")).toBe(true));
    expect((await f.store.getCommand(commands[0].commandId))?.turnId).toBe("air-turn");
    expect(f.mini.sent.some(m => m.type === "result_ack")).toBe(false);
    f.air.close();
    await vi.waitFor(async () => expect((await f.store.getCommand(commands[0].commandId))?.status).toBe("uncertain"));
    expect((await f.store.getCommand(commands[1].commandId))?.status).toBe("pending");
    expect(f.hub.isNodeConnected("demomini")).toBe(true);
    expect((await f.hub.getAllSessions()).map(s => s.nodeId)).toEqual(["demomini"]);
  } finally { await f.hub.closeAll(); }
});

it("rejects duplicate live nodes and mismatched authenticated hello without replacing other nodes", async () => {
  const f = await fixture();
  try {
    const duplicate = new NodeSocket();
    f.hub.handleConnection(duplicate as unknown as WebSocket, "demoair");
    expect(duplicate.closeCode).toBe(4009);
    expect(f.hub.isNodeConnected("demoair")).toBe(true);
    const imposter = new NodeSocket();
    f.hub.handleConnection(imposter as unknown as WebSocket, "third-node");
    imposter.receive({ type: "hello", version: 1, nodeId: "demomini", sessions: [], skills: [] });
    await vi.waitFor(() => expect(imposter.closeCode).toBe(4003));
    expect(f.hub.isNodeConnected("demomini")).toBe(true);
    expect(await f.hub.getAllSessions()).toHaveLength(2);
  } finally { await f.hub.closeAll(); }
});

it("discards an old socket result whose command lookup resumes after replacement", async () => {
  const f = await fixture();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const originalGet = f.store.getCommand.bind(f.store);
  let lookupEntered = false;
  try {
    const cmd = await f.service.submit({ nodeId: "demoair", sessionId: "shared-session",
      action: "send", prompt: "fixture only", requestId: "stale-result" }, 0);
    vi.spyOn(f.store, "getCommand").mockImplementationOnce(async id => {
      const snapshot = await originalGet(id);
      lookupEntered = true;
      await barrier;
      return snapshot;
    });
    f.air.receive({ type: "result", commandId: cmd.commandId, status: "accepted", turnId: "current-turn", output: "stale output" });
    await vi.waitFor(() => expect(lookupEntered).toBe(true));
    f.air.close();
    const replacement = new NodeSocket();
    f.hub.handleConnection(replacement as unknown as WebSocket, "demoair");
    replacement.receive({ type: "hello", version: 1, nodeId: "demoair", sessions: [], skills: [] });
    replacement.receive({ type: "result", commandId: cmd.commandId, status: "accepted", turnId: "current-turn", output: "current output" });
    await vi.waitFor(() => expect(replacement.sent.some(m => m.type === "result_ack")).toBe(true));
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(await originalGet(cmd.commandId)).toMatchObject({ status: "accepted", turnId: "current-turn", output: "current output" });
    expect(f.air.sent.some(m => m.type === "result_ack")).toBe(false);
  } finally {
    release();
    vi.restoreAllMocks();
    await f.hub.closeAll();
  }
});

it("revokes cached authority on malformed inventory instead of keeping old ready or native fallback", async () => {
  const f = await fixture();
  try {
    f.air.receive({ type: "heartbeat", skills: [], sessions: [{
      id: "shared-session", observedAt: new Date().toISOString(), loaded: true, status: "idle", capabilities: ["read", "send"],
      sendAvailability: { route: "invalid", state: "ready", observedAt: new Date().toISOString(), validUntil: "invalid" },
    }] });
    expect(f.air.closeCode).toBe(4000);
    expect(f.hub.isNodeConnected("demoair")).toBe(false);
    expect(f.hub.getNodeSession("demoair", "shared-session")).toBeNull();
    await expect(f.service.submit({ nodeId: "demoair", sessionId: "shared-session", action: "send", prompt: "fixture", requestId: "invalid-inventory" }, 0)).rejects.toThrow("offline");
    expect(f.air.sent.filter(frame => frame.type === "command")).toHaveLength(0);
  } finally { await f.hub.closeAll(); }
});
