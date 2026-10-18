import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { MemoryDeliveryRepository } from "../../src/deliveries/memory.js";
import { ResultDeliveryService } from "../../src/deliveries/service.js";
import type { LeaderModel } from "../../src/leader/model/contracts.js";

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
  const first = await create("# 研究结果一\n\n**完整内容 A** 😀");
  const second = await create("# 研究结果二\n\n完整内容 B");
  await repository.markChatWaiting(CHAT, "window_closed", now());
  const counts = await Promise.all(Array.from({ length: 8 }, () => service.resumeChat(CHAT, "inbound-one")));
  expect(counts.every(count => count === 1)).toBe(true);
  const pending = await repository.listPending([CHAT], now());
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ mode: "text", source: { type: "catchup" } });
  expect(pending[0].messages.join("")).toContain(first.messages[0]);
  expect(pending[0].messages.join("")).toContain(second.messages[0]);
  for (const original of [first, second]) {
    expect((await repository.get(original.id, now()))?.status).toBe("superseded");
    expect((await repository.getArtifact(original.artifact.id))?.bytes.toString("utf8")).toBe(original.messages[0]);
  }
  const materialized = await service.materialize(pending[0].id);
  expect(materialized).not.toHaveProperty("catchupSourceIds");
  expect(materialized).not.toHaveProperty("resumeGeneration");
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
