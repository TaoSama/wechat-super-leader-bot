import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../../src/runtime/state.js";
import { HealthTracker, checkGatewayHealth } from "../../src/runtime/health.js";
import { ILinkClient } from "../../src/wechat/client.js";
import { ControllerClient } from "../../src/controller/client.js";
import { WeChatGateway } from "../../src/gateway.js";
import { MAX_PROCESSING_PHASE_MS, REPLY_TIMEOUT_MS } from "../../src/runtime/budgets.js";

const json = (value: unknown) => new Response(JSON.stringify(value));
function fixture(t: { after: (fn: () => void) => void }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-lifecycle-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const account = path.join(directory, "account.json");
  const statePath = path.join(directory, "state.json");
  const healthPath = path.join(directory, "health.json");
  fs.writeFileSync(account, JSON.stringify({ token: "synthetic", accountId: "fixture" }));
  const state = new StateManager(account, statePath);
  state.beginBaseline(); state.markBaselineEstablished(); state.commitCursor("old-cursor");
  const health = new HealthTracker(healthPath); health.startRun();
  return { directory, account, statePath, healthPath, state, health };
}

test("processing remains healthy through a 35s poll plus 90s model, then expires without fake successes", t => {
  t.mock.timers.enable({ apis: ["Date"], now: 1800000000000 });
  const f = fixture(t);
  f.health.recordPollSuccess();
  const lastSuccess = JSON.parse(fs.readFileSync(f.healthPath, "utf8")).last_poll_succeeded_at;
  f.health.recordPollStart();
  t.mock.timers.tick(35000);
  f.health.recordMessageStart(MAX_PROCESSING_PHASE_MS);
  t.mock.timers.tick(90000);
  assert.equal(checkGatewayHealth(f.healthPath).ok, true);
  assert.equal(checkGatewayHealth(f.healthPath).status, "processing");
  assert.equal(JSON.parse(fs.readFileSync(f.healthPath, "utf8")).last_poll_succeeded_at, lastSuccess);
  t.mock.timers.tick(MAX_PROCESSING_PHASE_MS - 90000 + 1);
  assert.equal(checkGatewayHealth(f.healthPath).ok, false);
  assert.equal(checkGatewayHealth(f.healthPath).reason, "ProcessingDeadlineExceeded");
  f.health.startRun();
  const refreshed = JSON.parse(fs.readFileSync(f.healthPath, "utf8"));
  assert.equal(refreshed.phase, null);
  assert.equal(refreshed.last_poll_succeeded_at, null);
  assert.equal(refreshed.processed_message_count, 0);
});

