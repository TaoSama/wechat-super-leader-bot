import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
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
  t.mock.method(fs, "writeSync", (_fd: number, value: string | ArrayBufferView) => { warnings.push(String(value)); return Buffer.byteLength(String(value)); });
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
  const writes = t.mock.method(fs, "writeSync", () => { throw new Error("private-stderr-error"); });
  const trace = telemetry.createMessageTrace("chat", "message");
  const failure = new Error("original-action-error");
  let completedActions = 0;
  await telemetry.runWithTrace(trace, async () => {
    assert.doesNotThrow(() => telemetry.traceEvent("fixture"));
    assert.equal(await telemetry.traceSpan("success", async () => { completedActions++; return "accepted"; }), "accepted");
    await assert.rejects(telemetry.traceSpan("failure", async () => { throw failure; }), error => error === failure);
  });
  assert.equal(completedActions, 1);
  assert.equal(writes.mock.callCount(), 6, "five events and one fallback remain best effort");
  assert.ok(writes.mock.calls.every(call => call.arguments[0] === 2));
  assert.equal(writes.mock.calls.filter(call => call.arguments[1] === "[telemetry] event sink failed\n").length, 1,
    "a broken fallback must not create a warning loop");
  assert.equal(telemetry.currentTrace(), undefined);
});

test("calling telemetry without a context produces no event", t => {
  const output = t.mock.method(fs, "writeSync", () => 0);
  traceEvent("outside-context", { chars: 1 });
  assert.equal(output.mock.callCount(), 0);
});


for (const closedStderr of [false, true]) {
  test(`default telemetry preserves stdout JSON${closedStderr ? " with stderr closed" : " and writes JSON events to stderr"}`, () => {
    const moduleUrl = new URL("../../src/runtime/telemetry.js", import.meta.url);
    if (!fs.existsSync(moduleUrl)) moduleUrl.pathname = moduleUrl.pathname.replace(/\.js$/, ".ts");
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
      import fs from "node:fs";
      import { createMessageTrace, runWithTrace, traceSpan } from ${JSON.stringify(moduleUrl.href)};
      if (${closedStderr}) fs.closeSync(2);
      const trace = createMessageTrace("chat", "message");
      let result;
      let originalErrorPreserved = false;
      await runWithTrace(trace, async () => {
        result = await traceSpan("success", async () => "accepted");
        const original = new Error("private-action-failure");
        try { await traceSpan("failure", async () => { throw original; }); }
        catch (error) { if (error !== original) throw error; originalErrorPreserved = true; }
      });
      process.stdout.write(JSON.stringify({ result, originalErrorPreserved }));
    `], { encoding: "utf8", timeout: 5000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.signal, null);
    assert.deepEqual(JSON.parse(child.stdout), { result: "accepted", originalErrorPreserved: true });
    if (closedStderr) assert.equal(child.stderr, "");
    else {
      const events = child.stderr.trim().split("\n").map(line => JSON.parse(line));
      assert.deepEqual(events.map(event => event.stage), ["success.start", "success.end", "failure.start", "failure.end"]);
      assert.ok(events.every(event => event.service === "gateway"));
      assert.ok(!child.stderr.includes("private-action-failure"));
    }
  });
}
