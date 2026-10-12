import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../src/state.js";
import { ILinkClient, splitWeChatReply } from "../src/ilink.js";
import { ControllerClient, validateControllerUrl, ChatNotAllowedError } from "../src/controller_client.js";
import { WeChatGateway } from "../src/gateway.js";
import { parseGatewayCli, runCli } from "../src/index.js";
import { checkGatewayHealth, HealthTracker, resolveHealthPath, sanitizeErrorType } from "../src/health.js";

test("validateControllerUrl enforces HTTPS for remote and allows loopback or explicit ALLOW_INSECURE_CONTROLLER", () => {
  assert.equal(validateControllerUrl("http://127.0.0.1:8790/", false), "http://127.0.0.1:8790");
  assert.equal(validateControllerUrl("http://localhost:8790", false), "http://localhost:8790");
  assert.equal(validateControllerUrl("https://remote.example.com:8790/", false), "https://remote.example.com:8790");

  assert.throws(
    () => validateControllerUrl("http://controller:8790", false),
    /Remote CONTROLLER_URL must use https:///
  );
  assert.equal(validateControllerUrl("http://controller:8790/", true), "http://controller:8790");

  assert.throws(() => validateControllerUrl("http://user:pass@127.0.0.1:8790", true), /userinfo/);
  assert.throws(() => validateControllerUrl("http://127.0.0.1:8790?foo=bar", true), /query/);
  assert.throws(() => validateControllerUrl("http://127.0.0.1:8790#frag", true), /fragment/);
});

test("ControllerClient retries 5xx, throws ChatNotAllowedError on CHAT_NOT_ALLOWED, and rejects 401/403 immediately", async () => {
  let calls = 0;
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    calls++;
    const auth = (init?.headers as Record<string, string>)?.Authorization;
    assert.equal(auth, "Bearer ctrl-tok");
    if (calls === 1) {
      return new Response(JSON.stringify({ error: "temporary" }), { status: 502 });
    }
    return new Response(JSON.stringify({ text: "handled ok", commandId: "cmd-1" }), { status: 200 });
  };

  const client = new ControllerClient({
    controllerUrl: "http://127.0.0.1:8790",
    controllerToken: "ctrl-tok",
    fetchImpl: fakeFetch as typeof globalThis.fetch,
  });

  const res = await client.forwardMessage({ chatId: "u1", messageId: "m1", text: "hi" });
  assert.equal(res.text, "handled ok");
  assert.equal(res.commandId, "cmd-1");
  assert.equal(calls, 2);

  // 403 with code=CHAT_NOT_ALLOWED throws ChatNotAllowedError
  const poisonClient = new ControllerClient({
    controllerUrl: "http://127.0.0.1:8790",
    controllerToken: "ctrl-tok",
    fetchImpl: (async () => {
      return new Response(JSON.stringify({ error: "chat not allowed", code: "CHAT_NOT_ALLOWED" }), { status: 403 });
    }) as typeof globalThis.fetch,
  });
  await assert.rejects(
    () => poisonClient.forwardMessage({ chatId: "bad-chat", messageId: "m1", text: "hi" }),
    (err: Error) => err instanceof ChatNotAllowedError
  );

  // 401 without code does not retry and fails closed
  let authCalls = 0;
  const authFailClient = new ControllerClient({
    controllerUrl: "http://127.0.0.1:8790",
    controllerToken: "bad-tok",
    fetchImpl: (async () => {
      authCalls++;
      return new Response("unauthorized", { status: 401 });
    }) as typeof globalThis.fetch,
  });
  await assert.rejects(
    () => authFailClient.forwardMessage({ chatId: "u1", messageId: "m1", text: "hi" }),
    /authentication failed/
  );
  assert.equal(authCalls, 1);
});

