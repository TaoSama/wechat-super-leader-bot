import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { StateManager, writePrivateJsonSync } from "../../src/runtime/state.js";
import type { ResultDelivery } from "../../src/results/contracts.js";

const WAIT_MS = 5_000;
const TEST_MS = 20_000;
const POLL_INTERVAL_MS = 10;
const POLL_TIMEOUT_MS = 500;
const BODY_LIMIT_BYTES = 64 * 1024;
const CHAT = "synthetic-private-chat";
const CONTEXT = "synthetic-private-context";
const TYPING_TICKET = "synthetic-private-typing-ticket";
const WECHAT_TOKEN = "synthetic-private-wechat-token";
const CONTROLLER_TOKEN = "synthetic-private-controller-token";
const INBOUND_TEXT = "synthetic private inbound text";
const REPLY_TEXT = "synthetic private reply text";
const NOTICE_TEXT = "synthetic private notification text";
const UPSTREAM_ERROR = "synthetic private upstream errmsg";
const MESSAGE_ID = "synthetic-inbound-message";
const CLI_PATH = fileURLToPath(new URL("../../src/index.js", import.meta.url));
const PRIVATE_VALUES = [CHAT, CONTEXT, TYPING_TICKET, WECHAT_TOKEN, CONTROLLER_TOKEN, INBOUND_TEXT, REPLY_TEXT, NOTICE_TEXT, UPSTREAM_ERROR];

type Options = {
  sendBody?: unknown;
  sendStatus?: number;
  inbound?: boolean;
  controllerError?: { endpoint: "pending" | "messages"; status: number };
};
type Running = {
  child: ChildProcess;
  output: { stdout: string; stderr: string };
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

async function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), WAIT_MS);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function readBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  let text = "", bytes = 0;
  for await (const chunk of request) {
    bytes += Buffer.byteLength(chunk);
    assert.ok(bytes <= BODY_LIMIT_BYTES, "fixture request exceeds byte budget");
    text += chunk.toString();
  }
  return JSON.parse(text || "{}") as Record<string, unknown>;
}

function json(response: http.ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function close(server: http.Server): Promise<void> {
  if (!server.listening) return;
  await deadline(new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeIdleConnections();
  }), "loopback server close");
}

