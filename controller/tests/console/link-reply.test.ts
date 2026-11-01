import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleAuthService } from "../../src/console/auth.js";
import { consoleLinkRequestId, redactIssuedConsoleLink, restoreConsoleLinkReply } from "../../src/console/link-reply.js";
import { hashConsoleToken } from "../../src/console/types.js";
import { ControllerServer } from "../../src/http/server.js";
import type { LeaderModel } from "../../src/leader/model/contracts.js";
import { DirectCallSchema } from "../../src/leader/direct-contracts.js";
import { DirectToolJournal } from "../../src/leader/direct-journal.js";
import { MemoryStore } from "../../src/store/memory.js";

const ADMIN = "console-recovery-test-admin";
const PUBLIC_URL = "https://console.example.test";
const CHAT = "console-chat";
const servers = new Set<ControllerServer>();
const bearer = { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" };

afterEach(async () => {
  for (const server of servers) await server.stop();
  servers.clear();
  vi.restoreAllMocks();
});

async function start(store: MemoryStore, now: () => number, model?: LeaderModel) {
  const server = new ControllerServer({ host: "127.0.0.1", port: 0, controllerToken: ADMIN,
    nodeTokens: {}, tokenToNode: new Map(), allowedChatIds: new Set([CHAT]),
    persistenceMode: "memory", commandTtlSeconds: 60, consolePublicUrl: PUBLIC_URL }, store, model, now);
  servers.add(server);
  await server.start();
  const base = `http://127.0.0.1:${(server.getHttpServer().address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown, headers = bearer) => {
    const response = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const get = async (messageId: string) => {
    const response = await fetch(`${base}/v1/messages/${messageId}/reply?chatId=${CHAT}`, { headers: bearer });
    return { status: response.status, body: await response.json() };
  };
  const stop = async () => { await server.stop(); servers.delete(server); };
  return { post, get, stop };
}

describe("console link delivery recovery", () => {
  it("only reads existing issuance and preserves its URL, deadline and first-login audit across service instances", async () => {
    const store = new MemoryStore();
    let clock = 1_700_000_000_000;
    const create = () => new ConsoleAuthService(store, PUBLIC_URL, ADMIN, () => clock);
    const auth = create();
    const requestId = consoleLinkRequestId(CHAT, "original");
    const issued = await auth.issueLink(requestId);
    const token = new URL(issued.url).hash.slice("#login=".length);
    const write = vi.spyOn(store, "createConsoleLinkIfAbsent");
    expect(await auth.recoverLink(consoleLinkRequestId(CHAT, "missing"))).toBeNull();
    clock += 60_000;
    const first = await auth.exchangeToken(token), second = await auth.exchangeToken(token);
    expect(first?.sessionToken).toBeTruthy();
    expect(second?.sessionToken).not.toBe(first?.sessionToken);
    const before = await store.getConsoleLink(hashConsoleToken(token));
    expect(await create().recoverLink(requestId)).toEqual(issued);
    expect(await store.getConsoleLink(hashConsoleToken(token))).toEqual(before);
    clock = Date.parse(issued.expiresAt);
    expect(await create().recoverLink(requestId)).toBeNull();
    expect(await create().redactReply(requestId, issued.url)).toBe(redactIssuedConsoleLink(issued.url, requestId, issued.url));
    expect(await auth.exchangeToken(token)).toBeNull();
    expect(await store.getConsoleLink(hashConsoleToken(token))).toEqual(before);
    expect(write).not.toHaveBeenCalled();
  });

  it("requires the original chat/message issuance and exact final URL, without trusting a marker or nested origin", async () => {
    const store = new MemoryStore();
    const auth = new ConsoleAuthService(store, PUBLIC_URL, ADMIN);
    const requestId = consoleLinkRequestId(CHAT, "message");
    const link = await auth.issueLink(requestId);
    const redactedUrl = redactIssuedConsoleLink(link.url, requestId, link.url);
    const text = `入口：\n${redactedUrl}`;
    const issue = vi.spyOn(auth, "issueLink");
    const create = vi.spyOn(store, "createConsoleLinkIfAbsent");
    const resolve = auth.recoverLink.bind(auth);
    expect(await restoreConsoleLinkReply(text, CHAT, "message", resolve)).toBe(`入口：\n${link.url}`);
    for (const [chatId, messageId] of [[CHAT, "missing"], ["other-chat", "message"]]) {
      expect(await restoreConsoleLinkReply(text, chatId, messageId, resolve)).toBe(text);
    }
    for (const url of [redactedUrl.replace(PUBLIC_URL, "https://untrusted.test"), `https://untrusted.test/?next=${redactedUrl}`]) {
      await expect(restoreConsoleLinkReply(`入口：\n${url}`, CHAT, "message", resolve)).rejects.toMatchObject({ statusCode: 410 });
    }
    expect(issue).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("redacts leader receipts and message rows, and replays the original reply after restarting the server", async () => {
    const store = new MemoryStore();
    const model: LeaderModel = { complete: vi.fn(async () => { throw new Error("Plain console requests must bypass the model"); }) };
    const f = await start(store, Date.now, model);
    const write = vi.spyOn(store, "recordMessage");
    const issue = vi.spyOn(ConsoleAuthService.prototype, "issueLink");
    const request = { chatId: CHAT, messageId: "leader-link", text: "给我控制台链接" };
    const issued = await f.post("/v1/messages", request);
    expect(issued.status).toBe(200);
    const token = issued.body.text.split("#login=")[1];
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(write.mock.calls)).not.toContain(token);
    const state = await store.getLeaderState(CHAT);
    expect(JSON.stringify(state)).not.toContain(token);
    const row = await store.getMessage(CHAT, request.messageId);
    expect(row?.replyText).toContain("#login=[CONSOLE_LINK:");
    expect(await f.post("/v1/messages", request)).toEqual(issued);
    await f.stop();
    const restarted = await start(store, Date.now, model);
    expect(await restarted.post("/v1/messages", request)).toEqual(issued);
    expect(await restarted.get(request.messageId)).toEqual(issued);
    expect(await store.getLeaderState(CHAT)).toEqual(state);
    expect(await store.getMessage(CHAT, request.messageId)).toEqual(row);
    expect(issue).toHaveBeenCalledOnce();
    expect(model.complete).not.toHaveBeenCalled();
  });

  it("redacts both direct journal copies and replays calls and effects with original expiry after restart, then rejects expiry", async () => {
    const store = new MemoryStore();
    let clock = 1_700_000_000_000;
    const f = await start(store, () => clock);
    const writes = vi.spyOn(store, "recordMessage");
    const issue = vi.spyOn(ConsoleAuthService.prototype, "issueLink");
    const request = { chatId: CHAT, messageId: "direct-link", text: "给我控制台链接", callId: "first", name: "get_console_link", arguments: {} };
    const issued = await f.post("/v1/tools/call", request);
    expect(issued.status).toBe(200);
    const token = issued.body.reply.text.split("#login=")[1];
    const initialRows = writes.mock.calls.map(([row]) => row);
    expect(initialRows.filter(row => row.messageId.startsWith("direct_effect_done_") || row.messageId.startsWith("direct_done_") || row.messageId === request.messageId)).toHaveLength(3);
    expect(JSON.stringify(initialRows)).not.toContain(token);
    const link = await store.getConsoleLink(hashConsoleToken(token));
    expect(issued.body.result.expiresAt).toBe(link?.expiresAt);
    clock += 60_000;
    expect(await f.post("/v1/tools/call", request)).toEqual(issued);
    expect(await f.post("/v1/tools/call", { ...request, callId: "second" })).toEqual(issued);
    await f.stop();
    const restarted = await start(store, () => clock);
    expect(await restarted.post("/v1/tools/call", request)).toEqual(issued);
    expect(await restarted.post("/v1/tools/call", { ...request, callId: "third" })).toEqual(issued);
    expect(await restarted.get(request.messageId)).toEqual({ status: 200, body: issued.body.reply });
    for (let attempt = 0; attempt < 2; attempt++) {
      const login = await restarted.post("/auth/exchange", { token }, { ...bearer, origin: PUBLIC_URL });
      expect(login.status).toBe(200);
    }
    expect(issue).toHaveBeenCalledOnce();
    expect(JSON.stringify(writes.mock.calls)).not.toContain(token);
    clock = Date.parse(link!.expiresAt);
    expect((await restarted.get(request.messageId)).status).toBe(410);
    expect((await restarted.post("/v1/tools/call", request)).status).toBe(410);
    expect((await restarted.post("/auth/exchange", { token }, { ...bearer, origin: PUBLIC_URL })).status).toBe(401);
    expect(issue).toHaveBeenCalledOnce();
    expect((await store.getConsoleLink(hashConsoleToken(token)))?.expiresAt).toBe(link!.expiresAt);
  });

  it("does not issue from forged persisted markers or rewrite historical plaintext receipts", async () => {
    const store = new MemoryStore();
    const f = await start(store, Date.now);
    for (const [messageId, replyText] of [["forged", `控制台\n${PUBLIC_URL}/#login=[CONSOLE_LINK:${consoleLinkRequestId(CHAT, "forged")}]`], ["legacy", `${PUBLIC_URL}/#login=historical-token`]]) {
      await store.recordMessage({ chatId: CHAT, messageId, text: "original", replyText, createdAt: new Date().toISOString() });
    }
    const issue = vi.spyOn(ConsoleAuthService.prototype, "issueLink");
    const create = vi.spyOn(store, "createConsoleLinkIfAbsent");
    const write = vi.spyOn(store, "recordMessage");
    expect((await f.get("forged")).status).toBe(410);
    expect((await f.post("/v1/messages", { chatId: CHAT, messageId: "forged", text: "original" })).status).toBe(410);
    expect(await f.get("legacy")).toEqual({ status: 200, body: { text: `${PUBLIC_URL}/#login=historical-token` } });
    expect(issue).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it.each(["example", "[REDACTED]"])("preserves ordinary third-party #login=%s text in replies and journal replays", async value => {
    const store = new MemoryStore();
    const text = `示例页面\nhttps://docs.example.test/#login=${value}`;
    const model: LeaderModel = { complete: vi.fn(async () => ({ content: text, toolCalls: [] })) };
    const f = await start(store, Date.now, model);
    const request = { chatId: CHAT, messageId: "ordinary", text: "说明示例页面" };
    const first = await f.post("/v1/messages", request);
    expect(first).toEqual({ status: 200, body: { text } });
    expect(await f.post("/v1/messages", request)).toEqual(first);
    expect(await f.get(request.messageId)).toEqual(first);
    expect((await store.getMessage(CHAT, request.messageId))?.replyText).toBe(text);
    const call = DirectCallSchema.parse({ ...request, messageId: "journal", callId: "call", name: "list_nodes", arguments: {} });
    const result = { result: { text }, reply: { text } };
    const action = vi.fn(async () => result);
    expect(await new DirectToolJournal(store, () => true).call(call, action)).toEqual(result);
    expect(await new DirectToolJournal(store, () => true).call(call, action)).toEqual(result);
    expect(action).toHaveBeenCalledOnce();
  });
});
