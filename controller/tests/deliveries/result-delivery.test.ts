import express from "express";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryDeliveryRepository } from "../../src/deliveries/memory.js";
import { ResultDeliveryService } from "../../src/deliveries/service.js";
import { createResultArtifactRouter, createResultDeliveryRouter } from "../../src/deliveries/routes.js";
import { DELIVERY_ATTEMPT_MS, PREPARATION_LEASE_MS, RESULT_MESSAGE_CHARS, splitResultMessages, type ResultInput } from "../../src/deliveries/contracts.js";
import type { LeaderModel } from "../../src/leader/model/contracts.js";

const NOW = 1_800_000_000_000;
const SECRET = "test-result-download-secret-at-least-32-chars";
const input = (text: string, options: Partial<ResultInput> = {}): ResultInput => ({ key: randomUUID(), chatId: "allowed", text,
  source: { type: "plan", id: randomUUID() }, kind: "completed", createdAt: NOW, expiresAt: NOW + 23 * 60 * 60_000, ...options });
function fixture(options: { model?: LeaderModel; fileMaxBytes?: number } = {}) {
  let now = NOW;
  const repository = new MemoryDeliveryRepository();
  const service = new ResultDeliveryService(repository, { publicUrl: "https://results.example", signingSecret: SECRET, now: () => now, ...options });
  return { service, repository, advance: (ms: number) => { now += ms; }, now: () => now };
}

it("preserves complete results through exactly three messages and retains byte-exact Markdown", async () => {
  const { service, repository } = fixture();
  for (const length of [2000, 3800, 3801, 7600, 11400]) {
    const text = "字".repeat(length);
    const plan = await service.prepareResult(input(text));
    expect(plan.mode).toBe("text");
    expect(plan.status).toBe("ready");
    expect(plan.messages.join("")).toBe(text);
    expect(plan.messages.length).toBe(Math.ceil(length / RESULT_MESSAGE_CHARS));
    expect((await repository.getArtifact(plan.artifact.id))?.bytes.equals(Buffer.from(text))).toBe(true);
  }
  const unicode = "x".repeat(3799) + "😀" + "\n**结果**";
  const messages = splitResultMessages(unicode);
  expect(messages[0]).toHaveLength(3799);
  expect(messages.join("")).toBe(unicode);
});

it("formats the whole result before freezing three messages and keeps the source attachment unchanged", async () => {
  const { service, repository } = fixture();
  const body = "正文".repeat(RESULT_MESSAGE_CHARS * 3 / 2 - 7);
  const raw = "**结果：**\n①甲②乙\n" + body;
  const displayed = "结果：\n① 甲\n② 乙\n" + body;
  const plan = await service.prepareResult(input(raw));
  expect(plan).toMatchObject({ mode: "text", status: "ready" });
  expect(plan.messages).toHaveLength(3);
  expect(plan.messages.every(message => message.length <= RESULT_MESSAGE_CHARS)).toBe(true);
  expect(plan.messages.join("")).toBe(displayed);
  expect((await repository.getArtifact(plan.artifact.id))?.bytes.toString("utf8")).toBe(raw);
});

it("chooses an attachment when readable layout pushes the entire result past three messages", async () => {
  const complete = vi.fn(async () => ({ content: "**结果：**\n①完成②完整成果见附件", toolCalls: [] }));
  const { service, repository } = fixture({ model: { complete } });
  const raw = "①甲②乙\n" + "字".repeat(RESULT_MESSAGE_CHARS * 3 - 5);
  expect(raw).toHaveLength(RESULT_MESSAGE_CHARS * 3);
  const plan = await service.prepareResult(input(raw));
  expect(plan).toMatchObject({ mode: "attachment", status: "ready" });
  expect(plan.messages).toEqual(["结果：\n① 完成\n② 完整成果见附件"]);
  expect(complete).toHaveBeenCalledTimes(1);
  expect((await repository.getArtifact(plan.artifact.id))?.bytes.toString("utf8")).toBe(raw);
});

