import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../src/state.js";
import { WeChatGateway } from "../src/gateway.js";
import { parseGatewayCli, runCli } from "../src/index.js";
import { HealthTracker, checkGatewayHealth } from "../src/health.js";
import { harness, notification } from "./notification-fixtures.js";

test("terminal notification is one plain-text send with deterministic evidence ID and no state reset", async t => {
  const f = harness(t);
  f.state.commitCursor("original-cursor"); f.state.recordProcessedMessageKey("old-key");
  const before = fs.readFileSync(f.statePath, "utf8");
  assert.deepEqual(await f.gateway.deliverNotificationsOnce(), { accepted: 1, uncertain: 0, skipped: 0 });
  const item = notification();
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].client_id, `super-leader:notification:${item.id}`);
  assert.equal(f.sends[0].to_user_id, "chat");
  assert.equal(f.sends[0].context_token, "synthetic-context");
  assert.deepEqual(f.sends[0].item_list, [{ type: 1, text_item: { text: item.text } }]);
  assert.equal(fs.readFileSync(f.statePath, "utf8"), before);
  assert.equal(f.records.get(item.id)?.status, "accepted");
  assert.deepEqual(await f.gateway.deliverNotificationsOnce(), { accepted: 0, uncertain: 0, skipped: 0 });
  assert.equal(f.sends.length, 1);
});
test("default disabled, missing baseline/context/account and stop perform no list/claim/send", async t => {
  for (const mode of ["disabled", "baseline", "context", "account", "stop"]) {
    const f = harness(t, { enabled: mode !== "disabled", baseline: mode !== "baseline" });
    if (mode === "context") f.state.contextTokens = {};
    if (mode === "account") f.state.account = null;
    if (mode === "stop") f.gateway.stop();
    assert.deepEqual(await f.gateway.deliverNotificationsOnce(), { accepted: 0, uncertain: 0, skipped: 0 });
    assert.equal(f.requests.length, 0); assert.equal(f.sends.length, 0);
  }
  const f = harness(t);
  const defaultGateway = new WeChatGateway({ stateManager: f.state, controller: f.controller, ilink: f.ilink });
  assert.equal(defaultGateway.planNotifications, false);
  await defaultGateway.deliverNotificationsOnce(); assert.equal(f.requests.length, 0);
});
test("missing-context older records do not block reachable chat notifications", async t => {
  const f = harness(t, { items: [...Array.from({ length: 4 }, (_, index) => notification(index + 1, "unreachable")), notification(5)] });
  assert.equal((await f.gateway.deliverNotificationsOnce()).accepted, 1);
  assert.deepEqual(f.requests[0].body, { chatIds: ["chat"] });
  assert.ok(f.sends.every(send => send.to_user_id === "chat"));
  assert.equal([...f.records.values()].filter(item => item.status === "pending").length, 4);
});
test("over 128 contexts rotate sorted bounded chat batches without permanent starvation", async t => {
  const f = harness(t, { items: [notification(1, "chat-129")] });
  f.state.contextTokens = Object.fromEntries(Array.from({ length: 130 }, (_, index) => [`chat-${String(index).padStart(3, "0")}`, "context"]));
  assert.equal((await f.gateway.deliverNotificationsOnce()).accepted, 0);
  assert.equal((await f.gateway.deliverNotificationsOnce()).accepted, 1);
  const batches = f.requests.filter(request => request.url.endsWith("pending")).map(request => request.body.chatIds as string[]);
  assert.equal(batches[0].length, 128); assert.equal(batches[1].length, 128);
  assert.deepEqual(batches[0], Object.keys(f.state.contextTokens).sort().slice(0, 128));
  assert.deepEqual(batches[1].slice(0, 2), ["chat-128", "chat-129"]);
  assert.equal(new Set(batches.flat()).size, 130);
});
test("notification delivery is single-flight and limited to four sends per cycle", async t => {
  const f = harness(t, { items: Array.from({ length: 5 }, (_, index) => notification(index + 1)) });
  let release!: () => void;
  f.hooks.pending = async () => new Promise<void>(resolve => { release = resolve; });
  const first = f.gateway.deliverNotificationsOnce();
  assert.deepEqual(await f.gateway.deliverNotificationsOnce(), { accepted: 0, uncertain: 0, skipped: 0 });
  release(); await first;
  assert.equal(f.sends.length, 4);
  assert.equal(f.requests.filter(request => request.url.endsWith("pending")).length, 1);
});
test("lost claim receipt is not retried, sent, or replayed after restart", async t => {
  const f = harness(t);
  f.hooks.claim = () => { throw new Error("claim response lost"); };
  await assert.rejects(f.gateway.deliverNotificationsOnce(), /lost/);
  assert.equal(f.sends.length, 0);
  assert.equal(f.requests.filter(request => request.url.endsWith("claim")).length, 1);
  const state = new StateManager(f.accountPath, f.statePath);
  const restarted = new WeChatGateway({ stateManager: state, controller: f.controller, ilink: f.ilink, planNotifications: true });
  await restarted.deliverNotificationsOnce();
  assert.equal(f.sends.length, 0);
  assert.equal(f.requests.filter(request => request.url.endsWith("claim")).length, 1);
});
for (const mode of ["stop", "expiry", "attempt-expiry", "context", "account", "baseline"]) test(`post-claim ${mode} prevents sending and records uncertainty`, async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  const f = harness(t);
  f.hooks.claim = item => {
    if (mode === "stop") f.gateway.stop();
    if (mode === "expiry") t.mock.timers.tick(86400001);
    if (mode === "attempt-expiry") t.mock.timers.tick(60001);
    if (mode === "context") delete f.state.contextTokens.chat;
    if (mode === "account") f.state.account!.accountId = "changed";
    if (mode === "baseline") f.state.baselineEstablished = false;
    return item;
  };
  assert.deepEqual(await f.gateway.deliverNotificationsOnce(), { accepted: 0, uncertain: 0, skipped: 1 });
  assert.equal(f.sends.length, 0);
  assert.equal([...f.records.values()][0].status, "uncertain");
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
for (const response of [{}, { ret: null }, { ret: "0" }, { ret: 0, errcode: null }, { ret: 0, errcode: 1 }, { errcode: 0, ret: false }, []]) {
  test(`notification sends require explicit zero codes: ${JSON.stringify(response)}`, async t => {
    const f = harness(t); f.hooks.send = () => response;
    assert.deepEqual(await f.gateway.deliverNotificationsOnce(), { accepted: 0, uncertain: 1, skipped: 0 });
    await f.gateway.deliverNotificationsOnce();
    assert.equal(f.sends.length, 1);
    assert.equal([...f.records.values()][0].status, "uncertain");
  });
}
for (const response of [{ ret: 0 }, { errcode: 0 }, { ret: 0, errcode: 0 }]) test(`notification accepts explicit successful receipt: ${JSON.stringify(response)}`, async t => {
  const f = harness(t); f.hooks.send = () => response;
  assert.equal((await f.gateway.deliverNotificationsOnce()).accepted, 1);
});
test("ordinary replies preserve existing empty response behavior", async t => {
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
test("accepted send with exhausted receipt retries leaves claim queryable, never sends again", async t => {
  const f = harness(t); f.hooks.receipt = () => { throw new Error("receipt unavailable"); };
  await assert.rejects(f.gateway.deliverNotificationsOnce(), /unavailable/);
  assert.equal(f.sends.length, 1);
  assert.equal([...f.records.values()][0].status, "claimed");
  await f.gateway.deliverNotificationsOnce(); assert.equal(f.sends.length, 1);
});
test("run loop checks notifications before inbound poll and isolates notification errors", async t => {
  const f = harness(t); const order: string[] = [], errors: Error[] = [];
  f.hooks.pending = () => { order.push("notification"); throw new Error("list unavailable"); };
  f.hooks.poll = () => { order.push("poll"); f.gateway.stop(); };
  await f.gateway.runLoop(0, () => { assert.fail("inbound poll should succeed"); }, error => errors.push(error));
  assert.deepEqual(order, ["notification", "poll"]); assert.equal(errors.length, 1);
  assert.equal(f.state.syncBuf, "new-cursor");
});
test("stop remains terminal when runLoop is called after stopping", async t => {
  const f = harness(t); f.gateway.stop();
  await f.gateway.runLoop(0);
  assert.equal(f.requests.length, 0); assert.equal(f.sends.length, 0);
});
test("notification processing has a finite healthy phase without fabricating inbound success or counts", async t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  const f = harness(t);
  const healthPath = path.join(path.dirname(f.statePath), "health.json");
  const health = new HealthTracker(healthPath); health.startRun(); health.recordPollSuccess();
  const before = JSON.parse(fs.readFileSync(healthPath, "utf8"));
  const gateway = new WeChatGateway({ stateManager: f.state, controller: f.controller, ilink: f.ilink, planNotifications: true, healthTracker: health });
  let release!: () => void;
  f.hooks.pending = async () => new Promise<void>(resolve => { release = resolve; });
  const pending = gateway.deliverNotificationsOnce();
  t.mock.timers.tick(120001);
  assert.equal(checkGatewayHealth(healthPath).ok, true);
  assert.equal(checkGatewayHealth(healthPath).status, "processing");
  const during = JSON.parse(fs.readFileSync(healthPath, "utf8"));
  assert.equal(during.last_poll_succeeded_at, before.last_poll_succeeded_at);
  assert.equal(during.processed_message_count, 0);
  assert.equal(Date.parse(during.phase.deadline_at) - Date.parse(during.phase.started_at), 235000);
  t.mock.timers.tick(115000);
  assert.equal(checkGatewayHealth(healthPath).ok, false);
  assert.equal(checkGatewayHealth(healthPath).reason, "ProcessingDeadlineExceeded");
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
  const gateway = new WeChatGateway({ stateManager: f.state, controller: f.controller, ilink: f.ilink, planNotifications: true, healthTracker: health });
  let release!: () => void;
  f.hooks.pending = async () => new Promise<void>(resolve => { release = resolve; });
  const pending = gateway.deliverNotificationsOnce();
  health.recordPollStart();
  const phase = JSON.parse(fs.readFileSync(healthPath, "utf8")).phase;
  release(); await pending;
  assert.deepEqual(JSON.parse(fs.readFileSync(healthPath, "utf8")).phase, phase);
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
    assert.equal(path, "/v1/notifications/pending");
    assert.deepEqual(JSON.parse(init?.body as string), { chatIds: ["chat"] });
    return new Response(JSON.stringify({ items: [] }));
  };
  t.after(() => { globalThis.fetch = original; });
  const args = ["--poll-once", "--plan-notifications", "--credentials-path", f.accountPath, "--state-path", f.statePath];
  assert.equal(await runCli(args, { CONTROLLER_TOKEN: "synthetic" }), 0);
  assert.deepEqual(calls, ["/ilink/bot/getupdates", "/v1/notifications/pending"]);
  calls.length = 0; failPoll = true;
  await assert.rejects(runCli(args, { CONTROLLER_TOKEN: "synthetic" }), /inbound failed/);
  assert.deepEqual(calls, ["/ilink/bot/getupdates"]);
});
test("CLI notification opt-in is explicit and check/healthcheck/baseline never list or send", async t => {
  assert.equal(parseGatewayCli([], {}).planNotifications, false);
  assert.equal(parseGatewayCli(["--plan-notifications"], {}).planNotifications, true);
  assert.equal(parseGatewayCli([], { GATEWAY_PLAN_NOTIFICATIONS: "true" }).planNotifications, true);
  assert.equal(parseGatewayCli([], { GATEWAY_PLAN_NOTIFICATIONS: "1" }).planNotifications, false);
  const f = harness(t, { baseline: false });
  const original = globalThis.fetch;
  let polls = 0;
  globalThis.fetch = async url => {
    assert.ok(String(url).endsWith("getupdates"), "readonly/baseline modes must not request notifications");
    polls++; return new Response(JSON.stringify({ ret: 0, msgs: [], get_updates_buf: "baseline" }));
  };
  t.after(() => { globalThis.fetch = original; });
  const args = ["--plan-notifications", "--credentials-path", f.accountPath, "--state-path", f.statePath];
  assert.equal(await runCli(["--check", ...args], { CONTROLLER_TOKEN: "synthetic" }), 0);
  await runCli(["--healthcheck", ...args], {});
  assert.equal(await runCli(["--establish-baseline", ...args], { CONTROLLER_TOKEN: "synthetic" }), 0);
  assert.equal(polls, 1);
});
