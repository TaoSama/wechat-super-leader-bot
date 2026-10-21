import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StateManager } from "../../src/runtime/state.js";
import { ILinkClient } from "../../src/wechat/client.js";
import { ControllerClient } from "../../src/controller/client.js";
import { WeChatGateway } from "../../src/gateway.js";
import type { GatewayReplyEngine } from "../../src/leader/contracts.js";
import { createMessageTrace, currentTrace, runWithTrace, traceEvent } from "../../src/runtime/telemetry.js";

type Event = Record<string, unknown>;

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recovery-latency-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const account = path.join(root, "account.json");
  fs.writeFileSync(account, JSON.stringify({ token: "private-token", accountId: "account" }));
  const state = new StateManager(account);
  state.markBaselineEstablished();
  state.recordInboundContext("window", "chat", Date.now(), true, "private-context");
  const events: Event[] = [];
  t.mock.method(console, "info", (line: string) => events.push(JSON.parse(line)));
  const ilink = new ILinkClient({ stateManager: state, fetchImpl: async (input) => {
    assert.ok(String(input).endsWith("sendmessage"));
    traceEvent("fixture.wechat.send");
    return Response.json({ ret: 0 });
  } });
  const put = (messageId: string, status: "pending" | "receipt" | "expired" = "pending", source: "engine" | "controller" = "engine") => {
    const deliveryKey = state.computeDeliveryKey("chat", messageId);
    state.putOutbox({ kind: "reply", source, chatId: "chat", messageId, deliveryKey,
      splitMaxChars: 1000, splitMultiPart: false, status,
      ...(status === "receipt" ? { receiptStatus: "accepted" as const } : {}) });
    return deliveryKey;
  };
  return { state, events, ilink, put };
}

for (const source of ["engine", "controller"] as const) {
  test(`${source} frozen reads, sends and receipts share an old-message recovery attempt rather than the triggering inbound`, async t => {
    const { state, events, ilink, put } = fixture(t);
    const firstKey = put("old-first", "pending", source);
    const secondKey = put("old-second", "pending", source);
    const reads: string[] = [], acknowledgements: string[] = [];
    const engine: GatewayReplyEngine = { requestBudgetMs: 100,
      reply: async () => { throw new Error("Recovery must never regenerate"); },
      getReply: async (_account, _chat, messageId) => {
        reads.push(messageId); traceEvent("fixture.engine.read"); return { text: "private-frozen-reply" };
      },
      ackReply: async (_account, _chat, messageId) => { acknowledgements.push(messageId); traceEvent("fixture.engine.ack"); },
    };
    const controller = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "private-controller-token",
      maxRetries: 0, fetchImpl: async (_input, init) => {
        assert.equal(init?.method, "GET");
        reads.push("controller-get");
        traceEvent("fixture.controller.read");
        return Response.json({ text: "private-frozen-reply" });
      } });
    const gateway = new WeChatGateway({ stateManager: state, ilink, controller, replyEngine: source === "engine" ? engine : undefined });
    const inbound = createMessageTrace("chat", "new-inbound");
    await runWithTrace(inbound, async () => {
      await gateway.flushRepliesOnce();
      assert.equal(currentTrace(), inbound, "recovery scope must restore the admitting message");
    });
    assert.equal(state.outbox[firstKey], undefined);
    assert.equal(state.outbox[secondKey].status, "pending", "only one frozen pending reply is resumed per cycle");
    assert.deepEqual(reads, [source === "engine" ? "old-first" : "controller-get"]);
    assert.deepEqual(acknowledgements, source === "engine" ? ["old-first"] : []);
    const expected = createMessageTrace("chat", "old-first").traceId;
    assert.ok(events.length > 0);
    assert.ok(events.every(event => event.traceId === expected));
    assert.equal(new Set(events.map(event => event.attemptId)).size, 1);
    assert.ok(events.every(event => event.attemptId !== inbound.attemptId));
    const start = events.find(event => event.stage === "delivery.recovery.read.start")!;
    const delivery = events.find(event => event.stage === "delivery.start")!;
    assert.ok(events.indexOf(start) < events.indexOf(delivery));
    assert.equal(events.find(event => event.stage === "delivery.recovery.end")?.outcome, "ok");
    assert.equal(events.find(event => event.stage === "delivery.end")?.receiptStatus, "wechat_api_accepted");
    if (source === "controller") assert.equal(events.find(event => event.stage === "fixture.controller.read")?.traceId, expected);
    assert.doesNotMatch(JSON.stringify(events), /private-token|private-context|private-controller-token|private-frozen-reply/);
    await gateway.flushRepliesOnce();
    assert.equal(state.outbox[secondKey], undefined);
    assert.ok(events.some(event => event.traceId === createMessageTrace("chat", "old-second").traceId));
  });
}