it("never reformats an existing frozen or unknown result on replay", async () => {
  const f = fixture(), request = input("**已冻结原文**");
  const current = await f.service.prepareResult(request);
  const artifact = (await f.repository.getArtifact(current.artifact.id))!;
  const repository = new MemoryDeliveryRepository();
  await repository.createIfAbsent({ ...current, messages: [request.text] }, artifact, NOW);
  const service = new ResultDeliveryService(repository, { publicUrl: "https://results.example", signingSecret: SECRET, now: () => NOW });
  const attemptId = randomUUID();
  await repository.claim(current.id, attemptId, NOW);
  await repository.recordReceipt(current.id, "uncertain", attemptId);
  const replay = await service.prepareResult(request);
  expect(replay.messages).toEqual([request.text]);
  expect(replay.status).toBe("uncertain");
});

it("plans the entire four-message result once, generates a model summary without tools and caches it across retries", async () => {
  const complete = vi.fn(async () => ({ content: "已完成：验证通过。完整成果见附件。", toolCalls: [] }));
  const { service, repository } = fixture({ model: { complete } });
  const whole = input("完整成果\n" + "甲".repeat(RESULT_MESSAGE_CHARS * 3));
  const plans = await Promise.all(Array.from({ length: 8 }, () => service.prepareResult(whole)));
  const plan = await service.prepareResult(whole);
  expect(new Set(plans.map(value => value.id)).size).toBe(1);
  expect(plan.mode).toBe("attachment");
  expect(plan.messages).toEqual(["已完成：验证通过。完整成果见附件。"]);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(complete.mock.calls[0]?.[1]).toEqual([]);
  expect((await repository.getArtifact(plan.artifact.id))?.bytes.toString("utf8")).toBe(whole.text);
  await expect(service.prepareResult({ ...whole, text: whole.text + "different" })).rejects.toThrow("idempotency");
});

it("keeps failed or unavailable model preparation pending with the original result safely stored", async () => {
  const complete = vi.fn().mockRejectedValueOnce(new Error("secret-provider-token"))
    .mockResolvedValueOnce({ content: "实际完成的成果摘要", toolCalls: [] });
  const { service, repository } = fixture({ model: { complete } });
  const plan = await service.prepareResult(input("x".repeat(11401)));
  expect(plan).toMatchObject({ status: "preparing", messages: [], error: "summary_generation_failed" });
  expect(JSON.stringify(plan)).not.toContain("secret-provider-token");
  expect(await service.materialize(plan.id)).toBeNull();
  expect((await service.retryPreparation(plan.id))?.status).toBe("ready");
  expect((await repository.getArtifact(plan.artifact.id))?.size).toBe(11401);
  const noModel = fixture();
  expect((await noModel.service.prepareResult(input("x".repeat(11401)))).status).toBe("preparing");
});

it.each([{ content: "x".repeat(3801), toolCalls: [] }, { content: "", toolCalls: [] },
  { content: "done", toolCalls: [{ id: "bad", type: "function" as const, function: { name: "exec", arguments: "{}" } }] }])
  ("rejects summaries that cannot fit one message or contain tool calls", async reply => {
    const { service } = fixture({ model: { complete: async () => reply } });
    expect((await service.prepareResult(input("x".repeat(11401)))).status).toBe("preparing");
  });

it("preparation leases survive concurrent workers and can be reclaimed after a crashed worker", async () => {
  const { service, repository, advance, now } = fixture();
  const plan = await service.prepareResult(input("x".repeat(11401)));
  expect(await repository.claimPreparation(plan.id, "worker-a", now())).not.toBeNull();
  expect(await repository.claimPreparation(plan.id, "worker-b", now())).toBeNull();
  advance(PREPARATION_LEASE_MS);
  expect(await repository.claimPreparation(plan.id, "worker-b", now())).not.toBeNull();
  expect(await repository.finishPreparation(plan.id, "worker-a", ["stale summary"])).toBeNull();
  expect((await repository.finishPreparation(plan.id, "worker-b", ["current summary"]))?.messages).toEqual(["current summary"]);
});

