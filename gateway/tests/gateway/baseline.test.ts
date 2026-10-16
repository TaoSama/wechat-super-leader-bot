import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../../src/runtime/state.js";
import { ILinkClient } from "../../src/wechat/client.js";
import { ControllerClient } from "../../src/controller/client.js";
import { WeChatGateway } from "../../src/gateway.js";

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
