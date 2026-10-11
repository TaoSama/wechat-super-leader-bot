// Loopback-only browser surface fixture; no real terminal, account or credentials.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extname, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { createHash, randomUUID } from "node:crypto";

const { values } = parseArgs({ options: { port: { type: "string", default: "0" }, help: { type: "boolean", short: "h" } } });
if (values.help) {
  console.log("Usage: node web/tests/terminal-history-fixture.mjs [--port PORT]\nSynthetic Web-only acceptance on loopback. POST /fixture/stop closes it.");
  process.exit(0);
}
const port = Number(values.port);
if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid --port");

const ROOT = fileURLToPath(new URL("../dist/", import.meta.url));
const NODE_ID = "fixture-cli";
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 50;
const INITIAL_ITEMS = 150;
const EXPIRED_OBSERVATION_AGE_MS = 60_000;
const STATUS_INTERVAL_MS = 5_000;
const FIXTURE_TIMEOUT_MS = 20 * 60 * 1000;
const CONTENT_TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const now = () => new Date().toISOString();
const streams = new Set();
const metrics = { latest: 0, older: 0, contexts: 0, expiredHistoryRequests: 0, statuses: 0, sends: 0, terminalInputWrites: 0 };
const targets = new Map(["claude", "codex", "grok", "unmarked"].map(name => {
  const provider = name === "unmarked" ? "codex" : name;
  const session = { id: "terminal:" + createHash("sha256").update(`synthetic-cli:${name}`).digest("base64url"),
    nodeId: NODE_ID, provider: `terminal/${provider}`, title: `CLI 合成验收 · ${name}`, cwd: `/synthetic/${name}`,
    status: "active", loaded: false, capabilities: ["read"], observedAt: now(),
    ...(name === "unmarked" ? {} : { historySource: "terminal-transcript" }) };
  const items = Array.from({ length: INITIAL_ITEMS }, (_, index) => ({ id: `${name}-record-${index}`,
    turnId: "", kind: index % 2 ? "assistant" : "user", type: provider === "grok" ? "transcript_chunk" : "transcript_message",
    text: `${name} 第 ${index + 1} 条合成${provider === "grok" ? "文本片段" : "可见记录"}\n\n仅验证原 CLI 记录的前端呈现、刷新与滚动。这里不接触真实 Agent，不产生发送权限或完成证明。`,
    timestamp: new Date(Date.now() - (INITIAL_ITEMS - index) * 60_000).toISOString() }));
  return [name, { session, items, generation: 0, observationMode: "fresh" }];
}));
const historyContexts = new Map();
const historyCursors = new Map();
const cursorByAnchor = new Map();
let authenticated = true;
let stopping = false;