it("claims atomically, waits for a real inbound to resume, expires business delivery independently and never retries unknown sends", async () => {
  const { service, repository, advance, now } = fixture();
  const plan = await service.prepareResult(input("finished"));
  const attempts = [randomUUID(), randomUUID()];
  const claims = await Promise.all(attempts.map(id => repository.claim(plan.id, id, now())));
  expect(claims.filter(Boolean)).toHaveLength(1);
  const claim = claims.find(Boolean)!;
  expect((await repository.claim(plan.id, claim.attemptId!, now()))?.attemptId).toBe(claim.attemptId);
  expect(await repository.defer(plan.id, "wrong", "quota_exhausted", now())).toBeNull();
  expect((await repository.defer(plan.id, claim.attemptId!, "quota_exhausted", now()))?.status).toBe("waiting_for_user");
  expect((await repository.defer(plan.id, claim.attemptId!, "quota_exhausted", now()))?.lastDeferredAttemptId).toBe(claim.attemptId);
  expect(await repository.defer(plan.id, claim.attemptId!, "different_reason", now())).toBeNull();
  expect(await repository.listPending(["allowed"], now())).toEqual([]);
  expect(await repository.resumeChat("other", now())).toBe(0);
  expect(await repository.resumeChat("allowed", now())).toBe(1);
  const nextAttempt = randomUUID();
  await repository.claim(plan.id, nextAttempt, now());
  advance(DELIVERY_ATTEMPT_MS);
  expect(await repository.listPending(["allowed"], now())).toEqual([]);
  expect((await repository.get(plan.id))?.status).toBe("uncertain");
  expect(await repository.resumeChat("allowed", now())).toBe(0);
  expect(await repository.claim(plan.id, randomUUID(), now())).toBeNull();
  expect(await repository.recordReceipt(plan.id, "accepted", "wrong")).toBeNull();
  expect((await repository.recordReceipt(plan.id, "accepted", nextAttempt))?.status).toBe("accepted");
  expect((await repository.recordReceipt(plan.id, "uncertain", nextAttempt))?.status).toBe("accepted");
  advance(24 * 60 * 60_000);
  expect(await repository.getArtifact(plan.artifact.id)).not.toBeNull();
});

it("coalesces only unsent milestones and latest business results while retaining claimed and partially delivered outcomes", async () => {
  const { service, repository, advance, now } = fixture();
  const source = { type: "plan", id: randomUUID() };
  const first = await service.prepareResult(input("进度一", { source, kind: "progress" }));
  advance(1);
  const second = await service.prepareResult(input("进度二", { source, kind: "progress", createdAt: now() }));
  expect((await repository.get(first.id))?.status).toBe("superseded");
  advance(1);
  await service.prepareResult(input("完整终态成果", { source, createdAt: now() }));
  expect((await repository.get(second.id))?.status).toBe("superseded");
  const business = { category: "weather", supersedes: "weather:daily" };
  const weather = await service.prepareResult(input("昨天的天气", { business, createdAt: now() }));
  advance(1);
  await service.prepareResult(input("今天的天气", { business, createdAt: now() }));
  expect((await repository.get(weather.id))?.status).toBe("superseded");
  const partial = await service.prepareResult(input("部分已经送达，后续应保留", { business: { supersedes: "retained-partial" }, createdAt: now() }));
  const attemptId = randomUUID();
  await repository.claim(partial.id, attemptId, now());
  advance(1);
  await service.prepareResult(input("新成果不覆盖正在发送的成果", { business: { supersedes: "retained-partial" }, createdAt: now() }));
  expect((await repository.get(partial.id))?.status).toBe("claimed");
  await repository.defer(partial.id, attemptId, "quota_exhausted", now(), 1);
  advance(1);
  await service.prepareResult(input("新成果也不覆盖已发一部分的成果", { business: { supersedes: "retained-partial" }, createdAt: now() }));
  expect((await repository.get(partial.id))?.status).toBe("waiting_for_user");
  expect((await repository.get(partial.id))?.submittedMessages).toBe(1);
});

