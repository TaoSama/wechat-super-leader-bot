import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http, { type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControllerServer } from "../../src/http/server.js";
import { MemoryStore } from "../../src/store/memory.js";
import { HistoryError } from "../../src/sessions/history.js";
import type { Config } from "../../src/runtime/config.js";
import type { SessionHistory } from "../../src/types.js";

const HISTORY_PATH = "/v1/sessions/demoair/thread/history";
const ADMIN_TOKEN = "compression-admin-token";
const CONSOLE_ORIGIN = "http://127.0.0.1:8790";
const BEARER = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const HISTORY_CONTEXT = "00000000-0000-4000-8000-000000000001";
const LARGE_TEXT = Array.from({ length: 60 }, (_, index) =>
  `步骤 ${index}: 检查会话分页结果，保留完整工具输出与消息顺序。\n`).join("");
const JAVASCRIPT = Array.from({ length: 500 }, (_, index) =>
  `export const message${index} = ${JSON.stringify(LARGE_TEXT.slice(0, 90))};`).join("\n");
const CSS = Array.from({ length: 100 }, (_, index) =>
  `.message-${index} { white-space: pre-wrap; overflow-wrap: anywhere; }`).join("\n");

function history(text = LARGE_TEXT): SessionHistory {
  return {
    session: { id: "thread", provider: "codex-app", title: "Compression test", cwd: "/workspace",
      status: "idle", capabilities: ["read"], observedAt: "2026-10-18T00:00:00Z" },
    historyContext: HISTORY_CONTEXT, source: "control-socket",
    items: Array.from({ length: 20 }, (_, index) => ({ id: `item-${index}`, turnId: `turn-${index}`,
      kind: "assistant", type: "agentMessage", text })),
    nextCursor: "opaque+older=", fetchedAt: "2026-10-18T00:00:00Z", truncated: false,
  };
}

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  elapsedMs: number;
}

