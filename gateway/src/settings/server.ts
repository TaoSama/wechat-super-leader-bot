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