it("maintains every older pending result through cursor pages beyond the 100 most recent UI entries", async () => {
  const { service, repository, now } = fixture();
  const expected = new Set<string>();
  for (let index = 0; index < 105; index++) {
    const plan = await service.prepareResult(input(index % 2 ? "x".repeat(11401) : "等待用户回来", { createdAt: NOW - 1000 }));
    if (plan.status === "ready") {
      const attemptId = randomUUID();
      await repository.claim(plan.id, attemptId, now());
      await repository.defer(plan.id, attemptId, "quota_exhausted", now());
    }
    expected.add(plan.id);
  }
  for (let index = 0; index < 101; index++) await service.prepareResult(input("recent UI entry"));
  const recent = await repository.list(["allowed"]);
  expect(recent).toHaveLength(100);
  expect(recent.some(plan => expected.has(plan.id))).toBe(false);
  const seen: string[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await repository.listMaintenance(["allowed"], now(), after, 20);
    if (!page.length) break;
    expect(page.length).toBeLessThanOrEqual(20);
    seen.push(...page.map(plan => plan.id)); after = page.at(-1)!.id;
  }
  expect(seen).toHaveLength(105);
  expect(new Set(seen)).toEqual(expected);
  expect(await repository.listMaintenance(["forbidden"], now())).toEqual([]);
  expect(await repository.listMaintenance(["allowed"], NOW + 24 * 60 * 60_000)).toEqual([]);
});

it("reports an active result beyond the bounded recent UI list", async () => {
  const { service, repository, now, advance } = fixture();
  const waiting = await service.prepareResult(input("等待用户回来", { createdAt: NOW - 1_000 }));
  const attempt = randomUUID();
  await repository.claim(waiting.id, attempt, now());
  await repository.defer(waiting.id, attempt, "quota_exhausted", now());
  for (let index = 0; index < 101; index++) {
    const recent = await service.prepareResult(input(`已完成 ${index}`));
    const recentAttempt = randomUUID();
    await repository.claim(recent.id, recentAttempt, now());
    await repository.recordReceipt(recent.id, "accepted", recentAttempt);
  }
  expect((await repository.list(["allowed"])).every(plan => plan.status === "accepted")).toBe(true);
  expect(await repository.hasActiveDelivery("allowed", now())).toBe(true);
  advance(23 * 60 * 60_000 + 1);
  expect(await repository.hasActiveDelivery("allowed", now())).toBe(false);
});

it("GET and claim persist expired attempts as uncertain without requiring the pending queue scan", async () => {
  const { service, repository, now, advance } = fixture();
  const first = await service.prepareResult(input("first"));
  const second = await service.prepareResult(input("second"));
  const firstAttempt = randomUUID(), secondAttempt = randomUUID();
  await repository.claim(first.id, firstAttempt, now());
  await repository.claim(second.id, secondAttempt, now());
  advance(DELIVERY_ATTEMPT_MS);
  expect((await repository.get(first.id, now()))?.status).toBe("uncertain");
  expect(await repository.claim(second.id, randomUUID(), now())).toBeNull();
  expect((await repository.get(second.id, now()))?.status).toBe("uncertain");
  expect((await repository.claim(first.id, firstAttempt, now()))?.status).toBe("uncertain");
});

