import { test } from "node:test";
import assert from "node:assert/strict";
import { NotificationCycleDiagnostics } from "../../src/runtime/notification-diagnostics.js";
import { RequestDiagnostics, notificationFailure, safeErrorFacts } from "../../src/runtime/request-diagnostics.js";
import { ResultClient } from "../../src/controller/result-client.js";
import { ControllerClient } from "../../src/controller/client.js";
import { NotificationClient } from "../../src/controller/notification-client.js";
import { NOTIFICATION_RESPONSE_BYTES } from "../../src/controller/notification-contract.js";
import { WeChatGateway } from "../../src/gateway.js";
import { HealthTracker } from "../../src/runtime/health.js";
import { harness, ID, ATTEMPT } from "../fixtures/notification-fixtures.js";
import * as fs from "node:fs";
import * as path from "node:path";

const PRIVATE = "private-token-account-message-url";
const active = () => true;
const reportable = () => true;
function socketError(): TypeError {
  return new TypeError(PRIVATE, { cause: Object.assign(new Error(PRIVATE), { code: "ECONNRESET", hostname: PRIVATE }) });
}
function fixture() {
  const events: Record<string, unknown>[] = [];
  const observer = new NotificationCycleDiagnostics(1000, event => events.push(event));
  const run = (action: () => Promise<unknown>) => observer.run(action, active, reportable);
  return { events, observer, run };
}

test("cause facts are bounded, handle aggregate/cyclic causes and never serialize arbitrary values", () => {
  const cause = Object.assign(new Error(PRIVATE), { code: "ENOTFOUND", cause: undefined as unknown });
  const unknown = Object.assign(new Error(PRIVATE), { code: PRIVATE });
  const aggregate = new AggregateError([cause, unknown], PRIVATE);
  cause.cause = aggregate;
  const error = new TypeError(PRIVATE, { cause: aggregate });
  assert.deepEqual(safeErrorFacts(error), { errorName: "TypeError", causeCodes: ["ENOTFOUND", "OtherCode"] });
  assert.ok(!JSON.stringify(safeErrorFacts(error)).includes(PRIVATE));
  assert.deepEqual(safeErrorFacts(Object.assign(new Error(PRIVATE), { name: PRIVATE })), { errorName: "OtherError", causeCodes: [] });
  assert.deepEqual(safeErrorFacts({ cause: { code: { token: PRIVATE } } }), { errorName: "OtherError", causeCodes: ["OtherCode"] });
});

test("request failure preserves error identity and reveals only fixed request fields and cause codes", async () => {
  const f = fixture(), original = socketError();
  const client = new ResultClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: PRIVATE,
    fetchImpl: async () => { throw original; } });
  await assert.rejects(f.run(() => client.notificationInterest()), error => error === original);
  const event = f.events[0];
  assert.equal(event.event, "notification_cycle_failed");
  assert.equal(event.operation, "notification_interest");
  assert.equal(event.phase, "fetch");
  assert.deepEqual(event.causeCodes, ["ECONNRESET"]);
  assert.equal(event.errorType, "NetworkError");
  assert.equal(event.requestAttempts, 1);
  assert.equal(event.requestMaxAttempts, 1);
  assert.equal(event.retryScheduled, true);
  assert.equal(event.retryDelayMs, 1000);
  assert.equal(event.timedOut, false);
  assert.ok(!JSON.stringify(event).includes(PRIVATE));
  assert.ok(!JSON.stringify(event).includes("127.0.0.1"));
});

test("HTTP200 with a failing response body records body phase, never recovery", async () => {
  const f = fixture(), original = socketError();
  const client = new ResultClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: PRIVATE,
    fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.error(original); } })) });
  await assert.rejects(f.run(() => client.listDeliveries([PRIVATE])), error => error === original);
  assert.equal(f.events[0].operation, "result_pending");
  assert.equal(f.events[0].phase, "body");
  assert.equal(f.events[0].httpStatus, 200);
  await f.run(async () => ({ skipped: 1 }));
  assert.equal(f.events.length, 1);
});