test("terminal receipt retries each receive an independent trace and never re-read or re-send", async t => {
  const { state, events, ilink, put } = fixture(t);
  const accepted = put("old-accepted", "receipt");
  const expired = put("old-expired", "expired");
  const acknowledgements: Array<{ messageId: string; status: string; traceId?: string }> = [];
  const engine: GatewayReplyEngine = { requestBudgetMs: 100,
    reply: async () => { throw new Error("Unexpected regeneration"); },
    getReply: async () => { throw new Error("Unexpected frozen read"); },
    ackReply: async (_account, _chat, messageId, status) => {
      acknowledgements.push({ messageId, status, traceId: currentTrace()?.traceId });
      traceEvent("fixture.engine.ack");
    },
  };
  const controller = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "private-controller-token",
    fetchImpl: async () => { throw new Error("Unexpected Controller call"); } });
  const gateway = new WeChatGateway({ stateManager: state, ilink, controller, replyEngine: engine });
  await runWithTrace(createMessageTrace("new-chat", "new-message"), () => gateway.flushRepliesOnce());
  assert.equal(state.outbox[accepted], undefined);
  assert.equal(state.outbox[expired].engineAcked, true);
  assert.deepEqual(acknowledgements, [
    { messageId: "old-accepted", status: "accepted", traceId: createMessageTrace("chat", "old-accepted").traceId },
    { messageId: "old-expired", status: "expired", traceId: createMessageTrace("chat", "old-expired").traceId },
  ]);
  assert.equal(events.filter(event => event.stage === "delivery.recovery.ack.end").length, 2);
  assert.equal(new Set(events.map(event => event.attemptId)).size, 2);
  assert.equal(events.some(event => event.stage === "delivery.recovery.read.start" || event.stage === "delivery.start"), false);
});

test("failed frozen reads remain pending, retain original error and emit failure on the old message only", async t => {
  const { state, events, ilink, put } = fixture(t);
  const first = put("failed-old");
  const second = put("later-old");
  const failure = new Error("private-recovery-error");
  const engine: GatewayReplyEngine = { requestBudgetMs: 100,
    reply: async () => { throw new Error("Unexpected regeneration"); },
    getReply: async () => { throw failure; },
    ackReply: async () => { throw new Error("Unexpected acknowledgement"); },
  };
  const controller = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "private-controller-token" });
  const gateway = new WeChatGateway({ stateManager: state, ilink, controller, replyEngine: engine });
  await assert.rejects(runWithTrace(createMessageTrace("chat", "new-inbound"), () => gateway.flushRepliesOnce()), error => error === failure);
  assert.equal(state.outbox[first].status, "pending");
  assert.equal(state.outbox[second].status, "pending");
  assert.equal(events.find(event => event.stage === "delivery.recovery.read.end")?.outcome, "error");
  assert.equal(events.find(event => event.stage === "delivery.recovery.attempt.end")?.outcome, "error");
  assert.ok(events.every(event => event.traceId === createMessageTrace("chat", "failed-old").traceId));
  assert.equal(events.some(event => event.stage === "delivery.start"), false);
  assert.doesNotMatch(JSON.stringify(events), /private-recovery-error/);
});
