import http from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ControllerServer } from "../../src/http/server.js";
import type { LeaderModel } from "../../src/leader/model/contracts.js";
import { MemoryStore } from "../../src/store/memory.js";

const JSON_LIMIT_BYTES = 1024 * 1024;
const PRIVATE_INPUT = "private-json-body-and-header-marker";
const ORIGIN = "http://127.0.0.1:8790";
const ADMIN = "json-body-test-admin";
const ENDPOINTS = ["/v1/commands", "/auth/exchange"] as const;
const UNAVAILABLE = { error: "Controller temporarily unavailable; no automatic command replay" };

function jsonBody(bytes: number): string {
  const envelope = JSON.stringify({ token: PRIVATE_INPUT + "中" });
  return JSON.stringify({ token: PRIVATE_INPUT + "中" + "x".repeat(bytes - Buffer.byteLength(envelope)) });
}

describe("JSON parser errors", () => {
  const store = new MemoryStore();
  const model: LeaderModel = { complete: vi.fn(async () => ({ content: "must not run", toolCalls: [] })) };
  const server = new ControllerServer({
    host: "127.0.0.1", port: 0, controllerToken: ADMIN,
    nodeTokens: {}, tokenToNode: new Map(), allowedChatIds: new Set(["allowed"]),
    persistenceMode: "memory", commandTtlSeconds: 60, consolePublicUrl: ORIGIN,
  }, store, model);
  const createCommand = vi.spyOn(store, "createCommandIfAbsent");
  const recordMessage = vi.spyOn(store, "recordMessage");
  const consumeLink = vi.spyOn(store, "consumeConsoleLink");
  const sendCommand = vi.spyOn(server.getNodeHub(), "sendCommand");
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
  let port: number;

  beforeAll(async () => {
    await server.start();
    port = (server.getHttpServer().address() as AddressInfo).port;
  });

  afterEach(async () => {
    expect(createCommand).not.toHaveBeenCalled();
    expect(recordMessage).not.toHaveBeenCalled();
    expect(sendCommand).not.toHaveBeenCalled();
    expect(model.complete).not.toHaveBeenCalled();
    expect(await store.listRecentCommands(10)).toEqual([]);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(PRIVATE_INPUT);
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await server.stop();
    vi.restoreAllMocks();
  });

  async function post(path: string, body: string | Buffer, headers: Record<string, string> = {}, chunked = false) {
    const response = await new Promise<{ status: number | undefined; headers: http.IncomingHttpHeaders; text: string }>((resolve, reject) => {
      const request = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: {
        Authorization: `Bearer ${ADMIN}`, Origin: ORIGIN, "Content-Type": "application/json",
        "X-Private-Input": PRIVATE_INPUT,
        ...(chunked ? { "Transfer-Encoding": "chunked" } : { "Content-Length": Buffer.byteLength(body) }),
        ...headers,
      } }, incoming => {
        const chunks: Buffer[] = [];
        incoming.on("data", chunk => chunks.push(Buffer.from(chunk)));
        incoming.on("error", reject);
        incoming.on("end", () => resolve({ status: incoming.statusCode, headers: incoming.headers,
          text: Buffer.concat(chunks).toString("utf8") }));
      });
      request.on("error", reject);
      if (chunked) request.write(body);
      request.end(chunked ? undefined : body);
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.text).not.toContain(PRIVATE_INPUT);
    return { ...response, body: JSON.parse(response.text) };
  }

  describe.each(ENDPOINTS)("%s", path => {
    it.each([JSON_LIMIT_BYTES - 1, JSON_LIMIT_BYTES])("allows %i UTF-8 bytes through to route validation", async bytes => {
      const body = jsonBody(bytes);
      expect(Buffer.byteLength(body)).toBe(bytes);
      const response = await post(path, body);
      expect(response.status).toBe(path === "/v1/commands" ? 400 : 401);
      expect(response.body.error).toBe(path === "/v1/commands" ? "Invalid command request body" : "Unauthorized");
    });

    it.each([false, true])("returns 413 for one byte over the limit (chunked: %s)", async chunked => {
      const response = await post(path, jsonBody(JSON_LIMIT_BYTES + 1), {}, chunked);
      expect(response.status).toBe(413);
      expect(response.body).toEqual({ error: "JSON body too large" });
      expect(consumeLink).not.toHaveBeenCalled();
    });

    it("applies the same limit to the decompressed JSON body", async () => {
      const body = gzipSync(jsonBody(JSON_LIMIT_BYTES + 1));
      expect(body.byteLength).toBeLessThan(JSON_LIMIT_BYTES);
      const response = await post(path, body, { "Content-Encoding": "gzip" });
      expect(response.status).toBe(413);
      expect(response.body).toEqual({ error: "JSON body too large" });
      expect(consumeLink).not.toHaveBeenCalled();
    });

    it.each([
      { "Content-Type": `application/json; charset=${PRIVATE_INPUT}` },
      { "Content-Encoding": PRIVATE_INPUT },
    ])("returns a static 415 for unsupported charset or encoding: %j", async headers => {
      const response = await post(path, JSON.stringify({ token: PRIVATE_INPUT }), headers);
      expect(response.status).toBe(415);
      expect(response.body).toEqual({ error: "Unsupported JSON body encoding" });
      expect(consumeLink).not.toHaveBeenCalled();
    });

    it("preserves static 400 for malformed JSON without echoing its body", async () => {
      const response = await post(path, `{"token":"${PRIVATE_INPUT}"`);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "Invalid JSON body" });
      expect(consumeLink).not.toHaveBeenCalled();
    });
  });

  it.each([
    {}, { status: 413, type: "entity.too.large" },
    { status: 415, type: "charset.unsupported" }, { status: 403 },
  ])("preserves static 503 for downstream operational errors: %j", async properties => {
    const failingRead = vi.spyOn(store, "listRecentCommandSummaries")
      .mockRejectedValueOnce(Object.assign(new Error(PRIVATE_INPUT), properties));
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/status`, {
        headers: { Authorization: `Bearer ${ADMIN}` },
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(UNAVAILABLE);
    } finally {
      failingRead.mockRestore();
    }
  });
});