test("receipt retry budget remains three and auth remains one", async () => {
  for (const status of [503, 403]) {
    const f = fixture(); let calls = 0;
    const client = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: PRIVATE,
      fetchImpl: async () => { calls++; return Response.json({}, { status }); } });
    await assert.rejects(f.run(() => client.recordNotificationReceipt(ID, ATTEMPT, "accepted")), /HTTP/);
    assert.equal(calls, status === 503 ? 3 : 1);
    assert.equal(f.events[0].requestAttempts, calls);
    assert.equal(f.events[0].requestMaxAttempts, 3);
    assert.equal(f.events[0].operation, "notification_receipt");
    assert.equal(f.events[0].httpStatus, status);
    assert.equal(f.events[0].errorType, `Controller${status === 403 ? "Auth" : "Http"}${status}`);
  }
});

test("timeout facts differ from a caller abort and response byte-budget rejection", async () => {
  const f = fixture();
  const client = new ResultClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: PRIVATE, timeoutMs: 5,
    fetchImpl: async () => new Promise<Response>(() => {}) });
  await assert.rejects(f.run(() => client.notificationInterest()), /timed out/);
  assert.equal(f.events[0].timedOut, true);
  assert.equal(f.events[0].parentAborted, false);
  const abort = new AbortController(); abort.abort(new Error(PRIVATE));
  await assert.rejects(f.run(() => client.notificationInterest(abort.signal)));
  assert.equal(f.events[1].timedOut, false);
  assert.equal(f.events[1].parentAborted, true);
  const oversized = new NotificationClient("http://127.0.0.1:8790", PRIVATE,
    async () => new Response(new Uint8Array(NOTIFICATION_RESPONSE_BYTES + 1)));
  await assert.rejects(f.run(() => oversized.listNotifications([PRIVATE])), /byte budget/);
  assert.equal(f.events[2].timedOut, false);
});

test("successful skipped cycles, another recipient, and partial cycles cannot claim request recovery", async () => {
  const f = fixture(); let fail = true;
  const client = new ResultClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: PRIVATE,
    fetchImpl: async () => { if (fail) throw socketError(); return Response.json({ items: [] }); } });
  await assert.rejects(f.run(() => client.listDeliveries(["recipient-a"])));
  fail = false;
  await f.run(async () => ({ skipped: 1 }));
  await f.run(() => client.listDeliveries(["recipient-b"]));
  assert.equal(f.events.length, 1);
  await assert.rejects(f.run(async () => {
    await client.listDeliveries(["recipient-a"]);
    const diagnostics = new RequestDiagnostics("result_get", "later-stage");
    const error = socketError(); diagnostics.failure(error, 1, 1, false); throw error;
  }));
  assert.equal(f.events.length, 2, "a successful request cannot hide a later stage failure");
  await f.run(async () => ({ skipped: 0 }));
  assert.equal(f.events.length, 2);
  await f.run(async () => new RequestDiagnostics("result_get", "later-stage").success());
  assert.equal(f.events[2].event, "notification_cycle_recovered");
  assert.deepEqual(f.events[2].recoveredOperations, ["result_pending", "result_get"]);
  for (let index = 0; index < 5; index++) await f.run(async () => ({}));
  assert.equal(f.events.length, 3, "no successful per-second noise after recovery");
});

test("separate outstanding requests must all succeed before a complete cycle emits recovery", async () => {
  const f = fixture();
  const request = async (identity: string, fails: boolean) => {
    const diagnostics = new RequestDiagnostics("result_get", identity);
    if (fails) { const error = socketError(); diagnostics.failure(error, 1, 1, false); throw error; }
    diagnostics.success();
  };
  await assert.rejects(f.run(() => request("a", true)));
  await assert.rejects(f.run(() => request("b", true)));
  await f.run(() => request("a", false));
  assert.equal(f.events.length, 2);
  await f.run(() => request("b", false));
  assert.equal(f.events[2].event, "notification_cycle_recovered");
});

test("all failures from one cycle survive firstError propagation and skipped work", async () => {
  const f = fixture();
  await assert.rejects(f.run(async () => {
    const first = socketError(), second = socketError();
    new RequestDiagnostics("result_get", "a").failure(first, 1, 1, false);
    new RequestDiagnostics("result_get", "b").failure(second, 1, 1, false);
    throw first;
  }));
  assert.equal(f.events[0].unresolvedFailures, 2);
  await f.run(async () => new RequestDiagnostics("result_get", "a").success());
  await f.run(async () => ({ skipped: 1 }));
  assert.equal(f.events.length, 1);
  await f.run(async () => new RequestDiagnostics("result_get", "b").success());
  assert.equal(f.events[1].event, "notification_cycle_recovered");
});