describe("scoped response compression over real HTTP", () => {
  let server: ControllerServer;
  let store: MemoryStore;
  let baseUrl: string;
  let webDistDir: string;
  let cookie: string;
  let readHistory: ReturnType<typeof vi.spyOn>;

  function request(path: string, headers: Record<string, string> = {}, method = "GET", body?: unknown): Promise<RawResponse> {
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const req = http.request(baseUrl + path, { method, headers }, res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(Buffer.from(chunk)));
        res.once("error", reject);
        res.once("end", () => resolve({ status: res.statusCode!, headers: res.headers,
          body: Buffer.concat(chunks), elapsedMs: performance.now() - started }));
      });
      req.once("error", reject);
      req.setTimeout(2000, () => req.destroy(new Error("HTTP response timed out")));
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }

  beforeEach(async () => {
    webDistDir = await mkdtemp(join(tmpdir(), "controller-compression-"));
    await mkdir(join(webDistDir, "assets"));
    await Promise.all([
      writeFile(join(webDistDir, "assets", "app.js"), JAVASCRIPT),
      writeFile(join(webDistDir, "assets", "app.css"), CSS),
      writeFile(join(webDistDir, "assets", "tiny.js"), "export const ready = true;"),
      writeFile(join(webDistDir, "index.html"), `<html>${LARGE_TEXT}</html>`),
    ]);
    store = new MemoryStore();
    const config: Config = {
      port: 0, host: "127.0.0.1", controllerToken: ADMIN_TOKEN,
      nodeTokens: {}, tokenToNode: new Map(), allowedChatIds: new Set(["allowed-chat"]),
      persistenceMode: "memory", commandTtlSeconds: 60, consolePublicUrl: CONSOLE_ORIGIN,
      webDistDir,
    };
    server = new ControllerServer(config, store);
    await server.start();
    baseUrl = `http://127.0.0.1:${(server.getHttpServer().address() as AddressInfo).port}`;
    readHistory = vi.spyOn(server.getNodeHub(), "readHistory").mockResolvedValue(history());
    const link = await request("/v1/console-links", { ...BEARER, "Content-Type": "application/json" }, "POST", { requestId: "compression-login" });
    const token = new URL(JSON.parse(link.body.toString()).url).hash.slice("#login=".length);
    const exchange = await request("/auth/exchange", { Origin: CONSOLE_ORIGIN, "Content-Type": "application/json" }, "POST", { token });
    cookie = exchange.headers["set-cookie"]![0].split(";")[0];
  });

  afterEach(async () => {
    await server.stop();
    vi.restoreAllMocks();
    await rm(webDistDir, { recursive: true, force: true });
  });

  it.each(["bearer", "cookie"])("compresses %s history without changing public JSON or pagination", async auth => {
    const headers = auth === "bearer" ? BEARER : { Cookie: cookie };
    const path = `${HISTORY_PATH}?limit=20&cursor=opaque%2Bolder%3D&historyContext=${HISTORY_CONTEXT}`;
    const plain = await request(path, { ...headers, "Accept-Encoding": "identity" });
    const compressed = await request(path, { ...headers, "Accept-Encoding": "gzip" });
    expect(plain.status).toBe(200);
    expect(compressed.status).toBe(200);
    expect(compressed.headers["content-encoding"]).toBe("gzip");
    expect(compressed.headers["cache-control"]).toBe("no-store");
    expect(compressed.headers.vary).toContain("Accept-Encoding");
    expect(plain.headers.vary).toContain("Accept-Encoding");
    expect(plain.headers["content-encoding"]).toBeUndefined();
    expect(gunzipSync(compressed.body)).toEqual(plain.body);
    expect(JSON.parse(plain.body.toString())).toEqual(history());
    expect(compressed.body.length).toBeLessThan(plain.body.length);
    expect(readHistory).toHaveBeenLastCalledWith("demoair", "thread", {
      limit: 20, cursor: "opaque+older=", historyContext: HISTORY_CONTEXT,
    }, expect.any(AbortSignal));
    console.info(`history ${auth}: identity=${plain.body.length}B gzip=${compressed.body.length}B ` +
      `local HTTP=${plain.elapsedMs.toFixed(1)}/${compressed.elapsedMs.toFixed(1)}ms`);
  });

  it("negotiates Brotli and excludes explicitly rejected encodings", async () => {
    const brotli = await request(HISTORY_PATH, { ...BEARER, "Accept-Encoding": "gzip;q=0.5, br;q=1" });
    expect(brotli.headers["content-encoding"]).toBe("br");
    expect(JSON.parse(brotliDecompressSync(brotli.body).toString())).toEqual(history());
    for (const encoding of ["identity", "gzip;q=0, br;q=0, deflate;q=0", undefined]) {
      const response = await request(HISTORY_PATH, { ...BEARER, ...(encoding ? { "Accept-Encoding": encoding } : {}) });
      expect(response.headers["content-encoding"]).toBeUndefined();
      expect(JSON.parse(response.body.toString())).toEqual(history());
    }
  });

  it.each([["/assets/app.js", JAVASCRIPT], ["/assets/app.css", CSS]])("compresses static %s with byte-identical decoding", async (path, expected) => {
    const response = await request(path, { "Accept-Encoding": "gzip" });
    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers.vary).toContain("Accept-Encoding");
    expect(gunzipSync(response.body).toString()).toBe(expected);
  });

  it("leaves small responses and non-asset HTML uncompressed", async () => {
    readHistory.mockResolvedValue({ ...history(""), items: [] });
    for (const path of [HISTORY_PATH, "/assets/tiny.js", "/index.html", "/assets/missing.js"]) {
      const response = await request(path, { ...BEARER, "Accept-Encoding": "gzip" });
      expect(response.status).toBe(200);
      expect(response.headers["content-encoding"]).toBeUndefined();
      expect(response.headers["cache-control"]).toBe("no-store");
    }
  });

  it("preserves static byte ranges without transforming the partial representation", async () => {
    const response = await request("/assets/app.js", { "Accept-Encoding": "gzip", Range: "bytes=0-2047" });
    expect(response.status).toBe(206);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers["content-range"]).toBe(`bytes 0-2047/${Buffer.byteLength(JAVASCRIPT)}`);
    expect(response.body).toEqual(Buffer.from(JAVASCRIPT).subarray(0, 2048));
  });

  it("leaves authentication, history errors, status and successful message responses uncompressed", async () => {
    for (const headers of [{}, { Authorization: "Bearer wrong-token" }]) {
      const response = await request(HISTORY_PATH, { ...headers, "Accept-Encoding": "gzip" });
      expect([401, 403]).toContain(response.status);
      expect(response.headers["content-encoding"]).toBeUndefined();
    }
    expect(readHistory).not.toHaveBeenCalled();
    readHistory.mockRejectedValue(new HistoryError(502, "history_incomplete", LARGE_TEXT));
    const failed = await request(HISTORY_PATH, { ...BEARER, "Accept-Encoding": "gzip" });
    expect(failed.status).toBe(502);
    expect(failed.body.length).toBeGreaterThan(1024);
    expect(failed.headers["content-encoding"]).toBeUndefined();
    await store.recordMessage({ chatId: "allowed-chat", messageId: "cached-message", text: "hello",
      replyText: LARGE_TEXT, createdAt: new Date().toISOString() });
    const message = await request("/v1/messages", { ...BEARER, "Accept-Encoding": "gzip", "Content-Type": "application/json" },
      "POST", { chatId: "allowed-chat", messageId: "cached-message", text: "hello" });
    expect(message.status).toBe(200);
    expect(message.body.length).toBeGreaterThan(1024);
    expect(message.headers["content-encoding"]).toBeUndefined();
    vi.spyOn(server.getNodeHub(), "getAllSessions").mockResolvedValue([
      { ...history().session, nodeId: "demoair", title: LARGE_TEXT },
    ]);
    const status = await request("/v1/status", { ...BEARER, "Accept-Encoding": "gzip" });
    expect(status.status).toBe(200);
    expect(status.body.length).toBeGreaterThan(1024);
    expect(status.headers["content-encoding"]).toBeUndefined();
    const auth = await request("/auth/session", { Cookie: cookie, "Accept-Encoding": "gzip" });
    expect(auth.headers["content-encoding"]).toBeUndefined();
  });

  it("delivers SSE immediately even when the client accepts compression", async () => {
    const started = performance.now();
    await new Promise<void>((resolve, reject) => {
      const req = http.get(baseUrl + "/v1/events", { headers: { ...BEARER, "Accept-Encoding": "gzip, br" } }, res => {
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-encoding"]).toBeUndefined();
        expect(res.headers["cache-control"]).toBe("no-store");
        let received = "";
        res.on("data", chunk => {
          received += chunk.toString();
          if (!received.includes("\n\n")) return;
          expect(received).toContain("event: status");
          expect(performance.now() - started).toBeLessThan(1000);
          req.destroy();
          resolve();
        });
        res.once("error", reject);
      });
      req.once("error", reject);
      req.setTimeout(1000, () => req.destroy(new Error("SSE initial event was buffered")));
    });
  });
});
