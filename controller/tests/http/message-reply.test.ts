import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleAuthService } from "../../src/console/auth.js";
import { ControllerServer } from "../../src/http/server.js";
import { LeaderOrchestrator } from "../../src/leader/orchestrator.js";
import { NaturalLanguageResolver } from "../../src/leader/queries/resolver.js";
import type { LeaderModel } from "../../src/leader/model/contracts.js";
import type { Config } from "../../src/runtime/config.js";
import { MemoryStore } from "../../src/store/memory.js";

const ADMIN = "message-reply-admin";
const NODE = "message-reply-node";
const ORIGIN = "http://127.0.0.1:8790";
const bearer = { Authorization: `Bearer ${ADMIN}` };
const servers: ControllerServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  vi.restoreAllMocks();
});

async function fixture(model?: LeaderModel) {
  const store = new MemoryStore();
  const config: Config = {
    host: "127.0.0.1", port: 0, controllerToken: ADMIN,
    nodeTokens: { fixture: NODE }, tokenToNode: new Map([[NODE, "fixture"]]),
    allowedChatIds: new Set(["allowed", "other"]), persistenceMode: "memory",
    commandTtlSeconds: 60, consolePublicUrl: ORIGIN,
  };
  const server = new ControllerServer(config, store, model);
  servers.push(server);
  await server.start();
  const base = `http://127.0.0.1:${(server.getHttpServer().address() as AddressInfo).port}`;
  const get = async (path = "/v1/messages/message/reply?chatId=allowed", headers: Record<string, string> = bearer) => {
    const response = await fetch(base + path, { headers });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  return { store, config, server, base, get };
}

async function seed(store: MemoryStore, messageId = "message") {
  await store.recordMessage({ chatId: "allowed", messageId, text: "private original request",
    replyText: "frozen reply", createdAt: new Date().toISOString() });
}

describe("immutable message reply recovery", () => {
  it("requires management Bearer even with a valid browser session or node token", async () => {
    const f = await fixture();
    await seed(f.store);
    const auth = new ConsoleAuthService(f.store, ORIGIN, ADMIN);
    const link = await auth.issueLink("message-reply-login");
    const session = await auth.exchangeToken(new URL(link.url).hash.slice("#login=".length));
    expect(session).not.toBeNull();
    const cookie = `super_leader_session=${session!.sessionToken}`;
    const browserSession = await fetch(f.base + "/auth/session", { headers: { Cookie: cookie } });
    expect(browserSession.status).toBe(200);
    await browserSession.arrayBuffer();

    const read = vi.spyOn(f.store, "getMessage");
    for (const [headers, status] of [
      [{}, 401],
      [{ Cookie: cookie }, 401],
      [{ Authorization: `Bearer ${NODE}` }, 403],
      [{ Authorization: "Bearer invalid-admin" }, 403],
    ] as const) {
      expect((await f.get(undefined, headers)).status).toBe(status);
    }
    expect(read).not.toHaveBeenCalled();
    const reply = await f.get();
    expect(reply.status).toBe(200);
    expect(reply.body).toEqual({ text: "frozen reply" });
    expect(reply.headers.get("cache-control")).toBe("no-store");
  });

  it("checks the current allowlist before accessing stored messages", async () => {
    const f = await fixture();
    await seed(f.store);
    const read = vi.spyOn(f.store, "getMessage");
    expect((await f.get("/v1/messages/message/reply?chatId=forbidden")).body).toEqual({ code: "CHAT_NOT_ALLOWED" });
    expect(read).not.toHaveBeenCalled();
    expect((await f.get()).status).toBe(200);
    read.mockClear();
    f.config.allowedChatIds.delete("allowed");
    const revoked = await f.get();
    expect(revoked.status).toBe(403);
    expect(revoked.body).toEqual({ code: "CHAT_NOT_ALLOWED" });
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects missing, extra, repeated and malformed query values and oversized message IDs", async () => {
    const f = await fixture();
    const read = vi.spyOn(f.store, "getMessage");
    for (const path of [
      "/v1/messages/message/reply",
      "/v1/messages/message/reply?chatId=",
      "/v1/messages/message/reply?chatId=allowed&extra=true",
      "/v1/messages/message/reply?chatId=allowed&chatId=other",
      "/v1/messages/message/reply?chatId[]=allowed",
      "/v1/messages/message/reply?chatId[chatId]=allowed",
      `/v1/messages/message/reply?chatId=${"a".repeat(65)}`,
      `/v1/messages/${"m".repeat(129)}/reply?chatId=allowed`,
    ]) {
      expect((await f.get(path)).status, path).toBe(400);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("repeated GETs return only the frozen reply and attachments without executing any request", async () => {
    const model: LeaderModel = { complete: vi.fn(async () => ({ content: "must not run", toolCalls: [] })) };
    const f = await fixture(model);
    const images = [{ id: "00000000-0000-4000-8000-000000000001", mime: "image/png" as const,
      size: 9, sha256: "a".repeat(64) }];
    await f.store.recordMessage({ chatId: "allowed", messageId: "message", text: "private original request",
      replyText: "frozen reply", commandId: "existing-command", images, createdAt: new Date().toISOString() });
    await f.store.compareAndSetLeaderState("allowed", 0, {
      receipts: [{ messageId: "message", text: "newer receipt reply", commandId: "different-command" }],
    });
    const handle = vi.spyOn(LeaderOrchestrator.prototype, "handle");
    const resolve = vi.spyOn(NaturalLanguageResolver.prototype, "resolve");
    const sessions = vi.spyOn(f.server.getNodeHub(), "getAllSessions");
    const state = vi.spyOn(f.store, "getLeaderState");
    const write = vi.spyOn(f.store, "recordMessage");
    const before = await f.store.getMessage("allowed", "message");
    for (let attempt = 0; attempt < 3; attempt++) {
      const reply = await f.get();
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({ text: "frozen reply", commandId: "existing-command", images });
      expect(JSON.stringify(reply.body)).not.toContain("private original request");
    }
    expect(await f.store.getMessage("allowed", "message")).toEqual(before);
    expect(await f.store.listRecentCommands(10)).toEqual([]);
    expect(handle).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
    expect(sessions).not.toHaveBeenCalled();
    expect(model.complete).not.toHaveBeenCalled();
    expect(state).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it("returns 404 for absent or cross-chat records without falling back to leader receipts", async () => {
    const f = await fixture();
    await seed(f.store);
    await f.store.compareAndSetLeaderState("allowed", 0, {
      receipts: [{ messageId: "receipt-only", text: "must not recover this receipt" }],
    });
    const state = vi.spyOn(f.store, "getLeaderState");
    for (const path of [
      "/v1/messages/missing/reply?chatId=allowed",
      "/v1/messages/receipt-only/reply?chatId=allowed",
      "/v1/messages/message/reply?chatId=other",
    ]) {
      const reply = await f.get(path);
      expect(reply.status).toBe(404);
      expect(reply.body).toEqual({ error: "Message reply not found" });
    }
    expect(state).not.toHaveBeenCalled();
  });

  it("handles storage failure without exposing private error details or replaying work", async () => {
    const f = await fixture();
    vi.spyOn(f.store, "getMessage").mockRejectedValueOnce(new Error("private database details"));
    const reply = await f.get();
    expect(reply.status).toBe(503);
    expect(JSON.stringify(reply.body)).not.toContain("private database details");
    expect(await f.store.listRecentCommands(10)).toEqual([]);
  });
});
