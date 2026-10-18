import { createHash, randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { MemoryDeliveryRepository } from "../../src/deliveries/memory.js";
import { ResultDeliveryService } from "../../src/deliveries/service.js";
import type { LeaderModel } from "../../src/leader/model/contracts.js";
import { MAX_CATCHUP_ARTIFACT_BYTES, MAX_CATCHUP_SOURCES, splitResultMessages } from "../../src/deliveries/contracts.js";
import { createResultDeliveryRouter } from "../../src/deliveries/routes.js";

const NOW = 1_800_000_000_000;
const CHAT = "catchup-user";
const options = { publicUrl: "https://result.example", signingSecret: "catchup-test-signing-secret-at-least-32-chars" };
function fixture(model?: LeaderModel) {
  let now = NOW;
  const repository = new MemoryDeliveryRepository();
  const service = new ResultDeliveryService(repository, { ...options, model, now: () => now });
  const create = async (text: string, kind = "completed") => service.prepareResult({ key: randomUUID(), chatId: CHAT, text,
    source: { type: "plan", id: randomUUID() }, kind, createdAt: NOW, expiresAt: NOW + 3_600_000 });
  return { repository, service, create, now: () => now, advance: (ms: number) => { now += ms; } };
}

it("resumes several original outcomes as one complete delivery while preserving original Web artifacts", async () => {
  const { service, repository, create, now } = fixture();
  const firstText = "# 研究结果一\n\n**完整内容 A** 😀";
  const secondText = "# 研究结果二\n\n完整内容 B";
  const first = await create(firstText);
  const second = await create(secondText);
  await repository.markChatWaiting(CHAT, "window_closed", now());
  const counts = await Promise.all(Array.from({ length: 8 }, () => service.resumeChat(CHAT, "inbound-one")));
  expect(counts.every(count => count === 1)).toBe(true);
  const pending = await repository.listPending([CHAT], now());
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ mode: "text", source: { type: "catchup" } });
  expect(pending[0].messages.join("")).toContain(first.messages[0]);
  expect(pending[0].messages.join("")).toContain(second.messages[0]);
  for (const [original, rawText] of [[first, firstText], [second, secondText]] as const) {
    expect((await repository.get(original.id, now()))?.status).toBe("superseded");
    expect((await repository.getArtifact(original.artifact.id))?.bytes.toString("utf8")).toBe(rawText);
  }
  const materialized = await service.materialize(pending[0].id);
  expect(materialized).not.toHaveProperty("catchupSourceIds");
  expect(materialized).not.toHaveProperty("resumeGeneration");
});

it("restores a legacy preparing catch-up with its frozen three messages when new layout would expand it", async () => {
  const { service, repository, create, now } = fixture();
  const firstText = "①甲②乙\n".repeat(100), secondText = "字".repeat(10900);
  const first = await create(firstText), second = await create(secondText);
  await repository.markChatWaiting(CHAT, "window_closed", now());
  const raw = firstText + secondText, bytes = Buffer.from(raw);
  expect(raw).toHaveLength(11400);
  const id = randomUUID(), artifact = { ...first.artifact, id: randomUUID(), size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex") };
  const frozen = splitResultMessages(raw);
  await repository.createIfAbsent({ ...first, id, key: randomUUID(), source: { type: "catchup", id },
    status: "preparing", mode: "text", messages: frozen, artifact, catchupSourceIds: [first.id, second.id] },
  { ...artifact, bytes }, now());
  const restarted = new ResultDeliveryService(repository, { ...options, now });
  const restored = await restarted.retryPreparation(id);
  expect(restored).toMatchObject({ status: "ready", mode: "text", messages: frozen });
  expect(restored?.messages).toHaveLength(3);
  expect(restored?.messages.join("")).toBe(raw);
  expect((await repository.getArtifact(artifact.id))?.bytes.toString("utf8")).toBe(raw);
  for (const original of [first, second]) expect((await repository.get(original.id, now()))?.status).toBe("superseded");
  expect(await service.retryPreparation(id)).toMatchObject({ status: "ready", messages: frozen });
});

it("holds original waiting results until the durable model summary atomically activates their combined attachment", async () => {
  let finish!: (value: { content: string; toolCalls: [] }) => void;
  const complete = vi.fn(() => new Promise<{ content: string; toolCalls: [] }>(resolve => { finish = resolve; }));
  const { service, repository, create, now } = fixture({ complete });
  const firstText = "# 完整研究 A\n" + "甲".repeat(6000), secondText = "# 完整研究 B\n" + "乙".repeat(6000);
  const first = await create(firstText), second = await create(secondText);
  await repository.markChatWaiting(CHAT, "quota_exhausted", now());
  const operation = service.resumeChat(CHAT, "inbound-one");
  await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
  expect(await repository.listPending([CHAT], now())).toEqual([]);
  for (const original of [first, second]) expect(await repository.get(original.id, now())).toMatchObject({ status: "waiting_for_user", catchupId: expect.any(String) });
  expect(await repository.resumeChat(CHAT, now())).toBe(0);
  expect(await service.resumeChat(CHAT, "inbound-one")).toBe(1);
  expect(await service.resumeChat(CHAT, "inbound-two")).toBe(0);
  finish({ content: "两项研究都已完成，详细成果见完整附件。", toolCalls: [] });
  expect(await operation).toBe(1);
  const pending = await repository.listPending([CHAT], now());
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ status: "ready", mode: "attachment", messages: ["两项研究都已完成，详细成果见完整附件。"] });
  const artifact = await repository.getArtifact(pending[0].artifact.id);
  expect(artifact!.bytes.toString("utf8")).toContain(firstText);
  expect(artifact!.bytes.toString("utf8")).toContain(secondText);
  expect((await repository.get(first.id, now()))?.status).toBe("superseded");
  expect((await repository.get(second.id, now()))?.status).toBe("superseded");
  await service.retryPreparation(pending[0].id);
  expect(complete).toHaveBeenCalledTimes(1);
});

