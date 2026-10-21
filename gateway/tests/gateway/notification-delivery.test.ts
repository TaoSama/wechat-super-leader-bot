import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import nodeFs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { StateManager } from "../../src/runtime/state.js";
import { WeChatGateway } from "../../src/gateway.js";
import { parseGatewayCli } from "../../src/cli/options.js";
import { runCli, NOTIFICATION_DIAGNOSTIC_EXIT_CODE } from "../../src/cli/run.js";
import { HealthTracker, checkGatewayHealth } from "../../src/runtime/health.js";
import { harness, notification, goalNotification } from "../fixtures/notification-fixtures.js";

function notificationClientId(state: StateManager, chatId: string, id: string, index = 0): string {
  return `super-leader:${createHash("sha256")
    .update(JSON.stringify([state.getLoginFingerprint(), chatId, `notification:${id}`, index])).digest("hex").slice(0, 24)}`;
}

test("terminal notification is one plain-text send with deterministic evidence ID and no state reset", async t => {
  const f = harness(t);
  f.state.commitCursor("original-cursor"); f.state.recordProcessedMessageKey("old-key");
  const fingerprint = f.state.getLoginFingerprint();
  assert.deepEqual(await f.gateway.deliverNotificationsOnce(), { accepted: 1, uncertain: 0, skipped: 0 });
  const item = notification();
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].client_id, notificationClientId(f.state, item.chatId, item.id));
  assert.equal(f.sends[0].to_user_id, "chat");
  assert.equal(f.sends[0].context_token, "synthetic-context");
  assert.deepEqual(f.sends[0].item_list, [{ type: 1, text_item: { text: item.text } }]);
  assert.equal(f.state.getLoginFingerprint(), fingerprint);
  assert.equal(f.state.syncBuf, "original-cursor");
  assert.equal(f.state.isMessageProcessed("old-key"), true);
  assert.equal(new StateManager(f.accountPath, f.statePath).replyDeliveries[`notification:${item.id}`].acknowledgedChunks, 1);
  assert.equal(f.records.get(item.id)?.status, "accepted");
  assert.deepEqual(await f.gateway.deliverNotificationsOnce(), { accepted: 0, uncertain: 0, skipped: 0 });
  assert.equal(f.sends.length, 1);
});
for (const source of ["plan", "goal"] as const) test(`${source} result Markdown is sent verbatim`, async t => {
  const item = source === "plan" ? notification() : goalNotification();
  item.text = "## 执行结果\n\n**完成**：修复确认流程。\n- 已通过 `pnpm test`\n- [查看变更](https://example.com/pull/42)";
  const f = harness(t, { items: [item] });
  assert.deepEqual(await f.gateway.deliverNotificationsOnce(), { accepted: 1, uncertain: 0, skipped: 0 });
  assert.equal(f.sends.length, 1);
  assert.deepEqual(f.sends[0].item_list, [{ type: 1, text_item: {
    text: item.text,
  } }]);
  assert.equal(f.sends[0].client_id, notificationClientId(f.state, item.chatId, item.id));
  assert.equal(f.records.get(item.id)?.text, item.text, "receipts retain the original notification identity");
  await f.gateway.deliverNotificationsOnce();
  assert.equal(f.sends.length, 1);
});
test("long notification preserves all Markdown and Unicode across bounded chunks", async t => {
  const item = notification();
  item.text = "# 执行结果\n\n- **完成**：" + "验证通过🚀".repeat(200);
  const f = harness(t, { items: [item], policy: { sendBudget: 100 } }), maxChars = 96;
  const gateway = new WeChatGateway({ stateManager: f.state, controller: f.controller, ilink: f.ilink,
    notifications: true, splitMaxChars: maxChars, splitMultiPart: true });
  assert.equal((await gateway.deliverNotificationsOnce()).accepted, 1);
  assert.ok(f.sends.length > 1);
  const texts = f.sends.map((send, index) => {
    const text = (send.item_list as { text_item: { text: string } }[])[0].text_item.text;
    assert.ok(text.length <= maxChars);
    assert.equal(Buffer.from(text, "utf8").toString("utf8"), text);
    assert.equal(send.client_id, notificationClientId(f.state, item.chatId, item.id, index));
    return text;
  });
  assert.equal(texts.join(""), item.text);
  const count = f.sends.length;
  await gateway.deliverNotificationsOnce();
  assert.equal(f.sends.length, count);
});
test("failed Markdown notification is permanently uncertain without another send after restart", async t => {
  const item = goalNotification();
  item.text = "# 执行结果\n\n- **完成**：" + "验证通过🚀".repeat(200);
  const f = harness(t, { items: [item] });
  f.hooks.send = () => { throw new TypeError("response lost"); };
  const gateway = new WeChatGateway({ stateManager: f.state, controller: f.controller, ilink: f.ilink,
    notifications: true, splitMaxChars: 96, splitMultiPart: true });
  assert.deepEqual(await gateway.deliverNotificationsOnce(), { accepted: 0, uncertain: 1, skipped: 0 });
  const state = new StateManager(f.accountPath, f.statePath);
  const restarted = new WeChatGateway({ stateManager: state, controller: f.controller, ilink: f.createILink(state), notifications: true });
  await restarted.deliverNotificationsOnce();
  assert.equal(f.records.get(item.id)?.status, "uncertain");
  assert.equal(f.sends.length, 1);
  assert.equal(f.requests.filter(request => request.url.endsWith("claim")).length, 1);
});
for (const kind of ["completed", "blocked", "expired"] as const) test(`goal ${kind} is delivered unchanged to synthetic iLink exactly once`, async t => {
  const item = goalNotification(kind), f = harness(t, { items: [item] });
  assert.deepEqual(await f.gateway.deliverNotificationsOnce(), { accepted: 1, uncertain: 0, skipped: 0 });
  assert.equal(f.records.get(item.id)?.source.type, "goal");
  assert.equal(f.records.get(item.id)?.status, "accepted");
  assert.deepEqual(f.sends[0].item_list, [{ type: 1, text_item: { text: item.text } }]);
  assert.equal(f.sends[0].client_id, notificationClientId(f.state, item.chatId, item.id));
  assert.equal(f.sends[0].to_user_id, item.chatId);
  await f.gateway.deliverNotificationsOnce();
  assert.equal(f.sends.length, 1);
});
test("uncertain goal notification remains permanent across gateway restart", async t => {
  const item = goalNotification("blocked"), f = harness(t, { items: [item] });
  f.hooks.send = () => ({ ret: null });
  assert.equal((await f.gateway.deliverNotificationsOnce()).uncertain, 1);
  const state = new StateManager(f.accountPath, f.statePath);
  const restarted = new WeChatGateway({ stateManager: state, controller: f.controller, ilink: f.createILink(state), notifications: true });
  await restarted.deliverNotificationsOnce();
  assert.equal(f.records.get(item.id)?.status, "uncertain");
  assert.equal(f.sends.length, 1);
  assert.equal(f.requests.filter(request => request.url.endsWith("claim")).length, 1);
});
for (const sourceType of ["plan", "goal"] as const) test(`claim cannot change ${sourceType} source type with the same ID, kind and text`, async t => {
  const item = sourceType === "plan" ? notification() : goalNotification(), f = harness(t, { items: [item] });
  f.hooks.claim = value => ({ ...value, source: { type: sourceType === "plan" ? "goal" : "plan", id: value.id } });
  await assert.rejects(f.gateway.deliverNotificationsOnce(), /identity mismatch/);
  assert.equal(f.sends.length, 0);
  assert.equal(f.records.get(item.id)?.status, "claimed");
  await f.gateway.deliverNotificationsOnce();
  assert.equal(f.sends.length, 0);
  assert.equal(f.requests.filter(request => request.url.endsWith("claim")).length, 1);
});
test("disabled, missing prerequisites, expired budgets and stop perform no list/claim/send", async t => {
  for (const mode of ["disabled", "baseline", "context", "account", "budget", "window", "stop"]) {
    const f = harness(t, { enabled: mode !== "disabled", baseline: mode !== "baseline" });
    if (mode === "context") f.state.contextTokens = {};
    if (mode === "account") f.state.account = null;
    if (mode === "budget") f.state.contextBudgets = {};
    if (mode === "window") f.state.contextBudgets.chat.refreshedAt = Date.now() - f.state.policy.contextWindowMs;
    if (mode === "stop") f.gateway.stop();
    assert.deepEqual(await f.gateway.deliverNotificationsOnce(), { accepted: 0, uncertain: 0, skipped: 0 });
    assert.equal(f.requests.length, 0); assert.equal(f.sends.length, 0);
  }
  const f = harness(t);
  const defaultGateway = new WeChatGateway({ stateManager: f.state, controller: f.controller, ilink: f.ilink });
  assert.equal(defaultGateway.notifications, false);
  await defaultGateway.deliverNotificationsOnce(); assert.equal(f.requests.length, 0);
});
test("missing-context older records do not block reachable chat notifications", async t => {
  const f = harness(t, { items: [...Array.from({ length: 4 }, (_, index) => notification(index + 1, "unreachable")), notification(5)] });
  assert.equal((await f.gateway.deliverNotificationsOnce()).accepted, 1);
  assert.deepEqual(f.requests[0].body, { chatIds: ["chat"] });
  assert.ok(f.sends.every(send => send.to_user_id === "chat"));
  assert.equal([...f.records.values()].filter(item => item.status === "pending").length, 4);
});
test("over 128 contexts use per-chat lookups and rotate bounded cycles without starvation", async t => {
  const f = harness(t, { items: [notification(1, "chat-129")] });
  f.state.contextTokens = Object.fromEntries(Array.from({ length: 130 }, (_, index) => [`chat-${String(index).padStart(3, "0")}`, "context"]));
  for (const chatId of Object.keys(f.state.contextTokens)) f.state.recordInboundContext(`fixture:inbound:${chatId}`, chatId, Date.now() - 1000);
  assert.equal((await f.gateway.deliverNotificationsOnce()).accepted, 0);
  assert.equal((await f.gateway.deliverNotificationsOnce()).accepted, 1);
  const batches = f.requests.filter(request => request.url.endsWith("pending")).map(request => request.body.chatIds as string[]);
  assert.ok(batches.every(batch => batch.length === 1), "an unrelated queue head must never hide another chat");
  assert.deepEqual(batches.slice(0, 128).flat(), Object.keys(f.state.contextTokens).sort().slice(0, 128));
  assert.deepEqual(batches.slice(128).flat(), ["chat-128", "chat-129"]);
  assert.equal(new Set(batches.flat()).size, 130);
});
test("round robin gives each reachable chat one notification before returning to a busy chat", async t => {
  const f = harness(t, { items: [notification(1, "chat-a"), notification(2, "chat-a"), notification(3, "chat-b")] });
  f.state.contextTokens = { "chat-a": "context-a", "chat-b": "context-b" };
  for (const chatId of Object.keys(f.state.contextTokens)) f.state.recordInboundContext(`fixture:inbound:${chatId}`, chatId, Date.now() - 1000);
  for (let cycle = 0; cycle < 3; cycle++) {
    const before = f.sends.length;
    assert.equal((await f.gateway.deliverNotificationsOnce()).accepted, 1);
    assert.equal(f.sends.length - before, 1);
  }
  assert.deepEqual(f.sends.map(send => send.to_user_id), ["chat-a", "chat-b", "chat-a"]);
});
test("notification delivery is single-flight and limited to one outbox item per cycle", async t => {
  const f = harness(t, { items: Array.from({ length: 5 }, (_, index) => notification(index + 1)) });
  let release!: () => void;
  f.hooks.pending = async () => new Promise<void>(resolve => { release = resolve; });
  const first = f.gateway.deliverNotificationsOnce();
  assert.deepEqual(await f.gateway.deliverNotificationsOnce(), { accepted: 0, uncertain: 0, skipped: 0 });
  release(); await first;
  assert.equal(f.sends.length, 1);
  assert.equal(f.requests.filter(request => request.url.endsWith("pending")).length, 1);
});
test("lost claim response resumes the existing unattempted send after restart without reclaiming", async t => {
  const f = harness(t);
  f.hooks.claim = () => { throw new Error("claim response lost"); };
  await assert.rejects(f.gateway.deliverNotificationsOnce(), /lost/);
  assert.equal(f.sends.length, 0);
  assert.equal(f.requests.filter(request => request.url.endsWith("claim")).length, 1);
  const state = new StateManager(f.accountPath, f.statePath);
  const restarted = new WeChatGateway({ stateManager: state, controller: f.controller, ilink: f.createILink(state), notifications: true });
  assert.deepEqual(await restarted.deliverNotificationsOnce(), { accepted: 1, uncertain: 0, skipped: 0 });
  assert.equal(f.sends.length, 1);
  assert.equal(f.requests.filter(request => request.url.endsWith("claim")).length, 1);
  assert.equal(f.records.get(notification().id)?.status, "accepted");
  assert.ok(f.requests.some(request => request.url === `/v1/notifications/${notification().id}`));
  await restarted.deliverNotificationsOnce();
  assert.equal(f.sends.length, 1);
});
for (const mode of ["stop", "expiry", "attempt-expiry", "context", "account", "baseline", "budget"]) test(`post-claim ${mode} prevents sending and retains the appropriate evidence`, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  const f = harness(t);
  f.hooks.claim = item => {
    if (mode === "stop") f.gateway.stop();
    if (mode === "expiry") t.mock.timers.tick(86400001);
    if (mode === "attempt-expiry") t.mock.timers.tick(60001);
    if (mode === "context") delete f.state.contextTokens.chat;
    if (mode === "account") f.state.account!.accountId = "changed";
    if (mode === "baseline") f.state.baselineEstablished = false;
    if (mode === "budget") f.state.contextBudgets.chat.remaining = 0;
    return item;
  };
  const deferred = ["stop", "context", "account", "baseline", "budget"].includes(mode);
  const expired = ["expiry", "attempt-expiry"].includes(mode);
  assert.deepEqual(await f.gateway.deliverNotificationsOnce(), { accepted: 0, uncertain: 0, skipped: 1 });
  assert.equal(f.sends.length, 0);
  const record = [...f.records.values()][0];
  assert.equal(record.status, deferred ? "pending" : "claimed");
  assert.equal(f.state.outbox[`notification:${record.id}`].status, expired ? "expired" : "pending");
  assert.equal(f.requests.filter(request => request.url.endsWith("/receipt")).length, 0,
    "local cancellation or expiry before the first send must never fabricate delivery uncertainty");
  const defers = f.requests.filter(request => request.url.endsWith("/defer"));
  assert.equal(defers.length, deferred ? 1 : 0);
  if (deferred) {
    assert.equal(record.lastDeferReason, mode === "budget" ? "budget_exhausted" : "context_changed");
    assert.equal(defers[0].body.attemptId, record.lastDeferredAttemptId);
    assert.equal(record.attemptId, undefined);
  }
  if (expired) {
    const restored = new StateManager(f.accountPath, f.statePath);
    assert.equal(restored.outbox[`notification:${record.id}`].status, "expired");
    const restarted = new WeChatGateway({ stateManager: restored, controller: f.controller,
      ilink: f.createILink(restored), notifications: true });
    await restarted.deliverNotificationsOnce();
    assert.equal(f.sends.length, 0);
    assert.equal(f.requests.filter(request => request.url.endsWith("/receipt")).length, 0);
  }
});
test("post-claim exhausted budget defers durably and resumes only after new inbound context", async t => {
  const f = harness(t);
  f.hooks.claim = item => { f.state.contextBudgets.chat.remaining = 0; return item; };
  assert.equal((await f.gateway.deliverNotificationsOnce()).skipped, 1);
  assert.equal(f.sends.length, 0);
  const state = new StateManager(f.accountPath, f.statePath);
  const restarted = new WeChatGateway({ stateManager: state, controller: f.controller, ilink: f.createILink(state), notifications: true });
  await restarted.deliverNotificationsOnce();
  assert.equal(f.sends.length, 0);
  assert.equal(f.requests.filter(request => request.url.endsWith("/claim")).length, 1);
  state.recordInboundContext("fixture:new-inbound", "chat", Date.now());
  f.hooks.claim = undefined;
  assert.equal((await restarted.deliverNotificationsOnce()).accepted, 1);
  assert.equal(f.sends.length, 1);
  assert.equal(f.records.get(notification().id)?.status, "accepted");
  assert.equal(f.requests.filter(request => request.url.endsWith("/claim")).length, 2);
});
for (const field of ["chatId", "text", "kind", "createdAt", "expiresAt", "attemptId"] as const) test(`post-claim ${field} mismatch fails closed`, async t => {
  const f = harness(t);
  f.hooks.claim = item => ({ ...item, [field]: field === "kind" ? "failed" : field === "createdAt" ? item.createdAt - 1 :
    field === "expiresAt" ? item.expiresAt + 1 : field === "attemptId" ? item.id : "changed" });
  await assert.rejects(f.gateway.deliverNotificationsOnce(), /identity mismatch/);
  assert.equal(f.sends.length, 0);
});
test("an item expired or context lost after listing is never claimed", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  for (const mode of ["expired", "context", "stop"]) {
    const f = harness(t);
    f.hooks.pending = () => {
      if (mode === "expired") t.mock.timers.tick(86400001);
      if (mode === "context") delete f.state.contextTokens.chat;
      if (mode === "stop") f.gateway.stop();
    };
    assert.equal((await f.gateway.deliverNotificationsOnce()).skipped, 1);
    assert.equal(f.requests.filter(request => request.url.endsWith("claim")).length, 0);
    assert.equal(f.sends.length, 0);
  }
});
for (const response of [{ base_resp: { ret: 0 } }, { ret: null }, { ret: "0" }, { ret: 0, errcode: null }, { ret: 0, errcode: 1 }, { errcode: 0, ret: false }, []]) {
  test(`notification rejects invalid or unrecognized receipts: ${JSON.stringify(response)}`, async t => {
    const f = harness(t); f.hooks.send = () => response;
    assert.deepEqual(await f.gateway.deliverNotificationsOnce(), { accepted: 0, uncertain: 1, skipped: 0 });
    await f.gateway.deliverNotificationsOnce();
    assert.equal(f.sends.length, 1);
    assert.equal([...f.records.values()][0].status, "uncertain");
  });
}
for (const response of [{}, { message_id: "123" }, { ret: 0 }, { errcode: 0 }, { ret: 0, errcode: 0 }]) test(`notification accepts supported successful response: ${JSON.stringify(response)}`, async t => {
  const f = harness(t); f.hooks.send = () => response;
  assert.equal((await f.gateway.deliverNotificationsOnce()).accepted, 1);
});
test("ordinary replies share the empty-object success contract", async t => {
  const f = harness(t); f.hooks.send = () => ({});
  await f.ilink.sendSingleText("chat", "ordinary");
  assert.equal(f.sends.length, 1);
});
test("network send errors record uncertainty and receipt retry never resends", async t => {
  const f = harness(t); f.hooks.send = () => { throw new Error("network response lost"); };
  let receipts = 0;
  f.hooks.receipt = () => { if (++receipts < 3) throw new Error("receipt response lost"); };
  assert.equal((await f.gateway.deliverNotificationsOnce()).uncertain, 1);
  assert.equal(f.sends.length, 1); assert.equal(receipts, 3);
  const bodies = f.requests.filter(request => request.url.endsWith("receipt")).map(request => JSON.stringify(request.body));
  assert.equal(new Set(bodies).size, 1);
});
for (const [error, errorType] of [
  [new TypeError("private network token/context/text/chatId"), "NetworkError"],
  [new Error("private timeout token/context/text/chatId"), "TimeoutError"],
  [new Error("WeChat sendmessage failed: private token/context/text/chatId"), "ILinkSendMessageError"],
] as const) test(`notification failure diagnostic is sanitized and follows permanent receipt: ${errorType}`, async t => {
  const f = harness(t), diagnostics: string[] = [], item = notification();
  f.hooks.send = () => { throw error; };
  t.mock.method(nodeFs, "writeSync", (fd: number, chunk: string) => {
    assert.equal(fd, 2);
    assert.equal(f.records.get(item.id)?.status, "uncertain", "persist receipt before diagnostics");
    diagnostics.push(String(chunk));
    return Buffer.byteLength(chunk);
  });
  assert.deepEqual(await f.gateway.deliverNotificationsOnce(), { accepted: 0, uncertain: 1, skipped: 0 });
  assert.equal(diagnostics.length, 1);
  assert.deepEqual(JSON.parse(diagnostics[0]), { event: "notification_send_failed", notificationId: item.id,
    attemptId: f.records.get(item.id)!.attemptId, errorType });
  for (const privateValue of [error.message, error.stack!, item.text, "synthetic", "synthetic-context", '"chat"']) {
    assert.ok(!diagnostics[0].includes(privateValue));
  }
  await f.gateway.deliverNotificationsOnce();
  assert.equal(f.sends.length, 1); assert.equal(diagnostics.length, 1);
});
test("notification diagnostic write failure keeps uncertainty permanent and never resends", async t => {
  const f = harness(t);
  f.hooks.send = () => { throw new TypeError("private send failure"); };
  t.mock.method(nodeFs, "writeSync", () => { throw new Error("private diagnostic sink failure"); });
  await assert.rejects(f.gateway.deliverNotificationsOnce(), { message: "Notification diagnostic write failed" });
  assert.equal([...f.records.values()][0].status, "uncertain");
  await f.gateway.deliverNotificationsOnce();
  assert.equal(f.sends.length, 1);
});
test("a short diagnostic write stops the run loop without its stderr error callback or another send", async t => {
  const f = harness(t);
  f.hooks.send = () => { throw new TypeError("private send failure"); };
  t.mock.method(nodeFs, "writeSync", () => 1);
  const callback = () => { assert.fail("do not write to the failed diagnostic sink again"); };
  await assert.rejects(f.gateway.runLoop(0, callback, callback), { message: "Notification diagnostic write failed" });
  assert.equal([...f.records.values()][0].status, "uncertain");
  await f.gateway.runLoop(0, callback, callback);
  assert.equal(f.requests.filter(request => request.url.endsWith("pending")).length, 1);
  assert.equal(f.sends.length, 1);
});
test("closed real stderr pipe exits CLI with code 2 after uncertainty, without replay on restart", { timeout: 10_000 }, async t => {
  const f = harness(t), healthPath = path.join(path.dirname(f.statePath), "health.json");
  f.state.saveState();
  const moduleUrl = new URL("../../src/cli/run.js", import.meta.url).href;
  const args = ["--run", "--notifications", "--credentials-path", f.accountPath, "--state-path", f.statePath,
    "--health-path", healthPath];
  const source = `
    import { runCli } from ${JSON.stringify(moduleUrl)};
    import fs from "node:fs";
    const old = ${JSON.stringify(notification())};
    let item = { id: old.id, key: old.id, source: old.source, chatId: old.chatId, kind: old.kind,
      status: "ready", mode: "text", messages: [old.text], createdAt: old.createdAt, expiresAt: old.expiresAt,
      retainedUntil: old.expiresAt, artifact: { id: old.id, chatId: old.chatId, name: "result.md", size: 1,
        sha256: "a".repeat(64), expiresAt: old.expiresAt } }, sends = 0, polls = 0, restarting = false;
    const json = value => new Response(JSON.stringify(value));
    globalThis.fetch = async (url, init) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname.endsWith("getupdates")) {
        polls++;
        if (restarting) process.emit("SIGTERM");
        return json({ ret: 0, msgs: [], get_updates_buf: "original-cursor" });
      }
      if (pathname.endsWith("sendmessage")) { sends++; throw new TypeError("private token/context/text/chatId"); }
      if (pathname === "/v1/chats/notification-interest") return json({ chatIds: [item.chatId], interested: [] });
      const body = JSON.parse(init.body || "{}");
      if (pathname.endsWith("pending")) return json({ items: item.status === "ready" ? [item] : [] });
      if (pathname.endsWith("claim")) {
        const attemptedAt = Date.now();
        item = { ...item, status: "claimed", attemptId: body.attemptId, attemptedAt, attemptExpiresAt: attemptedAt + 60000 };
        return json({ delivery: item });
      }
      if (pathname.endsWith("materialize")) return json({ delivery: { ...item,
        artifact: { ...item.artifact, downloadUrl: "http://127.0.0.1:8790/v1/result-artifacts/" + item.id + "/download?expires=" + item.expiresAt + "&signature=" + "b".repeat(64) } } });
      if (pathname.endsWith("receipt")) { item = { ...item, status: body.status }; return json({ delivery: item }); }
      if (pathname === "/v1/deliveries/" + item.id) return json({ delivery: item });
      throw new Error("unexpected fixture request");
    };
    await new Promise(resolve => process.stdin.once("data", resolve));
    const code = await runCli(${JSON.stringify(args)}, { CONTROLLER_URL: "http://127.0.0.1:8790", CONTROLLER_TOKEN: "synthetic" });
    const stopped = JSON.parse(fs.readFileSync(${JSON.stringify(healthPath)}, "utf8")).status;
    process.stdout.write(JSON.stringify({ code, sends, polls, status: item.status, stopped }) + "\\n");
    restarting = true;
    const restartCode = await runCli(${JSON.stringify(args)}, { CONTROLLER_URL: "http://127.0.0.1:8790", CONTROLLER_TOKEN: "synthetic" });
    process.stdout.write(JSON.stringify({ restartCode, sends, polls, status: item.status }) + "\\n");
    process.exitCode = code;
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => { output += chunk; });
  child.stderr.once("close", () => { child.stdin.end("go\n"); });
  child.stderr.destroy();
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(result, { code: NOTIFICATION_DIAGNOSTIC_EXIT_CODE, signal: null }, output);
  const lines = output.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.deepEqual({ ...lines[0], polls: undefined },
    { code: NOTIFICATION_DIAGNOSTIC_EXIT_CODE, sends: 1, polls: undefined, status: "uncertain", stopped: "stopped" });
  assert.deepEqual({ ...lines[1], polls: undefined }, { restartCode: 0, sends: 1, polls: undefined, status: "uncertain" });
  assert.ok(lines[1].polls > lines[0].polls);
});
test("failed notification receipt persistence does not emit a persisted-failure diagnostic or resend", async t => {
  const f = harness(t), diagnostics: string[] = [];
  f.hooks.send = () => { throw new TypeError("private send failure"); };
  f.hooks.receipt = () => { throw new Error("receipt unavailable"); };
  t.mock.method(nodeFs, "writeSync", (_fd: number, chunk: string) => { diagnostics.push(chunk); return Buffer.byteLength(chunk); });
  await assert.rejects(f.gateway.deliverNotificationsOnce(), /receipt unavailable/);
  assert.equal([...f.records.values()][0].status, "claimed");
  assert.equal(diagnostics.length, 0);
  await assert.rejects(f.gateway.deliverNotificationsOnce(), /receipt unavailable/);
  f.hooks.receipt = undefined;
  assert.equal((await f.gateway.deliverNotificationsOnce()).uncertain, 1);
  assert.equal([...f.records.values()][0].status, "uncertain");
  assert.equal(diagnostics.length, 0);
  assert.equal(f.sends.length, 1);
});
test("run loop reports a sanitized send failure even without consuming the delivery summary", async t => {
  const f = harness(t), diagnostics: string[] = [], cycleErrors: Error[] = [];
  f.hooks.send = () => { throw new TypeError("private token/context/text/chatId"); };
  f.hooks.receipt = () => { f.gateway.stop(); };
  t.mock.method(nodeFs, "writeSync", (_fd: number, chunk: string) => { diagnostics.push(chunk); return Buffer.byteLength(chunk); });
  await f.gateway.runLoop(0, error => cycleErrors.push(error), error => cycleErrors.push(error));
  assert.equal(cycleErrors.length, 0);
  const events = diagnostics.map(line => JSON.parse(line));
  const telemetry = events.filter(event => event.event === "message_latency");
  assert.ok(telemetry.length > 0);
  assert.ok(telemetry.every(event => event.schema === 1 && event.service === "gateway" && typeof event.stage === "string"));
  const failures = events.filter(event => event.event !== "message_latency");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].errorType, "NetworkError");
  assert.ok(!diagnostics.join("").includes("private token/context/text/chatId"));
  assert.equal([...f.records.values()][0].status, "uncertain");
  assert.equal(f.sends.length, 1);
});
test("accepted send with exhausted receipt retries leaves claim queryable, never sends again", async t => {
  const f = harness(t); f.hooks.receipt = () => { throw new Error("receipt unavailable"); };
  await assert.rejects(f.gateway.deliverNotificationsOnce(), /unavailable/);
  assert.equal(f.sends.length, 1);
  assert.equal([...f.records.values()][0].status, "claimed");
  await assert.rejects(f.gateway.deliverNotificationsOnce(), /unavailable/);
  f.hooks.receipt = undefined;
  assert.equal((await f.gateway.deliverNotificationsOnce()).accepted, 1);
  assert.equal([...f.records.values()][0].status, "accepted");
  assert.equal(f.sends.length, 1);
});
test("ordinary reply recovery failure still delivers pending notifications and preserves the original error", async t => {
  const f = harness(t), replyError = new Error("ordinary stale reply recovery failed");
  t.mock.method(f.gateway, "flushRepliesOnce", async () => { throw replyError; });
  await assert.rejects(f.gateway.deliverNotificationsOnce(), error => {
    assert.equal(error, replyError);
    return true;
  });
  assert.equal(f.records.get(notification().id)?.status, "accepted");
  assert.equal(f.sends.length, 1);
});
test("run loop starts notification work alongside inbound polling and isolates notification errors", async t => {
  const f = harness(t); const order: string[] = [], errors: Error[] = [];
  f.hooks.pending = () => { order.push("notification"); throw new Error("list unavailable"); };
  f.hooks.poll = () => { order.push("poll"); };
  await f.gateway.runLoop(0, () => { assert.fail("inbound poll should succeed"); }, error => { errors.push(error); f.gateway.stop(); });
  assert.ok(order.includes("notification")); assert.ok(order.includes("poll")); assert.equal(errors.length, 1);
  assert.equal(f.state.syncBuf, "new-cursor");
});
test("stop remains terminal when runLoop is called after stopping", async t => {
  const f = harness(t); f.gateway.stop();
  await f.gateway.runLoop(0);
  assert.equal(f.requests.length, 0); assert.equal(f.sends.length, 0);
});
test("notification work does not create a processing phase or hide stale inbound health", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  const f = harness(t);
  const healthPath = path.join(path.dirname(f.statePath), "health.json");
  const health = new HealthTracker(healthPath); health.startRun(); health.recordPollSuccess();
  const before = JSON.parse(fs.readFileSync(healthPath, "utf8"));
  const gateway = new WeChatGateway({ stateManager: f.state, controller: f.controller, ilink: f.ilink, notifications: true, healthTracker: health });
  let release!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  f.hooks.pending = async () => new Promise<void>(resolve => { release = resolve; markStarted(); });
  const pending = gateway.deliverNotificationsOnce();
  await started;
  t.mock.timers.tick(120001);
  assert.equal(checkGatewayHealth(healthPath).ok, false);
  const during = JSON.parse(fs.readFileSync(healthPath, "utf8"));
  assert.equal(during.last_poll_succeeded_at, before.last_poll_succeeded_at);
  assert.equal(during.processed_message_count, 0);
  assert.equal(during.phase, null);
  release(); await pending;
  const after = JSON.parse(fs.readFileSync(healthPath, "utf8"));
  assert.equal(after.phase, null);
  assert.equal(after.last_poll_succeeded_at, before.last_poll_succeeded_at);
  assert.equal(after.processed_message_count, 0);
});
test("notification cleanup does not erase a concurrent inbound polling health phase", async t => {
  const f = harness(t);
  const healthPath = path.join(path.dirname(f.statePath), "health.json");
  const health = new HealthTracker(healthPath); health.startRun();
  const gateway = new WeChatGateway({ stateManager: f.state, controller: f.controller, ilink: f.ilink, notifications: true, healthTracker: health });
  let release!: () => void;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  f.hooks.pending = async () => new Promise<void>(resolve => { release = resolve; markStarted(); });
  const pending = gateway.deliverNotificationsOnce();
  await started;
  health.recordPollStart();
  const phase = JSON.parse(fs.readFileSync(healthPath, "utf8")).phase;
  release(); await pending;
  assert.deepEqual(JSON.parse(fs.readFileSync(healthPath, "utf8")).phase, phase);
});

test("stop after the first notification chunk cancels the remaining chunks and records uncertainty", async t => {
  const item = notification();
  item.text = "# 结果\n" + "完整输出🚀\n".repeat(30);
  const f = harness(t, { items: [item] });
  const gateway = new WeChatGateway({ stateManager: f.state, controller: f.controller, ilink: f.ilink,
    notifications: true, splitMaxChars: 32 });
  f.hooks.send = () => { gateway.stop(); return { ret: 0 }; };
  assert.deepEqual(await gateway.deliverNotificationsOnce(), { accepted: 0, uncertain: 1, skipped: 0 });
  assert.equal(f.sends.length, 1);
  assert.equal(f.records.get(item.id)?.status, "uncertain");
  const restartedState = new StateManager(f.accountPath, f.statePath);
  const restarted = new WeChatGateway({ stateManager: restartedState, controller: f.controller, ilink: f.createILink(restartedState),
    notifications: true, splitMaxChars: 32 });
  await restarted.deliverNotificationsOnce();
  assert.equal(f.sends.length, 1);
});

test("blocked notification work does not prevent inbound polling or replace its health phase", async t => {
  const f = harness(t);
  const healthPath = path.join(path.dirname(f.statePath), "health.json");
  const health = new HealthTracker(healthPath); health.startRun();
  const gateway = new WeChatGateway({ stateManager: f.state, controller: f.controller, ilink: f.ilink,
    notifications: true, healthTracker: health });
  let release!: () => void;
  let notificationStarted = false;
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  f.hooks.pending = () => new Promise<void>(resolve => { notificationStarted = true; release = resolve; markStarted(); });
  let polls = 0;
  f.hooks.poll = async () => {
    await started;
    polls++;
    assert.equal(notificationStarted, true);
    assert.equal(JSON.parse(fs.readFileSync(healthPath, "utf8")).phase.name, "polling");
    gateway.stop();
    release();
  };
  await gateway.runLoop(0);
  assert.equal(polls, 1);
  assert.equal(f.sends.length, 0);
  assert.equal(f.records.get(notification().id)?.status, "pending");
});
test("CLI poll-once processes notifications only after a successful inbound cycle", async t => {
  const f = harness(t);
  f.state.saveState();
  const original = globalThis.fetch, calls: string[] = [];
  let failPoll = false;
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    calls.push(path);
    if (path.endsWith("getupdates")) {
      if (failPoll) throw new Error("inbound failed");
      return new Response(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: "new-cursor" }));
    }
    if (path === "/v1/chats/notification-interest") return new Response(JSON.stringify({ chatIds: ["chat"], interested: [] }));
    assert.equal(path, "/v1/deliveries/pending");
    assert.deepEqual(JSON.parse(init?.body as string), { chatIds: ["chat"] });
    return new Response(JSON.stringify({ items: [] }));
  };
  t.after(() => { globalThis.fetch = original; });
  const args = ["--poll-once", "--notifications", "--credentials-path", f.accountPath, "--state-path", f.statePath];
  assert.equal(await runCli(args, { CONTROLLER_TOKEN: "synthetic" }), 0);
  assert.deepEqual(calls, ["/ilink/bot/getupdates", "/v1/chats/notification-interest", "/v1/deliveries/pending"]);
  calls.length = 0; failPoll = true;
  await assert.rejects(runCli(args, { CONTROLLER_TOKEN: "synthetic" }), /inbound failed/);
  assert.deepEqual(calls, ["/ilink/bot/getupdates"]);
});
test("CLI notification opt-in is explicit and check/healthcheck/baseline never list or send", async t => {
  assert.equal(parseGatewayCli([], {}).notifications, false);
  assert.equal(parseGatewayCli(["--notifications"], {}).notifications, true);
  assert.equal(parseGatewayCli([], { GATEWAY_NOTIFICATIONS: "true" }).notifications, true);
  assert.equal(parseGatewayCli([], { GATEWAY_NOTIFICATIONS: "1" }).notifications, false);
  assert.equal(parseGatewayCli([], { GATEWAY_PLAN_NOTIFICATIONS: "true" }).notifications, false);
  assert.throws(() => parseGatewayCli(["--plan-notifications"], {}), /Unknown option/);
  const f = harness(t, { baseline: false });
  const original = globalThis.fetch;
  let polls = 0;
  globalThis.fetch = async url => {
    assert.ok(String(url).endsWith("getupdates"), "readonly/baseline modes must not request notifications");
    polls++; return new Response(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: "baseline" }));
  };
  t.after(() => { globalThis.fetch = original; });
  const args = ["--notifications", "--credentials-path", f.accountPath, "--state-path", f.statePath];
  assert.equal(await runCli(["--check", ...args], { CONTROLLER_TOKEN: "synthetic" }), 0);
  await runCli(["--healthcheck", ...args], {});
  assert.equal(await runCli(["--establish-baseline", ...args], { CONTROLLER_TOKEN: "synthetic" }), 0);
  assert.equal(polls, 1);
});