test("WeChatGateway refuses pollOnce/run without baseline established", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-nobaseline-"));
  const credPath = path.join(tmpDir, "account.json");
  const statePath = path.join(tmpDir, "state.json");
  fs.writeFileSync(credPath, JSON.stringify({ token: "bot-tok", accountId: "bot-acc" }));

  const sm = new StateManager(credPath, statePath);
  const ilink = new ILinkClient({ stateManager: sm });
  const ctrl = new ControllerClient({
    controllerUrl: "http://127.0.0.1:8790",
    controllerToken: "tok",
  });
  const gateway = new WeChatGateway({ stateManager: sm, ilink, controller: ctrl });

  await assert.rejects(
    () => gateway.pollOnce(),
    /baseline is not established/
  );
  await assert.rejects(
    () => gateway.runLoop(10),
    /baseline is not established/
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("WeChatGateway establishBaseline drains history to empty batch without forwarding or replying", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-baseline-drain-"));
  const credPath = path.join(tmpDir, "account.json");
  const statePath = path.join(tmpDir, "state.json");
  fs.writeFileSync(credPath, JSON.stringify({ token: "bot-tok", accountId: "bot-acc" }));

  let pollCallCount = 0;
  let controllerCalls = 0;
  let sendCalls = 0;

  const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/ilink/bot/getupdates")) {
      pollCallCount++;
      if (pollCallCount === 1) {
        // Page 1: contains 1 text message
        return new Response(JSON.stringify({
          ret: 0,
          errcode: 0,
          get_updates_buf: "cursor-page-1",
          msgs: [
            {
              message_type: 1,
              from_user_id: "u-history",
              client_id: "hist-msg-1",
              context_token: "ctx-token-1",
              item_list: [{ type: 1, text_item: { text: "old question" } }],
            },
          ],
        }), { status: 200 });
      }
      if (pollCallCount === 2) {
        // Page 2: non-text event (e.g. system event). messages=[] but rawMessageCount=1. Must NOT stop baseline here!
        return new Response(JSON.stringify({
          ret: 0,
          errcode: 0,
          get_updates_buf: "cursor-page-2",
          msgs: [
            {
              message_type: 99,
              from_user_id: "u-sys",
            },
          ],
        }), { status: 200 });
      }
      // Page 3: raw msgs=[] (rawMessageCount=0). End of baseline drain!
      return new Response(JSON.stringify({
        ret: 0,
        errcode: 0,
        get_updates_buf: "cursor-empty-final",
        msgs: [],
      }), { status: 200 });
    }
    if (url.endsWith("/ilink/bot/sendmessage")) {
      sendCalls++;
      return new Response(JSON.stringify({ ret: 0, errcode: 0 }), { status: 200 });
    }
    throw new Error("unexpected URL " + url);
  };

  const sm = new StateManager(credPath, statePath);
  const ilink = new ILinkClient({ stateManager: sm, fetchImpl: fakeFetch as typeof globalThis.fetch });
  const ctrl = new ControllerClient({
    controllerUrl: "http://127.0.0.1:8790",
    controllerToken: "tok",
    fetchImpl: (async () => {
      controllerCalls++;
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch,
  });

  const gateway = new WeChatGateway({ stateManager: sm, ilink, controller: ctrl });
  const baseline = await gateway.establishBaseline(5);

  assert.equal(baseline.batchesDrained, 3);
  assert.equal(baseline.rawMessagesSkipped, 2);
  assert.equal(baseline.finalSyncBuf, "cursor-empty-final");
  assert.equal(sm.syncBuf, "cursor-empty-final");
  assert.equal(sm.baselineEstablished, true);
  assert.equal(sm.baselineInProgress, false);
  assert.ok(sm.baselineEstablishedAt);
  assert.equal(controllerCalls, 0, "must never call Controller during baseline");
  assert.equal(sendCalls, 0, "must never reply during baseline");
  assert.equal(sm.contextTokens["u-history"], "ctx-token-1");
  const histKey = sm.computeDeliveryKey("u-history", "hist-msg-1");
  assert.equal(sm.isMessageProcessed(histKey), true);

  // Duplicate baseline attempt must be refused
  await assert.rejects(
    () => gateway.establishBaseline(5),
    /Baseline is already established/
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("WeChatGateway end-to-end pollOnce, deduplication across chats, and cursor checkpointing", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-e2e-"));
  const credPath = path.join(tmpDir, "account.json");
  const statePath = path.join(tmpDir, "state.json");
  fs.writeFileSync(credPath, JSON.stringify({ token: "bot-tok", accountId: "bot-acc", baseUrl: "https://ilink.example" }));

  const sentToWeChat: Array<{ to: string; text: string; contextToken: string }> = [];
  const forwardedToController: Array<{ chatId: string; messageId: string; text: string }> = [];

  const ilinkFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body || "{}"));
    if (url.endsWith("/ilink/bot/getupdates")) {
      return new Response(JSON.stringify({
        ret: 0,
        errcode: 0,
        get_updates_buf: "cursor-after-batch-1",
        msgs: [
          {
            message_type: 1,
            from_user_id: "chat-a",
            client_id: "same-client-id",
            context_token: "ctx-a",
            item_list: [{ type: 1, text_item: { text: "status on demoair" } }],
          },
          {
            message_type: 1,
            from_user_id: "chat-b",
            client_id: "same-client-id",
            context_token: "ctx-b",
            item_list: [{ type: 1, text_item: { text: "hello from b" } }],
          },
        ],
      }), { status: 200 });
    }
    if (url.endsWith("/ilink/bot/sendmessage")) {
      sentToWeChat.push({
        to: body.msg.to_user_id,
        text: body.msg.item_list[0].text_item.text,
        contextToken: body.msg.context_token,
      });
      return new Response(JSON.stringify({ ret: 0, errcode: 0 }), { status: 200 });
    }
    throw new Error("unexpected URL " + url);
  };

  const controllerFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    forwardedToController.push(body);
    return new Response(JSON.stringify({ text: "**Reply** to " + body.chatId }), { status: 200 });
  };

  const sm = new StateManager(credPath, statePath);
  sm.markBaselineEstablished();

  const ilink = new ILinkClient({ stateManager: sm, fetchImpl: ilinkFetch as typeof globalThis.fetch });
  const ctrl = new ControllerClient({
    controllerUrl: "http://127.0.0.1:8790",
    controllerToken: "ctrl-token",
    fetchImpl: controllerFetch as typeof globalThis.fetch,
  });
  const gateway = new WeChatGateway({ stateManager: sm, ilink, controller: ctrl });

  const summary1 = await gateway.pollOnce();
  assert.equal(summary1.polledCount, 2);
  assert.equal(summary1.processedCount, 2);
  assert.equal(summary1.nextSyncBuf, "cursor-after-batch-1");
  assert.equal(sm.syncBuf, "cursor-after-batch-1");
  assert.equal(forwardedToController.length, 2);
  assert.equal(sentToWeChat.length, 2);
  assert.equal(sentToWeChat[0].text, "Reply to chat-a");
  assert.equal(sentToWeChat[1].text, "Reply to chat-b");

  // Second poll with same messages must deduplicate both and not forward again
  const summary2 = await gateway.pollOnce();
  assert.equal(summary2.polledCount, 0);
  assert.equal(forwardedToController.length, 2);
  assert.equal(sentToWeChat.length, 2);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Poison batch: CHAT_NOT_ALLOWED skips unallowed chat and lets cursor advance for valid chat", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-poison-"));
  const credPath = path.join(tmpDir, "account.json");
  const statePath = path.join(tmpDir, "state.json");
  fs.writeFileSync(credPath, JSON.stringify({ token: "bot-tok", accountId: "bot-acc" }));

  const ilinkFetch = async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/ilink/bot/getupdates")) {
      return new Response(JSON.stringify({
        ret: 0,
        errcode: 0,
        get_updates_buf: "cursor-past-poison",
        msgs: [
          {
            message_type: 1,
            from_user_id: "unauthorized-stranger",
            client_id: "poison-msg-1",
            item_list: [{ type: 1, text_item: { text: "spam" } }],
          },
          {
            message_type: 1,
            from_user_id: "authorized-owner",
            client_id: "valid-msg-2",
            context_token: "ctx-owner",
            item_list: [{ type: 1, text_item: { text: "legit task" } }],
          },
        ],
      }), { status: 200 });
    }
    if (url.endsWith("/ilink/bot/sendmessage")) {
      return new Response(JSON.stringify({ ret: 0, errcode: 0 }), { status: 200 });
    }
    throw new Error("unexpected URL");
  };

  const controllerFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    if (body.chatId === "unauthorized-stranger") {
      return new Response(JSON.stringify({ error: "chat not allowed", code: "CHAT_NOT_ALLOWED" }), { status: 403 });
    }
    return new Response(JSON.stringify({ text: "ok" }), { status: 200 });
  };

  const sm = new StateManager(credPath, statePath);
  sm.markBaselineEstablished();

  const ilink = new ILinkClient({ stateManager: sm, fetchImpl: ilinkFetch as typeof globalThis.fetch });
  const ctrl = new ControllerClient({
    controllerUrl: "http://127.0.0.1:8790",
    controllerToken: "ctrl-token",
    fetchImpl: controllerFetch as typeof globalThis.fetch,
  });
  const gateway = new WeChatGateway({ stateManager: sm, ilink, controller: ctrl });

  const summary = await gateway.pollOnce();
  assert.equal(summary.polledCount, 2);
  assert.equal(summary.processedCount, 1);
  assert.equal(summary.skippedCount, 1);
  assert.equal(summary.nextSyncBuf, "cursor-past-poison");
  assert.equal(sm.syncBuf, "cursor-past-poison");

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Multi-part reply partial failure resumes from unsent chunk without duplicating sent chunks or advancing cursor prematurely", async (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-multipart-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const credPath = path.join(tmpDir, "account.json");
  const statePath = path.join(tmpDir, "state.json");
  fs.writeFileSync(credPath, JSON.stringify({ token: "bot-tok", accountId: "bot-acc" }));

  const sentChunks: Array<{ text: string; clientId: string }> = [];
  let failSecondChunkOnce = true;

  const ilinkFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body || "{}"));
    if (url.endsWith("/ilink/bot/getupdates")) {
      return new Response(JSON.stringify({
        ret: 0,
        errcode: 0,
        get_updates_buf: "cursor-next",
        msgs: [
          {
            message_type: 1,
            from_user_id: "owner",
            client_id: "msg-multipart-1",
            context_token: "ctx-owner",
            item_list: [{ type: 1, text_item: { text: "give long output" } }],
          },
        ],
      }), { status: 200 });
    }
    if (url.endsWith("/ilink/bot/sendmessage")) {
      const text = body.msg.item_list[0].text_item.text;
      const clientId = body.msg.client_id;
      if (text === "Part2\n" && failSecondChunkOnce) {
        failSecondChunkOnce = false;
        throw new Error("simulated network drop on chunk 2");
      }
      sentChunks.push({ text, clientId });
      return new Response(JSON.stringify({ ret: 0, errcode: 0 }), { status: 200 });
    }
    throw new Error("unexpected URL " + url);
  };

  const controllerFetch = async () => {
    return new Response(JSON.stringify({ text: "Part1\nPart2\nPart3" }), { status: 200 });
  };

  const sm1 = new StateManager(credPath, statePath);
  sm1.markBaselineEstablished();

  const ilink1 = new ILinkClient({ stateManager: sm1, fetchImpl: ilinkFetch as typeof globalThis.fetch });
  const ctrl1 = new ControllerClient({
    controllerUrl: "http://127.0.0.1:8790",
    controllerToken: "ctrl-token",
    fetchImpl: controllerFetch as typeof globalThis.fetch,
  });
  // Set maxChars=6; separators remain part of each transmitted fragment.
  const gw1 = new WeChatGateway({ stateManager: sm1, ilink: ilink1, controller: ctrl1, splitMaxChars: 6 });

  await assert.rejects(() => gw1.pollOnce(), /simulated network drop on chunk 2/);
  assert.equal(sm1.syncBuf, "");
  assert.deepEqual(sentChunks.map((c) => c.text), ["Part1\n"]);

  // Simulate restart by loading a fresh StateManager from disk
  const sm2 = new StateManager(credPath, statePath);
  assert.equal(sm2.baselineEstablished, true);
  assert.equal(sm2.syncBuf, "");
  const ilink2 = new ILinkClient({ stateManager: sm2, fetchImpl: ilinkFetch as typeof globalThis.fetch });
  const ctrl2 = new ControllerClient({
    controllerUrl: "http://127.0.0.1:8790",
    controllerToken: "ctrl-token",
    fetchImpl: controllerFetch as typeof globalThis.fetch,
  });
  const gw2 = new WeChatGateway({ stateManager: sm2, ilink: ilink2, controller: ctrl2, splitMaxChars: 6 });

  const summary = await gw2.pollOnce();
  assert.equal(summary.processedCount, 1);
  assert.equal(sm2.syncBuf, "cursor-next");
  assert.deepEqual(sentChunks.map((c) => c.text), ["Part1\n", "Part2\n", "Part3"]);
  assert.equal(sentChunks.map((c) => c.text).join(""), "Part1\nPart2\nPart3");
  assert.deepEqual(sm2.sentReplyProgress, {});

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("CLI parseGatewayCli mode mutual exclusivity and env handling", () => {
  // Disallow multiple modes
  assert.throws(
    () => parseGatewayCli(["--check", "--run"]),
    /Cannot specify multiple mode flags simultaneously/
  );
  assert.throws(
    () => parseGatewayCli(["--establish-baseline", "--run"]),
    /Cannot specify multiple mode flags simultaneously/
  );
  assert.throws(
    () => parseGatewayCli(["--healthcheck", "--poll-once"]),
    /Cannot specify multiple mode flags simultaneously/
  );

  // Explicit --check or --establish-baseline or --healthcheck ignores GATEWAY_RUN_POLL=true
  const optsBaseline = parseGatewayCli(["--establish-baseline"], { GATEWAY_RUN_POLL: "true" });
  assert.equal(optsBaseline.mode, "establish-baseline");
  assert.equal(optsBaseline.run, false);

  const optsCheck = parseGatewayCli(["--check"], { GATEWAY_RUN_POLL: "true" });
  assert.equal(optsCheck.mode, "check");
  assert.equal(optsCheck.run, false);

  const optsHealth = parseGatewayCli(["--healthcheck"], { GATEWAY_RUN_POLL: "true" });
  assert.equal(optsHealth.mode, "healthcheck");
  assert.equal(optsHealth.run, false);

  // When no mode flag is provided, GATEWAY_RUN_POLL triggers run mode
  const optsRunFromEnv = parseGatewayCli([], { GATEWAY_RUN_POLL: "true" });
  assert.equal(optsRunFromEnv.mode, "run");
  assert.equal(optsRunFromEnv.run, true);
});