test("stop completes one message and durable key, preserves cursor, then restart deduplicates and resumes", async t => {
  const f = fixture(t);
  let gateway!: WeChatGateway;
  const forwarded: string[] = [];
  const sent: string[] = [];
  const batch = { ret: 0, get_updates_buf: "new-cursor", msgs: ["first", "second"].map(id => ({
    create_time_ms: Date.now() - 1000,
    message_type: 1, from_user_id: "user", client_id: id, context_token: "synthetic-context",
    item_list: [{ type: 1, text_item: { text: id } }],
  })) };
  const ilinkFetch: typeof fetch = async (url, init) => {
    if (String(url).endsWith("getupdates")) return json(batch);
    if (String(url).endsWith("getconfig")) return json({ ret: 0, typing_ticket: "ticket" });
    if (String(url).endsWith("sendtyping")) return json({ ret: 0 });
    sent.push(JSON.parse(init?.body as string).msg.client_id);
    return json({ ret: 0 });
  };
  const controller = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic",
    fetchImpl: async (url, init) => {
      if (String(url).endsWith("/v1/chats/authorize")) return json({ allowed: true });
      forwarded.push(JSON.parse(init?.body as string).messageId);
      gateway.stop();
      return json({ text: "reply" });
    } });
  gateway = new WeChatGateway({ stateManager: f.state, ilink: new ILinkClient({ stateManager: f.state, fetchImpl: ilinkFetch }), controller, healthTracker: f.health });
  const stopped = await gateway.pollOnce();
  assert.equal(stopped.interrupted, true);
  assert.equal(stopped.processedCount, 1);
  assert.equal(stopped.nextSyncBuf, "old-cursor");
  assert.deepEqual(forwarded, ["first"]);
  assert.equal(sent.length, 0);
  assert.equal(Object.values(f.state.outbox)[0]?.status, "pending");
  const oldCheckpoint = JSON.parse(fs.readFileSync(f.statePath, "utf8"));
  assert.equal(oldCheckpoint.sync_buf, "old-cursor");
  assert.equal(oldCheckpoint.processed_message_keys.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(f.healthPath, "utf8")).last_poll_succeeded_at, null);
  const resumedState = new StateManager(f.account, f.statePath);
  const resumed = new WeChatGateway({ stateManager: resumedState,
    ilink: new ILinkClient({ stateManager: resumedState, fetchImpl: ilinkFetch }),
    controller: new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic",
      fetchImpl: async (url, init) => {
        if (String(url).endsWith("/v1/chats/authorize")) return json({ allowed: true });
        if (init?.method === "GET") return json({ text: "reply" });
        forwarded.push(JSON.parse(init?.body as string).messageId); return json({ text: "reply" });
      } }),
    healthTracker: f.health });
  assert.equal((await resumed.pollOnce()).processedCount, 1);
  assert.deepEqual(forwarded, ["first", "second"]);
  assert.equal(sent.length, 2);
  assert.equal(resumedState.syncBuf, "new-cursor");
  assert.equal(JSON.parse(fs.readFileSync(f.healthPath, "utf8")).processed_message_count, 2);
});

test("stop during getupdates starts no Controller message and does not checkpoint an unprocessed page", async t => {
  const f = fixture(t);
  let gateway!: WeChatGateway;
  let forwarded = 0;
  const ilink = new ILinkClient({ stateManager: f.state, fetchImpl: async () => {
    gateway.stop();
    return json({ get_updates_buf: "unprocessed-cursor", msgs: [{ message_type: 1, from_user_id: "user", client_id: "id",
      item_list: [{ type: 1, text_item: { text: "message" } }] }] });
  } });
  const controller = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic",
    fetchImpl: async () => { forwarded++; return json({ text: "reply" }); } });
  gateway = new WeChatGateway({ stateManager: f.state, ilink, controller, healthTracker: f.health });
  assert.equal((await gateway.pollOnce()).interrupted, true);
  assert.equal(forwarded, 0);
  assert.equal(f.state.syncBuf, "old-cursor");
});

test("multipart sending has a finite 60s budget and persists only completed chunks", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1800000000000 });
  const f = fixture(t);
  f.state.setContextToken("user", "synthetic-context");
  f.state.recordInboundContext("new-inbound", "user", Date.now() - 1000);
  let requests = 0;
  const ilink = new ILinkClient({ stateManager: f.state, fetchImpl: async (url, init) => {
    if (String(url).endsWith("getconfig")) return json({ ret: 0, typing_ticket: "ticket" });
    if (String(url).endsWith("sendtyping")) return json({ ret: 0 });
    requests++;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 14000);
      init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
    });
    return json({ ret: 0 });
  } });
  const pending = ilink.sendMarkdownReply("user", "abcdefghij", { maxCharsPerChunk: 1, deliveryKey: "delivery" });
  const rejected = assert.rejects(pending, /timed out/);
  for (let step = 0; step < 32; step++) await Promise.resolve();
  for (let chunk = 0; chunk < 4; chunk++) {
    t.mock.timers.tick(14000);
    for (let step = 0; step < 32; step++) await Promise.resolve();
  }
  t.mock.timers.tick(REPLY_TIMEOUT_MS - 56000);
  await rejected;
  assert.equal(requests, 5);
  assert.equal(f.state.getReplySentChunks("delivery"), 4);
  assert.equal(f.state.isMessageProcessed("delivery"), false);
});