async function fixture(t: TestContext, options: Options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-receipt-cli-"));
  const accountPath = path.join(directory, "account.json");
  const statePath = path.join(directory, "state.json");
  const healthPath = path.join(directory, "health.json");
  const certificate = path.join(directory, "certificate.pem"), key = path.join(directory, "key.pem");
  const config = path.join(directory, "openssl.cnf");
  const children: Running[] = [], servers: http.Server[] = [], errors: unknown[] = [];
  const sends: Record<string, unknown>[] = [], forwards: Record<string, unknown>[] = [];
  const createdAt = Date.now() - 1_000;
  const item: ResultDelivery = {
    id: "00000000-0000-4000-8000-000000000001", key: "synthetic-result", chatId: CHAT,
    source: { type: "task", id: "synthetic-task" }, kind: "completed", status: "ready", mode: "text", messages: [NOTICE_TEXT],
    artifact: { id: "00000000-0000-4000-8000-000000000002", chatId: CHAT, name: "result.md",
      size: Buffer.byteLength(NOTICE_TEXT), sha256: createHash("sha256").update(NOTICE_TEXT).digest("hex"), expiresAt: createdAt + 120_000 },
    createdAt, expiresAt: createdAt + 60_000, retainedUntil: createdAt + 120_000,
  };
  const records = new Map<string, ResultDelivery>([[item.id, item]]);
  let polls = 0, claims = 0, receipts = 0, defers = 0, pendingRequests = 0;

  async function stop(running: Running): Promise<void> {
    if (running.child.exitCode === null && running.child.signalCode === null) {
      assert.ok(running.child.kill("SIGTERM"), "normal SIGTERM must be delivered");
    }
    assert.deepEqual(await deadline(running.done, "CLI normal shutdown"), { code: 0, signal: null });
    assert.equal(JSON.parse(fs.readFileSync(healthPath, "utf8")).status, "stopped");
  }
  t.after(async () => {
    const cleanupErrors: unknown[] = [];
    for (const running of children) {
      try { await stop(running); } catch (error) { cleanupErrors.push(error); }
    }
    for (const server of servers) {
      try { await close(server); } catch (error) { cleanupErrors.push(error); }
    }
    // Never remove files a still-running child might be using.
    if (children.every(running => running.child.exitCode !== null || running.child.signalCode !== null)) {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
        assert.equal(fs.existsSync(directory), false);
      } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, "Fixture cleanup failed");
  });

  // Runtime-only certificate: trust this local CA, without disabling TLS verification.
  fs.writeFileSync(config, "[req]\ndistinguished_name=dn\n[dn]\n[v3]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n", { mode: 0o600 });
  await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-config", config, "-extensions", "v3", "-keyout", key, "-out", certificate]);
  writePrivateJsonSync(accountPath, { token: WECHAT_TOKEN, accountId: "synthetic-account" });
  const state = new StateManager(accountPath, statePath);
  state.markBaselineEstablished(); state.setContextToken(CHAT, CONTEXT);
  const inboundCreatedAtMs = Date.now() - 1000;
  state.recordInboundContext("synthetic-prior-inbound-key", CHAT, inboundCreatedAtMs - 1, true, CONTEXT);
  state.commitCursor("synthetic-old-cursor"); state.saveState();

  function handle(handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>) {
    return (req: http.IncomingMessage, res: http.ServerResponse) => {
      void handler(req, res).catch(error => { errors.push(error); json(res, { error: "fixture failure" }, 500); });
    };
  }
  const wechat = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(certificate) }, handle(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${WECHAT_TOKEN}`);
    assert.equal(req.headers.authorizationtype, "ilink_bot_token"); assert.equal(req.method, "POST");
    const body = await readBody(req);
    if (req.url === "/ilink/bot/getupdates") {
      polls++;
      json(res, { ret: 0, get_updates_buf: "synthetic-next-cursor", msgs: options.inbound ? [{
        message_type: 1, from_user_id: CHAT, client_id: MESSAGE_ID, context_token: CONTEXT,
        create_time_ms: inboundCreatedAtMs,
        item_list: [{ type: 1, text_item: { text: INBOUND_TEXT } }],
      }] : [] });
      return;
    }
    if (req.url === "/ilink/bot/getconfig") {
      assert.equal(body.ilink_user_id, CHAT);
      assert.equal(body.context_token, CONTEXT);
      json(res, { ret: 0, typing_ticket: TYPING_TICKET });
      return;
    }
    if (req.url === "/ilink/bot/sendtyping") {
      assert.equal(body.ilink_user_id, CHAT);
      assert.equal(body.typing_ticket, TYPING_TICKET);
      assert.ok(body.status === 1 || body.status === 2);
      json(res, { ret: 0 });
      return;
    }
    assert.equal(req.url, "/ilink/bot/sendmessage");
    const msg = body.msg as Record<string, unknown>;
    assert.equal(msg.to_user_id, CHAT); assert.equal(msg.context_token, CONTEXT);
    assert.equal(msg.message_type, 2); assert.equal(msg.message_state, 2);
    const text = ((msg.item_list as { text_item: { text: string } }[])[0]).text_item.text;
    assert.ok(text === NOTICE_TEXT || text === REPLY_TEXT);
    if (text === NOTICE_TEXT) {
      const digest = createHash("sha256").update(JSON.stringify([
        state.getLoginFingerprint(), CHAT, `result:${item.id}:step:0`, 0,
      ])).digest("hex").slice(0, 24);
      assert.equal(msg.client_id, `super-leader:${digest}`);
    }
    sends.push(msg);
    json(res, options.sendBody ?? {}, options.sendStatus ?? 200);
  }));
  servers.push(wechat);
  const controller = http.createServer(handle(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${CONTROLLER_TOKEN}`);
    if (req.url === "/v1/chats/notification-interest") {
      assert.equal(req.method, "GET");
      json(res, { chatIds: [CHAT], interested: [CHAT] });
      return;
    }
    if (req.url === `/v1/deliveries/${item.id}`) {
      assert.equal(req.method, "GET");
      json(res, { delivery: records.get(item.id) });
      return;
    }
    assert.equal(req.method, "POST");
    const body = await readBody(req);
    if (req.url === "/v1/chats/authorize") {
      assert.deepEqual(body, { chatId: CHAT });
      json(res, { allowed: true });
      return;
    }
    if (req.url === "/v1/messages") {
      assert.deepEqual(body, { chatId: CHAT, messageId: MESSAGE_ID, text: INBOUND_TEXT });
      forwards.push(body);
      json(res, { text: REPLY_TEXT, errmsg: UPSTREAM_ERROR }, options.controllerError?.endpoint === "messages" ? options.controllerError.status : 200);
      return;
    }
    if (req.url === "/v1/deliveries/resume") {
      assert.equal(body.chatId, CHAT);
      assert.equal(typeof body.generation, "string");
      json(res, { resumed: 0 });
      return;
    }
    if (req.url === "/v1/deliveries/pending") {
      pendingRequests++; assert.deepEqual(body, { chatIds: [CHAT] });
      if (options.controllerError?.endpoint === "pending") json(res, { errmsg: UPSTREAM_ERROR }, options.controllerError.status);
      else json(res, { items: [...records.values()].filter(record => record.status === "ready") });
      return;
    }
    const current = records.get(item.id)!;
    if (req.url === `/v1/deliveries/${item.id}/claim`) {
      claims++; assert.equal(current.status, "ready");
      records.set(item.id, { ...current, status: "claimed", attemptId: body.attemptId as string,
        attemptedAt: Date.now(), attemptExpiresAt: Date.now() + 30_000 });
    } else if (req.url === `/v1/deliveries/${item.id}/materialize`) {
      assert.equal(current.status, "claimed");
      assert.equal(body.attemptId, current.attemptId);
      json(res, { delivery: { ...current, artifact: { ...current.artifact,
        downloadUrl: `http://127.0.0.1:${controllerPort}/v1/result-artifacts/${current.artifact.id}/download?expires=${current.expiresAt}&signature=${"a".repeat(64)}` } } });
      return;
    } else if (req.url === `/v1/deliveries/${item.id}/defer`) {
      defers++; assert.equal(body.attemptId, current.attemptId);
      assert.equal(body.reason, "rejected");
      assert.equal(body.submittedMessages, 0);
      const { attemptId: _attemptId, attemptedAt: _attemptedAt, attemptExpiresAt: _attemptExpiresAt, ...rest } = current;
      records.set(item.id, { ...rest, status: "waiting_for_user", submittedMessages: 0,
        lastDeferredAttemptId: body.attemptId as string, lastDeferReason: "rejected", lastDeferredAt: Date.now() });
    } else {
      assert.equal(req.url, `/v1/deliveries/${item.id}/receipt`);
      receipts++; assert.equal(body.attemptId, current.attemptId);
      assert.ok(body.status === "accepted" || body.status === "uncertain");
      records.set(item.id, { ...current, status: body.status as "accepted" | "uncertain" });
    }
    json(res, { delivery: records.get(item.id) });
  }));
  servers.push(controller);
  const wechatPort = await listen(wechat), controllerPort = await listen(controller);

  function start(): Running {
    const child = spawn(process.execPath, [CLI_PATH, "--run", "--notifications", "--poll-interval-ms", String(POLL_INTERVAL_MS),
      "--poll-timeout-ms", String(POLL_TIMEOUT_MS), "--credentials-path", accountPath, "--state-path", statePath,
      "--health-path", healthPath, "--controller-url", `http://127.0.0.1:${controllerPort}`,
      "--wechat-base-url", `https://127.0.0.1:${wechatPort}`], {
      // Do not inherit real runtime credentials or notification switches.
      env: { PATH: process.env.PATH ?? "", NODE_EXTRA_CA_CERTS: certificate, CONTROLLER_TOKEN },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = { stdout: "", stderr: "" };
    child.stdout!.setEncoding("utf8").on("data", chunk => { output.stdout += chunk; });
    child.stderr!.setEncoding("utf8").on("data", chunk => { output.stderr += chunk; });
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal }));
    });
    const running = { child, output, done }; children.push(running); return running;
  }
  async function waitFor(running: Running, condition: () => boolean): Promise<void> {
    const end = Date.now() + WAIT_MS;
    while (!condition()) {
      if (errors.length) throw new AggregateError(errors, "Loopback handler failed");
      assert.equal(running.child.exitCode, null, `CLI exited early: ${running.output.stderr}`);
      assert.equal(running.child.signalCode, null, "CLI terminated early");
      assert.ok(Date.now() < end, `Fixture condition timed out: ${running.output.stderr}`);
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    if (errors.length) throw new AggregateError(errors, "Loopback handler failed");
  }
  function assertPrivate(running: Running): void {
    const output = running.output.stdout + running.output.stderr + fs.readFileSync(healthPath, "utf8");
    for (const value of PRIVATE_VALUES) assert.equal(output.includes(value), false, `diagnostic leaked ${value}`);
    assert.deepEqual(errors, []);
  }
  return { start, stop, waitFor, assertPrivate, records, item, sends, forwards, statePath, accountPath, healthPath,
    counts: () => ({ polls, claims, receipts, defers, pendingRequests }) };
}