it("marks unsent ready results waiting without taking a transport attempt or disturbing other execution states", async () => {
  const { service, repository, now } = fixture();
  const ready = await service.prepareResult(input("waiting for context"));
  const preparing = await service.prepareResult(input("x".repeat(11401)));
  const claimed = await service.prepareResult(input("active attempt"));
  await repository.claim(claimed.id, randomUUID(), now());
  const unknown = await service.prepareResult(input("unknown submission"));
  const unknownAttempt = randomUUID();
  await repository.claim(unknown.id, unknownAttempt, now());
  await repository.recordReceipt(unknown.id, "uncertain", unknownAttempt);
  const partial = await service.prepareResult(input("partially sent"));
  const partialAttempt = randomUUID();
  await repository.claim(partial.id, partialAttempt, now());
  await repository.defer(partial.id, partialAttempt, "quota_exhausted", now(), 1);
  await repository.resumeChat("allowed", now());
  expect(await repository.markChatWaiting("allowed", "no_context", now())).toBe(1);
  expect(await repository.markChatWaiting("allowed", "no_context", now())).toBe(0);
  expect((await repository.get(ready.id, now()))).toMatchObject({ status: "waiting_for_user", deferReason: "no_context" });
  expect((await repository.get(ready.id, now()))?.attemptId).toBeUndefined();
  expect((await repository.get(preparing.id, now()))?.status).toBe("preparing");
  expect((await repository.get(claimed.id, now()))?.status).toBe("claimed");
  expect((await repository.get(unknown.id, now()))?.status).toBe("uncertain");
  expect((await repository.get(partial.id, now()))?.status).toBe("ready");
  expect(await repository.markChatWaiting("forbidden", "no_context", now())).toBe(0);
});

it.each(["not_submitted", "artifact_unavailable", "reply_pending", "attempt_expired"])
  ("safely retries known-unsubmitted %s outcomes while preserving partial prefixes and permanent unknown evidence", async reason => {
    const { service, repository, now } = fixture();
    const plan = await service.prepareResult(input("a result whose remaining steps were not submitted"));
    const attemptId = randomUUID(), retryAttempt = randomUUID();
    await repository.claim(plan.id, attemptId, now());
    expect(await repository.defer(plan.id, attemptId, reason, now(), 1)).toMatchObject({ status: "ready", submittedMessages: 1, lastDeferredAttemptId: attemptId });
    expect((await repository.defer(plan.id, attemptId, reason, now(), 1))?.status).toBe("ready");
    expect((await repository.claim(plan.id, retryAttempt, now()))?.status).toBe("claimed");
    expect(await repository.defer(plan.id, attemptId, reason, now(), 1)).toMatchObject({ status: "claimed", attemptId: retryAttempt });
    await repository.recordReceipt(plan.id, "uncertain", retryAttempt);
    expect(await repository.defer(plan.id, retryAttempt, reason, now(), 1)).toBeNull();
    expect((await repository.defer(plan.id, attemptId, reason, now(), 1))?.status).toBe("uncertain");
    expect(await repository.claim(plan.id, randomUUID(), now())).toBeNull();
  });

it("generates expiring links at actual materialization and preserves oversized complete results for download", async () => {
  const { service, advance } = fixture({ fileMaxBytes: 100, model: { complete: async () => ({ content: "完成摘要", toolCalls: [] }) } });
  const plan = await service.prepareResult(input("x".repeat(11401)));
  expect(plan.mode).toBe("download");
  const first = await service.materialize(plan.id);
  expect(first?.messages).toHaveLength(2);
  const url = new URL(first!.artifact.downloadUrl);
  expect(service.validDownload(plan.artifact.id, url.searchParams.get("expires"), url.searchParams.get("signature"))).toBe(true);
  expect(service.validDownload(randomUUID(), url.searchParams.get("expires"), url.searchParams.get("signature"))).toBe(false);
  advance(16 * 60_000);
  expect(service.validDownload(plan.artifact.id, url.searchParams.get("expires"), url.searchParams.get("signature"))).toBe(false);
  expect((await service.materialize(plan.id))?.artifact.downloadUrl).not.toBe(first?.artifact.downloadUrl);
});

const servers: ReturnType<ReturnType<typeof express>["listen"]>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))); });

