import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { ControllerServer } from "../src/server.js";
import { MemoryStore } from "../src/store/memory.js";
import type { Config } from "../src/config.js";
import type { Session, SessionHistory } from "../src/types.js";
import { CONSOLE_SESSION_TTL_MS } from "../src/console/auth.js";

const CONTROLLER_TOKEN = "workspace-admin-token";
const CONSOLE_ORIGIN = "http://127.0.0.1:8790";
const SESSION_ID = "shared-thread";
const NODE_TOKENS = new Map([["demoair", "workspace-air-token"], ["demomini", "workspace-mini-token"]]);
const MESSAGE_PATH = `/v1/sessions/demoair/${SESSION_ID}/messages`;
const HISTORY_PATH = `/v1/sessions/demoair/${SESSION_ID}/history`;

type Frame = Record<string, unknown>;
interface FakeDaemon {
  ws: WebSocket;
  frames: Frame[];
  history: SessionHistory;
}

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: SESSION_ID, provider: "codex-app", title: "Workspace thread", cwd: "/workspace",
    status: "idle", capabilities: ["read", "send"], observedAt: new Date().toISOString(),
    loaded: true, model: "reported-model", modelProvider: "reported-provider", reasoningEffort: "high",
    ...overrides,
  };
}

describe("Session workspace HTTP boundary", () => {
  let server: ControllerServer;
  let store: MemoryStore;
  let baseUrl: string;
  let cookie: string;
  let now: number;
  let loginSequence: number;
  const daemons: FakeDaemon[] = [];

  it("Cookie history request explicitly selects pagination without sending a command", async () => {
    const air = await connect();
    const response = await fetch(baseUrl + HISTORY_PATH + "?source=control-socket", { headers: { Cookie: cookie } });
    expect(response.status).toBe(200);
    expect((await response.json()).source).toBe("control-socket");
    expect(air.frames).toHaveLength(1);
    expect(air.frames[0]).toMatchObject({ type: "read_history", source: "control-socket" });
    for (const source of ["codex-desktop", "terminal-transcript", "invalid"]) {
      expect((await fetch(baseUrl + HISTORY_PATH + "?source=" + source, { headers: { Cookie: cookie } })).status).toBe(400);
    }
    expect(air.frames).toHaveLength(1);
  });

  function browserHeaders(overrides: Record<string, string> = {}): Record<string, string> {
    return {
      Cookie: cookie, Origin: CONSOLE_ORIGIN, "Content-Type": "application/json",
      "X-Super-Leader-Intent": "session-message", "Sec-Fetch-Site": "same-origin", ...overrides,
    };
  }

  function post(body: unknown = { prompt: "hello", requestId: "request-1" },
    headers = browserHeaders(), path = MESSAGE_PATH): Promise<Response> {
    return fetch(baseUrl + path, { method: "POST", headers, body: JSON.stringify(body) });
  }

  async function login(): Promise<string> {
    const issue = await fetch(baseUrl + "/v1/console-links", {
      method: "POST",
      headers: { Authorization: `Bearer ${CONTROLLER_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: `workspace-login-${++loginSequence}` }),
    });
    expect(issue.status).toBe(200);
    const link = await issue.json();
    const exchange = await fetch(baseUrl + "/auth/exchange", {
      method: "POST", headers: { Origin: CONSOLE_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ token: new URL(link.url).hash.slice("#login=".length) }),
    });
    expect(exchange.status).toBe(200);
    const setCookie = exchange.headers.get("set-cookie");
    expect(setCookie).toContain("HttpOnly");
    return setCookie!.split(";")[0];
  }

  async function connect(nodeId = "demoair", target = session(), replyHistory = true): Promise<FakeDaemon> {
    const ws = new WebSocket(baseUrl.replace("http:", "ws:") + "/v1/daemon", {
      headers: { Authorization: `Bearer ${NODE_TOKENS.get(nodeId)}` },
    });
    const daemon: FakeDaemon = {
      ws, frames: [],
      history: {
        session: target,
        historyContext: "cf7e282f-d6d2-4a98-a517-9fb753f2549b", source: "control-socket",
        items: [{ id: `${nodeId}-item`, turnId: "turn-1", kind: "assistant", type: "agentMessage", text: `${nodeId} history` }],
        nextCursor: "older-page", fetchedAt: new Date().toISOString(), truncated: false,
      },
    };
    daemons.push(daemon);
    ws.on("message", raw => {
      const frame = JSON.parse(raw.toString()) as Frame;
      daemon.frames.push(frame);
      if (frame.type === "read_history" && replyHistory) {
        ws.send(JSON.stringify({ type: "history", requestId: frame.requestId,
          sessionId: frame.sessionId, history: daemon.history }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "hello", version: 1, nodeId, sessions: [target], skills: [] }));
    await vi.waitFor(() => expect(server.getNodeHub().isNodeConnected(nodeId)).toBe(true));
    return daemon;
  }

  beforeEach(async () => {
    now = Date.now();
    loginSequence = 0;
    daemons.length = 0;
    store = new MemoryStore();
    const config: Config = {
      port: 0, host: "127.0.0.1", controllerToken: CONTROLLER_TOKEN,
      nodeTokens: Object.fromEntries(NODE_TOKENS),
      tokenToNode: new Map([...NODE_TOKENS].map(([nodeId, token]) => [token, nodeId])),
      allowedChatIds: new Set(["allowed-chat"]), persistenceMode: "memory",
      commandTtlSeconds: 60, consolePublicUrl: CONSOLE_ORIGIN,
    };
    server = new ControllerServer(config, store, undefined, () => now);
    await server.start();
    const address = server.getHttpServer().address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
    cookie = await login();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await server.stop();
    for (const daemon of daemons) {
      if (daemon.ws.readyState !== WebSocket.CLOSED) daemon.ws.terminate();
    }
  });

  it("reads Cookie and Bearer history through a real daemon roundtrip without creating commands", async () => {
    const air = await connect();
    const mini = await connect("demomini");
    const first = await fetch(baseUrl + HISTORY_PATH, { headers: { Cookie: cookie } });
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(await first.json()).toEqual(air.history);
    expect(air.frames[0]).toMatchObject({ type: "read_history", nodeId: "demoair", sessionId: SESSION_ID, limit: 30 });
    expect(air.frames[0].requestId).toEqual(expect.any(String));
    expect(mini.frames).toHaveLength(0);

    const second = await fetch(baseUrl + HISTORY_PATH + `?cursor=opaque%2Bolder%3D&limit=1&historyContext=${air.history.historyContext}`, {
      headers: { Authorization: `Bearer ${CONTROLLER_TOKEN}` },
    });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(air.history);
    expect(air.frames[1]).toMatchObject({ cursor: "opaque+older=", limit: 1 });
    expect(air.frames[1].requestId).not.toBe(air.frames[0].requestId);
    expect(await store.listRecentCommands()).toEqual([]);
  });

  it.each([
    ["History context expired", 409, "history_context_expired"],
    ["History incomplete", 502, "history_incomplete"],
    ["History response too large", 413, "history_too_large"],
  ])("returns static %s HTTP errors from the exact daemon", async (error, status, code) => {
    const air = await connect("demoair", session(), false);
    air.ws.on("message", raw => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "read_history") air.ws.send(JSON.stringify({ type: "history", requestId: frame.requestId, sessionId: frame.sessionId, error }));
    });
    const response = await fetch(baseUrl + HISTORY_PATH, { headers: { Cookie: cookie } });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code, error });
  });

  it("HTTP cancellation sends the exact request tuple and ignores its late reply", async () => {
    const air = await connect("demoair", session(), false);
    const abort = new AbortController();
    const read = fetch(baseUrl + HISTORY_PATH, { headers: { Cookie: cookie }, signal: abort.signal });
    const cancelled = expect(read).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(air.frames.filter(frame => frame.type === "read_history")).toHaveLength(1));
    const original = air.frames[0];
    abort.abort();
    await cancelled;
    await vi.waitFor(() => expect(air.frames.filter(frame => frame.type === "cancel_history")).toHaveLength(1));
    expect(air.frames.at(-1)).toEqual({ type: "cancel_history", requestId: original.requestId, nodeId: "demoair", sessionId: SESSION_ID });
    air.ws.send(JSON.stringify({ type: "history", requestId: original.requestId, sessionId: SESSION_ID, history: air.history }));
    const next = fetch(baseUrl + HISTORY_PATH, { headers: { Cookie: cookie } });
    await vi.waitFor(() => expect(air.frames.filter(frame => frame.type === "read_history")).toHaveLength(2));
    const request = air.frames.at(-1)!;
    air.ws.send(JSON.stringify({ type: "history", requestId: request.requestId, sessionId: SESSION_ID, history: air.history }));
    expect((await next).status).toBe(200);
  });

  it("dispatches the fixed send action to the exact node/session and permits Cookie receipt reads", async () => {
    const air = await connect();
    const mini = await connect("demomini");
    const response = await post({ prompt: "exact target", requestId: "browser-request" });
    expect(response.status).toBe(202);
    const command = await response.json();
    const expectedRequestId = "web_" + createHash("sha256")
      .update(JSON.stringify(["session-message", "browser-request"])).digest("hex");
    expect(command).toMatchObject({ nodeId: "demoair", sessionId: SESSION_ID,
      action: "send", sendRoute: "control-socket", prompt: "exact target", requestId: expectedRequestId, status: "pending" });
    await vi.waitFor(() => expect(air.frames).toHaveLength(1));
    expect(air.frames[0]).toMatchObject({ type: "command", commandId: command.commandId,
      nodeId: "demoair", sessionId: SESSION_ID, action: "send", sendRoute: "control-socket", prompt: "exact target" });
    expect(air.frames[0]).not.toHaveProperty("skills");
    expect(mini.frames).toHaveLength(0);
    const receipt = await fetch(baseUrl + `/v1/commands/${command.commandId}`, { headers: { Cookie: cookie } });
    expect(receipt.status).toBe(200);
    expect((await receipt.json()).commandId).toBe(command.commandId);
  });

  it("dispatches concurrent retries once and rejects changed prompt or target with 409", async () => {
    const air = await connect();
    const mini = await connect("demomini");
    const send = vi.spyOn(server.getNodeHub(), "sendCommand");
    const responses = await Promise.all(Array.from({ length: 12 }, () => post()));
    expect(responses.every(response => response.status === 202)).toBe(true);
    const commands = await Promise.all(responses.map(response => response.json()));
    expect(new Set(commands.map(command => command.commandId)).size).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(air.frames.filter(frame => frame.type === "command")).toHaveLength(1));
    expect((await store.listRecentCommands()).length).toBe(1);
    expect((await post({ prompt: "different", requestId: "request-1" })).status).toBe(409);
    expect((await post(undefined, browserHeaders(), `/v1/sessions/demomini/${SESSION_ID}/messages`)).status).toBe(409);
    expect(send).toHaveBeenCalledTimes(1);
    expect(mini.frames).toHaveLength(0);
  });

  it.each([
    ["missing Origin", "Origin", undefined],
    ["foreign Origin", "Origin", "https://foreign.example"],
    ["different Origin port", "Origin", "http://127.0.0.1:8791"],
    ["null Origin", "Origin", "null"],
    ["missing intent", "X-Super-Leader-Intent", undefined],
    ["incorrect intent", "X-Super-Leader-Intent", "send"],
    ["non-JSON content type", "Content-Type", "text/plain"],
    ["missing content type", "Content-Type", undefined],
    ["cross-site fetch", "Sec-Fetch-Site", "cross-site"],
    ["same-site fetch", "Sec-Fetch-Site", "same-site"],
  ])("rejects Cookie sending with %s before dispatch", async (_label, name, value) => {
    const air = await connect();
    const headers = browserHeaders();
    if (value === undefined) delete headers[name!];
    else headers[name!] = value;
    expect((await post(undefined, headers)).status).toBe(403);
    expect(air.frames).toHaveLength(0);
    expect(await store.listRecentCommands()).toEqual([]);
  });

  it("allows exact-origin JSON without fetch metadata and separately authenticates Bearer sends", async () => {
    const air = await connect();
    const headers = browserHeaders();
    delete headers["Sec-Fetch-Site"];
    expect((await post({ prompt: "browser", requestId: "browser" }, headers)).status).toBe(202);
    expect((await post({ prompt: "admin", requestId: "admin" }, {
      Authorization: `Bearer ${CONTROLLER_TOKEN}`, "Content-Type": "application/json",
    })).status).toBe(202);
    expect((await post({ prompt: "wrong bearer", requestId: "bad-admin" },
      browserHeaders({ Authorization: "Bearer invalid" }))).status).toBe(403);
    await vi.waitFor(() => expect(air.frames.filter(frame => frame.type === "command")).toHaveLength(2));
  });

  it.each<[string, Record<string, unknown>]>([
    ["extra action", { action: "read" }], ["extra node", { nodeId: "demomini" }],
    ["extra session", { sessionId: "other" }], ["extra skills", { skills: [] }], ["extra route", { sendRoute: "desktop-owner" }],
    ["blank prompt", { prompt: "   " }], ["empty requestId", { requestId: "" }],
    ["unsafe requestId", { requestId: "unsafe/request" }],
    ["long requestId", { requestId: "r".repeat(129) }], ["long prompt", { prompt: "p".repeat(16001) }],
  ])("rejects message body with %s without creating a command", async (_label, change) => {
    const air = await connect();
    expect((await post({ prompt: "hello", requestId: "request-1", ...change })).status).toBe(400);
    expect(air.frames).toHaveLength(0);
    expect(await store.listRecentCommands()).toEqual([]);
  });

  it.each([
    "/v1/commands", "/v1/messages", "/v1/console-links",
  ])("keeps Cookie authority out of admin write route %s", async path => {
    expect((await post({ requestId: "admin-write", prompt: "hello", action: "send",
      nodeId: "demoair", sessionId: SESSION_ID, chatId: "allowed-chat", messageId: "m", text: "list" },
    browserHeaders(), path)).status).toBe(401);
    expect(await store.listRecentCommands()).toEqual([]);
  });

  it("rejects expired Cookie history and messages without daemon work", async () => {
    const air = await connect();
    now += CONSOLE_SESSION_TTL_MS;
    expect((await fetch(baseUrl + HISTORY_PATH, { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await post()).status).toBe(401);
    expect(air.frames).toHaveLength(0);
  });

  it("revokes Cookie history and sending immediately after logout", async () => {
    const air = await connect();
    const logout = await fetch(baseUrl + "/auth/logout", { method: "POST", headers: browserHeaders() });
    expect(logout.status).toBe(200);
    expect((await fetch(baseUrl + HISTORY_PATH, { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await post()).status).toBe(401);
    expect(air.frames).toHaveLength(0);
  });

  it.each<[string, Partial<Session>, number]>([
    ["busy", { status: "busy" }, 409],
    ["unknown status", { status: "unknown" }, 409],
    ["not loaded", { loaded: false }, 409],
    ["read-only", { capabilities: ["read"] }, 400],
    ["unknown capabilities", { capabilities: [] }, 400],
  ])("rejects %s targets without dispatch", async (_label, overrides, expectedStatus) => {
    const air = await connect("demoair", session(overrides));
    expect((await post()).status).toBe(expectedStatus);
    expect(air.frames).toHaveLength(0);
    expect(await store.listRecentCommands()).toEqual([]);
  });

  it("dispatches independent desktop authority and preserves it on retry after authority revocation", async () => {
    const observed = Date.now();
    const air = await connect("demoair", session({ loaded: false, status: "notLoaded", capabilities: ["read"],
      sendAvailability: { route: "desktop-owner", state: "ready", observedAt: new Date(observed).toISOString(), validUntil: new Date(observed + 45000).toISOString() } }));
    const response = await post();
    expect(response.status).toBe(202);
    const command = await response.json();
    expect(command.sendRoute).toBe("desktop-owner");
    await vi.waitFor(() => expect(air.frames).toHaveLength(1));
    expect(air.frames[0].sendRoute).toBe("desktop-owner");
    server.getNodeHub().getNodeSession("demoair", SESSION_ID)!.sendAvailability!.state = "blocked";
    expect((await (await post()).json()).commandId).toBe(command.commandId);
    expect(air.frames).toHaveLength(1);
  });

  it("fails a persisted command with zero wire frames when ready expires before final dispatch", async () => {
    const observed = Date.now();
    const air = await connect("demoair", session({ sendAvailability: {
      route: "desktop-owner", state: "ready", observedAt: new Date(observed).toISOString(), validUntil: new Date(observed + 45000).toISOString(),
    } }));
    const create = store.createCommandIfAbsent.bind(store);
    vi.spyOn(store, "createCommandIfAbsent").mockImplementationOnce(async record => {
      const result = await create(record);
      server.getNodeHub().getNodeSession("demoair", SESSION_ID)!.sendAvailability!.validUntil = new Date().toISOString();
      return result;
    });
    expect((await post()).status).toBe(409);
    expect(air.frames).toHaveLength(0);
    expect(await store.listRecentCommands()).toEqual([expect.objectContaining({ status: "failed", sendRoute: "desktop-owner" })]);
  });

  it("rejects a route injected into the admin command body", async () => {
    const air = await connect();
    const response = await post({ nodeId: "demoair", sessionId: SESSION_ID, action: "send", prompt: "fixture", requestId: "injected", sendRoute: "desktop-owner" },
      { Authorization: `Bearer ${CONTROLLER_TOKEN}`, "Content-Type": "application/json" }, "/v1/commands");
    expect(response.status).toBe(400);
    expect(air.frames).toHaveLength(0);
    expect(await store.listRecentCommands()).toEqual([]);
  });

  it("rejects offline and missing targets without dispatch", async () => {
    expect((await post()).status).toBe(503);
    const offlineHistory = await fetch(baseUrl + HISTORY_PATH, { headers: { Cookie: cookie } });
    expect(offlineHistory.status).toBe(503);
    expect((await offlineHistory.json()).code).toBe("history_offline");
    const air = await connect();
    expect((await post(undefined, browserHeaders(), "/v1/sessions/demoair/missing/messages")).status).toBe(404);
    const missingHistory = await fetch(baseUrl + "/v1/sessions/demoair/missing/history", { headers: { Cookie: cookie } });
    expect(missingHistory.status).toBe(404);
    expect((await missingHistory.json()).code).toBe("history_session_not_found");
    expect(air.frames).toHaveLength(0);
  });

  it.each([
    ["zero limit", "?limit=0"], ["large limit", "?limit=51"], ["padded limit", "?limit=01"],
    ["fractional limit", "?limit=1.5"], ["duplicate limit", "?limit=1&limit=2"],
    ["empty cursor", "?cursor="], ["long cursor", "?cursor=" + "c".repeat(4097)],
    ["cursor without context", "?cursor=opaque"], ["bad context", "?historyContext=bad"],
    ["empty context", "?historyContext="], ["duplicate context", "?historyContext=x&historyContext=y"],
    ["unknown field", "?unknown=value"], ["duplicate cursor", "?cursor=x&cursor=y"],
  ])("rejects history query with %s before reaching the daemon", async (_label, query) => {
    const air = await connect();
    expect((await fetch(baseUrl + HISTORY_PATH + query, { headers: { Cookie: cookie } })).status).toBe(400);
    expect(air.frames).toHaveLength(0);
  });

  it.each(["bad.node", "bad%2Fnode", "n".repeat(65)])("rejects invalid node target %s", async target => {
    expect((await post(undefined, browserHeaders(), `/v1/sessions/${target}/${SESSION_ID}/messages`)).status).toBe(400);
    expect((await fetch(baseUrl + `/v1/sessions/${target}/${SESSION_ID}/history`, { headers: { Cookie: cookie } })).status).toBe(400);
  });

  it.each(["bad.thread", "bad%2Fthread", "s".repeat(65)])("rejects invalid session target %s", async target => {
    expect((await post(undefined, browserHeaders(), `/v1/sessions/demoair/${target}/messages`)).status).toBe(400);
    expect((await fetch(baseUrl + `/v1/sessions/demoair/${target}/history`, { headers: { Cookie: cookie } })).status).toBe(400);
  });

  it("rechecks Cookie authorization after durable creation and before dispatch", async () => {
    const air = await connect();
    const originalCreate = store.createCommandIfAbsent.bind(store);
    const create = vi.spyOn(store, "createCommandIfAbsent").mockImplementation(async command => {
      const result = await originalCreate(command);
      now += CONSOLE_SESSION_TTL_MS;
      return result;
    });
    const send = vi.spyOn(server.getNodeHub(), "sendCommand");
    const response = await post();
    expect(response.status).toBe(401);
    expect(create).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(air.frames).toHaveLength(0);
    const records = await store.listRecentCommands();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: "failed", error: "Dispatch authority expired before transmission" });
  });
});