for (const sendBody of [{}, { errmsg: "" }, { ret: 0 }, { message_id: "18446744073709551615" }]) {
  test(`real CLI accepts ${JSON.stringify(sendBody)} and persists inbound/result dedup across restart`, { timeout: TEST_MS }, async t => {
    const f = await fixture(t, { sendBody, inbound: true });
    const first = f.start();
    await f.waitFor(first, () => f.counts().polls >= 3 && f.sends.length === 2 && f.counts().receipts === 1);
    await f.stop(first); f.assertPrivate(first);
    assert.equal(f.records.get(f.item.id)!.status, "accepted");
    assert.deepEqual([f.counts().claims, f.counts().receipts, f.sends.length, f.forwards.length], [1, 1, 2, 1]);
    const state = new StateManager(f.accountPath, f.statePath);
    assert.equal(state.isMessageProcessed(state.computeDeliveryKey(CHAT, MESSAGE_ID)), true);
    const initialPolls = f.counts().polls, second = f.start();
    await f.waitFor(second, () => f.counts().polls >= initialPolls + 3);
    await f.stop(second); f.assertPrivate(second);
    assert.equal(first.output.stderr + second.output.stderr, "");
    assert.deepEqual([f.counts().claims, f.counts().receipts, f.sends.length, f.forwards.length], [1, 1, 2, 1]);
  });
}

