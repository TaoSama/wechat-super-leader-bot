import { test } from "node:test";
import assert from "node:assert/strict";
import { ControllerClient } from "../../src/controller/client.js";

const request = { chatId: "chat", messageId: "message", text: "继续分析" };
const progress = (remaining: number, id = `report-${remaining}`) => ({ type: "progress", id, text: `已核实步骤${remaining}`, remaining });
const final = { type: "reply", reply: { text: "完整结果", commandId: "command" } };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + "\n");
const response = (events: unknown[]) => new Response(events.map(event => JSON.stringify(event) + "\n").join(""), {
  headers: { "content-type": "application/x-ndjson; charset=utf-8" },
});
const client = (fetchImpl: typeof fetch, timeoutMs?: number) => new ControllerClient({
  controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic", fetchImpl, ...(timeoutMs ? { timeoutMs } : {}),
});

test("progress arrives before the final reply and sends remaining query budget to Controller", async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let observed!: () => void;
  const first = new Promise<void>(resolve => { observed = resolve; });
  const instance = client(async (_url, init) => {
    assert.equal((init?.headers as Record<string, string>).Accept, "application/x-ndjson");
    assert.equal((init?.headers as Record<string, string>)["X-Progress-Remaining"], "2");
    return new Response(new ReadableStream({ start(controller) { stream = controller; } }), {
      headers: { "content-type": "application/x-ndjson" },
    });
  });
  const reports: string[] = [];
  const pending = instance.forwardMessage(request, { progressRemaining: 2, onProgress: async (text, id) => {
    reports.push(id); assert.equal(text, "已核实步骤1"); observed(); return { sent: true };
  } });
  for (let tick = 0; tick < 5; tick++) await Promise.resolve();
  const frame = bytes(progress(1));
  stream.enqueue(frame.slice(0, 12)); stream.enqueue(frame.slice(12));
  await first;
  assert.deepEqual(reports, ["report-1"]);
  stream.enqueue(bytes(final)); stream.close();
  assert.deepEqual(await pending, { text: "完整结果", commandId: "command" });
});

test("progress delivery applies backpressure and a rejected send consumes its stream slot", async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const reports: string[] = [];
  const pending = client(async () => response([progress(2), progress(1), final])).forwardMessage(request, {
    progressRemaining: 3, onProgress: async (_text, id) => {
      reports.push(id);
      if (reports.length === 1) { entered(); await blocked; }
      return { sent: false, reason: "delivery_uncertain" };
    },
  });
  await started;
  assert.equal(reports.length, 1);
  release();
  assert.equal((await pending).text, "完整结果");
  assert.deepEqual(reports, ["report-2", "report-1"]);
});

test("malformed, duplicate, excessive and out-of-order progress frames fail without replay", async () => {
  for (const frames of [
    [progress(3), final],
    [progress(2), progress(1, "report-2"), final],
    [progress(2), { ...progress(1), text: "x".repeat(2001) }, final],
    [progress(2), progress(1), progress(0), progress(-1), final],
    [final, progress(2)],
    [progress(2)],
    [{ ...progress(2), secret: "extra" }, final],
    [{ type: "error", code: "REPLY_UNAVAILABLE" }],
    [{ type: "reply", reply: { text: 1 } }],
  ]) {
    let calls = 0;
    const instance = client(async () => { calls++; return response(frames); });
    await assert.rejects(instance.forwardMessage(request, { progressRemaining: 3, onProgress: async () => ({ sent: true }) }),
      /invalid response schema|outcome uncertain/);
    assert.equal(calls, 1);
  }
});

test("streaming transport failures and server errors never automatically execute the query again", async () => {
  for (const phase of ["fetch", "server", "sink"]) {
    let calls = 0;
    const instance = client(async () => {
      calls++;
      if (phase === "fetch") throw new Error("lost receipt");
      if (phase === "server") return new Response("unavailable", { status: 503 });
      return response([progress(2), final]);
    });
    await assert.rejects(instance.forwardMessage(request, { progressRemaining: 3, onProgress: async () => { throw new Error("sink failure"); } }));
    assert.equal(calls, 1);
  }
});

test("stream and progress callbacks honor the HTTP deadline even when cancellation is ignored", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const phase of ["fetch", "body", "sink"]) {
    const instance = client(async () => {
      if (phase === "fetch") return new Promise<Response>(() => {});
      if (phase === "sink") return response([progress(2), final]);
      return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "application/x-ndjson" } });
    }, 20);
    const pending = instance.forwardMessage(request, { progressRemaining: 3, onProgress: async () => new Promise(() => {}) });
    const rejected = assert.rejects(pending, error => error instanceof Error && error.name === "AbortError");
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    t.mock.timers.tick(20);
    await rejected;
  }
});

test("an oversized unterminated frame is bounded before JSON parsing", async () => {
  const instance = client(async () => new Response("x".repeat(256 * 1024 + 1), { headers: { "content-type": "application/x-ndjson" } }));
  await assert.rejects(instance.forwardMessage(request, { progressRemaining: 3, onProgress: async () => ({ sent: true }) }), /invalid response schema/);
});

test("zero remaining slots permits a final result and JSON fallback retains reply validation", async () => {
  for (const result of [response([final]), Response.json(final.reply)]) {
    assert.equal((await client(async () => result).forwardMessage(request, {
      progressRemaining: 0, onProgress: async () => assert.fail("No available reports"),
    })).text, "完整结果");
  }
});
