import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import { StateManager } from "../../src/runtime/state.js";
import { ILinkClient } from "../../src/wechat/client.js";

const QUEUED_REPLY_TIMEOUT_MS = 100;
const LOCAL_HTTP_TEST_TIMEOUT_MS = 30_000;
const FIXTURE_SEND_BUDGET = 100;
const FIXTURE_BASE_URL = "https://wechat.fixture.invalid";

async function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-reply-queue-"));
  const credentials = path.join(directory, "account.json");
  const statePath = path.join(directory, "state.json");
  fs.writeFileSync(credentials, JSON.stringify({ token: "synthetic", accountId: "fixture" }));
  const state = new StateManager(credentials, statePath, { sendBudget: FIXTURE_SEND_BUDGET });
  state.setContextToken("chat", "synthetic-context");
  state.recordInboundContext("synthetic-inbound-key", "chat", Date.now());
  const sent: string[] = [];
  const errors: unknown[] = [];
  const held = new Map<string, { started: () => void; response?: ServerResponse }>();
  const accept = (response: ServerResponse) => response.writeHead(200, { "Content-Type": "application/json" }).end("{\"ret\":0}");
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    if (request.url?.endsWith("getconfig")) {
      response.writeHead(200, { "Content-Type": "application/json" }).end("{\"ret\":0,\"typing_ticket\":\"synthetic-ticket\"}");
      return;
    }
    if (request.url?.endsWith("sendtyping")) { accept(response); return; }
    assert.equal(request.url, "/ilink/bot/sendmessage");
    const body: Buffer[] = [];
    for await (const chunk of request) body.push(Buffer.from(chunk));
    const text = JSON.parse(Buffer.concat(body).toString("utf8")).msg.item_list[0].text_item.text;
    sent.push(text);
    const gate = held.get(text);
    if (gate) { gate.response = response; gate.started(); }
    else accept(response);
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(error => {
      errors.push(error);
      if (!response.destroyed) response.writeHead(500).end();
    });
  });
  t.after(async () => {
    for (const gate of held.values()) if (gate.response && !gate.response.destroyed) accept(gate.response);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
    assert.deepEqual(errors, [], "local HTTP fixture must not fail");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const localOrigin = `http://127.0.0.1:${address.port}`;
  const fetchImpl: typeof fetch = (input, init) => {
    const original = new URL(String(input));
    assert.equal(original.origin, FIXTURE_BASE_URL);
    return fetch(new URL(original.pathname, localOrigin), init);
  };
  return {
    state, sent,
    reload: () => new StateManager(credentials, statePath, state.policy),
    client: (manager = state) => new ILinkClient({ stateManager: manager, configuredBaseUrl: FIXTURE_BASE_URL, fetchImpl }),
    hold: (text: string) => {
      let started!: () => void;
      const began = new Promise<void>(resolve => { started = resolve; });
      const gate = { started, response: undefined as ServerResponse | undefined };
      held.set(text, gate);
      return { began, release: () => {
        if (gate.response && !gate.response.destroyed) accept(gate.response);
        gate.response = undefined;
        held.delete(text);
      } };
    },
  };
}

function assertRetryable(state: StateManager, deliveryKey: string): void {
  assert.equal(state.replyDeliveries[deliveryKey]?.inFlight, false);
  assert.equal(state.getReplySentChunks(deliveryKey), 0);
}

for (const cancellation of ["timeout", "abort"] as const) {
  test(`queued text ${cancellation} sends no HTTP request and remains retryable after restart`, { timeout: LOCAL_HTTP_TEST_TIMEOUT_MS }, async t => {
    const f = await fixture(t), client = f.client(), blocker = f.hold("blocker");
    const first = client.sendSingleText("chat", "blocker");
    await blocker.began;
    const abort = new AbortController();
    const key = `queued-${cancellation}`;
    const budgetBeforeQueue = f.state.remainingSendBudget("chat");
    try {
      const pending = client.sendMarkdownReply("chat", "queued body", { deliveryKey: key,
        ...(cancellation === "timeout" ? { timeoutMs: QUEUED_REPLY_TIMEOUT_MS } : { signal: abort.signal }) });
      const rejected = assert.rejects(pending, cancellation === "timeout" ? /reply timed out/ : /synthetic cancellation/);
      await setImmediate();
      assertRetryable(f.state, key);
      if (cancellation === "abort") abort.abort(new Error("synthetic cancellation"));
      await rejected;
      assert.deepEqual(f.sent, ["blocker"]);
      assertRetryable(f.state, key);
      assertRetryable(f.reload(), key);
      assert.equal(f.state.remainingSendBudget("chat"), budgetBeforeQueue);
    } finally { abort.abort(); blocker.release(); await first; }
    const resumed = f.reload();
    assert.equal(await f.client(resumed).sendMarkdownReply("chat", "queued body", { deliveryKey: key }), 1);
    assert.deepEqual(f.sent, ["blocker", "queued body"]);
    assert.equal(f.reload().getReplySentChunks(key), 1);
    await f.client(f.reload()).sendMarkdownReply("chat", "queued body", { deliveryKey: key });
    assert.equal(f.sent.length, 2, "acknowledged retry must not be repeated");
  });
}

test("a continuation invalidated while queued creates no send intent and can resume", { timeout: LOCAL_HTTP_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t), client = f.client(), blocker = f.hold("blocker");
  const first = client.sendSingleText("chat", "blocker");
  await blocker.began;
  let canContinue = true;
  const key = "queued-stopped";
  try {
    const pending = client.sendMarkdownReply("chat", "queued body", {
      deliveryKey: key, shouldContinue: () => canContinue,
    });
    const rejected = assert.rejects(pending, /interrupted before completion/);
    await setImmediate();
    assertRetryable(f.state, key);
    canContinue = false;
    blocker.release();
    await first;
    await rejected;
    assert.deepEqual(f.sent, ["blocker"]);
    assertRetryable(f.state, key);
    assertRetryable(f.reload(), key);
  } finally { blocker.release(); await first; }
  assert.equal(await f.client(f.reload()).sendMarkdownReply("chat", "queued body", { deliveryKey: key }), 1);
  assert.deepEqual(f.sent, ["blocker", "queued body"]);
});

test("canceling after HTTP submission preserves uncertainty and forbids replay after restart", { timeout: LOCAL_HTTP_TEST_TIMEOUT_MS }, async t => {
  const f = await fixture(t), client = f.client(), submitted = f.hold("submitted body");
  const abort = new AbortController(), key = "submitted-abort";
  const pending = client.sendMarkdownReply("chat", "submitted body", { deliveryKey: key, signal: abort.signal });
  const rejected = assert.rejects(pending, /synthetic cancellation/);
  try {
    await submitted.began;
    assert.equal(f.reload().replyDeliveries[key].inFlight, true, "intent must reach disk before HTTP submission");
    abort.abort(new Error("synthetic cancellation"));
    await rejected;
    assert.equal(f.state.hasUncertainReply(key), true);
    const resumed = f.reload();
    assert.equal(resumed.hasUncertainReply(key), true);
    await assert.rejects(f.client(resumed).sendMarkdownReply("chat", "submitted body", { deliveryKey: key }), /uncertain/);
    assert.deepEqual(f.sent, ["submitted body"]);
  } finally { abort.abort(); submitted.release(); }
});