const failures = [
  { sendBody: { message_id: 1.5 }, errorType: "ILinkSendInvalidMessageId" },
  { sendBody: { ret: 7, errmsg: UPSTREAM_ERROR }, errorType: "ILinkSendRejectedRet" },
  { sendBody: { errcode: -1, errmsg: UPSTREAM_ERROR }, errorType: "ILinkSendRejectedErrcode" },
  { sendBody: { ret: "0" }, errorType: "ILinkSendInvalidRet" },
  { sendBody: { errcode: null }, errorType: "ILinkSendInvalidErrcode" },
  { sendBody: { base_resp: { ret: 0 } }, errorType: "ILinkSendUnsupportedShape" },
  ...[401, 403].map(sendStatus => ({ sendBody: { errmsg: UPSTREAM_ERROR }, sendStatus, errorType: `ILinkHttp${sendStatus}` })),
];
for (const failure of failures) {
  const rejected = failure.errorType === "ILinkSendRejectedRet" || failure.errorType === "ILinkSendRejectedErrcode";
  test(`real CLI records ${failure.errorType} as ${rejected ? "waiting for user" : "permanent uncertainty"} without diagnostic leaks`, { timeout: TEST_MS }, async t => {
    const f = await fixture(t, failure), first = f.start();
    await f.waitFor(first, () => f.counts().polls >= 3 && f.counts().receipts + f.counts().defers === 1);
    await f.stop(first); f.assertPrivate(first);
    const item = f.records.get(f.item.id)!;
    assert.equal(item.status, rejected ? "waiting_for_user" : "uncertain");
    const evidence = new StateManager(f.accountPath, f.statePath).replyDeliveries[`result:${item.id}:step:0`];
    assert.equal(evidence.acknowledgedChunks, 0);
    assert.equal(Boolean(evidence.inFlight), !rejected);
    const diagnostics = first.output.stderr.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    assert.deepEqual(diagnostics, rejected ? [] : [{ event: "notification_send_failed", notificationId: item.id,
      attemptId: item.attemptId, errorType: "UncertainSend" }]);
    if (rejected) assert.equal(item.lastDeferReason, "rejected");
    const initialPolls = f.counts().polls, second = f.start();
    await f.waitFor(second, () => f.counts().polls >= initialPolls + 3);
    await f.stop(second); f.assertPrivate(second);
    assert.equal(second.output.stderr, "");
    assert.deepEqual([f.counts().claims, f.counts().receipts, f.counts().defers, f.sends.length, f.forwards.length],
      rejected ? [1, 0, 1, 1, 0] : [1, 1, 0, 1, 0]);
  });
}

for (const endpoint of ["pending", "messages"] as const) {
  for (const status of [401, 403]) {
    test(`real CLI classifies Controller ${endpoint} HTTP ${status} separately from WeChat`, { timeout: TEST_MS }, async t => {
      const f = await fixture(t, { inbound: endpoint === "messages", controllerError: { endpoint, status } });
      // Keep message-path authentication tests focused on forwarding, with no pending notice.
      if (endpoint === "messages") f.records.clear();
      const running = f.start(), expected = `ControllerAuth${status}`;
      await f.waitFor(running, () => f.counts().polls >= 3 && running.output.stderr.includes(expected));
      await f.stop(running); f.assertPrivate(running);
      const prefix = endpoint === "pending" ? "notification" : "poll";
      assert.ok(running.output.stderr.trim().split("\n").every(line => line === `[gateway] ${prefix} cycle error: ${expected}`));
      assert.deepEqual([f.counts().claims, f.counts().receipts, f.sends.length], [0, 0, 0]);
      if (endpoint === "messages") {
        assert.ok(f.forwards.length >= 2);
        assert.equal(JSON.parse(fs.readFileSync(f.healthPath, "utf8")).last_error_type, expected);
      }
    });
  }
}