test("Health tracker and checkGatewayHealth lifecycle and error sanitization", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-01T00:00:00Z") });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-health-test-"));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const healthPath = path.join(tmpDir, "health.json");

  // Health check fails when file doesn't exist
  const resMissing = checkGatewayHealth(healthPath, 120000);
  assert.equal(resMissing.ok, false);
  assert.equal(resMissing.reason, "HealthFileNotFound");

  // Start tracker and verify starting status
  const tracker = new HealthTracker(healthPath);
  tracker.startRun();
  const resStarting = checkGatewayHealth(healthPath, 120000);
  assert.equal(resStarting.ok, true);
  assert.equal(resStarting.status, "starting");
  assert.equal(resStarting.pid, process.pid);

  // Record error and verify error desensitization
  tracker.recordPollError(new Error("WeChat iLink HTTP 502 on /ilink/bot/getupdates"));
  const resDegraded = checkGatewayHealth(healthPath, 120000);
  assert.equal(resDegraded.consecutiveErrors, 1);
  assert.equal(resDegraded.lastErrorType, "ILinkHttp502");

  // Test error sanitizer never leaks arbitrary names
  assert.equal(sanitizeErrorType(new Error("WeChat getupdates failed")), "ILinkGetUpdatesError");
  assert.equal(sanitizeErrorType(new Error("Controller authentication/authorization failed (HTTP 403)")), "ControllerAuth403");
  assert.equal(sanitizeErrorType(new Error("Controller authentication failed (HTTP 401)")), "ControllerAuth401");
  assert.equal(sanitizeErrorType({ name: "CustomSensitiveErrorName123", message: "foo" }), "OperationalError");

  // Record poll success and verify healthy
  tracker.recordPollSuccess();
  const resHealthy = checkGatewayHealth(healthPath, 120000);
  assert.equal(resHealthy.ok, true);
  assert.equal(resHealthy.status, "healthy");
  assert.equal(resHealthy.consecutiveErrors, 0);

  // The exact age boundary is healthy; stale detection starts after it.
  const resAtBoundary = checkGatewayHealth(healthPath, 0);
  assert.equal(resAtBoundary.ok, true);
  assert.equal(resAtBoundary.ageMs, 0);
  t.mock.timers.tick(1);
  const resStale = checkGatewayHealth(healthPath, 0);
  assert.equal(resStale.ok, false);
  assert.equal(resStale.reason, "PollStale");
  assert.equal(resStale.ageMs, 1);

  // Stopped process
  tracker.recordStop();
  const resStopped = checkGatewayHealth(healthPath, 120000);
  assert.equal(resStopped.ok, false);
  assert.equal(resStopped.reason, "GatewayStopped");
});

