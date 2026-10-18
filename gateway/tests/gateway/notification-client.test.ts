import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { ControllerClient } from "../../src/controller/client.js";
import { parseNotification, sameNotification, NOTIFICATION_RESPONSE_BYTES, NOTIFICATION_TEXT_BYTES,
  NOTIFICATION_ATTEMPT_MS, LEGACY_NOTIFICATION_ATTEMPT_MS, NOTIFICATION_LIMIT, NOTIFICATION_PART_LIMIT } from "../../src/controller/notification-contract.js";
import { ATTEMPT, ID, claimed, json, notification, goalNotification } from "../fixtures/notification-fixtures.js";

test("notification client uses bounded pending POST, exact Bearer paths and strict claim/receipt/get", async () => {
  const calls: { url: string; body: unknown; method: string | undefined }[] = [];
  const item = claimed();
  const client = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic", fetchImpl: async (url, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer synthetic");
    assert.equal(init?.redirect, "error");
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    if (String(url).endsWith("pending")) return json({ items: [notification()] });
    const status = String(url).endsWith("receipt") ? "accepted" : "claimed";
    return json({ notification: { ...item, status } });
  } });
  assert.equal((await client.listNotifications(["chat"])).length, 1);
  await client.claimNotification(ID, ATTEMPT);
  await client.recordNotificationReceipt(ID, ATTEMPT, "accepted");
  await client.getNotification(ID);
  assert.deepEqual(calls.map(call => call.method), ["POST", "POST", "POST", "GET"]);
  assert.deepEqual(calls.map(call => call.body), [{ chatIds: ["chat"] }, { attemptId: ATTEMPT }, { attemptId: ATTEMPT, status: "accepted" }, undefined]);
  assert.ok(calls.every(call => !call.url.includes("?")));
});
for (const [name, change] of [
  ["extra field", (item: Record<string, unknown>) => { item.token = "forbidden"; }],
  ["legacy execution field", (item: Record<string, unknown>) => { item.executionId = item.id; }],
  ["missing source", (item: Record<string, unknown>) => { delete item.source; }],
  ["null source", (item: Record<string, unknown>) => { item.source = null; }],
  ["array source", (item: Record<string, unknown>) => { item.source = []; }],
  ["foreign source ID", (item: Record<string, unknown>) => { item.source = { type: "plan", id: ATTEMPT }; }],
  ["invalid source ID", (item: Record<string, unknown>) => { item.source = { type: "plan", id: "not-uuid" }; }],
  ["unknown source type", (item: Record<string, unknown>) => { item.source = { type: "session", id: item.id }; }],
  ["missing source type", (item: Record<string, unknown>) => { item.source = { id: item.id }; }],
  ["extra source field", (item: Record<string, unknown>) => { item.source = { type: "plan", id: item.id, executionId: item.id }; }],
  ["blocked plan", (item: Record<string, unknown>) => { item.kind = "blocked"; }],
  ["failed goal", (item: Record<string, unknown>) => { item.source = { type: "goal", id: item.id }; item.kind = "failed"; }],
  ["empty chat", (item: Record<string, unknown>) => { item.chatId = ""; }],
  ["overlong text", (item: Record<string, unknown>) => { item.text = "😀".repeat(NOTIFICATION_TEXT_BYTES / 4 + 1); }],
  ["missing text", (item: Record<string, unknown>) => { delete item.text; }],
  ["invalid date", (item: Record<string, unknown>) => { item.createdAt = Infinity; }],
  ["bad attempt", (item: Record<string, unknown>) => { item.status = "claimed"; item.attemptId = ATTEMPT; }],
  ["invalid status", (item: Record<string, unknown>) => { item.status = "completed"; }],
] as const) test(`strict notification parser rejects ${name}`, () => {
  const item: Record<string, unknown> = { ...notification() }; change(item);
  assert.throws(() => parseNotification(item), /schema invalid/);
});
test("notification parser allows expired pending projection, uncertain claim and exact UTF8 budget", () => {
  assert.equal(parseNotification({ ...notification(), status: "expired" }).status, "expired");
  assert.equal(parseNotification({ ...claimed(), status: "uncertain" }).status, "uncertain");
  for (const text of ["a".repeat(NOTIFICATION_TEXT_BYTES), "😀".repeat(NOTIFICATION_TEXT_BYTES / 4),
    "中".repeat(Math.floor(NOTIFICATION_TEXT_BYTES / 3)) + "aa"]) {
    assert.equal(Buffer.byteLength(text, "utf8"), NOTIFICATION_TEXT_BYTES);
    assert.equal(parseNotification({ ...notification(), text }).text, text);
  }
  assert.throws(() => parseNotification({ ...notification(), text: "a".repeat(NOTIFICATION_TEXT_BYTES + 1) }), /schema invalid/);
  assert.throws(() => parseNotification({ ...notification(), text: "中".repeat(Math.ceil(NOTIFICATION_TEXT_BYTES / 3)) }), /schema invalid/);
});
test("notification parser accepts exact new and legacy claim windows, including expiry clipping", () => {
  const item = notification(), attemptedAt = item.createdAt + 100;
  for (const duration of [NOTIFICATION_ATTEMPT_MS, LEGACY_NOTIFICATION_ATTEMPT_MS]) {
    for (const expiresAt of [item.expiresAt, attemptedAt + 1000]) {
      const value = { ...item, status: "claimed", attemptId: ATTEMPT, attemptedAt, expiresAt,
        attemptExpiresAt: Math.min(expiresAt, attemptedAt + duration) };
      assert.deepEqual(parseNotification(value), value);
    }
  }
  for (const duration of [1, LEGACY_NOTIFICATION_ATTEMPT_MS + 1, NOTIFICATION_ATTEMPT_MS + 1]) {
    assert.throws(() => parseNotification({ ...claimed(item), attemptedAt, attemptExpiresAt: attemptedAt + duration }), /schema invalid/);
  }
});
test("progress notifications preserve independent identity, strict metadata and source type", () => {
  for (const type of ["plan", "goal"] as const) {
    for (const sequence of [1, 2, 3]) {
      const item = { ...notification(), id: ATTEMPT, source: { type, id: ID }, kind: "progress", progress: { sequence, eventKey: "e".repeat(256) } };
      assert.deepEqual(parseNotification(item), item);
    }
  }
  const item = { ...notification(), id: ATTEMPT, kind: "progress", progress: { sequence: 1, eventKey: "event" } };
  for (const change of [{ id: ID }, { progress: undefined }, { progress: null }, { progress: [] }, { part: { index: 1, total: 1 } },
    { progress: { sequence: 0, eventKey: "event" } }, { progress: { sequence: 4, eventKey: "event" } },
    { progress: { sequence: 1.5, eventKey: "event" } }, { progress: { sequence: "1", eventKey: "event" } },
    { progress: { sequence: 1, eventKey: "" } }, { progress: { sequence: 1, eventKey: "e".repeat(257) } },
    { progress: { sequence: 1, eventKey: "event", extra: true } }]) {
    assert.throws(() => parseNotification({ ...item, ...change }), /schema invalid/);
  }
  assert.throws(() => parseNotification({ ...notification(), progress: item.progress }), /schema invalid/);
  const parsed = parseNotification(item);
  assert.equal(sameNotification(parsed, { ...parsed, progress: { sequence: 2, eventKey: "event" } }), false);
  assert.equal(sameNotification(parsed, { ...parsed, progress: { sequence: 1, eventKey: "other" } }), false);
  assert.equal(sameNotification(parsed, claimed(parsed)), true);
});
test("terminal parts preserve source identity and strict ordered metadata while legacy JSON stays unchanged", () => {
  for (const item of [notification(), goalNotification()]) {
    assert.deepEqual(parseNotification(item), item);
    for (const [index, total] of [[1, 1], [1, 2], [2, 2], [NOTIFICATION_PART_LIMIT, NOTIFICATION_PART_LIMIT]]) {
      const value = { ...item, id: index === 1 ? item.source.id : ATTEMPT, part: { index, total } };
      assert.deepEqual(parseNotification(value), value);
    }
    assert.equal(sameNotification(item, { ...item, part: { index: 1, total: 1 } }), true);
    assert.equal(sameNotification(item, { ...item, part: { index: 1, total: 2 } }), false);
    assert.equal(sameNotification(item, { ...item, part: { index: 2, total: 2 } }), false);
    for (const change of [{ part: null }, { part: undefined }, { part: [] }, { part: {} },
      { part: { index: 0, total: 2 } }, { part: { index: 1, total: 0 } }, { part: { index: 3, total: 2 } },
      { part: { index: 1.5, total: 2 } }, { part: { index: 1, total: 2.5 } }, { part: { index: "1", total: 2 } },
      { part: { index: 1, total: NOTIFICATION_PART_LIMIT + 1 } }, { part: { index: 1, total: 2, extra: true } },
      { id: ATTEMPT, part: { index: 1, total: 2 } }, { id: item.source.id, part: { index: 2, total: 2 } }]) {
      assert.throws(() => parseNotification({ ...item, ...change }), /schema invalid/);
    }
  }
});
test("multipart terminal text preserves whitespace continuations without permitting empty bodies", () => {
  for (const item of [notification(), goalNotification()]) {
    for (const index of [1, 2]) {
      const value = { ...item, id: index === 1 ? item.id : ATTEMPT, part: { index, total: 2 }, text: " \n\t\r " };
      assert.deepEqual(parseNotification(value), value);
      assert.throws(() => parseNotification({ ...value, text: "" }), /schema invalid/);
    }
    assert.throws(() => parseNotification({ ...item, text: " \n\t" }), /schema invalid/);
    assert.throws(() => parseNotification({ ...item, part: { index: 1, total: 1 }, text: " \n\t" }), /schema invalid/);
  }
  assert.throws(() => parseNotification({ ...notification(), id: ATTEMPT, kind: "progress",
    progress: { sequence: 1, eventKey: "event" }, text: " \n\t" }), /schema invalid/);
});
test("notification client accepts one large UTF8 body and JSON escaped text beyond the old response limit", async () => {
  const text = "中文😀\u0001\"\\\n".repeat(16_384);
  const items = Array.from({ length: NOTIFICATION_LIMIT }, (_, index) => ({ ...notification(index + 1), text }));
  const body = JSON.stringify({ items });
  assert.ok(Buffer.byteLength(body, "utf8") > 64 * 1024);
  // Every UTF8 byte can become a six-byte JSON escape, in addition to object metadata.
  assert.ok(NOTIFICATION_RESPONSE_BYTES > NOTIFICATION_LIMIT * NOTIFICATION_TEXT_BYTES * 6);
  const client = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic", fetchImpl: async () => new Response(body) });
  assert.deepEqual(await client.listNotifications(["chat"]), items);
});
test("notification response budget accepts a fully escaped exact 8MiB terminal part", async () => {
  const item = { ...notification(), text: "\u0001".repeat(NOTIFICATION_TEXT_BYTES), part: { index: 1, total: 2 } };
  const body = JSON.stringify({ items: [item] });
  assert.ok(Buffer.byteLength(body, "utf8") > NOTIFICATION_TEXT_BYTES * 6);
  assert.ok(Buffer.byteLength(body, "utf8") < NOTIFICATION_RESPONSE_BYTES);
  const client = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic", fetchImpl: async () => new Response(body) });
  assert.deepEqual(await client.listNotifications(["chat"]), [item]);
});
test("notification parser allows only source-specific kinds and preserves generic source", () => {
  for (const kind of ["completed", "failed", "expired"] as const) {
    const item = { ...notification(), kind };
    assert.deepEqual(parseNotification(item), item);
  }
  for (const kind of ["completed", "blocked", "expired"] as const) {
    const item = goalNotification(kind);
    assert.deepEqual(parseNotification(item), item);
  }
});
test("notification identity binds source type and ID even for shared kind and text", () => {
  const item = notification();
  assert.equal(sameNotification(item, claimed(item)), true);
  assert.equal(sameNotification(item, { ...item, source: { type: "goal", id: item.id } }), false);
  assert.equal(sameNotification(item, { ...item, source: { type: "plan", id: ATTEMPT } }), false);
});
for (const mode of ["network", "5xx", "409", "invalid-schema", "wrong-attempt", "wrong-id"]) test(`claim never retries ${mode}`, async () => {
  let calls = 0;
  const client = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic", fetchImpl: async () => {
    calls++;
    if (mode === "network") throw new Error("lost claim response");
    if (mode === "5xx" || mode === "409") return json({}, mode === "5xx" ? 502 : 409);
    if (mode === "invalid-schema") return json({ notification: {} });
    return json({ notification: { ...claimed(), ...(mode === "wrong-id" ? { id: ATTEMPT, source: { type: "plan", id: ATTEMPT } } : { attemptId: ID }) } });
  } });
  await assert.rejects(client.claimNotification(ID, ATTEMPT));
  assert.equal(calls, 1);
});
test("receipt retries only identical evidence with a finite budget and no claim or send", async () => {
  const bodies: string[] = [];
  const client = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic", fetchImpl: async (url, init) => {
    assert.ok(String(url).endsWith("/receipt")); bodies.push(String(init?.body));
    if (bodies.length < 3) throw new Error("receipt lost");
    return json({ notification: { ...claimed(), status: "accepted" } });
  } });
  await client.recordNotificationReceipt(ID, ATTEMPT, "accepted");
  assert.equal(bodies.length, 3); assert.equal(new Set(bodies).size, 1);
});
test("receipt gives up after three failures and rejects auth without retry", async () => {
  for (const status of [503, 401, 403, 409]) {
    let calls = 0;
    const client = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic", fetchImpl: async () => { calls++; return json({}, status); } });
    await assert.rejects(client.recordNotificationReceipt(ID, ATTEMPT, "uncertain"), /HTTP/);
    assert.equal(calls, status === 503 ? 3 : 1);
  }
});
test("notification lists reject overfull, duplicate, foreign-chat and malformed projections", async () => {
  const values = [{ items: Array.from({ length: NOTIFICATION_LIMIT + 1 }, (_, index) => notification(index + 1)) },
    { items: [notification(), notification()] }, { items: [notification(1, "foreign")] }, { items: null }, {}, { items: [], secret: "no" }];
  for (const value of values) {
    const client = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic", fetchImpl: async () => json(value) });
    await assert.rejects(client.listNotifications(["chat"]), /schema invalid/);
  }
});
test("notifications enforce request identity and response byte budgets", async () => {
  let calls = 0;
  const client = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic", fetchImpl: async () => {
    calls++; return new Response(new Uint8Array(NOTIFICATION_RESPONSE_BYTES + 1));
  } });
  await assert.rejects(client.listNotifications(Array(129).fill("chat")), /Invalid/);
  await assert.rejects(client.claimNotification("../../escape", ATTEMPT), /schema invalid/);
  assert.equal(calls, 0);
  await assert.rejects(client.listNotifications(["chat"]), /byte budget/);
  assert.equal(calls, 1);
});
test("notification request aborts at its deadline, including a late success response", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish!: (response: Response) => void;
  const client = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic", fetchImpl: async () => new Promise(resolve => { finish = resolve; }) });
  const pending = client.claimNotification(ID, ATTEMPT);
  const rejected = assert.rejects(pending, /abort/i);
  t.mock.timers.tick(10000);
  finish(json({ notification: claimed() }));
  await rejected;
});
test("notification deadlines bound an uncooperative fetch and an unfinished response stream", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const mode of ["fetch", "stream"]) {
    const client = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic", fetchImpl: async () => {
      if (mode === "fetch") return new Promise<Response>(() => {});
      return new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } }));
    } });
    const pending = client.listNotifications(["chat"]);
    const rejected = assert.rejects(pending, /abort/i);
    for (let step = 0; step < 12; step++) await Promise.resolve();
    t.mock.timers.tick(10000);
    await rejected;
  }
});
test("invalid notification JSON does not echo the untrusted body and is not retried", async () => {
  let calls = 0;
  const client = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic", fetchImpl: async () => {
    calls++; return new Response("sensitive_body_do_not_echo");
  } });
  await assert.rejects(client.recordNotificationReceipt(ID, ATTEMPT, "accepted"), error => {
    assert.equal((error as Error).message, "Controller notification response schema invalid"); return true;
  });
  assert.equal(calls, 1);
});
for (const mode of ["401", "409", "503", "utf8", "json", "over-budget"]) test(`notification request releases ${mode} bodies and abort listeners`, async () => {
  const signals: AbortSignal[] = [], responses: Response[] = [];
  let releases = 0;
  const client = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic", fetchImpl: async (_url, init) => {
    const signal = init?.signal as AbortSignal;
    signals.push(signal);
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      signal.addEventListener("abort", () => { releases++; controller.error(signal.reason); }, { once: true });
      if (mode === "utf8") controller.enqueue(new Uint8Array([0xff]));
      else if (mode === "over-budget") controller.enqueue(new Uint8Array(NOTIFICATION_RESPONSE_BYTES + 1));
      else if (mode === "json") { controller.enqueue(new TextEncoder().encode("invalid-json")); controller.close(); }
      // HTTP error bodies intentionally remain streaming and unread.
    } });
    const response = new Response(body, { status: ["401", "409", "503"].includes(mode) ? Number(mode) : 200 });
    responses.push(response); return response;
  } });
  await assert.rejects(client.claimNotification(ID, ATTEMPT));
  assert.equal(signals.length, 1, "claim must not retry while cleaning up");
  assert.equal(releases, 1);
  assert.ok(signals.every(signal => signal.aborted && getEventListeners(signal, "abort").length === 0));
  assert.ok(responses.every(response => response.body?.locked === false));
});
test("receipt retries release each unsuccessful streaming HTTP response before the next attempt", async () => {
  const signals: AbortSignal[] = [];
  let released = 0;
  const client = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic", fetchImpl: async (_url, init) => {
    assert.equal(released, signals.length, "previous request body must be released before retry");
    const signal = init?.signal as AbortSignal; signals.push(signal);
    return new Response(new ReadableStream<Uint8Array>({ start(controller) {
      signal.addEventListener("abort", () => { released++; controller.error(signal.reason); }, { once: true });
    } }), { status: 503 });
  } });
  await assert.rejects(client.recordNotificationReceipt(ID, ATTEMPT, "uncertain"), /HTTP 503/);
  assert.equal(signals.length, 3); assert.equal(released, 3);
  assert.ok(signals.every(signal => signal.aborted && getEventListeners(signal, "abort").length === 0));
});
test("successful notification requests also remove deadline listeners", async () => {
  let signal!: AbortSignal;
  const client = new ControllerClient({ controllerUrl: "http://127.0.0.1:8790", controllerToken: "synthetic", fetchImpl: async (_url, init) => {
    signal = init?.signal as AbortSignal; return json({ items: [] });
  } });
  await client.listNotifications([]);
  assert.equal(signal.aborted, true);
  assert.equal(getEventListeners(signal, "abort").length, 0);
});