it("serves actual HTTP result views and signed byte-exact downloads with per-chat access and attempt validation", async () => {
  const { service, advance } = fixture();
  const allowed = new Set(["allowed"]);
  const app = express(); app.use(express.json());
  app.use("/v1/deliveries", createResultDeliveryRouter(service, () => allowed));
  app.use("/v1/result-artifacts", createResultArtifactRouter(service, () => allowed));
  const server = app.listen(0, "127.0.0.1"); servers.push(server);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const plan = await service.prepareResult(input("# 完整结果\n\n😀 data"));
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect((await post("/v1/deliveries/blocked", { chatId: "forbidden", reason: "no_context" })).status).toBe(404);
  expect((await post("/v1/deliveries/blocked", { chatId: "allowed", reason: "" })).status).toBe(400);
  expect(await (await post("/v1/deliveries/blocked", { chatId: "allowed", reason: "no_context" })).json()).toEqual({ blocked: 1 });
  expect(await (await post("/v1/deliveries/blocked", { chatId: "allowed", reason: "no_context" })).json()).toEqual({ blocked: 0 });
  expect(await (await post("/v1/deliveries/resume", { chatId: "allowed" })).json()).toEqual({ resumed: 1 });
  expect((await (await post("/v1/deliveries/pending", { chatIds: ["allowed", "forbidden"] })).json()).items).toHaveLength(1);
  const attemptId = randomUUID();
  expect((await post(`/v1/deliveries/${plan.id}/claim`, { attemptId })).status).toBe(200);
  expect((await post(`/v1/deliveries/${plan.id}/claim`, { attemptId: randomUUID() })).status).toBe(409);
  expect((await post(`/v1/deliveries/${plan.id}/materialize`, { attemptId: randomUUID() })).status).toBe(409);
  const response = await post(`/v1/deliveries/${plan.id}/materialize`, { attemptId });
  const materialized = (await response.json()).delivery;
  const downloadPath = new URL(materialized.artifact.downloadUrl).pathname + new URL(materialized.artifact.downloadUrl).search;
  const download = await fetch(base + downloadPath);
  expect(download.status).toBe(200);
  expect(await download.text()).toBe("# 完整结果\n\n😀 data");
  expect(download.headers.get("content-disposition")).toContain("attachment;");
  const deferPath = `/v1/deliveries/${plan.id}/defer`;
  expect((await (await post(deferPath, { attemptId, reason: "artifact_unavailable", submittedMessages: 1 })).json()).delivery)
    .toMatchObject({ status: "ready", submittedMessages: 1 });
  const retryAttempt = randomUUID();
  expect((await post(`/v1/deliveries/${plan.id}/claim`, { attemptId: retryAttempt })).status).toBe(200);
  expect((await (await post(deferPath, { attemptId, reason: "artifact_unavailable", submittedMessages: 1 })).json()).delivery)
    .toMatchObject({ status: "claimed", attemptId: retryAttempt });
  expect((await post(`/v1/deliveries/${plan.id}/receipt`, { attemptId: retryAttempt, status: "uncertain" })).status).toBe(200);
  expect((await post(deferPath, { attemptId: retryAttempt, reason: "artifact_unavailable", submittedMessages: 1 })).status).toBe(409);
  expect((await fetch(base + downloadPath.replace("signature=", "signature=a"))).status).toBe(403);
  allowed.delete("allowed");
  expect((await fetch(base + `/v1/deliveries/${plan.id}/full`)).status).toBe(404);
  expect((await fetch(base + downloadPath)).status).toBe(404);
  allowed.add("allowed");
  advance(24 * 60 * 60_000);
  expect((await fetch(base + `/v1/deliveries/${plan.id}/full`)).status).toBe(200);
  advance(7 * 24 * 60 * 60_000);
  expect((await fetch(base + `/v1/deliveries/${plan.id}/full`)).status).toBe(410);
});
