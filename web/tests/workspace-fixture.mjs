// Loopback-only browser acceptance fixture. Never imported by the application.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname, sep } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { createPlanFixture, PLAN_MODES } from "./plan-fixture.mjs";
import { createTerminalFixture, TERMINAL_MODES } from "./terminal-fixture.mjs";
import { createGoalFixture, GOAL_MODES } from "./goal-fixture.mjs";

const { values } = parseArgs({ options: { port: { type: "string", default: "0" }, help: { type: "boolean", short: "h" } } });
if (values.help) {
  console.log("Usage: node web/tests/workspace-fixture.mjs [--port PORT]\nServes built Web with synthetic API on loopback. POST /fixture/stop closes it.");
  process.exit(0);
}
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid --port");
const root = fileURLToPath(new URL("../dist/", import.meta.url));
const PAGE_SIZE = 30;
const MODEL_EXPIRY_PROBE_AGE_MS = 40_000;
const FIXTURE_TIMEOUT_MS = 20 * 60 * 1000;
const now = () => new Date().toISOString();
const sessions = [
  { id: "fixture-workspace", nodeId: "demoair", title: "工作台体验 · 实时会话与历史阅读", status: "idle", model: "gpt-6.1-sol", cwd: "/Users/demo/Workspaces/super-leader", preview: "已完成会话列表分组，正在验证手机上的长消息阅读。" },
  { id: "fixture-api", nodeId: "demoair", title: "检查微信查询超时与安全重试", status: "busy", model: "gpt-6.1-sol", cwd: "/Users/demo/Workspaces/super-leader", preview: "正在核对请求预算和错误处理。不会向其他会话发送指令。" },
  { id: "fixture-review", nodeId: "demoair", title: "数据库事务与回执关联复核", status: "idle", model: "gpt-6-astra", cwd: "/Users/demo/Workspaces/control-plane", preview: "测试通过，等待查看审查结论。" },
  { id: "fixture-offline", nodeId: "demomini", title: "离线机器上的架构研究", status: "unknown", model: "gpt-6.1-sol", cwd: "/Users/demo/Workspaces/research", preview: "机器离线时保留最后已知状态。" },
].map((s) => ({ ...s, provider: "codex-app", modelProvider: "openai_http", reasoningEffort: "high", capabilities: ["read", "send"], loaded: true, observedAt: now(), updatedAt: now() }));
const plans = createPlanFixture(sessions);
const goals = createGoalFixture(sessions);
const commands = ["uncertain", "accepted", "completed", "failed"].map((status, i) => ({
  commandId: `fixture-command-${i}`, requestId: `fixture-request-${i}`, nodeId: "demoair", sessionId: sessions[i % 3].id,
  action: "send", prompt: ["检查实时刷新是否正常", "复核查询预算与重试边界", "阅读测试结果并总结", "确认节点连接状态"][i], status,
  output: status === "completed" ? "验证已完成。\n\n所有测试通过，未向外部发送消息。" : undefined,
  error: status === "uncertain" ? "连接断开，回执未确认，请先核查原请求。" : status === "failed" ? "机器暂时无法访问。" : undefined,
  createdAt: now(), updatedAt: now(), expiresAt: now(), turnId: status === "accepted" ? "fixture-turn" : undefined,
}));
const terminal = createTerminalFixture(sessions, commands);
const items = Array.from({ length: 240 }, (_, i) => ({
  id: `fixture-item-${i}`, turnId: `fixture-turn-${Math.floor(i / 2)}`, kind: i % 8 === 5 ? "tool" : i % 2 ? "assistant" : "user",
  type: i % 8 === 5 ? "commandExecution" : "message", title: i % 8 === 5 ? "运行本地测试" : undefined,
  text: i % 8 === 5 ? "pnpm test\n\nTests: 24 passed\n".repeat(5) : i % 2 ? `第 ${i + 1} 条 · 验证记录\n\n已核查自动更新与分页。向上阅读时保留当前位置，新的回复不会打断阅读。\n\n- 状态与模型来自真实字段\n- 回执不确定时不重发\n\n\`const ready = true;\`` : `第 ${i + 1} 条 · 请检查这段会话的执行状态，并保留原始上下文。`,
  timestamp: new Date(Date.now() - (240 - i) * 60_000).toISOString(),
}));
const streams = new Set();
const metrics = { latest: 0, older: 0, statuses: 0, sends: 0, contexts: 0, expiredHistoryRequests: 0, planUpdates: 0 };
const historyContexts = new Map();
const historyCursors = new Map();
const cursorByAnchor = new Map();
let historyGeneration = 0;
let historySource = "codex-desktop";
let authenticated = true;
let failOlder = false;
const status = () => ({ leaderMode: "model", leaderModel: "gpt-6.1-sol", sessions, commands,
  goals: goals.snapshot(), executions: plans.snapshot(), nodes: [
  { nodeId: "demoair", connected: true, lastHeartbeat: now(), sessionCount: sessions.filter(session => session.nodeId === "demoair").length },
  { nodeId: "demomini", connected: false, lastHeartbeat: now(), sessionCount: sessions.filter(session => session.nodeId === "demomini").length },
] });
function broadcast() { for (const stream of streams) stream.write(`event: status\ndata: ${JSON.stringify(status())}\n\n`); }
function json(res, value, code = 200) { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); }
const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = createServer((req, res) => {
  handle(req, res).catch((error) => { console.error("fixture request failed", error.message); if (!res.headersSent) json(res, { error: "fixture failure" }, 500); else res.end(); });
});
async function handle(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");
  const path = url.pathname;
  if (path === "/fixture/stop" && req.method === "POST") {
    json(res, { stopped: true });
    clearTimeout(lifetime);
    for (const stream of streams) stream.end();
    server.close();
    return;
  }
  if (path === "/fixture/metrics") return json(res, { ...metrics, ...terminal.metrics() });
  if (path === "/fixture/goals" && req.method === "POST") {
    const mode = url.searchParams.get("mode");
    if (!GOAL_MODES.includes(mode)) return json(res, { error: "unknown goal fixture mode" }, 400);
    goals.setMode(mode); broadcast(); return json(res, { mode, synthetic: true });
  }
  if (path === "/fixture/terminal" && req.method === "POST") {
    const mode = url.searchParams.get("mode");
    if (!TERMINAL_MODES.includes(mode)) return json(res, { error: "unknown terminal fixture mode" }, 400);
    terminal.setMode(mode); broadcast(); return json(res, { mode, synthetic: true });
  }
  if (path === "/fixture/plans" && req.method === "POST") {
    const mode = url.searchParams.get("mode");
    if (!PLAN_MODES.includes(mode)) return json(res, { error: "unknown plan fixture mode" }, 400);
    plans.setMode(mode); metrics.planUpdates++;
    broadcast(); return json(res, { mode, synthetic: true });
  }
  if (path === "/fixture/expire-history" && req.method === "POST") {
    const source = url.searchParams.get("source");
    if (source !== null && !["control-socket", "codex-desktop"].includes(source)) return json(res, { error: "unknown history source" }, 400);
    historyGeneration++;
    if (source) historySource = source;
    historyContexts.clear(); historyCursors.clear(); cursorByAnchor.clear();
    return json(res, { expired: true, source: historySource, synthetic: true });
  }
  if (path === "/fixture/model" && req.method === "POST") {
    const mode = url.searchParams.get("mode");
    if (!["fresh", "updated", "expiring", "unavailable", "invalid", "empty"].includes(mode)) {
      return json(res, { error: "unknown model fixture mode" }, 400);
    }
    Object.assign(sessions[0], { model: mode === "empty" ? undefined : "native-recorded-model",
      modelProvider: "native-provider", reasoningEffort: "low", status: "notLoaded", loaded: false, capabilities: ["read"],
      observedAt: now(), desktopObservation: { source: "codex-desktop", status: "idle",
        availability: mode === "unavailable" ? "unavailable" : "available",
        observedAt: new Date(Date.now() - (mode === "expiring" ? MODEL_EXPIRY_PROBE_AGE_MS : 0)).toISOString(),
        model: mode === "invalid" ? 42 : mode === "empty" ? undefined : mode === "updated" ? "gpt-6.1-sol" : "gpt-6-astra",
        modelProvider: "desktop-provider", reasoningEffort: mode === "updated" ? "high" : "ultra" } });
    broadcast(); return json(res, { mode, synthetic: true });
  }
  if (path === "/fixture/append" && req.method === "POST") {
    const id = `fixture-item-${items.length}`;
    items.push({ id, turnId: "fixture-live-turn", kind: "assistant", type: "message", text: `实时新增 ${id}：更新已到达，阅读位置应保持。`, timestamp: now() });
    sessions[0].updatedAt = now(); sessions[0].preview = items.at(-1).text;
    broadcast(); return json(res, { id });
  }
  if (path === "/fixture/fail-older" && req.method === "POST") { failOlder = !failOlder; return json(res, { failOlder }); }
  if (path === "/auth/logout" && req.method === "POST") {
    authenticated = false;
    for (const stream of streams) { stream.write("event: auth-expired\ndata: {}\n\n"); stream.end(); }
    return json(res, { authenticated });
  }
  if (path === "/auth/session") return json(res, { authenticated, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, authenticated ? 200 : 401);
  if (path.startsWith("/v1/") && !authenticated) return json(res, { error: "unauthenticated" }, 401);
  if (path === "/v1/status") { metrics.statuses++; return json(res, status()); }
  if (path === "/v1/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(`event: status\ndata: ${JSON.stringify(status())}\n\n`);
    streams.add(res); req.on("close", () => streams.delete(res)); return;
  }
  const match = path.match(/^\/v1\/sessions\/([^/]+)\/([^/]+)\/history$/);
  if (match) {
    const session = sessions.find((s) => s.nodeId === decodeURIComponent(match[1]) && s.id === decodeURIComponent(match[2]));
    if (!session) return json(res, { error: "unknown session" }, 404);
    if (session.provider.startsWith("terminal/")) return json(res, { code: "history_unavailable", error: "Terminal snapshots are not native chat history" }, 502);
    const cursor = url.searchParams.get("cursor");
    metrics[cursor ? "older" : "latest"]++;
    let historyContext = url.searchParams.get("historyContext");
    if (cursor && !historyContext) return json(res, { code: "history_invalid_request", error: "Invalid history request" }, 400);
    if (!historyContext) {
      historyContext = randomUUID();
      historyContexts.set(historyContext, { nodeId: session.nodeId, sessionId: session.id, source: historySource, generation: historyGeneration });
      metrics.contexts++;
    }
    const context = historyContexts.get(historyContext);
    const pageCursor = cursor ? historyCursors.get(cursor) : undefined;
    if (!context || context.nodeId !== session.nodeId || context.sessionId !== session.id || context.generation !== historyGeneration ||
        cursor && (!pageCursor || pageCursor.historyContext !== historyContext)) {
      metrics.expiredHistoryRequests++;
      return json(res, { code: "history_context_expired", error: "History context expired" }, 409);
    }
    if (cursor && failOlder) return json(res, { error: "synthetic older failure" }, 503);
    const end = cursor ? pageCursor.end : items.length;
    if (!Number.isInteger(end) || end < 0 || end > items.length) return json(res, { error: "bad cursor" }, 400);
    const start = Math.max(0, end - PAGE_SIZE);
    let nextCursor = null;
    if (start) {
      const anchor = JSON.stringify([historyContext, start]);
      nextCursor = cursorByAnchor.get(anchor) ?? randomUUID();
      cursorByAnchor.set(anchor, nextCursor);
      historyCursors.set(nextCursor, { historyContext, end: start });
    }
    return json(res, { session, historyContext, source: context.source, items: items.slice(start, end), nextCursor, fetchedAt: now(), truncated: false });
  }
  const commandMatch = path.match(/^\/v1\/commands\/([^/]+)$/);
  if (commandMatch) {
    const command = commands.find(value => value.commandId === decodeURIComponent(commandMatch[1]));
    return json(res, command ?? { error: "unknown synthetic command" }, command ? 200 : 404);
  }
  const inputMatch = path.match(/^\/v1\/sessions\/([^/]+)\/([^/]+)\/messages$/);
  if (inputMatch && req.method === "POST" && terminal.matches(decodeURIComponent(inputMatch[1]), decodeURIComponent(inputMatch[2]))) {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > 64 * 1024) return json(res, { error: "synthetic input too large" }, 413);
    }
    const response = terminal.send(JSON.parse(body)); metrics.sends++;
    broadcast(); return json(res, response.body, response.code);
  }
  if (path.endsWith("/messages")) { metrics.sends++; return json(res, { error: "Sending is disabled in this fixture" }, 409); }
  if (path.startsWith("/v1/")) return json(res, { error: "unknown route" }, 404);
  const file = resolve(root, path === "/" ? "index.html" : `.${path}`);
  if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) return json(res, { error: "invalid path" }, 400);
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }); res.end(body);
  } catch (error) {
    if (error.code === "ENOENT") return json(res, { error: "file not found; build web first" }, 404);
    throw error;
  }
}
const lifetime = setTimeout(() => { for (const stream of streams) stream.end(); server.close(); }, FIXTURE_TIMEOUT_MS);
server.on("error", (error) => { clearTimeout(lifetime); console.error(error.message); process.exitCode = 1; });
server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ fixtureUrl: `http://127.0.0.1:${server.address().port}`, synthetic: true })));