it("keeps both originals and durable preparation after model failure, then resumes preparation after restart", async () => {
  const complete = vi.fn().mockRejectedValueOnce(new Error("model unavailable"))
    .mockResolvedValueOnce({ content: "已经完成两项工作，其中一项存在需要处理的问题。", toolCalls: [] });
  const { service, repository, create, now } = fixture({ complete });
  const first = await create("A".repeat(6000)), second = await create("B".repeat(6000), "failed");
  await repository.markChatWaiting(CHAT, "no_context", now());
  expect(await service.resumeChat(CHAT, "initial")).toBe(1);
  const preparing = (await repository.listMaintenance([CHAT], now())).find(plan => plan.source.type === "catchup")!;
  expect(preparing.status).toBe("preparing");
  expect(await repository.listPending([CHAT], now())).toEqual([]);
  expect((await repository.get(first.id, now()))?.status).toBe("waiting_for_user");
  expect((await repository.get(second.id, now()))?.status).toBe("waiting_for_user");
  const restarted = new ResultDeliveryService(repository, { ...options, model: { complete }, now });
  expect(await restarted.resumeChat(CHAT, "initial")).toBe(1);
  expect(complete).toHaveBeenCalledTimes(1);
  const ready = await restarted.retryPreparation(preparing.id);
  expect(ready?.status).toBe("ready");
  expect(complete).toHaveBeenCalledTimes(2);
  expect((await repository.get(first.id, now()))?.status).toBe("superseded");
  expect((await repository.get(second.id, now()))?.status).toBe("superseded");
});

it("does not merge progress, partially sent, claimed, unknown or expired results into catch-up", async () => {
  const { service, repository, create, now } = fixture();
  const first = await create("terminal one"), second = await create("terminal two");
  const progress = await create("ongoing milestone", "progress");
  const partial = await create("partially delivered");
  const partialAttempt = randomUUID(); await repository.claim(partial.id, partialAttempt, now());
  await repository.defer(partial.id, partialAttempt, "quota_exhausted", now(), 1);
  const claimed = await create("active send"); await repository.claim(claimed.id, randomUUID(), now());
  const unknown = await create("unknown send"), unknownAttempt = randomUUID();
  await repository.claim(unknown.id, unknownAttempt, now()); await repository.recordReceipt(unknown.id, "uncertain", unknownAttempt);
  await repository.markChatWaiting(CHAT, "window_closed", now());
  await service.resumeChat(CHAT, "inbound");
  const pending = await repository.listPending([CHAT], now());
  expect(pending).toHaveLength(1);
  expect(pending[0].catchupSourceIds).toEqual([first.id, second.id].sort());
  expect((await repository.get(progress.id, now()))?.status).toBe("waiting_for_user");
  expect((await repository.get(partial.id, now()))?.status).toBe("waiting_for_user");
  expect((await repository.get(claimed.id, now()))?.status).toBe("claimed");
  expect((await repository.get(unknown.id, now()))?.status).toBe("uncertain");
});

it("persists generation receipts so lost resume responses cannot reopen newly waiting or subsequently deferred results", async () => {
  const { service, repository, create, now } = fixture();
  const first = await create("single result");
  await repository.markChatWaiting(CHAT, "window_closed", now());
  expect(await service.resumeChat(CHAT, "same-inbound")).toBe(1);
  const attemptId = randomUUID(); await repository.claim(first.id, attemptId, now());
  await repository.defer(first.id, attemptId, "quota_exhausted", now());
  const newer = await create("new result arriving after this inbound");
  await repository.markChatWaiting(CHAT, "window_closed", now());
  expect(await service.resumeChat(CHAT, "same-inbound")).toBe(1);
  expect((await repository.get(first.id, now()))?.status).toBe("waiting_for_user");
  expect((await repository.get(newer.id, now()))?.status).toBe("waiting_for_user");
  expect(await service.resumeChat(CHAT, "next-inbound")).toBe(1);
  expect((await repository.listPending([CHAT], now()))).toHaveLength(1);
});