test("CLI --healthcheck runs independently without requiring credentials", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-cli-health-"));
  const healthPath = path.join(tmpDir, "health.json");

  const tracker = new HealthTracker(healthPath);
  tracker.startRun();
  tracker.recordPollSuccess();

  // Call runCli with --healthcheck pointing to non-existent credentials path
  const code = await runCli(["--healthcheck", "--health-path", healthPath, "--credentials-path", "/non-existent/account.json"]);
  assert.equal(code, 0);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Baseline resume upon interruption and refuse baseline when normal processed keys exist", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-baseline-resume-"));
  const credPath = path.join(tmpDir, "account.json");
  const statePath = path.join(tmpDir, "state.json");
  fs.writeFileSync(credPath, JSON.stringify({ token: "bot-tok", accountId: "bot-acc" }));

  // Simulate an interrupted baseline run where baseline_in_progress=true was persisted
  fs.writeFileSync(statePath, JSON.stringify({
    login_fingerprint: "",
    sync_buf: "interrupted-cursor",
    context_tokens: {},
    processed_message_keys: ["bot-acc:\"chat-1\":\"msg-1\""],
    baseline_in_progress: true,
    baseline_established: false,
  }));

  const sm = new StateManager(credPath, statePath);
  assert.equal(sm.baselineInProgress, true);
  assert.equal(sm.baselineEstablished, false);
  assert.equal(sm.syncBuf, "interrupted-cursor");

  // It should safely allow resuming baseline!
  let drained = false;
  const fakeFetch = async (input: string | URL | Request) => {
    drained = true;
    return new Response(JSON.stringify({ ret: 0, errcode: 0, get_updates_buf: "final-resumed-buf", msgs: [] }), { status: 200 });
  };
  const ilink = new ILinkClient({ stateManager: sm, fetchImpl: fakeFetch as typeof globalThis.fetch });
  const ctrl = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "tok" });
  const gw = new WeChatGateway({ stateManager: sm, ilink, controller: ctrl });

  const summary = await gw.establishBaseline(5);
  assert.equal(drained, true);
  assert.equal(summary.finalSyncBuf, "final-resumed-buf");
  assert.equal(sm.baselineEstablished, true);
  assert.equal(sm.baselineInProgress, false);

  // Now create state that has normal processed keys and baseline_established=false and baseline_in_progress=false
  const dirtyStatePath = path.join(tmpDir, "dirty-state.json");
  fs.writeFileSync(dirtyStatePath, JSON.stringify({
    login_fingerprint: "",
    sync_buf: "active-cursor",
    context_tokens: {},
    processed_message_keys: ["key1"],
    baseline_in_progress: false,
    baseline_established: false,
  }));
  const dirtySm = new StateManager(credPath, dirtyStatePath);
  const dirtyGw = new WeChatGateway({ stateManager: dirtySm, ilink, controller: ctrl });
  await assert.rejects(
    () => dirtyGw.establishBaseline(5),
    /state already contains active sync cursor or processed message records/
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("Log error classification and output redaction verification", () => {
  // Test error sanitizer with raw tokens, messages, errcode strings
  const sensitiveLeak = new Error("WeChat iLink failed with sensitive_token_9999 and body: {\"secret\":123}");
  assert.equal(sanitizeErrorType(sensitiveLeak), "OperationalError");

  const timeoutErr = new Error("Request to ilinkai.weixin.qq.com/getupdates timed out after 35000ms");
  assert.equal(sanitizeErrorType(timeoutErr), "TimeoutError");

  const ctrl500 = new Error("Controller /v1/messages returned HTTP 500");
  assert.equal(sanitizeErrorType(ctrl500), "ControllerHttp500");

  const parseErr = new SyntaxError("Unexpected token in JSON at position 12");
  assert.equal(sanitizeErrorType(parseErr), "InvalidJsonSyntax");
});
