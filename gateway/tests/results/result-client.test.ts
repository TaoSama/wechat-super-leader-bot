import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { ResultClient } from "../../src/controller/result-client.js";
import { parseResultDelivery, type MaterializedResultDelivery } from "../../src/results/contracts.js";

const now = 1_800_000_000_000, bytes = Buffer.from("完整成果🚀\n");
function plan(): MaterializedResultDelivery {
  const id = randomUUID(), artifactId = randomUUID();
  return { id, key: `task:${id}`, chatId: "chat", source: { type: "plan", id: "source" }, kind: "completed", status: "claimed", mode: "attachment", messages: ["摘要"],
    artifact: { id: artifactId, chatId: "chat", name: "result.md", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
      expiresAt: now + 200_000, downloadUrl: `https://public.test/v1/result-artifacts/${artifactId}/download?expires=${now + 100_000}&signature=${"a".repeat(64)}` },
    createdAt: now - 100_000, expiresAt: now + 100_000, retainedUntil: now + 200_000,
    attemptId: randomUUID(), attemptedAt: now, attemptExpiresAt: now + 100_000 };
}
function client(fetchImpl: typeof fetch, extra: { timeoutMs?: number; maxFileBytes?: number } = {}) {
  return new ResultClient({ controllerUrl: "http://127.0.0.1:3000", artifactPublicOrigin: "https://public.test", controllerToken: "synthetic-bearer", fetchImpl, ...extra });
}
function markdownResponse(content = bytes): Response {
  return new Response(content, { headers: { "Content-Type": "text/markdown; charset=utf-8", "Content-Length": String(content.length) } });
}
test("materialization authenticates only configured Controller route and checks claim identity", async () => {
  const item = plan(), calls: { url: string; options?: RequestInit }[] = [];
  const c = client(async (input, options) => { calls.push({ url: String(input), options }); return Response.json({ delivery: item }); });
  const result = await c.materializeDelivery(item.id, item.attemptId!);
  assert.equal(result.artifact.sha256, item.artifact.sha256);
  assert.equal(calls[0].url, `http://127.0.0.1:3000/v1/deliveries/${item.id}/materialize`);
  assert.equal(new Headers(calls[0].options?.headers).get("authorization"), "Bearer synthetic-bearer");
  assert.equal(calls[0].options?.redirect, "error");
  assert.deepEqual(JSON.parse(String(calls[0].options?.body)), { attemptId: item.attemptId });
  await assert.rejects(c.materializeDelivery(item.id, randomUUID()), /identity mismatch/);
});
test("public signed artifact URLs map to Controller transport without sending bearer", async () => {
  const item = plan(), calls: { url: string; options?: RequestInit }[] = [];
  const c = client(async (input, options) => { calls.push({ url: String(input), options }); return markdownResponse(); });
  assert.deepEqual(await c.downloadArtifact(item.artifact), bytes);
  assert.ok(calls[0].url.startsWith(`http://127.0.0.1:3000/v1/result-artifacts/${item.artifact.id}/download?`));
  assert.equal(new Headers(calls[0].options?.headers).get("authorization"), null);
  assert.equal(calls[0].options?.redirect, "error");
});
for (const mutate of [
  (url: URL) => { url.hostname = "attacker.test"; },
  (url: URL) => { url.username = "userinfo"; },
  (url: URL) => { url.pathname = "/v1/messages"; },
  (url: URL) => { url.hash = "#fragment"; },
  (url: URL) => { url.searchParams.append("signature", "b".repeat(64)); },
  (url: URL) => { url.searchParams.append("redirect", "https://attacker.test"); },
]) test(`untrusted artifact destination is rejected before network (${String(mutate)})`, async () => {
  const item = plan(), url = new URL(item.artifact.downloadUrl);
  mutate(url); item.artifact.downloadUrl = url.href;
  let calls = 0;
  const c = client(async () => { calls++; return markdownResponse(); });
  await assert.rejects(c.downloadArtifact(item.artifact), /Untrusted/);
  assert.equal(calls, 0);
});
test("a cross-artifact URL cannot fetch a different file under the same origin", async () => {
  const item = plan(); item.artifact.id = randomUUID();
  await assert.rejects(client(async () => markdownResponse()).downloadArtifact(item.artifact), /Untrusted/);
});
test("download verifies immutable size, SHA256, MIME, and application file limit", async () => {
  const item = plan();
  await assert.rejects(client(async () => markdownResponse(Buffer.from("corrupt"))).downloadArtifact(item.artifact), /length mismatch/);
  const corrupted = Buffer.alloc(bytes.length);
  await assert.rejects(client(async () => markdownResponse(corrupted)).downloadArtifact(item.artifact), /integrity mismatch/);
  await assert.rejects(client(async () => new Response(bytes, { headers: { "Content-Type": "text/html" } })).downloadArtifact(item.artifact), /invalid response/);
  let calls = 0;
  await assert.rejects(client(async () => { calls++; return markdownResponse(); }, { maxFileBytes: bytes.length - 1 }).downloadArtifact(item.artifact), /file budget/);
  assert.equal(calls, 0);
});
test("chunked download stops at expected bytes even without Content-Length", async () => {
  const item = plan();
  const response = new Response(Buffer.alloc(bytes.length + 1), { headers: { "Content-Type": "text/markdown" } });
  await assert.rejects(client(async () => response).downloadArtifact(item.artifact), /byte budget/);
});
test("request byte budgets and deadlines also constrain fetch implementations ignoring abort", async () => {
  const item = plan();
  await assert.rejects(client(async () => new Response(" ".repeat(2 * 1024 * 1024 + 1))).getDelivery(item.id), /byte budget/);
  const c = client(async () => new Promise<Response>(() => {}), { timeoutMs: 5 });
  await assert.rejects(c.getDelivery(item.id), /timed out/);
});
test("parent cancellation interrupts download body reads and releases its reader lock", async () => {
  const item = plan(), abort = new AbortController();
  const body = new ReadableStream<Uint8Array>({ start() {} });
  const response = new Response(body, { headers: { "Content-Type": "text/markdown" } });
  const pending = client(async () => response).downloadArtifact(item.artifact, abort.signal);
  setTimeout(() => abort.abort(new Error("test-cancel")), 5);
  await assert.rejects(pending, /test-cancel/);
  assert.equal(body.locked, false);
});
test("pending list refuses results belonging to another chat", async () => {
  const item = { ...plan(), status: "ready", attemptId: undefined, attemptedAt: undefined, attemptExpiresAt: undefined };
  const c = client(async () => Response.json({ items: [item] }));
  await assert.rejects(c.listDeliveries(["other"]), /identity mismatch/);
});
test("strict DTO rejects unsafe filenames, cross-chat artifacts and oversized text", () => {
  const item = plan();
  assert.throws(() => parseResultDelivery({ ...item, artifact: { ...item.artifact, name: "../secret" } }), /schema invalid/);
  assert.throws(() => parseResultDelivery({ ...item, artifact: { ...item.artifact, chatId: "other" } }), /schema invalid/);
  assert.throws(() => parseResultDelivery({ ...item, messages: ["a".repeat(3801)] }), /schema invalid/);
});
test("notification interest includes all allowed chats while validating the interested subset", async () => {
  let url = "";
  const c = client(async input => { url = String(input); return Response.json({ chatIds: ["no-context", "chat"], interested: ["chat"] }); });
  assert.deepEqual(await c.notificationInterest(), { chatIds: ["no-context", "chat"], interested: ["chat"] });
  assert.equal(url, "http://127.0.0.1:3000/v1/chats/notification-interest");
  await assert.rejects(client(async () => Response.json({ chatIds: ["chat"], interested: ["unauthorized"] })).notificationInterest(), /schema invalid/);
});

test("artifact transfer scales independently while control requests retain their 15s deadline", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const item = plan(); item.artifact.size = 32 * 1024 * 1024;
  const signals: AbortSignal[] = [];
  const c = client(async (_input, init) => {
    signals.push(init!.signal! as AbortSignal);
    return new Promise<Response>(() => {});
  });
  const download = assert.rejects(c.downloadArtifact(item.artifact), /download timed out/);
  const control = assert.rejects(c.getDelivery(item.id), /request timed out/);
  t.mock.timers.tick(15_000);
  await control;
  assert.equal(signals[0].aborted, false, "32MiB transfer outlives the control-request timeout");
  assert.equal(signals[1].aborted, true);
  t.mock.timers.tick(32_000);
  await download;
  assert.equal(signals[0].aborted, true);
});

test("short multi-chunk artifact never exposes unfilled preallocated bytes", async () => {
  const item = plan();
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(bytes.subarray(0, 2)); controller.enqueue(bytes.subarray(2, bytes.length - 1)); controller.close();
  } });
  await assert.rejects(client(async () => new Response(stream, { headers: { "Content-Type": "text/markdown" } }))
    .downloadArtifact(item.artifact), /integrity mismatch/);
});
