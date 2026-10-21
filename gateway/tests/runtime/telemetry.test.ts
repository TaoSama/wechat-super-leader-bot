import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessageTrace, currentTrace, runWithTrace, traceEvent, traceSpan } from "../../src/runtime/telemetry.js";

test("message identity remains stable across attempts without logging chat or message contents", () => {
  const events: Record<string, unknown>[] = [];
  const first = createMessageTrace("private-chat", "private-message", event => events.push(event));
  const retry = createMessageTrace("private-chat", "private-message");
  const otherChat = createMessageTrace("other-chat", "private-message");
  assert.equal(first.traceId, retry.traceId);
  assert.notEqual(first.attemptId, retry.attemptId);
  assert.notEqual(first.traceId, otherChat.traceId);
  assert.match(first.traceId, /^[a-f0-9]{64}$/);
  assert.match(first.attemptId, /^[a-f0-9-]{36}$/);
  runWithTrace(first, () => traceEvent("message.received", { chars: 3 }));
  assert.equal(events.length, 1);
  assert.equal(events[0].traceId, first.traceId);
  assert.equal(events[0].attemptId, first.attemptId);
  assert.equal(events[0].service, "gateway");
  assert.equal(events[0].schema, 1);
  assert.ok(Number.isFinite(Date.parse(String(events[0].timestamp))));
  assert.equal(typeof events[0].elapsedMs, "number");
  assert.ok(!JSON.stringify(events).includes("private-chat"));
  assert.ok(!JSON.stringify(events).includes("private-message"));
});

test("telemetry drops non-allowlisted secrets and invalid numeric values", () => {
  const events: Record<string, unknown>[] = [];
  const trace = createMessageTrace("chat", "message", event => events.push(event));
  runWithTrace(trace, () => traceEvent("fixture", {
    text: "secret-message-body", token: "secret-token", authorization: "secret-authorization",
    arguments: "secret-tool-arguments", output: "secret-tool-output", contextToken: "secret-context",
    traceId: "overridden-trace", service: "overridden-service", timestamp: "overridden-time",
    durationMs: Number.NaN, inputTokens: Number.POSITIVE_INFINITY, chunkCount: undefined,
    httpStatus: 200, failed: false, reason: null, tool: "x".repeat(300),
  }));
  assert.equal(events.length, 1);
  const event = events[0];
  for (const key of ["text", "token", "authorization", "arguments", "output", "contextToken", "durationMs", "inputTokens", "chunkCount"]) {
    assert.equal(Object.hasOwn(event, key), false, key);
  }
  assert.equal(event.traceId, trace.traceId);
  assert.equal(event.service, "gateway");
  assert.notEqual(event.timestamp, "overridden-time");
  assert.equal(event.httpStatus, 200);
  assert.equal(event.failed, false);
  assert.equal(event.reason, null);
  assert.equal(event.tool, "x".repeat(128));
  assert.ok(!JSON.stringify(events).includes("secret-"));
});

test("async trace contexts remain separate and restore the caller context", async () => {
  const events: Record<string, unknown>[] = [];
  const first = createMessageTrace("chat-a", "message", event => events.push(event));
  const second = createMessageTrace("chat-b", "message", event => events.push(event));
  assert.equal(currentTrace(), undefined);
  await Promise.all([first, second].map(trace => runWithTrace(trace, async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(currentTrace(), trace);
    traceEvent("isolated");
  })));
  assert.deepEqual(new Set(events.map(event => event.traceId)), new Set([first.traceId, second.traceId]));
  assert.equal(currentTrace(), undefined);
});

test("spans pair success and failure without swallowing the original error", async () => {
  const events: Record<string, unknown>[] = [];
  const trace = createMessageTrace("chat", "message", event => events.push(event));
  const failure = new Error("private-provider-error");
  await runWithTrace(trace, async () => {
    assert.equal(await traceSpan("success", async () => 42), 42);
    await assert.rejects(traceSpan("failure", async () => { throw failure; }), error => error === failure);
  });
  assert.deepEqual(events.map(event => event.stage), ["success.start", "success.end", "failure.start", "failure.end"]);
  assert.equal(events[0].spanId, events[1].spanId);
  assert.equal(events[2].spanId, events[3].spanId);
  assert.notEqual(events[0].spanId, events[2].spanId);
  assert.equal(events[1].outcome, "ok");
  assert.equal(events[3].outcome, "error");
  for (const event of [events[1], events[3]]) assert.ok(Number(event.durationMs) >= 0);
  assert.ok(!JSON.stringify(events).includes(failure.message));
});

test("a throwing logger cannot turn a successful action into failure or replace an action failure", async t => {
  const warnings: string[] = [];
  t.mock.method(process.stderr, "write", (value: string | Uint8Array) => { warnings.push(String(value)); return true; });
  const trace = createMessageTrace("chat", "message", () => { throw new Error("private-sink-error"); });
  const failure = new Error("original-action-failure");
  await runWithTrace(trace, async () => {
    traceEvent("fixture");
    assert.equal(await traceSpan("success", async () => "accepted"), "accepted");
    await assert.rejects(traceSpan("failure", async () => { throw failure; }), error => error === failure);
  });
  assert.ok(warnings.every(value => !value.includes("private-sink-error")));
  assert.equal(currentTrace(), undefined);
});

test("failed event and diagnostic sinks cannot interrupt actions or replace their original failures", async t => {
  // A fresh module instance tests the first diagnostic attempt independently of other failures.
  const moduleUrl = new URL("../../src/runtime/telemetry.js", import.meta.url);
  moduleUrl.searchParams.set("fixture", "broken-event-and-diagnostic-sinks");
  const telemetry: typeof import("../../src/runtime/telemetry.js") = await import(moduleUrl.href);
  const sink = t.mock.method(console, "info", () => { throw new Error("private-event-sink-error"); });
  const diagnostic = t.mock.method(process.stderr, "write", () => { throw new Error("private-stderr-error"); });
  const trace = telemetry.createMessageTrace("chat", "message");
  const failure = new Error("original-action-error");
  let completedActions = 0;
  await telemetry.runWithTrace(trace, async () => {
    assert.doesNotThrow(() => telemetry.traceEvent("fixture"));
    assert.equal(await telemetry.traceSpan("success", async () => { completedActions++; return "accepted"; }), "accepted");
    await assert.rejects(telemetry.traceSpan("failure", async () => { throw failure; }), error => error === failure);
  });
  assert.equal(completedActions, 1);
  assert.equal(sink.mock.callCount(), 5, "all event attempts remain best effort");
  assert.equal(diagnostic.mock.callCount(), 1, "a broken fallback must not create a warning loop");
  assert.equal(diagnostic.mock.calls[0].arguments[0], "[telemetry] event sink failed\n");
  assert.equal(telemetry.currentTrace(), undefined);
});

test("calling telemetry without a context produces no event", t => {
  const output = t.mock.method(console, "info", () => {});
  traceEvent("outside-context", { chars: 1 });
  assert.equal(output.mock.callCount(), 0);
});