function status() {
  const sessions = [...targets.values()].map(target => {
    if (target.observationMode === "fresh") target.session.observedAt = now();
    return target.session;
  });
  return { sessions, commands: [], executions: { observedAt: Date.now(), limit: 12, hasMore: false, items: [] },
    nodes: [{ nodeId: NODE_ID, connected: true, lastHeartbeat: now(), sessionCount: sessions.length }] };
}
function json(res, value, code = 200) {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}
function broadcast() { for (const stream of streams) stream.write(`event: status\ndata: ${JSON.stringify(status())}\n\n`); }
function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(statusTimer); clearTimeout(lifetime);
  for (const stream of streams) stream.end();
  if (server.listening) server.close(error => { if (error) { console.error("fixture shutdown failed", error.message); process.exitCode = 1; } });
}
const server = createServer((req, res) => {
  handle(req, res).catch(error => {
    console.error("synthetic fixture request failed", error.message);
    if (!res.headersSent) json(res, { error: "Synthetic fixture failure" }, 500);
    else res.end();
  });
});
async function handle(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const path = url.pathname;
  if (path === "/fixture/metrics" && req.method === "GET") return json(res, { ...metrics, synthetic: true,
    sessions: Object.fromEntries([...targets].map(([name, target]) => [name, target.session.id])) });
  if (path === "/fixture/stop" && req.method === "POST") { json(res, { stopped: true }); stop(); return; }
  if (path.startsWith("/fixture/")) {
    if (req.method !== "POST") return json(res, { error: "Use POST for fixture controls" }, 405);
    const name = url.searchParams.get("target") ?? "claude";
    const target = targets.get(name);
    if (!target) return json(res, { error: "Unknown synthetic target" }, 400);
    if (path === "/fixture/append") {
      const id = `${name}-record-${target.items.length}`;
      target.items.push({ id, turnId: "", kind: "assistant", type: name === "grok" ? "transcript_chunk" : "transcript_message",
        text: `实时新增 ${id}：仅合成记录，向上阅读时应保留锚点。`, timestamp: now() });
      broadcast(); return json(res, { id, synthetic: true });
    }
    if (path === "/fixture/expire-history") { target.generation++; return json(res, { expired: true, synthetic: true }); }
    if (path === "/fixture/marker") {
      const enabled = url.searchParams.get("enabled");
      if (enabled !== "true" && enabled !== "false") return json(res, { error: "enabled must be true or false" }, 400);
      if (enabled === "true") target.session.historySource = "terminal-transcript";
      else delete target.session.historySource;
      broadcast(); return json(res, { enabled: enabled === "true", synthetic: true });
    }
    if (path === "/fixture/observation") {
      const mode = url.searchParams.get("mode");
      if (mode !== "fresh" && mode !== "expired") return json(res, { error: "mode must be fresh or expired" }, 400);
      target.observationMode = mode;
      target.session.observedAt = new Date(Date.now() - (mode === "expired" ? EXPIRED_OBSERVATION_AGE_MS : 0)).toISOString();
      broadcast(); return json(res, { mode, synthetic: true });
    }
    return json(res, { error: "Unknown fixture control" }, 404);
  }
  if (path === "/health") return json(res, { status: "ok" });
  if (path === "/auth/session") return json(res, { authenticated, expiresAt: new Date(Date.now() + FIXTURE_TIMEOUT_MS).toISOString() }, authenticated ? 200 : 401);
  if (path === "/auth/logout" && req.method === "POST") {
    authenticated = false;
    for (const stream of streams) { stream.write("event: auth-expired\ndata: {}\n\n"); stream.end(); }
    return json(res, { authenticated });
  }
  if (path.startsWith("/v1/") && !authenticated) return json(res, { error: "Synthetic session logged out" }, 401);
  if (path === "/v1/status" && req.method === "GET") { metrics.statuses++; return json(res, status()); }
  if (path === "/v1/events" && req.method === "GET") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(`event: status\ndata: ${JSON.stringify(status())}\n\n`);
    streams.add(res);
    req.on("close", () => streams.delete(res));
    res.on("error", error => { console.error("fixture stream failed", error.message); streams.delete(res); res.destroy(); });
    return;
  }
  const match = path.match(/^\/v1\/sessions\/([^/]+)\/([^/]+)\/history$/);
  if (match && req.method === "GET") {
    const target = [...targets.values()].find(value => value.session.nodeId === decodeURIComponent(match[1]) && value.session.id === decodeURIComponent(match[2]));
    if (!target) return json(res, { code: "history_session_not_found" }, 404);
    if (!target.session.historySource) return json(res, { code: "history_unavailable" }, 502);
    const limit = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) return json(res, { code: "history_invalid_request" }, 400);
    const cursor = url.searchParams.get("cursor");
    let historyContext = url.searchParams.get("historyContext");
    if (cursor && !historyContext) return json(res, { code: "history_invalid_request" }, 400);
    metrics[cursor ? "older" : "latest"]++;
    if (!historyContext) {
      historyContext = randomUUID(); metrics.contexts++;
      historyContexts.set(historyContext, { sessionId: target.session.id, generation: target.generation });
    }
    const context = historyContexts.get(historyContext);
    const pageCursor = cursor ? historyCursors.get(cursor) : undefined;
    if (!context || context.sessionId !== target.session.id || context.generation !== target.generation ||
        cursor && (!pageCursor || pageCursor.historyContext !== historyContext)) {
      metrics.expiredHistoryRequests++;
      return json(res, { code: "history_context_expired" }, 409);
    }
    const end = cursor ? pageCursor.end : target.items.length;
    const start = Math.max(0, end - limit);
    let nextCursor = null;
    if (start) {
      const anchor = JSON.stringify([historyContext, start]);
      nextCursor = cursorByAnchor.get(anchor) ?? randomUUID();
      cursorByAnchor.set(anchor, nextCursor); historyCursors.set(nextCursor, { historyContext, end: start });
    }
    return json(res, { session: target.session, historyContext, source: "terminal-transcript",
      items: target.items.slice(start, end), nextCursor, fetchedAt: now(), truncated: false });
  }
  if (path.endsWith("/messages") && req.method === "POST") { metrics.sends++; return json(res, { error: "Synthetic fixture is read-only" }, 409); }
  if (path.startsWith("/v1/")) return json(res, { error: "Unknown synthetic API route" }, 404);
  if (req.method !== "GET") return json(res, { error: "Method not allowed" }, 405);
  const file = resolve(ROOT, path === "/" ? "index.html" : `.${path}`);
  if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) return json(res, { error: "Invalid path" }, 400);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }); res.end(body);
  } catch (error) {
    if (error.code === "ENOENT") return json(res, { error: "Build Web first" }, 404);
    throw error;
  }
}
const statusTimer = setInterval(broadcast, STATUS_INTERVAL_MS);
const lifetime = setTimeout(stop, FIXTURE_TIMEOUT_MS);
server.on("error", error => { console.error("fixture server failed", error.message); process.exitCode = 1; stop(); });
process.once("SIGTERM", stop); process.once("SIGINT", stop);
server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ fixtureUrl: `http://127.0.0.1:${server.address().port}`, synthetic: true })));