it("refuses to activate an aggregate if original business data expires during summary generation", async () => {
  let finish!: (value: { content: string; toolCalls: [] }) => void;
  const complete = vi.fn(() => new Promise<{ content: string; toolCalls: [] }>(resolve => { finish = resolve; }));
  const { service, repository, create, now, advance } = fixture({ complete });
  const first = await create("A".repeat(6000)), second = await create("B".repeat(6000));
  await repository.markChatWaiting(CHAT, "window_closed", now());
  const operation = service.resumeChat(CHAT, "inbound");
  await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
  advance(3_600_000);
  finish({ content: "结果摘要", toolCalls: [] });
  await operation;
  expect(await repository.listPending([CHAT], now())).toEqual([]);
  expect(await repository.get(first.id, now())).toMatchObject({ status: "waiting_for_user" });
  expect((await repository.get(first.id, now()))?.catchupId).toBeUndefined();
  expect((await repository.get(second.id, now()))?.catchupId).toBeUndefined();
});

it("bounds the original set per generation and leaves additional complete results waiting and available on the Web", async () => {
  const { service, repository, create, now } = fixture();
  const originals = [];
  for (let index = 0; index < MAX_CATCHUP_SOURCES + 3; index++) originals.push(await create(`完整成果 ${index}`));
  await repository.markChatWaiting(CHAT, "no_context", now());
  expect(await repository.listCatchupCandidates(CHAT, now(), 1000)).toHaveLength(MAX_CATCHUP_SOURCES);
  await service.resumeChat(CHAT, "bounded-inbound");
  const pending = await repository.listPending([CHAT], now());
  expect(pending).toHaveLength(1);
  expect(pending[0].catchupSourceIds).toHaveLength(MAX_CATCHUP_SOURCES);
  const outcomes = await Promise.all(originals.map(plan => repository.get(plan.id, now())));
  expect(outcomes.filter(plan => plan?.status === "superseded")).toHaveLength(MAX_CATCHUP_SOURCES);
  expect(outcomes.filter(plan => plan?.status === "waiting_for_user")).toHaveLength(3);
  for (const original of originals) expect(await repository.getArtifact(original.artifact.id)).not.toBeNull();
  await service.resumeChat(CHAT, "bounded-inbound");
  expect(await repository.listPending([CHAT], now())).toHaveLength(1);
});

it("checks byte budgets before fetching oversized originals and resumes at most one existing complete result", async () => {
  const { service, repository, create, now } = fixture();
  const small = await create("small complete original");
  for (let index = 0; index < 2; index++) {
    const id = randomUUID(), artifactId = randomUUID();
    const metadata = { ...small.artifact, id: artifactId, size: MAX_CATCHUP_ARTIFACT_BYTES };
    await repository.createIfAbsent({ ...small, id, key: randomUUID(), source: { type: "plan", id }, artifact: metadata },
      { ...metadata, bytes: Buffer.from("not fetched by the budget planner") });
  }
  await repository.markChatWaiting(CHAT, "no_context", now());
  const getArtifact = vi.spyOn(repository, "getArtifact");
  await service.resumeChat(CHAT, "bounded-bytes");
  expect(getArtifact).not.toHaveBeenCalled();
  const pending = await repository.listPending([CHAT], now());
  expect(pending).toHaveLength(1);
  expect(pending[0].id).toBe(small.id);
  expect((await repository.listMaintenance([CHAT], now())).filter(plan => plan.status === "waiting_for_user")).toHaveLength(2);
  await service.resumeChat(CHAT, "bounded-bytes");
  expect(getArtifact).not.toHaveBeenCalled();
});

it("exposes the stable resume HTTP contract while keeping reservation fields private and original content readable", async () => {
  const { service, repository, create, now } = fixture();
  const originals = [await create("完整成果 A"), await create("完整成果 B")];
  await repository.markChatWaiting(CHAT, "no_context", now());
  const app = express(); app.use(express.json());
  app.use("/v1/deliveries", createResultDeliveryRouter(service, () => new Set([CHAT])));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/deliveries`;
    const resume = () => fetch(base + "/resume", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: CHAT, generation: "one-inbound" }) });
    expect(await (await resume()).json()).toEqual({ resumed: 1 });
    const listed = (await (await fetch(base)).json()).items;
    expect(listed.filter((item: { status: string }) => item.status === "ready")).toHaveLength(1);
    for (const item of listed) {
      expect(item).not.toHaveProperty("catchupSourceIds"); expect(item).not.toHaveProperty("catchupId");
      expect(item).not.toHaveProperty("resumeGeneration");
    }
    for (const original of originals) expect(await (await fetch(base + `/${original.id}/full`)).text()).toBe(original.messages[0]);
    const later = await create("同次入站响应丢失后才完成的新成果");
    await repository.markChatWaiting(CHAT, "no_context", now());
    expect(await (await resume()).json()).toEqual({ resumed: 1 });
    expect((await repository.get(later.id, now()))?.status).toBe("waiting_for_user");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
