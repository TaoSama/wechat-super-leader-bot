import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { RuntimeResourceError } from "./resources.js";
import type { GatewaySettings } from "./service.js";

const BODY_BYTES = 1024 * 1024 + 4096;
function authorize(request: IncomingMessage, token: string): boolean {
  const actual = Buffer.from(request.headers.authorization ?? ""), expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
async function body(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) throw new RuntimeResourceError(400, "invalid_content_type", "JSON content type required");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > BODY_BYTES) throw new RuntimeResourceError(413, "body_too_large", "Settings request is too large");
    chunks.push(data);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new RuntimeResourceError(400, "invalid_json", "Invalid settings JSON"); }
}
export async function startSettingsServer(options: { host: string; port: number; token: string; settings: GatewaySettings }) {
  if (!options.host.trim() || !options.token.trim() || !Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error("Invalid Gateway settings listener configuration");
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Gateway settings operation failed", code: "settings_failed" }));
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify(value));
    };
    if (!authorize(request, options.token)) { send(401, { error: "Unauthorized" }); return; }
    try {
      const url = new URL(request.url ?? "/", "http://gateway.internal");
      let result: unknown;
      if (url.pathname === "/settings" && request.method === "GET") result = await options.settings.overview();
      else if (url.pathname === "/settings/models" && request.method === "GET") {
        if (url.searchParams.get("scope") !== "wechat") throw new RuntimeResourceError(400, "invalid_scope", "Unknown model scope");
        result = await options.settings.models();
      } else if (url.pathname === "/settings/models/refresh" && request.method === "POST") {
        const input = await body(request);
        if (!input || typeof input !== "object" || (input as { scope?: unknown }).scope !== "wechat") throw new RuntimeResourceError(400, "invalid_scope", "Unknown model scope");
        result = await options.settings.models(true);
      } else if (url.pathname === "/settings/models" && request.method === "POST") result = await options.settings.updateModel(await body(request));
      else if (url.pathname === "/settings/resources" && request.method === "GET") result = await options.settings.list(url.searchParams.get("chatId") ?? undefined);
      else if (url.pathname === "/settings/leader-history" && request.method === "GET") {
        const allowed = new Set(["chatId", "cursor", "limit", "historyContext"]);
        if ([...url.searchParams.keys()].some(key => !allowed.has(key))) {
          throw new RuntimeResourceError(400, "invalid_history_query", "Unknown history query parameter");
        }
        if ([...allowed].some(key => url.searchParams.getAll(key).length > 1)) {
          throw new RuntimeResourceError(400, "invalid_history_query", "History query parameters must be unique");
        }
        const chatId = url.searchParams.get("chatId") ?? undefined;
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const historyContext = url.searchParams.get("historyContext") ?? undefined;
        if (historyContext !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(historyContext)) {
          throw new RuntimeResourceError(400, "invalid_history_context", "History context is invalid");
        }
        if (cursor !== undefined && historyContext === undefined) {
          throw new RuntimeResourceError(400, "invalid_history_context", "History cursor requires context");
        }
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit === null || rawLimit === "" ? undefined : Number(rawLimit);
        if (rawLimit !== null && (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 50)) {
          throw new RuntimeResourceError(400, "invalid_history_limit", "History limit must be between 1 and 50");
        }
        result = await options.settings.history(chatId, cursor, limit, historyContext);
      }
      else if (url.pathname.startsWith("/settings/resources/")) {
        const id = decodeURIComponent(url.pathname.slice("/settings/resources/".length));
        if (request.method === "GET") result = await options.settings.read(id, url.searchParams.get("chatId") ?? undefined);
        else if (request.method === "POST") result = await options.settings.write(id, await body(request));
        else throw new RuntimeResourceError(404, "not_found", "Unknown settings operation");
      } else throw new RuntimeResourceError(404, "not_found", "Unknown settings operation");
      send(200, result);
    } catch (error) {
      if (error instanceof RuntimeResourceError) send(error.status, { error: error.message, code: error.code });
      else if (error instanceof URIError) send(400, { error: "Invalid resource identifier" });
      else send(500, { error: "Gateway settings operation failed", code: "settings_failed" });
    }
  }
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => { server.removeListener("error", reject); resolve(); });
  });
  return { address: server.address(), close: () => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections();
  }) };
}
