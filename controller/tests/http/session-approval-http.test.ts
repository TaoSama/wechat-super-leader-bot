import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { ControllerServer } from "../../src/http/server.js";
import { MemoryStore } from "../../src/store/memory.js";
import type { Config } from "../../src/runtime/config.js";
import type { Session } from "../../src/types.js";

const CONTROLLER_TOKEN = "approval-admin-token";
const NODE_TOKEN = "approval-node-token";
const CONSOLE_ORIGIN = "http://127.0.0.1:8790";
const SESSION_ID = "waiting-thread";
const TURN_ID = "turn-waiting";
const APPROVAL_PATH = `/v1/sessions/macair/${SESSION_ID}/approval`;
const PENDING = { requestId: "7", kind: "commandExecution", turnId: TURN_ID, command: "make deploy", answerable: true } as const;
const BODY = { requestId: "press-1", turnId: TURN_ID, approvalRequestId: "7", decision: "accept" };

type Frame = Record<string, unknown>;

describe("Console session approval boundary", () => {
  let server: ControllerServer;
  let store: MemoryStore;
  let baseUrl: string;
  let cookie: string;
  const sockets: WebSocket[] = [];

  function session(overrides: Partial<Session> = {}): Session {
    return { id: SESSION_ID, provider: "codex-app", title: "Waiting thread", cwd: "/w", status: "waitingApproval",
      capabilities: ["read", "send"], observedAt: new Date().toISOString(), loaded: true, pendingApprovals: [PENDING], ...overrides };
  }

  function headers(overrides: Record<string, string | undefined> = {}): Record<string, string> {
    const all: Record<string, string | undefined> = { Cookie: cookie, Origin: CONSOLE_ORIGIN, "Content-Type": "application/json",
      "X-Super-Leader-Intent": "session-approval", "Sec-Fetch-Site": "same-origin", ...overrides };
    return Object.fromEntries(Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== undefined));
  }

  function post(body: unknown = BODY, requestHeaders = headers(), path = APPROVAL_PATH) {
    return fetch(baseUrl + path, { method: "POST", headers: requestHeaders, body: JSON.stringify(body) });
  }

  async function connect(target = session(), reply: (frame: Frame) => Frame | undefined = frame =>
    ({ type: "result", commandId: frame.commandId, status: "completed", turnId: frame.expectedTurnId, output: "resolved" })) {
    const ws = new WebSocket(baseUrl.replace("http:", "ws:") + "/v1/daemon", { headers: { Authorization: `Bearer ${NODE_TOKEN}` } });
    sockets.push(ws);
    const frames: Frame[] = [];
    ws.on("message", raw => {
      const frame = JSON.parse(raw.toString()) as Frame;
      frames.push(frame);
      const result = frame.type === "command" ? reply(frame) : undefined;
      if (result) ws.send(JSON.stringify(result));
    });
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    ws.send(JSON.stringify({ type: "hello", version: 1, nodeId: "macair", sessions: [target], skills: [] }));
    await vi.waitFor(() => expect(server.getNodeHub().isNodeConnected("macair")).toBe(true));
    return frames;
  }

  beforeEach(async () => {
    store = new MemoryStore();
    const config: Config = { port: 0, host: "127.0.0.1", controllerToken: CONTROLLER_TOKEN,
      nodeTokens: { macair: NODE_TOKEN }, tokenToNode: new Map([[NODE_TOKEN, "macair"]]),
      allowedChatIds: new Set(["allowed-chat"]), persistenceMode: "memory", commandTtlSeconds: 60, consolePublicUrl: CONSOLE_ORIGIN };
    server = new ControllerServer(config, store);
    await server.start();
    baseUrl = `http://127.0.0.1:${(server.getHttpServer().address() as AddressInfo).port}`;
    const issue = await fetch(baseUrl + "/v1/console-links", { method: "POST",
      headers: { Authorization: `Bearer ${CONTROLLER_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: "approval-login" }) });
    const link = await issue.json();
    const exchange = await fetch(baseUrl + "/auth/exchange", { method: "POST",
      headers: { Origin: CONSOLE_ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ token: new URL(link.url).hash.slice("#login=".length) }) });
    cookie = exchange.headers.get("set-cookie")!.split(";")[0];
  });

  afterEach(async () => {
    await server.stop();
    for (const ws of sockets.splice(0)) if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  });

  it("sends one exact approval and returns the resolved receipt; retries reuse it", async () => {
    const frames = await connect();
    const response = await post();
    expect(response.status).toBe(200);
    const command = await response.json();
    expect(command).toMatchObject({ action: "approve", status: "completed", turnId: TURN_ID, approvalRequestId: "7", approvalDecision: "accept" });
    const commands = frames.filter(frame => frame.type === "command");
    expect(commands).toEqual([expect.objectContaining({ action: "approve", sessionId: SESSION_ID, expectedTurnId: TURN_ID,
      approvalRequestId: "7", approvalDecision: "accept" })]);
    expect(commands[0]).not.toHaveProperty("prompt");
    expect((await (await post()).json()).commandId).toBe(command.commandId);
    expect(frames.filter(frame => frame.type === "command")).toHaveLength(1);
    expect((await post({ ...BODY, decision: "decline" })).status).toBe(409);
  });

  it("rejects requests that are not observed as pending on that turn", async () => {
    const frames = await connect();
    expect((await post({ ...BODY, requestId: "press-2", approvalRequestId: "8" })).status).toBe(409);
    expect((await post({ ...BODY, requestId: "press-3", turnId: "turn-other" })).status).toBe(409);
    expect(frames.filter(frame => frame.type === "command")).toHaveLength(0);
  });

  it("keeps an unknown daemon outcome uncertain", async () => {
    await connect(session(), frame => ({ type: "result", commandId: frame.commandId, status: "uncertain", error: "no resolution" }));
    const command = await (await post()).json();
    expect(command.status).toBe("uncertain");
    expect(command.turnId).toBeUndefined();
  });

  it.each([
    ["missing Origin", { Origin: undefined }],
    ["foreign Origin", { Origin: "https://foreign.example" }],
    ["missing intent", { "X-Super-Leader-Intent": undefined }],
    ["interrupt intent", { "X-Super-Leader-Intent": "session-interrupt" }],
    ["non-JSON content type", { "Content-Type": "text/plain" }],
    ["cross-site fetch", { "Sec-Fetch-Site": "cross-site" }],
    ["missing Cookie", { Cookie: undefined }],
  ])("rejects %s before dispatch", async (_label, overrides) => {
    const frames = await connect();
    const status = (await post(undefined, headers(overrides))).status;
    expect([401, 403]).toContain(status);
    expect(frames.filter(frame => frame.type === "command")).toHaveLength(0);
    expect(await store.listRecentCommands()).toEqual([]);
  });

  it("rejects malformed bodies, session-wide decisions and terminal targets without commands", async () => {
    const frames = await connect();
    expect((await post({ ...BODY, decision: "acceptForSession" })).status).toBe(400);
    expect((await post({ ...BODY, prompt: "x" })).status).toBe(400);
    expect((await post({ requestId: "press-4", turnId: TURN_ID })).status).toBe(400);
    expect((await post(undefined, headers(), "/v1/sessions/macair/terminal%3Apane-1/approval")).status).toBe(400);
    expect(frames.filter(frame => frame.type === "command")).toHaveLength(0);
    expect(await store.listRecentCommands()).toEqual([]);
  });
});