test("schema and identity validation stay in their request; skipped cycles cannot recover them or retry a receipt", async () => {
  for (const kind of ["result", "notification"] as const) {
    const f = fixture(); let calls = 0, bad = true;
    const fetchImpl: typeof fetch = async () => { calls++; return Response.json({ items: bad ? "bad" : [] }); };
    const client = kind === "result"
      ? new ResultClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: PRIVATE, fetchImpl })
      : new NotificationClient("http://127.0.0.1:8790", PRIVATE, fetchImpl);
    const list = () => client instanceof ResultClient ? client.listDeliveries([PRIVATE]) : client.listNotifications([PRIVATE]);
    await assert.rejects(f.run(list));
    assert.equal(f.events[0].phase, "validate");
    assert.equal(f.events[0].operation, kind === "result" ? "result_pending" : "notification_pending");
    await f.run(async () => ({ skipped: 1 }));
    assert.equal(f.events.length, 1);
    bad = false; await f.run(list);
    assert.equal(f.events[1].event, "notification_cycle_recovered");
    assert.equal(calls, 2);
    await assert.rejects(f.run(() => client instanceof ResultClient
      ? client.recordReceipt(ID, ATTEMPT, "accepted") : client.recordNotificationReceipt(ID, ATTEMPT, "accepted")));
    assert.equal(calls, 3, "response validation is never newly retried");
    await f.run(async () => ({ skipped: 1 }));
    assert.equal(f.events.length, 3);
  }
});

test("an uninstrumented local-stage failure is left unproven by a skipped cycle", async () => {
  const f = fixture();
  await assert.rejects(f.run(async () => { throw new Error(PRIVATE); }));
  await f.run(async () => ({ skipped: 1 }));
  assert.equal(f.events.length, 1);
});

test("readiness is logged once; shutdown aborts and fatal diagnostic errors are not retried diagnostics", async () => {
  const f = fixture();
  await f.run(async () => ({})); await f.run(async () => ({}));
  assert.deepEqual(f.events.map(event => event.event), ["notification_cycle_ready"]);
  await assert.rejects(f.observer.run(async () => { throw socketError(); }, () => false, reportable));
  await assert.rejects(f.observer.run(async () => { throw socketError(); }, active, () => false));
  assert.equal(f.events.length, 1);
});

test("actual independent Gateway loop retries and reports recovery while inbound health remains separate", async t => {
  const f = harness(t, { items: [] }), events: Record<string, unknown>[] = [], errors: Error[] = [];
  const healthPath = path.join(path.dirname(f.statePath), "health.json"), health = new HealthTracker(healthPath);
  health.startRun();
  let requests = 0, gateway: WeChatGateway;
  f.hooks.pending = () => { if (++requests === 1) throw socketError(); };
  const diagnostics = new NotificationCycleDiagnostics(1, event => {
    events.push(event);
    if (event.event === "notification_cycle_recovered") gateway.stop();
  });
  gateway = new WeChatGateway({ stateManager: f.state, controller: f.controller, ilink: f.ilink, healthTracker: health,
    notificationDiagnostics: diagnostics });
  const timeout = setTimeout(() => gateway.stop(), 2000); t.after(() => clearTimeout(timeout));
  await gateway.runLoop(1, () => assert.fail("notification errors are not poll errors"), error => errors.push(error));
  assert.equal(errors.length, 1);
  assert.equal(events[0].stage, "notification_delivery");
  assert.equal(events[0].operation, "notification_pending");
  assert.equal(events[1].event, "notification_cycle_recovered");
  assert.ok(requests >= 2);
  assert.equal(f.sends.length, 0);
  const data = JSON.parse(fs.readFileSync(healthPath, "utf8"));
  assert.equal(data.total_error_count, 0);
  assert.ok(data.last_poll_succeeded_at);
  assert.equal(notificationFailure(errors[0]).request?.operation, "notification_pending");
});
